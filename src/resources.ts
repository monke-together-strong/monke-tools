import { MonkeError } from "./errors.ts";
import { listSessionStates } from "./registry.ts";
import { withScopedLock } from "./runtime.ts";
import type {
  RepoConfig,
  ResourceCommandConfig,
  ResourceCommandState,
  ResourceValueState,
  Runtime,
  SessionRepoState,
} from "./types.ts";

/** Result of resolving deterministic Resource values for one repo/session pair. */
export interface ResolvedResourceValues {
  /** Declared Resource values to persist and write to the session root .env. */
  values: ResourceValueState[];
  /** Previously remembered Resource env names no longer declared by the repo. */
  removedEnvNames: string[];
}

/** Result of resolving Resource command outputs for one repo/session pair. */
export interface ResolvedResourceCommands {
  /** Declared Resource command outputs to persist and write to the session root .env. */
  commands: ResourceCommandState[];
  /** Previously remembered Resource command env names no longer declared by the repo. */
  removedEnvNames: string[];
}

type ResourceCommandInput = Record<string, string[]>;

/** Resolve, reuse, prune, and collision-check deterministic Resource values. */
export function resolveResourceValues(options: {
  home: string;
  rootSourceRoot: string;
  session: string;
  repoConfig: RepoConfig;
  existingRepoState: SessionRepoState | undefined;
  env: Record<string, string | undefined>;
}): ResolvedResourceValues {
  const declaredEnvNames = new Set(
    options.repoConfig.resourceValuesInOrder.map((resource) => resource.env),
  );
  const existingValues = options.existingRepoState?.resourceValues ?? [];
  const rememberedValues = new Map(
    existingValues
      .filter((resource) => declaredEnvNames.has(resource.env) && resource.value.trim())
      .map((resource) => [resource.env, resource.value]),
  );

  const values = options.repoConfig.resourceValuesInOrder.map((resource) => {
    const remembered = rememberedValues.get(resource.env);
    const value =
      remembered ??
      interpolateResourceLiteral({
        literal: resource.literal,
        session: options.session,
        user: resolveResourceUser(options.env),
        location: `${options.repoConfig.configPath}#resources.values.${resource.env}`,
      });

    if (!value.trim()) {
      throw new MonkeError(
        `${options.repoConfig.configPath}#resources.values.${resource.env} resolved to an empty value`,
      );
    }

    return {
      env: resource.env,
      value,
    };
  });

  rejectResourceValueCollisions({
    home: options.home,
    rootSourceRoot: options.rootSourceRoot,
    session: options.session,
    sourceRoot: options.repoConfig.sourceRoot,
    values,
  });

  return {
    values,
    removedEnvNames: dedupe(
      existingValues.map((resource) => resource.env).filter((env) => !declaredEnvNames.has(env)),
    ),
  };
}

/** Resolve, reuse, prune, execute, and validate Resource command outputs. */
export function resolveResourceCommands(options: {
  runtime: Runtime;
  home: string;
  session: string;
  repoConfig: RepoConfig;
  existingRepoState: SessionRepoState | undefined;
  worktreePath: string;
  resourceValues: ResourceValueState[];
  onResolvedCommandOutputs: (commands: ResourceCommandState[]) => void;
}): ResolvedResourceCommands {
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

    withResourceCommandLock(options.home, options.repoConfig.sourceRoot, command.name, () => {
      const stdin = buildResourceCommandInput({
        home: options.home,
        session: options.session,
        sourceRoot: options.repoConfig.sourceRoot,
        command,
      });

      currentByName.set(
        command.name,
        runResourceCommand({
          runtime: options.runtime,
          command,
          worktreePath: options.worktreePath,
          stdin,
          resourceValues: options.resourceValues,
        }),
      );
      options.onResolvedCommandOutputs(
        toImmediateResourceCommandStates(
          options.repoConfig.resourceCommandsInOrder,
          currentByName,
          existingCommands,
        ),
      );
    });
  }

  const commands = toResourceCommandStates(
    options.repoConfig.resourceCommandsInOrder,
    currentByName,
  );
  const finalEnvNames = new Set(
    commands.flatMap((command) => command.outputs.map((output) => output.env)),
  );
  const removedEnvNames = dedupe(
    existingCommands
      .flatMap((command) => command.outputs.map((output) => output.env))
      .filter((env) => !finalEnvNames.has(env)),
  );

  return { commands, removedEnvNames };
}

function getReusableResourceCommand(
  command: ResourceCommandConfig,
  existing: ResourceCommandState | undefined,
): ResourceCommandState | null {
  if (!existing) {
    return null;
  }

  const rememberedByEnv = new Map(existing.outputs.map((output) => [output.env, output.value]));
  const outputs: Array<{ env: string; value: string }> = [];
  for (const env of command.outputs) {
    const value = rememberedByEnv.get(env);
    if (!value?.trim()) {
      return null;
    }
    outputs.push({ env, value });
  }

  return {
    name: command.name,
    outputs,
  };
}

function runResourceCommand(options: {
  runtime: Runtime;
  command: ResourceCommandConfig;
  worktreePath: string;
  stdin: ResourceCommandInput;
  resourceValues: ResourceValueState[];
}): ResourceCommandState {
  const stdin = JSON.stringify(options.stdin);
  const result = options.runtime.exec("sh", ["-lc", options.command.command], {
    cwd: options.worktreePath,
    env: Object.fromEntries(
      options.resourceValues.map((resource) => [resource.env, resource.value]),
    ),
    stdin,
    timeoutSeconds: options.command.timeoutSeconds,
    allowFailure: true,
  });

  if (result.timedOut) {
    throw resourceCommandFailure({
      command: options.command,
      kind: "timeout",
      stderr: result.stderr,
    });
  }

  if (result.exitCode !== 0) {
    throw resourceCommandFailure({
      command: options.command,
      kind: `nonzero exit ${result.exitCode}`,
      stderr: result.stderr,
    });
  }

  const outputs = validateResourceCommandStdout(
    options.command,
    result.stdout,
    result.stderr,
    options.stdin,
  );
  return {
    name: options.command.name,
    outputs,
  };
}

function withResourceCommandLock<T>(
  home: string,
  sourceRoot: string,
  commandName: string,
  callback: () => T,
): T {
  return withScopedLock(home, `resource-command\u0000${sourceRoot}\u0000${commandName}`, callback);
}

function buildResourceCommandInput(options: {
  home: string;
  session: string;
  sourceRoot: string;
  command: ResourceCommandConfig;
}): ResourceCommandInput {
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
        (command) => command.name === options.command.name,
      );
      if (!rememberedCommand) {
        continue;
      }

      const rememberedByEnv = new Map(
        rememberedCommand.outputs.map((output) => [output.env, output.value]),
      );
      for (const env of options.command.outputs) {
        const remembered = rememberedByEnv.get(env);
        if (remembered?.trim()) {
          valuesByEnv.get(env)?.add(remembered);
        }
      }
    }
  }

  return Object.fromEntries(
    options.command.outputs.map((env) => [env, [...(valuesByEnv.get(env) ?? [])].sort()]),
  );
}

function validateResourceCommandStdout(
  command: ResourceCommandConfig,
  stdout: string,
  stderr: string,
  stdin: ResourceCommandInput,
): Array<{ env: string; value: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw resourceCommandFailure({
      command,
      kind: "invalid stdout JSON",
      stderr,
      stdout,
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw resourceCommandFailure({
      command,
      kind: "stdout contract violation",
      stderr,
      stdout,
    });
  }

  const value = parsed as Record<string, unknown>;
  const expected = new Set(command.outputs);
  const actual = Object.keys(value);
  const missing = command.outputs.filter((output) => !(output in value));
  const extra = actual.filter((output) => !expected.has(output));
  if (missing.length > 0 || extra.length > 0) {
    throw resourceCommandFailure({
      command,
      kind: "stdout contract violation",
      stderr,
      stdout,
    });
  }

  return command.outputs.map((env) => {
    const outputValue = value[env];
    if (typeof outputValue !== "string" || !outputValue.trim()) {
      throw resourceCommandFailure({
        command,
        kind: "stdout contract violation",
        stderr,
        stdout,
      });
    }
    if ((stdin[env] ?? []).includes(outputValue)) {
      throw resourceCommandFailure({
        command,
        kind: `same-output collision for ${env}`,
        stderr,
        stdout,
      });
    }
    return { env, value: outputValue };
  });
}

function resourceCommandFailure(options: {
  command: ResourceCommandConfig;
  kind: string;
  stderr: string;
  stdout?: string;
}): MonkeError {
  const stderr = options.stderr.trim() || "<empty>";
  const stdout =
    options.stdout === undefined ? "" : `\nstdout:\n${options.stdout.trim() || "<empty>"}`;
  return new MonkeError(
    `Resource command ${options.command.name} failed: ${options.command.command}\nkind: ${options.kind}\nstderr:\n${stderr}${stdout}`,
  );
}

function toResourceCommandStates(
  declaredCommands: ResourceCommandConfig[],
  currentByName: Map<string, ResourceCommandState>,
): ResourceCommandState[] {
  return declaredCommands.flatMap((command) => {
    const state = currentByName.get(command.name);
    return state ? [state] : [];
  });
}

function toImmediateResourceCommandStates(
  declaredCommands: ResourceCommandConfig[],
  currentByName: Map<string, ResourceCommandState>,
  existingCommands: ResourceCommandState[],
): ResourceCommandState[] {
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
        outputs: [...current.outputs, ...staleOutputs],
      },
    ];
  });
  return [
    ...declaredStates,
    ...existingCommands.filter((command) => !declaredNames.has(command.name)),
  ];
}

function interpolateResourceLiteral(options: {
  literal: string;
  session: string;
  user: string;
  location: string;
}): string {
  const value = options.literal.replace(/\$\{([^}]*)\}/g, (placeholder, name: string) => {
    if (name === "session") {
      return options.session;
    }
    if (name === "user") {
      return options.user;
    }
    throw new MonkeError(
      `${options.location} contains unsupported placeholder ${placeholder}; supported placeholders are \${session} and \${user}`,
    );
  });

  if (value.includes("${")) {
    throw new MonkeError(
      `${options.location} contains an unsupported placeholder; supported placeholders are \${session} and \${user}`,
    );
  }

  return value;
}

function resolveResourceUser(env: Record<string, string | undefined>): string {
  return env.USER?.trim() || env.LOGNAME?.trim() || env.USERNAME?.trim() || "unknown";
}

function rejectResourceValueCollisions(options: {
  home: string;
  rootSourceRoot: string;
  session: string;
  sourceRoot: string;
  values: ResourceValueState[];
}): void {
  for (const state of listSessionStates(options.home)) {
    if (state.rootSourceRoot === options.rootSourceRoot && state.session === options.session) {
      continue;
    }

    for (const repoState of state.repos) {
      if (repoState.sourceRoot !== options.sourceRoot) {
        continue;
      }

      const rememberedValues = new Map(
        (repoState.resourceValues ?? []).map((resource) => [resource.env, resource.value]),
      );
      for (const value of options.values) {
        if (rememberedValues.get(value.env) !== value.value) {
          continue;
        }

        throw new MonkeError(
          `Resource value collision for ${value.env}=${value.value} in ${options.sourceRoot}; retained session ${state.session} already owns that value`,
        );
      }
    }
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
