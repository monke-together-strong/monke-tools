import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { verifyCodiffAsync } from "../src/codiff.ts";
import { runCliAsync } from "../src/index.ts";
import { makeTempDir, write } from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";
import { prepareActiveLocal, prepareActiveRelease } from "./update-fixtures.ts";

const projectRoot = path.resolve(import.meta.dirname, "..");
const skillPath = path.join("skills", "internal", "monke-install", "SKILL.md");

describe("Installation guidance in errors", () => {
  test.each(["local", "release"] as const)(
    "%s install failures point to their own guidance source",
    async (kind) => {
      const sandbox = makeTempDir(`install-guidance-${kind}`);
      const monkeHome = path.join(sandbox, "monke-home");
      const sourceCheckout = path.join(sandbox, "source");
      const installRoot =
        kind === "local"
          ? prepareActiveLocal(monkeHome, sourceCheckout)
          : prepareActiveRelease(monkeHome, "1.2.3");
      const guidanceRoot = kind === "local" ? sourceCheckout : installRoot;
      write(guidanceRoot, skillPath, "Installation guidance.\n");

      const failure = runCliAsync(
        ["update", "--check"],
        createTestRuntime({
          architecture: "x64",
          cwd: sandbox,
          env: { MONKE_HOME: monkeHome },
          onStderr() {},
          platform: "linux",
          releaseDistribution: {
            async downloadReleaseAsset() {
              throw new Error("check must not download assets");
            },
            async listReleases() {
              return [];
            }
          },
          toolInstallRoot: installRoot
        })
      );
      await expect(failure).rejects.toThrow(
        kind === "local"
          ? "No stable monke-tools Release was found"
          : "Customized release install cannot be updated."
      );
      await expect(failure).rejects.toThrow(
        `Installation guidance: ${path.join(guidanceRoot, skillPath)}`
      );
    }
  );

  test("a broken active install still points to guidance shipped with the running tool", async () => {
    const sandbox = makeTempDir("install-guidance-broken-pointer");
    const monkeHome = path.join(sandbox, "monke-home");
    const toolInstallRoot = path.join(sandbox, "running-tool");
    write(monkeHome, "current", "not a symlink\n");
    write(toolInstallRoot, skillPath, "Installation guidance.\n");

    await expect(
      runCliAsync(
        ["update", "--check"],
        createTestRuntime({
          cwd: sandbox,
          env: { MONKE_HOME: monkeHome },
          toolInstallRoot
        })
      )
    ).rejects.toThrow(
      `Active install pointer is not a symbolic link: ${path.join(monkeHome, "current")}\nInstallation guidance: ${path.join(toolInstallRoot, skillPath)}`
    );
  });

  test("missing Codiff points to installation guidance while retaining the install command", async () => {
    const sandbox = makeTempDir("install-guidance-codiff");
    await expect(
      verifyCodiffAsync(
        createTestRuntime({
          cwd: sandbox,
          env: { MONKE_HOME: path.join(sandbox, "monke-home"), PATH: path.join(sandbox, "bin") }
        })
      )
    ).rejects.toThrow(
      `Install it with: brew install --cask --require-sha nkzw-tech/tap/codiff\nInstallation guidance: ${path.join(projectRoot, skillPath)}`
    );
  });

  test("the executable prints the installation error and source guidance path", () => {
    const sandbox = makeTempDir("install-guidance-cli");
    const result = spawnSync("bun", ["run", "src/index.ts", "update", "--check"], {
      cwd: projectRoot,
      encoding: "utf-8",
      env: { ...process.env, MONKE_HOME: path.join(sandbox, "monke-home") }
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `No Active tool install was found; install monke-tools before updating\nInstallation guidance: ${path.join(projectRoot, skillPath)}\n`
    );
  });
});
