import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as z from "zod";

import { describeRedactedValue } from "./env.ts";
import { MonkeError } from "./errors.ts";
import { withScopedLockAsync } from "./runtime.ts";
import type { SessionStateStore } from "./session-state-store.ts";
import type {
  RepoConfig,
  ResourceCommandConfig,
  ResourceCommandState,
  ResourceValueState,
  Runtime,
  SessionRepoState
} from "./types.ts";

type ResourceCommandInput = Record<string, string[]>;

const RESOURCE_COMMAND_RUNNER_ARGV = "monke-resource-command-runner";
// Runs in the repo's Bun process. Keep inputs in argv/stdin and results separate from logs.
const RESOURCE_COMMAND_MODULE_RUNNER = String.raw`
import { pathToFileURL } from "node:url";

const [, runnerArgv, modulePath, outputPath] = process.argv;
try {
  if (runnerArgv !== "monke-resource-command-runner" || !modulePath || !outputPath) {
    throw new Error("Missing resource command runner arguments");
  }
  const previousText = await Bun.stdin.text();
  const previous = previousText.trim() ? JSON.parse(previousText) : {};
  const resourceModule = await import(pathToFileURL(modulePath).href);
  if (typeof resourceModule !== "object" || resourceModule === null || !("default" in resourceModule)) {
    throw new Error("Resource command module " + modulePath + " must export a default function");
  }
  if (typeof resourceModule.default !== "function") {
    throw new TypeError("Resource command module " + modulePath + " default export must be a function");
  }
  const value = await resourceModule.default({ previous });
  await Bun.write(outputPath, JSON.stringify({ value }));
} catch (error) {
  await Bun.write(Bun.stderr, (error instanceof Error && error.stack ? error.stack : String(error)) + "\n");
  process.exit(1);
}
`;
const ResourceCommandRunnerEnvelopeSchema = z.strictObject({ value: z.unknown() });
const ResourceCommandReturnSchema = z.record(
  z.string(),
  z.string().refine((value) => value.trim().length > 0)
);

/** Resolve, reuse, prune, and collision-check deterministic Resource values. */
export function resolveResourceValues(options: {
  env: Record<string, string | undefined>;
  existingRepoState: SessionRepoState | undefined;
  repoConfig: RepoConfig;
  rootSourceRoot: string;
  session: string;
  store: SessionStateStore;
}) {
  const declaredEnvNames = new Set(
    options.repoConfig.resourceValuesInOrder.map((resource) => resource.env)
  );
  const existingValues = options.existingRepoState?.resourceValues ?? [];
  const rememberedValues = new Map(
    existingValues
      .filter((resource) => declaredEnvNames.has(resource.env) && resource.value.trim() !== "")
      .map((resource) => [resource.env, resource.value])
  );

  const values = options.repoConfig.resourceValuesInOrder.map((resource) => {
    const remembered = rememberedValues.get(resource.env);
    const value =
      remembered ??
      interpolateResourceLiteral({
        literal: resource.literal,
        location: `${options.repoConfig.configPath}#resources.values.${resource.env}`,
        session: options.session,
        user: resolveResourceUser(options.env)
      });

    if (!value.trim()) {
      throw new MonkeError(
        `${options.repoConfig.configPath}#resources.values.${resource.env} resolved to an empty value`
      );
    }

    return {
      env: resource.env,
      value
    };
  });

  rejectResourceValueCollisions({
    rootSourceRoot: options.rootSourceRoot,
    session: options.session,
    sourceRoot: options.repoConfig.sourceRoot,
    store: options.store,
    values
  });

  return {
    removedEnvNames: dedupe(
      existingValues.map((resource) => resource.env).filter((env) => !declaredEnvNames.has(env))
    ),
    values
  };
}

/** Resolve, reuse, prune, execute, and validate Resource command outputs. */
export async function resolveResourceCommands(options: {
  existingRepoState: SessionRepoState | undefined;
  onCommandExecutionStarting?: (commands: ResourceCommandState[]) => void;
  onResolvedCommandOutputs: (commands: ResourceCommandState[]) => void;
  repoConfig: RepoConfig;
  resourceValues: ResourceValueState[];
  rootSourceRoot: string;
  runtime: Runtime;
  session: string;
  store: SessionStateStore;
  worktreePath: string;
}) {
  const existingCommands = options.existingRepoState?.resourceCommandOutputs ?? [];
  const existingByName = new Map(existingCommands.map((command) => [command.name, command]));
  const currentByName = new Map<string, ResourceCommandState>();

  for (const command of options.repoConfig.resourceCommandsInOrder) {
    const reusable = getReusableResourceCommand(command, existingByName.get(command.name));
    if (reusable) {
      currentByName.set(command.name, reusable);
    }
  }

  for (const command of options.repoConfig.resourceCommandsInOrder) {
    if (currentByName.has(command.name)) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- Commands in one repo are intentionally ordered; sibling repos remain concurrent.
    await withResourceCommandLock(
      options.store.home,
      options.repoConfig.sourceRoot,
      command.name,
      async () => {
        const stdin = options.store.resourceCommandInput({
          command,
          rootSourceRoot: options.rootSourceRoot,
          session: options.session,
          sourceRoot: options.repoConfig.sourceRoot
        });
        options.onCommandExecutionStarting?.(
          toImmediateResourceCommandStates(
            options.repoConfig.resourceCommandsInOrder,
            currentByName,
            existingCommands
          )
        );
        currentByName.set(
          command.name,
          await runResourceCommand({
            command,
            resourceValues: options.resourceValues,
            runtime: options.runtime,
            stdin,
            worktreePath: options.worktreePath
          })
        );
        options.onResolvedCommandOutputs(
          toImmediateResourceCommandStates(
            options.repoConfig.resourceCommandsInOrder,
            currentByName,
            existingCommands
          )
        );
      }
    );
  }

  const commands = toResourceCommandStates(
    options.repoConfig.resourceCommandsInOrder,
    currentByName
  );
  const finalEnvNames = new Set(
    commands.flatMap((command) => command.outputs.map((output) => output.env))
  );
  const removedEnvNames = dedupe(
    existingCommands
      .flatMap((command) => command.outputs.map((output) => output.env))
      .filter((env) => !finalEnvNames.has(env))
  );
  return { commands, removedEnvNames };
}

function getReusableResourceCommand(
  command: ResourceCommandConfig,
  existing: ResourceCommandState | undefined
) {
  if (!existing) {
    return null;
  }

  const rememberedByEnv = new Map(existing.outputs.map((output) => [output.env, output.value]));
  const outputs: { env: string; value: string }[] = [];
  for (const env of command.outputs) {
    const value = rememberedByEnv.get(env);
    if (value === undefined || value.trim() === "") {
      return null;
    }
    outputs.push({ env, value });
  }

  return {
    name: command.name,
    outputs
  };
}

async function runResourceCommand(options: {
  command: ResourceCommandConfig;
  resourceValues: ResourceValueState[];
  runtime: Runtime;
  stdin: ResourceCommandInput;
  worktreePath: string;
}) {
  const stdin = JSON.stringify(options.stdin);
  const outputDirectory = mkdtempSync(path.join(tmpdir(), "monke-resource-command-"));
  const outputPath = path.join(outputDirectory, "output.json");
  const modulePath = resolveResourceCommandRunPath(options.worktreePath, options.command);
  try {
    const runner = resolveResourceCommandRunner(options.worktreePath);
    const result = await options.runtime.execAsync(
      runner.command,
      runner.args(modulePath, outputPath),
      {
        allowFailure: true,
        cwd: options.worktreePath,
        env: Object.fromEntries(
          options.resourceValues.map((resource) => [resource.env, resource.value])
        ),
        stdin,
        timeoutSeconds: options.command.timeoutSeconds
      }
    );
    if (result.timedOut === true) {
      throw resourceCommandFailure({
        command: options.command,
        kind: "timeout",
        stderr: result.stderr
      });
    }
    if (result.exitCode !== 0) {
      throw resourceCommandFailure({
        command: options.command,
        kind: `nonzero exit ${result.exitCode}`,
        stderr: result.stderr
      });
    }
    const returned = readResourceCommandRunnerOutput({
      command: options.command,
      outputPath,
      stderr: result.stderr,
      stdout: result.stdout
    });
    return {
      name: options.command.name,
      outputs: validateResourceCommandReturn(
        options.command,
        returned,
        result.stdout,
        result.stderr,
        options.stdin
      )
    };
  } finally {
    rmSync(outputDirectory, { force: true, recursive: true });
  }
}

function resolveResourceCommandRunner(worktreePath: string) {
  if (existsSync(path.join(worktreePath, "pnpm-lock.yaml"))) {
    return {
      args: (modulePath: string, outputPath: string) => [
        "exec",
        "bun",
        "--eval",
        RESOURCE_COMMAND_MODULE_RUNNER,
        "--",
        RESOURCE_COMMAND_RUNNER_ARGV,
        modulePath,
        outputPath
      ],
      command: "pnpm"
    };
  }

  return {
    args: (modulePath: string, outputPath: string) => [
      "--eval",
      RESOURCE_COMMAND_MODULE_RUNNER,
      "--",
      RESOURCE_COMMAND_RUNNER_ARGV,
      modulePath,
      outputPath
    ],
    command: "bun"
  };
}

function withResourceCommandLock<T>(
  home: string,
  sourceRoot: string,
  commandName: string,
  callback: () => Promise<T>
) {
  return withScopedLockAsync(
    home,
    `resource-command\u0000${sourceRoot}\u0000${commandName}`,
    callback
  );
}

function readResourceCommandRunnerOutput(options: {
  command: ResourceCommandConfig;
  outputPath: string;
  stderr: string;
  stdout: string;
}) {
  let outputText: string;
  try {
    outputText = readFileSync(options.outputPath, "utf-8");
  } catch {
    throw resourceCommandFailure({
      command: options.command,
      kind: "runner protocol violation",
      stderr: options.stderr,
      stdout: options.stdout
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    throw resourceCommandFailure({
      command: options.command,
      kind: "runner protocol violation",
      stderr: options.stderr,
      stdout: options.stdout
    });
  }

  const envelope = ResourceCommandRunnerEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    throw resourceCommandFailure({
      command: options.command,
      kind: "runner protocol violation",
      stderr: options.stderr,
      stdout: options.stdout
    });
  }

  return envelope.data.value;
}

function validateResourceCommandReturn(
  command: ResourceCommandConfig,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The command runner return crosses a process boundary and is parsed immediately below.
  returned: unknown,
  stdout: string,
  stderr: string,
  stdin: ResourceCommandInput
) {
  const parsed = ResourceCommandReturnSchema.safeParse(returned);
  if (!parsed.success) {
    throw resourceCommandFailure({
      command,
      kind: "return contract violation",
      stderr,
      stdout
    });
  }

  const value = parsed.data;
  const expected = new Set(command.outputs);
  const actual = Object.keys(value);
  const missing = command.outputs.filter((output) => !(output in value));
  const extra = actual.filter((output) => !expected.has(output));
  if (missing.length > 0 || extra.length > 0) {
    throw resourceCommandFailure({
      command,
      kind: "return contract violation",
      stderr,
      stdout
    });
  }

  return command.outputs.map((env) => {
    const outputValue = value[env];
    if (outputValue === undefined) {
      throw resourceCommandFailure({
        command,
        kind: `missing output for ${env}`,
        stderr,
        stdout
      });
    }
    if ((stdin[env] ?? []).includes(outputValue)) {
      throw resourceCommandFailure({
        command,
        kind: `same-output collision for ${env}`,
        stderr,
        stdout
      });
    }
    return { env, value: outputValue };
  });
}

function resolveResourceCommandRunPath(worktreePath: string, command: ResourceCommandConfig) {
  const resolved = path.resolve(worktreePath, command.run);
  const relative = path.relative(worktreePath, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new MonkeError(
      `Resource command ${command.name} run path must resolve inside ${worktreePath}: ${command.run}`
    );
  }
  return resolved;
}

function resourceCommandFailure(options: {
  command: ResourceCommandConfig;
  kind: string;
  stderr: string;
  stdout?: string;
}) {
  const stderr = options.stderr.trim() || "<empty>";
  const stdout =
    options.stdout === undefined ? "" : `\nstdout:\n${options.stdout.trim() || "<empty>"}`;
  return new MonkeError(
    `Resource command ${options.command.name} failed: ${options.command.run}\nkind: ${options.kind}\nstderr:\n${stderr}${stdout}`
  );
}

function toResourceCommandStates(
  declaredCommands: ResourceCommandConfig[],
  currentByName: Map<string, ResourceCommandState>
) {
  return declaredCommands.flatMap((command) => {
    const state = currentByName.get(command.name);
    return state ? [state] : [];
  });
}

function toImmediateResourceCommandStates(
  declaredCommands: ResourceCommandConfig[],
  currentByName: Map<string, ResourceCommandState>,
  existingCommands: ResourceCommandState[]
) {
  const existingByName = new Map(existingCommands.map((command) => [command.name, command]));
  const declaredNames = new Set(declaredCommands.map((command) => command.name));
  const declaredStates = declaredCommands.flatMap((command) => {
    const current = currentByName.get(command.name);
    const existing = existingByName.get(command.name);
    if (!current) {
      return existing ? [existing] : [];
    }

    const declaredEnvNames = new Set(command.outputs);
    const staleOutputs =
      existing?.outputs.filter((output) => !declaredEnvNames.has(output.env)) ?? [];
    return [
      {
        name: command.name,
        outputs: [...current.outputs, ...staleOutputs]
      }
    ];
  });
  return [
    ...declaredStates,
    ...existingCommands.filter((command) => !declaredNames.has(command.name))
  ];
}

function interpolateResourceLiteral(options: {
  literal: string;
  location: string;
  session: string;
  user: string;
}) {
  const value = options.literal.replaceAll(
    /\$\{(?<name>[^}]*)\}/gu,
    (placeholder, name: string) => {
      if (name === "session") {
        return options.session;
      }
      if (name === "user") {
        return options.user;
      }
      throw new MonkeError(
        `${options.location} contains unsupported placeholder ${placeholder}; supported placeholders are \${session} and \${user}`
      );
    }
  );

  if (value.includes("${")) {
    throw new MonkeError(
      `${options.location} contains an unsupported placeholder; supported placeholders are \${session} and \${user}`
    );
  }

  return value;
}

function resolveResourceUser(env: Record<string, string | undefined>) {
  for (const key of ["USER", "LOGNAME", "USERNAME"]) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return "unknown";
}

function rejectResourceValueCollisions(options: {
  rootSourceRoot: string;
  session: string;
  sourceRoot: string;
  store: SessionStateStore;
  values: ResourceValueState[];
}) {
  const collision = options.store.resourceValueCollision(options);
  if (collision) {
    throw new MonkeError(
      `Resource value collision for ${collision.env}=${describeRedactedValue(collision.value)} in ${options.sourceRoot}; retained session ${collision.session} already owns that value`
    );
  }
}

function dedupe(values: string[]) {
  return [...new Set(values)];
}
