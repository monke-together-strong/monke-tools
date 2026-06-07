import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseDocument, stringify } from "yaml";

import { MonkeError } from "./errors.ts";
import { ensureDirectory } from "./runtime.ts";

/** Built-in Agent skill roots supported by monke-tools. */
export type BuiltInSkillInstallTargetKind = "codex" | "claude" | "cursor";

/** Skill install target kinds stored in Global monke config. */
export type SkillInstallTargetKind = BuiltInSkillInstallTargetKind | "custom";

/** A stored built-in Skill install target preference. */
export interface BuiltInSkillInstallTargetPreference {
  /** Built-in Agent destination selected for Skill installation. */
  kind: BuiltInSkillInstallTargetKind;
}

/** A stored custom Skill install target preference with an absolute Agent skill root path. */
export interface CustomSkillInstallTargetPreference {
  /** Custom Agent destination selected for Skill installation. */
  kind: "custom";
  /** Absolute Agent skill root path that will contain the managed monke-tools namespace. */
  path: string;
}

/** One stored Skill install target in the current Skill install preference. */
export type SkillInstallTargetPreference =
  | BuiltInSkillInstallTargetPreference
  | CustomSkillInstallTargetPreference;

/** The current set of Agent skill roots selected for Distributed skill installation. */
export interface SkillInstallPreference {
  /** Non-empty list of configured Skill install targets. */
  targets: SkillInstallTargetPreference[];
}

/** Versioned machine-local monke-tools configuration stored under the monke home directory. */
export interface GlobalMonkeConfig {
  /** Global config schema version. */
  version: 1;
  /** Source checkout used by the current local monke-tools install. */
  installedSourceCheckout?: string;
  /** Current Skill install target selection. */
  skillInstallPreference?: SkillInstallPreference;
}

/** Load versioned Global monke config from `config.yml`, returning migration-safe defaults. */
export function loadGlobalMonkeConfig(home: string): GlobalMonkeConfig {
  const configPath = getGlobalConfigPath(home);
  if (!existsSync(configPath)) {
    return { version: 1 };
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

  return parseGlobalMonkeConfig(document.toJS() as unknown, configPath);
}

/** Save versioned Global monke config to `config.yml` under the monke home directory. */
export function saveGlobalMonkeConfig(home: string, config: GlobalMonkeConfig): void {
  const parsed = parseGlobalMonkeConfig(config, getGlobalConfigPath(home));
  ensureDirectory(home);
  writeFileSync(getGlobalConfigPath(home), stringify(parsed), "utf8");
}

/** Return the path of the Global monke config file for a monke home directory. */
export function getGlobalConfigPath(home: string): string {
  return path.join(home, "config.yml");
}

function parseGlobalMonkeConfig(rawConfig: unknown, configPath: string): GlobalMonkeConfig {
  const config = asRecord(rawConfig, configPath);
  assertKnownKeys(
    config,
    ["version", "installedSourceCheckout", "skillInstallPreference"],
    configPath,
  );

  if (config.version !== 1) {
    throw new MonkeError(`${configPath}#version must be 1`);
  }

  const installedSourceCheckout =
    config.installedSourceCheckout === undefined
      ? undefined
      : requireAbsolutePath(
          config.installedSourceCheckout,
          `${configPath}#installedSourceCheckout`,
        );

  const skillInstallPreference =
    config.skillInstallPreference === undefined
      ? undefined
      : parseSkillInstallPreference(config.skillInstallPreference, configPath);

  return {
    version: 1,
    ...(installedSourceCheckout === undefined ? {} : { installedSourceCheckout }),
    ...(skillInstallPreference === undefined ? {} : { skillInstallPreference }),
  };
}

function parseSkillInstallPreference(
  rawPreference: unknown,
  configPath: string,
): SkillInstallPreference {
  const location = `${configPath}#skillInstallPreference`;
  const preference = asRecord(rawPreference, location);
  assertKnownKeys(preference, ["targets"], location);

  if (!Array.isArray(preference.targets)) {
    throw new MonkeError(`${location}.targets must be a non-empty array`);
  }

  if (preference.targets.length === 0) {
    throw new MonkeError(`${location}.targets must be a non-empty array`);
  }

  const targets: SkillInstallTargetPreference[] = [];
  const seenBuiltIns = new Set<BuiltInSkillInstallTargetKind>();
  let customSeen = false;

  for (const [index, rawTarget] of preference.targets.entries()) {
    const targetLocation = `${location}.targets[${index}]`;
    const target = asRecord(rawTarget, targetLocation);
    const kind = target.kind;

    switch (kind) {
      case "codex":
      case "claude":
      case "cursor":
        assertKnownKeys(target, ["kind"], targetLocation);
        if (seenBuiltIns.has(kind)) {
          throw new MonkeError(`Duplicate Skill install target ${kind} in ${location}`);
        }
        seenBuiltIns.add(kind);
        targets.push({ kind });
        break;
      case "custom":
        assertKnownKeys(target, ["kind", "path"], targetLocation);
        if (customSeen) {
          throw new MonkeError(`${location} may contain at most one custom target`);
        }
        customSeen = true;
        targets.push({
          kind: "custom",
          path: requireAbsolutePath(target.path, `${targetLocation}.path`),
        });
        break;
      default:
        throw new MonkeError(`${targetLocation}.kind must be codex, claude, cursor, or custom`);
    }
  }

  return { targets };
}

function requireAbsolutePath(value: unknown, location: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MonkeError(`${location} must be a non-empty absolute path`);
  }

  if (!path.isAbsolute(value)) {
    throw new MonkeError(`${location} must be an absolute path`);
  }

  return path.resolve(value);
}

function asRecord(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MonkeError(`${location} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new MonkeError(`Unknown key ${key} at ${location}`);
    }
  }
}
