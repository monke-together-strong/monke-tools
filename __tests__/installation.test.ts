import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { loadGlobalMonkeConfig } from "../src/global-config.ts";
import { runCliAsync } from "../src/index.ts";
import { loadLocalInstall } from "../src/install-manifest.ts";
import { createRuntime } from "../src/runtime.ts";
import { makeTempDir, write, writeGlobalInstructionsSource } from "./helpers.ts";

function prepareSource(sourceCheckout: string) {
  write(
    sourceCheckout,
    "skills/internal/monke-tools-core/SKILL.md",
    "---\nname: monke-tools-core\n---\n"
  );
  writeGlobalInstructionsSource(sourceCheckout);
  write(sourceCheckout, "skills/references/internal/README.md", "Reference guidance.\n");
}

function prepareStagedInstall(monkeHome: string, installId: string) {
  const stagedInstall = path.join(monkeHome, "install-staging", installId);
  mkdirSync(stagedInstall, { recursive: true });
  const executable = path.join(stagedInstall, "mt");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", "utf-8");
  chmodSync(executable, 0o755);
  return stagedInstall;
}

async function activateLocal(options: {
  dirty?: boolean;
  home: string;
  installId: string;
  monkeHome: string;
  onMutationOutput?: () => void;
  sourceCheckout: string;
  targetKinds?: string[];
}) {
  const stagedInstall = prepareStagedInstall(options.monkeHome, options.installId);
  const args = [
    "activate-local-install",
    stagedInstall,
    options.sourceCheckout,
    "--install-id",
    options.installId,
    "--source-commit",
    "0123456789abcdef0123456789abcdef01234567",
    "--created-at",
    "2026-08-20T12:34:56.000Z",
    "--platform",
    "darwin-arm64"
  ];
  const targetKinds = options.targetKinds ?? ["codex"];
  if (targetKinds.length > 0) {
    args.push("--targets", ...targetKinds);
  }
  if (options.dirty === true) {
    args.push("--dirty");
  }

  await runCliAsync(
    args,
    createRuntime({
      architecture: "x64",
      cwd: options.sourceCheckout,
      env: {
        CODEX_HOME: path.join(options.home, ".codex"),
        HOME: options.home,
        MONKE_HOME: options.monkeHome,
        PATH: "/usr/bin:/bin",
        SHELL: "/bin/zsh"
      },
      onStderr() {
        options.onMutationOutput?.();
      },
      onStdout() {},
      platform: "linux",
      toolBuildIdentity: options.dirty ? "local+0123456-dirty" : "local+0123456"
    })
  );
}

describe("versioned installation lifecycle", () => {
  test("rejects a manifest whose Codiff minimum cannot be consumed", () => {
    const installRoot = makeTempDir("invalid-install-manifest");
    writeFileSync(
      path.join(installRoot, "install-manifest.json"),
      JSON.stringify({
        createdAt: "2026-08-20T12:34:56.000Z",
        createdBy: "bun run install:local",
        installId: "local-invalid",
        installKind: "local",
        minimumCodiffVersion: "newest",
        platform: "darwin-arm64",
        schemaVersion: 1,
        sourceCheckout: installRoot,
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        sourceDirty: false,
        toolBuildIdentity: "local+0123456"
      })
    );

    expect(() => loadLocalInstall(installRoot)).toThrow(/minimumCodiffVersion/u);
  });

  test("Local refresh atomically activates a self-describing install behind the stable command", async () => {
    const sandbox = makeTempDir("local-install-activation");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const sourceCheckout = path.join(sandbox, "source");
    prepareSource(sourceCheckout);
    let lockObserved = false;

    await activateLocal({
      dirty: true,
      home,
      installId: "local-first",
      monkeHome,
      onMutationOutput() {
        lockObserved ||= existsSync(path.join(monkeHome, "locks", "installation.lock"));
      },
      sourceCheckout
    });

    const installRoot = path.join(monkeHome, "installs", "local-first");
    const activePointer = path.join(monkeHome, "current");
    const stableCommand = path.join(home, ".local", "bin", "mt");
    expect(readlinkSync(activePointer)).toBe(path.join("installs", "local-first"));
    expect(readlinkSync(stableCommand)).toBe(path.join(monkeHome, "current", "mt"));
    expect(realpathSync(stableCommand)).toBe(path.join(installRoot, "mt"));

    expect(
      JSON.parse(readFileSync(path.join(installRoot, "install-manifest.json"), "utf-8"))
    ).toStrictEqual({
      createdAt: "2026-08-20T12:34:56.000Z",
      createdBy: "bun run install:local",
      installId: "local-first",
      installKind: "local",
      minimumCodiffVersion: "1.9.0",
      platform: "darwin-arm64",
      schemaVersion: 1,
      sourceCheckout,
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      sourceDirty: true,
      toolBuildIdentity: "local+0123456-dirty"
    });
    expect(loadGlobalMonkeConfig(monkeHome)).toStrictEqual({
      skillInstallPreference: { targets: [{ kind: "codex" }] },
      version: 1
    });
    expect(readlinkSync(path.join(home, ".codex", "skills", "monke-tools", "internal"))).toBe(
      path.join(sourceCheckout, "skills", "internal")
    );
    expect(readlinkSync(path.join(home, ".codex", "skills", "monke-tools", "references"))).toBe(
      path.join(sourceCheckout, "skills", "references")
    );
    expect(existsSync(path.join(home, ".zshrc"))).toBeTruthy();
    expect(existsSync(path.join(home, ".bashrc"))).toBeFalsy();
    expect(lockObserved).toBeTruthy();
    expect(existsSync(path.join(monkeHome, "locks", "installation.lock"))).toBeFalsy();
  });

  test("Local refresh keeps the stable command link and only one predecessor", async () => {
    const sandbox = makeTempDir("local-install-retention");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const sourceCheckout = path.join(sandbox, "source");
    prepareSource(sourceCheckout);

    await activateLocal({ home, installId: "local-first", monkeHome, sourceCheckout });
    const stableCommand = path.join(home, ".local", "bin", "mt");
    const originalStableLink = lstatSync(stableCommand);
    const unvalidatedInstall = path.join(monkeHome, "installs", "manual-install");
    const externalDirectory = path.join(sandbox, "external");
    mkdirSync(unvalidatedInstall);
    mkdirSync(externalDirectory);
    symlinkSync(externalDirectory, path.join(monkeHome, "installs", "release-external"), "dir");
    await activateLocal({ home, installId: "local-second", monkeHome, sourceCheckout });
    await activateLocal({ home, installId: "local-third", monkeHome, sourceCheckout });

    expect(readlinkSync(stableCommand)).toBe(path.join(monkeHome, "current", "mt"));
    expect(lstatSync(stableCommand).ino).toBe(originalStableLink.ino);
    expect(existsSync(path.join(monkeHome, "installs", "local-first"))).toBeFalsy();
    expect(existsSync(path.join(monkeHome, "installs", "local-second"))).toBeTruthy();
    expect(existsSync(path.join(monkeHome, "installs", "local-third"))).toBeTruthy();
    expect(existsSync(unvalidatedInstall)).toBeTruthy();
    expect(
      lstatSync(path.join(monkeHome, "installs", "release-external")).isSymbolicLink()
    ).toBeTruthy();
  });

  test("Local refresh migrates legacy Global config and preserves its Skill preference", async () => {
    const sandbox = makeTempDir("local-install-legacy-config");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const sourceCheckout = path.join(sandbox, "source");
    prepareSource(sourceCheckout);
    write(
      monkeHome,
      "config.yml",
      `version: 1
installedSourceCheckout: /previous/checkout
skillInstallPreference:
  targets:
    - kind: cursor
`
    );

    await activateLocal({
      home,
      installId: "local-migrated",
      monkeHome,
      sourceCheckout,
      targetKinds: []
    });

    expect(loadGlobalMonkeConfig(monkeHome)).toStrictEqual({
      skillInstallPreference: { targets: [{ kind: "cursor" }] },
      version: 1
    });
    expect(readFileSync(path.join(monkeHome, "config.yml"), "utf-8")).not.toContain(
      "installedSourceCheckout"
    );
    expect(readlinkSync(path.join(home, ".cursor", "skills", "monke-tools", "internal"))).toBe(
      path.join(sourceCheckout, "skills", "internal")
    );
  });

  test("failed activation preserves the previous Active tool install and skips cleanup", async () => {
    const sandbox = makeTempDir("local-install-failed-activation");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const sourceCheckout = path.join(sandbox, "source");
    prepareSource(sourceCheckout);

    await activateLocal({ home, installId: "local-first", monkeHome, sourceCheckout });
    await activateLocal({ home, installId: "local-second", monkeHome, sourceCheckout });
    const missingStage = path.join(monkeHome, "install-staging", "local-missing");

    await expect(
      runCliAsync(
        [
          "activate-local-install",
          missingStage,
          sourceCheckout,
          "--install-id",
          "local-missing",
          "--source-commit",
          "0123456789abcdef0123456789abcdef01234567",
          "--created-at",
          "2026-08-20T12:34:56.000Z",
          "--platform",
          "darwin-arm64",
          "--targets",
          "codex"
        ],
        createRuntime({
          architecture: "x64",
          cwd: sourceCheckout,
          env: {
            HOME: home,
            MONKE_HOME: monkeHome,
            PATH: "/usr/bin:/bin",
            SHELL: "/bin/zsh"
          },
          onStderr() {},
          onStdout() {},
          platform: "linux",
          toolBuildIdentity: "local+0123456"
        })
      )
    ).rejects.toThrow(/Staged Local tool install is missing/u);

    expect(readlinkSync(path.join(monkeHome, "current"))).toBe(
      path.join("installs", "local-second")
    );
    expect(existsSync(path.join(monkeHome, "installs", "local-first"))).toBeTruthy();
    expect(existsSync(path.join(monkeHome, "installs", "local-second"))).toBeTruthy();
  });

  test("Codiff failure after activation leaves the new Local tool install active", async () => {
    const sandbox = makeTempDir("local-install-codiff-failure");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const sourceCheckout = path.join(sandbox, "source");
    const installId = "local-codiff-failure";
    const stagedInstall = prepareStagedInstall(monkeHome, installId);
    prepareSource(sourceCheckout);

    await expect(
      runCliAsync(
        [
          "activate-local-install",
          stagedInstall,
          sourceCheckout,
          "--install-id",
          installId,
          "--source-commit",
          "0123456789abcdef0123456789abcdef01234567",
          "--created-at",
          "2026-08-20T12:34:56.000Z",
          "--platform",
          "darwin-arm64",
          "--targets",
          "codex"
        ],
        createRuntime({
          architecture: "arm64",
          cwd: sourceCheckout,
          env: {
            HOME: home,
            MONKE_HOME: monkeHome,
            PATH: path.join(sandbox, "empty-bin"),
            SHELL: "/bin/zsh"
          },
          onStderr() {},
          onStdout() {},
          platform: "darwin",
          toolBuildIdentity: "local+0123456"
        })
      )
    ).rejects.toThrow(/Local tool install is active.*Retry with: mt install-dependencies/u);

    expect(readlinkSync(path.join(monkeHome, "current"))).toBe(path.join("installs", installId));
    expect(existsSync(path.join(monkeHome, "installs", installId, "mt"))).toBeTruthy();
    expect(realpathSync(path.join(home, ".local", "bin", "mt"))).toBe(
      path.join(monkeHome, "installs", installId, "mt")
    );
  });

  test("a running Skills Configure command keeps its resolved install root across later activation", async () => {
    const sandbox = makeTempDir("local-install-configure");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const firstSourceCheckout = path.join(sandbox, "first-source");
    const secondSourceCheckout = path.join(sandbox, "second-source");
    prepareSource(firstSourceCheckout);
    prepareSource(secondSourceCheckout);
    await activateLocal({
      home,
      installId: "local-first",
      monkeHome,
      sourceCheckout: firstSourceCheckout
    });

    const runningCommand = createRuntime({
      cwd: sandbox,
      env: {
        HOME: home,
        MONKE_HOME: monkeHome
      },
      multiSelectValues: [["cursor"]],
      onStderr() {},
      onStdout() {},
      toolInstallRoot: path.join(monkeHome, "installs", "local-first")
    });
    await activateLocal({
      home,
      installId: "local-second",
      monkeHome,
      sourceCheckout: secondSourceCheckout
    });

    await runCliAsync(["skills", "configure"], runningCommand);

    expect(loadGlobalMonkeConfig(monkeHome)).toStrictEqual({
      skillInstallPreference: { targets: [{ kind: "cursor" }] },
      version: 1
    });
    expect(readlinkSync(path.join(home, ".cursor", "skills", "monke-tools", "internal"))).toBe(
      path.join(firstSourceCheckout, "skills", "internal")
    );
  });
});
