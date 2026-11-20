import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { stringify } from "yaml";
import * as z from "zod";

import { unwrapBoundaryResult, parseOwnedYamlFile } from "./validation.ts";

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

export const MODEL_ROLES = ["writer", "reviewer", "post-merge"] as const;

const ModelPreferenceSchema = z.strictObject({
  effort: z.enum(["low", "medium", "high", "xhigh"]),
  // `mt models get` prints models as one comma-separated line.
  model: z.string().regex(/^[^\s,]+$/u, { error: "must be a model id without spaces or commas" }),
  provider: z.enum(["antigravity", "claudeAgent", "codex"])
});

// A model's family is the leading name of its id, such as `claude` in `claude-opus-5-5`.
const modelFamily = (model: string) => model.split("-")[0];

const ModelPreferencesSchema = z
  .tuple([ModelPreferenceSchema], ModelPreferenceSchema)
  .superRefine((preferences, context) => {
    const families = preferences.map(({ model }) => modelFamily(model));

    for (const [index, family] of families.entries()) {
      if (families.indexOf(family) !== index) {
        context.addIssue({
          code: "custom",
          message: `repeats the ${family} model family`,
          path: [index, "model"]
        });
      }
    }
  });

const GlobalMonkeConfigSchema = z.strictObject({
  diffAdapter: z.enum(["codiff", "ms"]).optional(),
  models: z.partialRecord(z.enum(MODEL_ROLES), ModelPreferencesSchema).optional(),
  skillInstallPreference: SkillInstallPreferenceSchema.optional(),
  version: z.literal(1, { error: "must be 1" })
});

export type ModelRole = (typeof MODEL_ROLES)[number];

export type ModelPreference = z.output<typeof ModelPreferenceSchema>;

export type ModelPreferences = z.output<typeof ModelPreferencesSchema>;

export type BuiltInSkillInstallTargetKind = z.output<typeof BuiltInSkillInstallTargetKindSchema>;

export type SkillInstallTargetPreference = z.output<typeof SkillInstallTargetPreferenceSchema>;

export type SkillInstallTargetKind = SkillInstallTargetPreference["kind"];

export type SkillInstallPreference = z.output<typeof SkillInstallPreferenceSchema>;

export type GlobalMonkeConfig = z.output<typeof GlobalMonkeConfigSchema>;

/** Load versioned Global monke config from `config.yml`, returning defaults when absent. */
export function loadGlobalMonkeConfig(home: string): GlobalMonkeConfig {
  const configPath = getGlobalConfigPath(home);

  if (!existsSync(configPath)) {
    return { version: 1 };
  }

  return parseOwnedYamlFile(configPath, GlobalMonkeConfigSchema);
}

export function saveGlobalMonkeConfig(home: string, config: GlobalMonkeConfig) {
  const configPath = getGlobalConfigPath(home);
  const parsed = unwrapBoundaryResult(GlobalMonkeConfigSchema.safeParse(config), configPath);
  mkdirSync(home, { recursive: true });
  writeFileSync(configPath, stringify(parsed), "utf-8");
}

function getGlobalConfigPath(home: string) {
  return path.join(home, "config.yml");
}
