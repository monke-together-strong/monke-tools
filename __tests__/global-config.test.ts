import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { parse } from "yaml";

import { loadGlobalMonkeConfig, saveGlobalMonkeConfig } from "../src/global-config.ts";
import { makeTempDir, read, write } from "./helpers.ts";

describe("global configuration", () => {
  test("global monke config stores preferences without Active install identity", () => {
    const home = makeTempDir("global-config");
    const customSkillRoot = path.join(home, "custom-skills");

    saveGlobalMonkeConfig(home, {
      skillInstallPreference: {
        targets: [{ kind: "codex" }, { kind: "custom", path: customSkillRoot }]
      },
      version: 1
    });

    const configPath = path.join(home, "config.yml");
    expect(existsSync(configPath)).toBeTruthy();
    expect(parse(read(home, "config.yml"))).toStrictEqual({
      skillInstallPreference: {
        targets: [{ kind: "codex" }, { kind: "custom", path: customSkillRoot }]
      },
      version: 1
    });
    expect(loadGlobalMonkeConfig(home)).toStrictEqual({
      skillInstallPreference: {
        targets: [{ kind: "codex" }, { kind: "custom", path: customSkillRoot }]
      },
      version: 1
    });
  });

  test("global monke config rejects duplicated Active install identity", () => {
    const home = makeTempDir("global-config-active-identity");
    writeInvalidConfig(
      home,
      `version: 1
installedSourceCheckout: /tmp/monke-tools
`
    );

    expect(() => loadGlobalMonkeConfig(home)).toThrow(/installedSourceCheckout/u);
  });

  test("global monke config rejects empty preferences and relative custom paths", () => {
    const emptyPreferenceHome = makeTempDir("global-config-empty-preference");
    writeInvalidConfig(
      emptyPreferenceHome,
      `version: 1
skillInstallPreference:
  targets: []
`
    );

    expect(() => loadGlobalMonkeConfig(emptyPreferenceHome)).toThrow(/non-empty array/u);

    const relativeCustomHome = makeTempDir("global-config-relative-custom");
    writeInvalidConfig(
      relativeCustomHome,
      `version: 1
skillInstallPreference:
  targets:
    - kind: custom
      path: relative/skills
`
    );

    expect(() => loadGlobalMonkeConfig(relativeCustomHome)).toThrow(/absolute path/u);
  });

  test("global monke config rejects unknown future versions with the file and field path", () => {
    const home = makeTempDir("global-config-future-version");
    writeInvalidConfig(home, "version: 2\n");

    expect(() => loadGlobalMonkeConfig(home)).toThrow(/config\.yml[\s\S]*version/u);
  });
});

function writeInvalidConfig(home: string, contents: string) {
  write(home, "config.yml", contents);
}
