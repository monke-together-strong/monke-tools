import { existsSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { expect, test } from "vite-plus/test";

import { loadGlobalMonkeConfig, saveGlobalMonkeConfig } from "../src/global-config.ts";
import { makeTempDir, read, write } from "./helpers.ts";

test("global monke config stores installed source checkout and current skill install preference", () => {
  const home = makeTempDir("global-config");
  const sourceCheckout = path.join(home, "monke-tools");
  const customSkillRoot = path.join(home, "custom-skills");

  saveGlobalMonkeConfig(home, {
    version: 1,
    installedSourceCheckout: sourceCheckout,
    skillInstallPreference: {
      targets: [{ kind: "codex" }, { kind: "custom", path: customSkillRoot }],
    },
  });

  const configPath = path.join(home, "config.yml");
  expect(existsSync(configPath)).toBe(true);
  expect(parse(read(home, "config.yml"))).toEqual({
    version: 1,
    installedSourceCheckout: sourceCheckout,
    skillInstallPreference: {
      targets: [{ kind: "codex" }, { kind: "custom", path: customSkillRoot }],
    },
  });
  expect(loadGlobalMonkeConfig(home)).toEqual({
    version: 1,
    installedSourceCheckout: sourceCheckout,
    skillInstallPreference: {
      targets: [{ kind: "codex" }, { kind: "custom", path: customSkillRoot }],
    },
  });
});

test("global monke config rejects empty preferences and relative custom paths", () => {
  const emptyPreferenceHome = makeTempDir("global-config-empty-preference");
  writeInvalidConfig(
    emptyPreferenceHome,
    `version: 1
skillInstallPreference:
  targets: []
`,
  );

  expect(() => loadGlobalMonkeConfig(emptyPreferenceHome)).toThrow(/non-empty array/);

  const relativeCustomHome = makeTempDir("global-config-relative-custom");
  writeInvalidConfig(
    relativeCustomHome,
    `version: 1
skillInstallPreference:
  targets:
    - kind: custom
      path: relative/skills
`,
  );

  expect(() => loadGlobalMonkeConfig(relativeCustomHome)).toThrow(/absolute path/);
});

test("global monke config rejects unknown future versions with the file and field path", () => {
  const home = makeTempDir("global-config-future-version");
  writeInvalidConfig(home, "version: 2\n");

  expect(() => loadGlobalMonkeConfig(home)).toThrow(/config\.yml[\s\S]*version/);
});

function writeInvalidConfig(home: string, contents: string): void {
  write(home, "config.yml", contents);
}
