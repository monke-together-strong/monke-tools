import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";

import { resolveGitRepoRoot } from "./git.ts";
import { MonkeError } from "./errors.ts";
import type {
  AppConfig,
  ExternalMapping,
  ExternalRepoConfig,
  LocalMapping,
  RepoConfig,
  ResolvedGraph,
  Runtime,
} from "./types.ts";

const LABEL_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENV_RE = /^[A-Z][A-Z0-9_]*$/;
const PORT_RE = /^[A-Z][A-Z0-9_]*_PORT$/;

export function loadResolvedGraph(runtime: Runtime, rootSourceRoot: string): ResolvedGraph {
  const configCache = new Map<string, RepoConfig>();
  const visiting = new Set<string>();
  const reposInOrder: RepoConfig[] = [];
  const visited = new Set<string>();

  function visit(sourceRoot: string): RepoConfig {
    const config = loadRepoConfig(runtime, sourceRoot, configCache, visiting);

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
      if (existingOwner && existingOwner !== repo.sourceRoot) {
        throw new MonkeError(
          `Port key ${portKey} is owned by both ${existingOwner} and ${repo.sourceRoot}`,
        );
      }
      ownerByPortKey.set(portKey, repo.sourceRoot);
    }
  }

  return {
    rootSourceRoot,
    reposInMaterializationOrder: reposInOrder,
    reposByRoot: new Map(reposInOrder.map((repo) => [repo.sourceRoot, repo])),
  };
}

function loadRepoConfig(
  runtime: Runtime,
  sourceRoot: string,
  cache: Map<string, RepoConfig>,
  visiting: Set<string>,
): RepoConfig {
  const cached = cache.get(sourceRoot);
  if (cached) {
    return cached;
  }

  if (visiting.has(sourceRoot)) {
    throw new MonkeError(`Dependency cycles are not supported: ${sourceRoot}`);
  }

  visiting.add(sourceRoot);
  const configPath = path.join(sourceRoot, "monke.yml");
  if (!existsSync(configPath)) {
    throw new MonkeError(`Expected monke.yml at ${configPath}`);
  }

  const document = parseDocument(readFileSync(configPath, "utf8"), {
    uniqueKeys: true,
    merge: false,
    strict: true,
  });

  if (document.errors.length > 0) {
    const message = document.errors.map((error) => error.message).join("\n");
    throw new MonkeError(`Invalid ${configPath}:\n${message}`);
  }

  const rawConfig = document.toJS() as unknown;
  const repoConfig = parseRepoConfigObject(runtime, sourceRoot, configPath, rawConfig);
  cache.set(sourceRoot, repoConfig);

  for (const externalRepo of repoConfig.externalInOrder) {
    const dependency = loadRepoConfig(runtime, externalRepo.absoluteRepoRoot, cache, visiting);
    const dependencyLocalPorts = new Set(dependency.localPortOrder);

    for (const mapping of externalRepo.mappings) {
      if (!dependencyLocalPorts.has(mapping.portKey)) {
        throw new MonkeError(
          `External mapping ${mapping.portKey} in ${configPath} is not owned locally by ${externalRepo.absoluteRepoRoot}`,
        );
      }
    }
  }

  visiting.delete(sourceRoot);
  return repoConfig;
}

function parseRepoConfigObject(
  runtime: Runtime,
  sourceRoot: string,
  configPath: string,
  rawConfig: unknown,
): RepoConfig {
  const config = asRecord(rawConfig, configPath);
  assertKnownKeys(config, ["apps", "external"], configPath);

  const rawApps = config.apps;
  if (!rawApps) {
    throw new MonkeError(`${configPath} must contain an apps section`);
  }

  const appsRecord = asRecord(rawApps, `${configPath}#apps`);
  const appsByLabel = new Map<string, AppConfig>();
  const appsInOrder: AppConfig[] = [];
  const localPortOrder: string[] = [];
  const localMappingsByPort = new Map<string, LocalMapping[]>();
  const claimedTargets = new Map<string, string>();

  for (const [label, rawApp] of Object.entries(appsRecord)) {
    validateLabel(label, `${configPath}#apps`);
    const appValue = asRecord(rawApp, `${configPath}#apps.${label}`);
    assertKnownKeys(appValue, ["path", "envFile", "mappings"], `${configPath}#apps.${label}`);

    const relativePath = requireString(appValue.path, `${configPath}#apps.${label}.path`);
    const relativeEnvFile = requireString(appValue.envFile, `${configPath}#apps.${label}.envFile`);
    const absoluteAppPath = resolveInside(
      sourceRoot,
      relativePath,
      `${configPath}#apps.${label}.path`,
    );

    if (normalize(absoluteAppPath) === normalize(sourceRoot)) {
      throw new MonkeError(`App ${label} cannot point at the repo root`);
    }

    if (!existsSync(absoluteAppPath)) {
      throw new MonkeError(`App path does not exist: ${absoluteAppPath}`);
    }

    const rawMappings = appValue.mappings ?? [];
    if (!Array.isArray(rawMappings)) {
      throw new MonkeError(`${configPath}#apps.${label}.mappings must be an array`);
    }

    const localMappings: LocalMapping[] = [];
    for (const [index, rawMapping] of rawMappings.entries()) {
      const mapping = asRecord(rawMapping, `${configPath}#apps.${label}.mappings[${index}]`);
      assertKnownKeys(mapping, ["port", "env"], `${configPath}#apps.${label}.mappings[${index}]`);

      const portKey = requirePortName(
        mapping.port,
        `${configPath}#apps.${label}.mappings[${index}].port`,
      );
      const targetEnv = requireEnvName(
        mapping.env,
        `${configPath}#apps.${label}.mappings[${index}].env`,
      );
      const targetKey = `${label}\u0000${targetEnv}`;
      if (claimedTargets.has(targetKey)) {
        throw new MonkeError(`Duplicate rewrite target ${label}.${targetEnv} in ${configPath}`);
      }
      claimedTargets.set(targetKey, portKey);

      if (!localMappingsByPort.has(portKey)) {
        localPortOrder.push(portKey);
        localMappingsByPort.set(portKey, []);
      }

      const localMapping: LocalMapping = { targetApp: label, targetEnv, portKey };
      localMappings.push(localMapping);
      localMappingsByPort.get(portKey)?.push(localMapping);
    }

    const appConfig: AppConfig = {
      label,
      relativePath,
      relativeEnvFile,
      absoluteAppPath,
      localMappings,
    };

    appsByLabel.set(label, appConfig);
    appsInOrder.push(appConfig);
  }

  const externalRecord = config.external ? asRecord(config.external, `${configPath}#external`) : {};
  const externalInOrder: ExternalRepoConfig[] = [];
  const externalMappingsInOrder: ExternalMapping[] = [];
  const externalTargetApps = new Set<string>();

  for (const [label, rawExternal] of Object.entries(externalRecord)) {
    validateLabel(label, `${configPath}#external`);
    const externalValue = asRecord(rawExternal, `${configPath}#external.${label}`);
    assertKnownKeys(externalValue, ["path", "mappings"], `${configPath}#external.${label}`);

    const relativePath = requireString(externalValue.path, `${configPath}#external.${label}.path`);
    const absoluteRepoRoot = path.resolve(sourceRoot, relativePath);
    const resolvedRepoRoot = resolveGitRepoRoot(runtime, absoluteRepoRoot);
    if (normalize(resolvedRepoRoot) !== normalize(absoluteRepoRoot)) {
      throw new MonkeError(
        `External dependency ${label} must point to the dependency repo root exactly: ${absoluteRepoRoot}`,
      );
    }

    if (!existsSync(path.join(absoluteRepoRoot, "monke.yml"))) {
      throw new MonkeError(
        `External dependency ${label} is missing monke.yml at ${absoluteRepoRoot}`,
      );
    }

    const rawMappings = externalValue.mappings;
    if (!Array.isArray(rawMappings) || rawMappings.length === 0) {
      throw new MonkeError(`${configPath}#external.${label}.mappings must be a non-empty array`);
    }

    const mappings: ExternalMapping[] = [];
    for (const [index, rawMapping] of rawMappings.entries()) {
      const mapping = asRecord(rawMapping, `${configPath}#external.${label}.mappings[${index}]`);
      assertKnownKeys(
        mapping,
        ["port", "app", "env"],
        `${configPath}#external.${label}.mappings[${index}]`,
      );

      const portKey = requirePortName(
        mapping.port,
        `${configPath}#external.${label}.mappings[${index}].port`,
      );
      const targetApp = requireLabel(
        mapping.app,
        `${configPath}#external.${label}.mappings[${index}].app`,
      );
      const targetEnv = requireEnvName(
        mapping.env,
        `${configPath}#external.${label}.mappings[${index}].env`,
      );

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
      label,
      relativePath,
      absoluteRepoRoot,
      mappings,
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
    sourceRoot,
    configPath,
    appsInOrder,
    appsByLabel,
    externalInOrder,
    localPortOrder,
    localMappingsByPort,
    externalMappingsInOrder,
    externalTargetApps,
  };
}

function asRecord(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MonkeError(`${location} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: string[],
  location: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new MonkeError(`Unknown key ${key} at ${location}`);
    }
  }
}

function requireString(value: unknown, location: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MonkeError(`${location} must be a non-empty string`);
  }
  return value;
}

function requireLabel(value: unknown, location: string): string {
  if (typeof value !== "string") {
    throw new MonkeError(`${location} must be a string`);
  }
  validateLabel(value, location);
  return value;
}

function requireEnvName(value: unknown, location: string): string {
  if (typeof value !== "string" || !ENV_RE.test(value)) {
    throw new MonkeError(`${location} must be an uppercase env name`);
  }
  return value;
}

function requirePortName(value: unknown, location: string): string {
  if (typeof value !== "string" || !PORT_RE.test(value)) {
    throw new MonkeError(`${location} must be an uppercase env name ending in _PORT`);
  }
  return value;
}

function validateLabel(label: string, location: string): void {
  if (!LABEL_RE.test(label)) {
    throw new MonkeError(`${location} label ${label} must be lowercase alphanumeric plus hyphen`);
  }
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
