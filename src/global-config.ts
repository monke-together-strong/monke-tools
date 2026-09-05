import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { stringify } from "yaml";
import * as z from "zod";

import { parseBoundaryValue, parseOwnedYamlFile } from "./validation.ts";

const BuiltInSkillInstallTargetKindSchema = z.enum(["codex", "claude", "cursor"]);
const AbsolutePathSchema = z
  .string({ error: "must be a non-empty absolute path" })
  .refine((value) => value.trim().length > 0, {
    error: "must be a non-empty absolute path"
  })
  .refine((value) => path.isAbsolute(value), { error: "must be an absolute path" })
  .transform((value) => path.resolve(value));
const SkillInstallTargetPreferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: BuiltInSkillInstallTargetKindSchema }),
  z.strictObject({ kind: z.literal("custom"), path: AbsolutePathSchema })
]);
export const SkillInstallPreferenceSchema = z.strictObject({
  targets: z
    .array(SkillInstallTargetPreferenceSchema)
    .min(1, {
      error: "must be a non-empty array"
    })
    .superRefine((targets, context) => {
      const seen = new Set<SkillInstallTargetKind>();
      for (const [index, target] of targets.entries()) {
        if (seen.has(target.kind)) {
          context.addIssue({
            code: "custom",
            message:
              target.kind === "custom"
                ? "may contain at most one custom target"
                : `Duplicate Skill install target ${target.kind}`,
            path: [index, "kind"]
          });
        }
        seen.add(target.kind);
      }
    })
});
const GlobalMonkeConfigSchema = z.strictObject({
  skillInstallPreference: SkillInstallPreferenceSchema.optional(),
  version: z.literal(1, { error: "must be 1" })
});
/** Built-in Agent skill roots supported by monke-tools. */
export type BuiltInSkillInstallTargetKind = z.output<typeof BuiltInSkillInstallTargetKindSchema>;
/** One stored Skill install target in the current Skill install preference. */
export type SkillInstallTargetPreference = z.output<typeof SkillInstallTargetPreferenceSchema>;
export type SkillInstallTargetKind = SkillInstallTargetPreference["kind"];
/** The current set of Agent skill roots selected for Distributed skill installation. */
export type SkillInstallPreference = z.output<typeof SkillInstallPreferenceSchema>;
/** Versioned machine-local monke-tools configuration. */
export type GlobalMonkeConfig = z.output<typeof GlobalMonkeConfigSchema>;

/** Load versioned Global monke config from `config.yml`, returning defaults when absent. */
export function loadGlobalMonkeConfig(home: string): GlobalMonkeConfig {
  const configPath = getGlobalConfigPath(home);
  if (!existsSync(configPath)) {
    return { version: 1 };
  }

  return parseOwnedYamlFile(configPath, GlobalMonkeConfigSchema);
}

/** Save versioned Global monke config to `config.yml` under the monke home directory. */
export function saveGlobalMonkeConfig(home: string, config: GlobalMonkeConfig) {
  const configPath = getGlobalConfigPath(home);
  const parsed = parseBoundaryValue(GlobalMonkeConfigSchema, config, configPath);
  mkdirSync(home, { recursive: true });
  writeFileSync(configPath, stringify(parsed), "utf-8");
}

/** Return the path of the Global monke config file for a monke home directory. */
function getGlobalConfigPath(home: string) {
  return path.join(home, "config.yml");
}
