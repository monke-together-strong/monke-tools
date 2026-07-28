import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as z from "zod";

import { resolveGitRepoRoot } from "./git.ts";
import { MonkeError } from "./errors.ts";
import type {
  AppConfig,
  ExternalMapping,
  ExternalRepoConfig,
  LocalMapping,
  RepoConfig,
  ResourceCommandConfig,
  ResourceValueConfig,
  ResolvedGraph,
  Runtime,
} from "./types.ts";
import { parseOwnedYamlText } from "./validation.ts";

const LABEL_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ENV_RE = /^[A-Z][A-Z0-9_]*$/u;
const PORT_RE = /^[A-Z][A-Z0-9_]*_PORT$/u;
const RUN_MODULE_EXTENSION_RE = /\.(?:[cm]?[jt]s|jsx|tsx)$/u;
const DEFAULT_ENV_FILE = ".env";
const DEFAULT_RESOURCE_COMMAND_TIMEOUT_SECONDS = 60;

const NonEmptyStringSchema = z
  .string({ error: "must be a non-empty string" })
  .refine((value) => value.trim().length > 0, { error: "must be a non-empty string" });
const EnvNameSchema = z
  .string({ error: "must be an uppercase env name" })
  .regex(ENV_RE, { error: "must be an uppercase env name" });
const PortNameSchema = z
  .string({ error: "must be an uppercase env name ending in _PORT" })
  .regex(PORT_RE, { error: "must be an uppercase env name ending in _PORT" });
const LabelSchema = z
  .string({ error: "must be a string" })
  .regex(LABEL_RE, { error: "must be lowercase alphanumeric plus hyphen" });

const LocalMappingSchema = z.strictObject({
  env: EnvNameSchema,
  port: PortNameSchema,
});
const AppSchema = z.strictObject({
  envFile: NonEmptyStringSchema.optional(),
  mappings: z.array(LocalMappingSchema, { error: "must be an array" }).default([]),
  path: NonEmptyStringSchema,
});
const ExternalMappingSchema = z.strictObject({
  app: LabelSchema,
  env: EnvNameSchema,
  port: PortNameSchema,
});
const ExternalRepoSchema = z.strictObject({
  mappings: z
    .array(ExternalMappingSchema, { error: "must be a non-empty array" })
    .min(1, { error: "must be a non-empty array" }),
  path: NonEmptyStringSchema,
  pathEnv: EnvNameSchema,
});
const ResourceCommandSchema = z.strictObject({
  outputs: z
    .array(EnvNameSchema, { error: "must be a non-empty array" })
    .min(1, { error: "must be a non-empty array" }),
  run: NonEmptyStringSchema,
  timeoutSeconds: z
    .number({ error: "must be a positive integer" })
    .int({ error: "must be a positive integer" })
    .positive({ error: "must be a positive integer" })
    .default(DEFAULT_RESOURCE_COMMAND_TIMEOUT_SECONDS),
});
const ResourceValuesSchema = z
  .record(EnvNameSchema, NonEmptyStringSchema)
  .refine((values) => Object.keys(values).length > 0, {
    error: "must declare at least one value",
  });
const ResourceCommandsSchema = z
  .record(LabelSchema, ResourceCommandSchema)
  .refine((commands) => Object.keys(commands).length > 0, {
    error: "must declare at least one command",
  });
const ResourcesSchema = z
  .strictObject({
    commands: ResourceCommandsSchema.optional(),
    values: ResourceValuesSchema.optional(),
  })
  .refine((resources) => resources.values !== undefined || resources.commands !== undefined, {
    error: "must contain values or commands",
  });
const RawRepoConfigSchema = z.strictObject({
  apps: z.record(LabelSchema, AppSchema, { error: "must contain an apps section" }),
  bootstrapCommand: NonEmptyStringSchema.optional(),
  cleanupCommand: NonEmptyStringSchema.optional(),
  external: z.record(LabelSchema, ExternalRepoSchema).optional(),
  resources: ResourcesSchema.optional(),
  seedPaths: z.array(NonEmptyStringSchema, { error: "must be an array" }).optional(),
});

type RawRepoConfig = z.output<typeof RawRepoConfigSchema>;
type RawResources = z.output<typeof ResourcesSchema>;

/** Alternate repo-content readers used when resolving a Session graph. */
export interface LoadResolvedGraphOptions {
  /** Read the repo's `monke.yml` content from a source other than the working tree. */
  readRepoConfig?: (sourceRoot: string) => string;
  /** Check whether a repo-relative path exists in the same content source as config. */
  pathExists?: (sourceRoot: string, relativePath: string) => boolean;
}

/** Load the resolved Session graph from repo configuration. */
export function loadResolvedGraph(
  runtime: Runtime,
  rootSourceRoot: string,
  options: LoadResolvedGraphOptions = {},
): ResolvedGraph {
  const readRepoConfig = options.readRepoConfig ?? readRepoConfigFromFilesystem;
  const pathExists = options.pathExists ?? pathExistsOnFilesystem;
  const configCache = new Map<string, RepoConfig>();
  const visiting = new Set<string>();
  const reposInOrder: RepoConfig[] = [];
  const visited = new Set<string>();

  function visit(sourceRoot: string): RepoConfig {
    const config = loadRepoConfig(runtime, sourceRoot, configCache, visiting, {
      pathExists,
      readRepoConfig,
    });

    if (visited.has(sourceRoot)) {
      return config;
    }

    visited.add(sourceRoot);
    for (const externalRepo of config.externalInOrder) {
      visit(externalRepo.absoluteRepoRoot);
    }
    reposInOrder.push(config);
    return config;
  }

  visit(rootSourceRoot);

  const ownerByPortKey = new Map<string, string>();
  for (const repo of reposInOrder) {
    for (const portKey of repo.localPortOrder) {
      const existingOwner = ownerByPortKey.get(portKey);
      if (existingOwner !== undefined && existingOwner !== repo.sourceRoot) {
        throw new MonkeError(
          `Port key ${portKey} is owned by both ${existingOwner} and ${repo.sourceRoot}`,
        );
      }
      ownerByPortKey.set(portKey, repo.sourceRoot);
    }
  }

  return {
    reposByRoot: new Map(reposInOrder.map((repo) => [repo.sourceRoot, repo])),
    reposInMaterializationOrder: reposInOrder,
    rootSourceRoot,
  };
}

function loadRepoConfig(
  runtime: Runtime,
  sourceRoot: string,
  cache: Map<string, RepoConfig>,
  visiting: Set<string>,
  options: Required<LoadResolvedGraphOptions>,
): RepoConfig {
  if (visiting.has(sourceRoot)) {
    throw new MonkeError(`Dependency cycles are not supported: ${sourceRoot}`);
  }

  const cached = cache.get(sourceRoot);
  if (cached) {
    return cached;
  }

  visiting.add(sourceRoot);
  try {
    const configPath = path.join(sourceRoot, "monke.yml");
    const configText = options.readRepoConfig(sourceRoot);

    const rawConfig = parseOwnedYamlText(configText, configPath, RawRepoConfigSchema);
    const repoConfig = parseRepoConfigObject(runtime, sourceRoot, configPath, rawConfig, options);

    for (const externalRepo of repoConfig.externalInOrder) {
      const dependency = loadRepoConfig(
        runtime,
        externalRepo.absoluteRepoRoot,
        cache,
        visiting,
        options,
      );
      const dependencyLocalPorts = new Set(dependency.localPortOrder);

      for (const mapping of externalRepo.mappings) {
        if (!dependencyLocalPorts.has(mapping.portKey)) {
          throw new MonkeError(
            `External mapping ${mapping.portKey} in ${configPath} is not owned locally by ${externalRepo.absoluteRepoRoot}`,
          );
        }
      }
    }

    cache.set(sourceRoot, repoConfig);
    return repoConfig;
  } finally {
    visiting.delete(sourceRoot);
  }
}

function parseRepoConfigObject(
  runtime: Runtime,
  sourceRoot: string,
  configPath: string,
  config: RawRepoConfig,
  options: Required<LoadResolvedGraphOptions>,
): RepoConfig {
  const { bootstrapCommand } = config;
  const { cleanupCommand } = config;
  const seedPaths = parseSeedPaths(config.seedPaths, sourceRoot, configPath);
  const { resourceValuesInOrder, resourceCommandsInOrder } = parseResources(
    config.resources,
    configPath,
  );

  const appsByLabel = new Map<string, AppConfig>();
  const appsInOrder: AppConfig[] = [];
  const localPortOrder: string[] = [];
  const localMappingsByPort = new Map<string, LocalMapping[]>();
  const claimedTargets = new Map<string, string>();

  for (const [label, rawApp] of Object.entries(config.apps)) {
    const relativePath = rawApp.path;
    const relativeEnvFile = rawApp.envFile ?? DEFAULT_ENV_FILE;
    const absoluteAppPath = resolveInside(
      sourceRoot,
      relativePath,
      `${configPath}#apps.${label}.path`,
    );
    const absoluteEnvFilePath = resolveInside(
      absoluteAppPath,
      relativeEnvFile,
      `${configPath}#apps.${label}.envFile`,
    );

    if (normalize(absoluteEnvFilePath) === normalize(absoluteAppPath)) {
      throw new MonkeError(`App ${label} envFile must point to a file inside the app path`);
    }

    if (!options.pathExists(sourceRoot, path.relative(sourceRoot, absoluteAppPath))) {
      throw new MonkeError(`App path does not exist: ${absoluteAppPath}`);
    }

    const localMappings: LocalMapping[] = [];
    for (const rawMapping of rawApp.mappings) {
      const portKey = rawMapping.port;
      const targetEnv = rawMapping.env;
      const targetKey = `${label}\u0000${targetEnv}`;
      if (claimedTargets.has(targetKey)) {
        throw new MonkeError(`Duplicate rewrite target ${label}.${targetEnv} in ${configPath}`);
      }
      claimedTargets.set(targetKey, portKey);

      const existingMappings = localMappingsByPort.get(portKey);
      if (!existingMappings) {
        localPortOrder.push(portKey);
        localMappingsByPort.set(portKey, []);
      }

      const localMapping: LocalMapping = { portKey, targetApp: label, targetEnv };
      localMappings.push(localMapping);
      localMappingsByPort.get(portKey)?.push(localMapping);
    }

    const appConfig: AppConfig = {
      absoluteAppPath,
      label,
      localMappings,
      relativeEnvFile,
      relativePath,
    };

    appsByLabel.set(label, appConfig);
    appsInOrder.push(appConfig);
  }

  const externalInOrder: ExternalRepoConfig[] = [];
  const externalMappingsInOrder: ExternalMapping[] = [];
  const externalTargetApps = new Set<string>();
  const externalPathEnvOwners = new Map<string, string>();

  for (const [label, rawExternal] of Object.entries(config.external ?? {})) {
    const relativePath = rawExternal.path;
    const { pathEnv } = rawExternal;
    const existingPathEnvOwner = externalPathEnvOwners.get(pathEnv);
    if (existingPathEnvOwner !== undefined) {
      throw new MonkeError(
        `Duplicate external pathEnv ${pathEnv} in ${configPath} for ${existingPathEnvOwner} and ${label}`,
      );
    }
    externalPathEnvOwners.set(pathEnv, label);
    const absoluteRepoRoot = path.resolve(sourceRoot, relativePath);
    const resolvedRepoRoot = resolveGitRepoRoot(runtime, absoluteRepoRoot);
    if (normalize(resolvedRepoRoot) !== normalize(absoluteRepoRoot)) {
      throw new MonkeError(
        `External dependency ${label} must point to the dependency repo root exactly: ${absoluteRepoRoot}`,
      );
    }

    if (!options.pathExists(absoluteRepoRoot, "monke.yml")) {
      throw new MonkeError(
        `External dependency ${label} is missing monke.yml at ${absoluteRepoRoot}`,
      );
    }

    const mappings: ExternalMapping[] = [];
    for (const rawMapping of rawExternal.mappings) {
      const portKey = rawMapping.port;
      const targetApp = rawMapping.app;
      const targetEnv = rawMapping.env;

      if (!appsByLabel.has(targetApp)) {
        throw new MonkeError(`External mapping for ${label} targets unknown app ${targetApp}`);
      }

      const targetKey = `${targetApp}\u0000${targetEnv}`;
      if (claimedTargets.has(targetKey)) {
        throw new MonkeError(`Duplicate rewrite target ${targetApp}.${targetEnv} in ${configPath}`);
      }
      claimedTargets.set(targetKey, `${label}:${portKey}`);
      externalTargetApps.add(targetApp);

      const externalMapping: ExternalMapping = {
        dependencyLabel: label,
        dependencyRoot: absoluteRepoRoot,
        portKey,
        targetApp,
        targetEnv,
      };
      mappings.push(externalMapping);
      externalMappingsInOrder.push(externalMapping);
    }

    externalInOrder.push({
      absoluteRepoRoot,
      label,
      mappings,
      pathEnv,
      relativePath,
    });
  }

  for (const app of appsInOrder) {
    if (app.localMappings.length === 0 && !externalTargetApps.has(app.label)) {
      throw new MonkeError(
        `App ${app.label} owns no local ports and is not targeted by any external mapping`,
      );
    }
  }

  return {
    appsByLabel,
    appsInOrder,
    bootstrapCommand,
    cleanupCommand,
    configPath,
    externalInOrder,
    externalMappingsInOrder,
    externalTargetApps,
    localMappingsByPort,
    localPortOrder,
    resourceCommandsInOrder,
    resourceValuesInOrder,
    seedPaths,
    sourceRoot,
  };
}

function readRepoConfigFromFilesystem(sourceRoot: string): string {
  const configPath = path.join(sourceRoot, "monke.yml");
  if (!existsSync(configPath)) {
    throw new MonkeError(`Expected monke.yml at ${configPath}`);
  }
  return readFileSync(configPath, "utf-8");
}

function pathExistsOnFilesystem(sourceRoot: string, relativePath: string): boolean {
  return existsSync(path.join(sourceRoot, relativePath));
}

function resolveInside(root: string, relativePath: string, location: string): string {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new MonkeError(`${location} must resolve inside ${root}`);
  }
  return resolved;
}

function normalize(targetPath: string): string {
  return path.normalize(targetPath);
}

function parseSeedPaths(
  rawSeedPaths: string[] | undefined,
  sourceRoot: string,
  configPath: string,
): string[] {
  if (rawSeedPaths === undefined) {
    return [];
  }

  const seedPaths: string[] = [];
  const seen = new Map<string, string>();

  for (const [index, relativePath] of rawSeedPaths.entries()) {
    const absolutePath = resolveInside(
      sourceRoot,
      relativePath,
      `${configPath}#seedPaths[${index}]`,
    );
    const normalizedPath = normalize(absolutePath);
    if (relativePath === "." || normalizedPath === normalize(sourceRoot)) {
      throw new MonkeError(
        `${configPath}#seedPaths[${index}] cannot point at the repo root; seedPath "." is not allowed`,
      );
    }

    const existing = seen.get(normalizedPath);
    if (existing !== undefined) {
      throw new MonkeError(
        `Duplicate seedPath ${relativePath} in ${configPath}; already declared as ${existing}`,
      );
    }

    seen.set(normalizedPath, relativePath);
    seedPaths.push(path.relative(sourceRoot, absolutePath) || ".");
  }

  return seedPaths;
}

function parseResources(
  resources: RawResources | undefined,
  configPath: string,
): {
  resourceValuesInOrder: ResourceValueConfig[];
  resourceCommandsInOrder: ResourceCommandConfig[];
} {
  if (resources === undefined) {
    return { resourceCommandsInOrder: [], resourceValuesInOrder: [] };
  }

  const seenEnvNames = new Set<string>();

  const resourceValuesInOrder: ResourceValueConfig[] = [];
  if (resources.values !== undefined) {
    for (const [env, literal] of Object.entries(resources.values)) {
      claimResourceEnvName(seenEnvNames, env, configPath);
      resourceValuesInOrder.push({
        env,
        literal: requireResourceLiteral(literal, `${configPath}#resources.values.${env}`),
      });
    }
  }

  const resourceCommandsInOrder: ResourceCommandConfig[] = [];
  if (resources.commands !== undefined) {
    for (const [name, commandValue] of Object.entries(resources.commands)) {
      const outputs = requireResourceCommandOutputs(
        commandValue.outputs,
        `${configPath}#resources.commands.${name}.outputs`,
        seenEnvNames,
        configPath,
      );
      resourceCommandsInOrder.push({
        name,
        outputs,
        run: requireResourceCommandRunPath(
          commandValue.run,
          `${configPath}#resources.commands.${name}.run`,
        ),
        timeoutSeconds: commandValue.timeoutSeconds,
      });
    }
  }

  return { resourceCommandsInOrder, resourceValuesInOrder };
}

function claimResourceEnvName(seenEnvNames: Set<string>, env: string, configPath: string): void {
  if (seenEnvNames.has(env)) {
    throw new MonkeError(`Duplicate resource env name ${env} in ${configPath}`);
  }
  seenEnvNames.add(env);
}

function requireResourceCommandOutputs(
  value: string[],
  location: string,
  seenEnvNames: Set<string>,
  configPath: string,
): string[] {
  const outputs: string[] = [];
  const seenOutputs = new Set<string>();
  for (const env of value) {
    if (seenOutputs.has(env)) {
      throw new MonkeError(`Duplicate resource command output ${env} at ${location}`);
    }
    seenOutputs.add(env);
    claimResourceEnvName(seenEnvNames, env, configPath);
    outputs.push(env);
  }
  return outputs;
}

function requireResourceCommandRunPath(relativePath: string, location: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new MonkeError(`${location} must be a relative JS/TS module path`);
  }

  const normalizedPath = path.normalize(relativePath);
  if (
    normalizedPath === "." ||
    normalizedPath.startsWith(`..${path.sep}`) ||
    normalizedPath === ".." ||
    path.isAbsolute(normalizedPath)
  ) {
    throw new MonkeError(`${location} must resolve inside the session worktree`);
  }

  if (!RUN_MODULE_EXTENSION_RE.test(normalizedPath)) {
    throw new MonkeError(`${location} must be a relative JS/TS module path`);
  }

  return normalizedPath;
}

function requireResourceLiteral(literal: string, location: string): string {
  for (const match of literal.matchAll(/\$\{(?<placeholder>[^}]*)\}/gu)) {
    const placeholder = match.groups?.placeholder ?? "";
    if (placeholder !== "session" && placeholder !== "user") {
      throw new MonkeError(
        `${location} contains unsupported placeholder \${${placeholder}}; supported placeholders are \${session} and \${user}`,
      );
    }
  }

  if (literal.replaceAll(/\$\{(?:session|user)\}/gu, "").includes("${")) {
    throw new MonkeError(
      `${location} contains an unsupported placeholder; supported placeholders are \${session} and \${user}`,
    );
  }

  return literal;
}
