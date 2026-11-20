import { loadGlobalMonkeConfig } from "./global-config.ts";
import type { ModelPreference, ModelRole } from "./global-config.ts";
import { getMonkeHome } from "./runtime.ts";
import type { Runtime } from "./types.ts";

const DEFAULT_MODEL_PREFERENCES: Record<ModelRole, ModelPreference[]> = {
  "post-merge": [{ effort: "high", model: "gpt-6.2-sol", provider: "codex" }],
  reviewer: [
    { effort: "high", model: "gpt-6.2-sol", provider: "codex" },
    { effort: "high", model: "claude-opus-5-5", provider: "claudeAgent" }
  ],
  writer: [
    { effort: "high", model: "gemini-4-neon", provider: "antigravity" },
    { effort: "high", model: "claude-opus-5-5", provider: "claudeAgent" }
  ]
};

const FALLBACK_LABELS = ["", "fallback ", "then "];

/** A Model role's models in fallback order, from Global monke config or the defaults. */
export function modelPreferences(runtime: Runtime, role: ModelRole): ModelPreference[] {
  return (
    loadGlobalMonkeConfig(getMonkeHome(runtime)).models?.[role] ?? DEFAULT_MODEL_PREFERENCES[role]
  );
}

/** Print the role's models as `first high, fallback second high, then third high`. */
export function runModelsGet(runtime: Runtime, role: ModelRole) {
  const line = modelPreferences(runtime, role)
    .map(({ effort, model }, index) => `${FALLBACK_LABELS[Math.min(index, 2)]}${model} ${effort}`)
    .join(", ");

  runtime.writeStdout(`${line}\n`);
}
