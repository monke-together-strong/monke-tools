import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as z from "zod";

import { describeRedactedValue } from "./env.ts";
import { MonkeError } from "./errors.ts";
import { withScopedLockAsync } from "./runtime.ts";
import { listSessionStates } from "./session-state-store.ts";
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
const ResourceCommandRunnerEnvelopeSchema = z.strictObject({ value: z.unknown() });
const ResourceCommandReturnSchema = z.record(
  z.string(),
  z.string().refine((value) => value.trim().length > 0)
);

const RESOURCE_COMMAND_MODULE_RUNNER = [
  'import { pathToFileURL } from "node:url";',
  "",
  "const runnerArgv = process.argv[1];",
  "const modulePath = process.argv[2];",
  "const outputPath = process.argv[3];",
  "",
  "function fail(message) {",
  "  console.error(message);",
  "  process.exit(1);",
  "}",
  "",
  "try {",
  `  if (runnerArgv !== ${JSON.stringify(RESOURCE_COMMAND_RUNNER_ARGV)} || !modulePath || !outputPath) {`,
  '    fail("Missing resource command runner arguments");',
  "  }",
  "  const previousText = await Bun.stdin.text();",
  "  const previous = previousText.trim() ? JSON.parse(previousText) : {};",
  "  const resourceModule = await import(pathToFileURL(modulePath).href);",
  '  if (!Object.prototype.hasOwnProperty.call(resourceModule, "default")) {',
  // This is a template literal in the generated runner, not in this source module.
  // oxlint-disable-next-line no-template-curly-in-string
  "    fail(`Resource command module ${modulePath} must export a default function`);",
  "  }",
  '  if (typeof resourceModule.default !== "function") {',
  // This is a template literal in the generated runner, not in this source module.
  // oxlint-disable-next-line no-template-curly-in-string
  "    fail(`Resource command module ${modulePath} default export must be a function`);",
  "  }",
  "  const value = await resourceModule.default({ previous });",
  "  await Bun.write(outputPath, JSON.stringify({ value }));",
  "} catch (error) {",
  "  console.error(error instanceof Error && error.stack ? error.stack : String(error));",
  "  process.exit(1);",
  "}"
].join("\n");

/** Resolve, reuse, prune, and collision-check deterministic Resource values. */
export function resolveResourceValues(options: {
  env: Record<string, string | undefined>;
  existingRepoState: SessionRepoState | undefined;
  home: string;
  repoConfig: RepoConfig;
  rootSourceRoot: string;
  session: string;
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
    home: options.home,
    rootSourceRoot: options.rootSourceRoot,
    session: options.session,
    sourceRoot: options.repoConfig.sourceRoot,
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
  home: string;
  onCommandExecutionStarting?: (commands: ResourceCommandState[]) => void;
  onResolvedCommandOutputs: (commands: ResourceCommandState[]) => void;
  repoConfig: RepoConfig;
  resourceValues: ResourceValueState[];
  runtime: Runtime;
  session: string;
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
      options.home,
      options.repoConfig.sourceRoot,
      command.name,
      async () => {
        const stdin = buildResourceCommandInput({
          command,
          home: options.home,
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

function buildResourceCommandInput(options: {
  command: ResourceCommandConfig;
  home: string;
  session: string;
  sourceRoot: string;
}) {
  const valuesByEnv = new Map(options.command.outputs.map((env) => [env, new Set<string>()]));

  for (const state of listSessionStates(options.home)) {
    if (state.session === options.session) {
      continue;
    }

    for (const repoState of state.repos) {
      if (repoState.sourceRoot !== options.sourceRoot) {
        continue;
      }

      const rememberedCommand = (repoState.resourceCommandOutputs ?? []).find(
        (command) => command.name === options.command.name
      );
      if (!rememberedCommand) {
        continue;
      }

      const rememberedByEnv = new Map(
        rememberedCommand.outputs.map((output) => [output.env, output.value])
      );
      for (const env of options.command.outputs) {
        const remembered = rememberedByEnv.get(env);
        if (remembered !== undefined && remembered.trim() !== "") {
          valuesByEnv.get(env)?.add(remembered);
        }
      }
    }
  }

  return Object.fromEntries(
    options.command.outputs.map((env) => [env, [...(valuesByEnv.get(env) ?? [])].toSorted()])
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
  home: string;
  rootSourceRoot: string;
  session: string;
  sourceRoot: string;
  values: ResourceValueState[];
}) {
  for (const state of listSessionStates(options.home)) {
    if (state.rootSourceRoot === options.rootSourceRoot && state.session === options.session) {
      continue;
    }

    for (const repoState of state.repos) {
      if (repoState.sourceRoot !== options.sourceRoot) {
        continue;
      }

      const rememberedValues = new Map(
        (repoState.resourceValues ?? []).map((resource) => [resource.env, resource.value])
      );
      for (const value of options.values) {
        if (rememberedValues.get(value.env) !== value.value) {
          continue;
        }

        throw new MonkeError(
          `Resource value collision for ${value.env}=${describeRedactedValue(value.value)} in ${options.sourceRoot}; retained session ${state.session} already owns that value`
        );
      }
    }
  }
}

function dedupe(values: string[]) {
  return [...new Set(values)];
}
