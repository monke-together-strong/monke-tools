import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import * as z from "zod";

import { MonkeError } from "./errors.ts";
import { ensureDirectory } from "./runtime.ts";
import { parseBoundaryValue, parseOwnedYamlFile } from "./validation.ts";

const BuiltInSkillInstallTargetKindSchema = z.enum(["codex", "claude", "cursor"]);
const AbsolutePathSchema = z
  .string({ error: "must be a non-empty absolute path" })
  .refine((value) => value.trim().length > 0, {
    error: "must be a non-empty absolute path",
  })
  .refine((value) => path.isAbsolute(value), { error: "must be an absolute path" })
  .transform((value) => path.resolve(value));
const SkillInstallTargetPreferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: BuiltInSkillInstallTargetKindSchema }),
  z.strictObject({ kind: z.literal("custom"), path: AbsolutePathSchema }),
]);
const SkillInstallPreferenceSchema = z.strictObject({
  targets: z.array(SkillInstallTargetPreferenceSchema).min(1, {
    error: "must be a non-empty array",
  }),
});
const GlobalMonkeConfigSchema = z.strictObject({
  installedSourceCheckout: AbsolutePathSchema.optional(),
  skillInstallPreference: SkillInstallPreferenceSchema.optional(),
  version: z.literal(1, { error: "must be 1" }),
});

type ParsedSkillInstallPreference = z.output<typeof SkillInstallPreferenceSchema>;
type ParsedGlobalMonkeConfig = z.output<typeof GlobalMonkeConfigSchema>;

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

  return normalizeGlobalMonkeConfig(
    parseOwnedYamlFile(configPath, GlobalMonkeConfigSchema),
    configPath,
  );
}

/** Save versioned Global monke config to `config.yml` under the monke home directory. */
export function saveGlobalMonkeConfig(home: string, config: GlobalMonkeConfig): void {
  const configPath = getGlobalConfigPath(home);
  const parsed = normalizeGlobalMonkeConfig(
    parseBoundaryValue(GlobalMonkeConfigSchema, config, configPath),
    configPath,
  );
  ensureDirectory(home);
  writeFileSync(configPath, stringify(parsed), "utf-8");
}

/** Return the path of the Global monke config file for a monke home directory. */
function getGlobalConfigPath(home: string): string {
  return path.join(home, "config.yml");
}

function normalizeGlobalMonkeConfig(
  config: ParsedGlobalMonkeConfig,
  configPath: string,
): GlobalMonkeConfig {
  const { installedSourceCheckout } = config;

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
  preference: ParsedSkillInstallPreference,
  configPath: string,
): SkillInstallPreference {
  const location = `${configPath}#skillInstallPreference`;

  const targets: SkillInstallTargetPreference[] = [];
  const seenBuiltIns = new Set<BuiltInSkillInstallTargetKind>();
  let customSeen = false;

  for (const rawTarget of preference.targets) {
    const { kind } = rawTarget;

    switch (kind) {
      case "codex":
      case "claude":
      case "cursor": {
        if (seenBuiltIns.has(kind)) {
          throw new MonkeError(`Duplicate Skill install target ${kind} in ${location}`);
        }
        seenBuiltIns.add(kind);
        targets.push({ kind });
        break;
      }
      case "custom": {
        if (customSeen) {
          throw new MonkeError(`${location} may contain at most one custom target`);
        }
        customSeen = true;
        targets.push({
          kind: "custom",
          path: rawTarget.path,
        });
        break;
      }
      default: {
        throw new MonkeError(`Unsupported Skill install target in ${location}`);
      }
    }
  }

  return { targets };
}
