import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { runCliAsync } from "../src/index.ts";
import { makeTempDir, write } from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

async function modelsGet(monkeHome: string, role: string) {
  let stdout = "";

  await runCliAsync(
    ["models", "get", role],
    createTestRuntime({
      env: { MONKE_HOME: monkeHome },
      onStdout(text) {
        stdout += text;
      }
    })
  );

  return stdout;
}

describe("mt models get", () => {
  it("prints the default models in fallback order", async () => {
    await expect(modelsGet(makeTempDir("models-default"), "writer")).resolves.toBe(
      "gemini-4-neon high, fallback claude-opus-5-5 high\n"
    );
  });

  it("prints a configured override with later fallbacks after then", async () => {
    const monkeHome = makeTempDir("models-override");
    write(
      monkeHome,
      "config.yml",
      `version: 1
models:
  reviewer:
    - { provider: codex, model: gpt-6.2-sol, effort: xhigh }
    - { provider: claudeAgent, model: claude-opus-5-5, effort: high }
    - { provider: antigravity, model: gemini-4-neon, effort: medium }
`
    );

    await expect(modelsGet(monkeHome, "reviewer")).resolves.toBe(
      "gpt-6.2-sol xhigh, fallback claude-opus-5-5 high, then gemini-4-neon medium\n"
    );
  });

  it("rejects a fallback from the same model family", async () => {
    const monkeHome = makeTempDir("models-same-family");
    write(
      monkeHome,
      "config.yml",
      `version: 1
models:
  writer:
    - { provider: claudeAgent, model: claude-opus-5-5, effort: high }
    - { provider: claudeAgent, model: claude-sonnet-5-5, effort: high }
`
    );

    await expect(modelsGet(path.resolve(monkeHome), "writer")).rejects.toThrow(
      /models\.writer\[1\]\.provider.*different model family/su
    );
  });
});
