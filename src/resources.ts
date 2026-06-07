import { MonkeError } from "./errors.ts";
import { listSessionStates } from "./registry.ts";
import type { RepoConfig, ResourceValueState, SessionRepoState } from "./types.ts";

/** Result of resolving deterministic Resource values for one repo/session pair. */
export interface ResolvedResourceValues {
  /** Declared Resource values to persist and write to the session root .env. */
  values: ResourceValueState[];
  /** Previously remembered Resource env names no longer declared by the repo. */
  removedEnvNames: string[];
}

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
