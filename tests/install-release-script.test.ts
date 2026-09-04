import { cpSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { makeTempDir, writeExecutable } from "./helpers.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

describe("bundle-owned Release installer", () => {
  test("delegates automation targets to the bundled executable", () => {
    const bundleRoot = makeTempDir("release-installer");
    const logPath = path.join(bundleRoot, "mt.log");
    cpSync(
      path.join(repositoryRoot, "scripts", "install-release.sh"),
      path.join(bundleRoot, "install.sh")
    );
    writeExecutable(
      path.join(bundleRoot, "mt"),
      `#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(logPath)}
`
    );

    const result = Bun.spawnSync({
      cmd: ["sh", path.join(bundleRoot, "install.sh"), "--targets", "codex", "cursor"],
      stderr: "pipe",
      stdout: "pipe"
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(logPath, "utf-8").split("\n").filter(Boolean)).toStrictEqual([
      "activate-release-install",
      bundleRoot,
      "--targets",
      "codex",
      "cursor"
    ]);
  });
});
