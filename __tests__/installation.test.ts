import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { loadGlobalMonkeConfig, saveGlobalMonkeConfig } from "../src/global-config.ts";
import { runCliAsync } from "../src/index.ts";
import { loadLocalInstall, ReleaseInstallManifestSchema } from "../src/install-manifest.ts";
import { writeCollisionRecovery } from "../src/install-recovery.ts";
import { createRuntime } from "../src/runtime.ts";
import { makeTempDir, write } from "./helpers.ts";
import {
  activateLocal,
  activateRelease,
  prepareReleaseBundle,
  prepareStagedInstall,
  prepareSource
} from "./installation-fixtures.ts";

describe("versioned installation lifecycle", () => {
  test("a verified bundle activates one complete Release install with writable projected guidance", async () => {
    const sandbox = makeTempDir("release-install-activation");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const release = prepareReleaseBundle(sandbox);

    await activateRelease({
      args: ["--targets", "codex"],
      bundleRoot: release.bundleRoot,
      home,
      monkeHome,
      runtime: {
        env: {
          MONKE_TOOLS_EXPECTED_ARTIFACT_NAME: release.manifest.artifactName,
          MONKE_TOOLS_EXPECTED_RELEASE_TAG: release.manifest.releaseTag,
          MONKE_TOOLS_EXPECTED_RELEASE_VERSION: release.manifest.releaseVersion,
          MONKE_TOOLS_EXPECTED_SOURCE_COMMIT: release.manifest.sourceCommit
        }
      },
      sandbox
    });

    const installRoot = path.join(monkeHome, "installs", "release-1.2.3-linux-x64");
    const projectedSkill = path.join(
      home,
      ".codex",
      "skills",
      "monke-tools",
      "internal",
      "example",
      "SKILL.md"
    );
    expect(readlinkSync(path.join(monkeHome, "current"))).toBe(
      path.join("installs", "release-1.2.3-linux-x64")
    );
    expect(realpathSync(path.join(home, ".local", "bin", "mt"))).toBe(path.join(installRoot, "mt"));
    expect(
      JSON.parse(readFileSync(path.join(installRoot, "install-manifest.json"), "utf-8"))
    ).toStrictEqual(release.manifest);
    expect(realpathSync(projectedSkill)).toBe(
      path.join(installRoot, "skills", "internal", "example", "SKILL.md")
    );
    expect(lstatSync(realpathSync(projectedSkill)).isFile()).toBeTruthy();
    writeFileSync(projectedSkill, "Locally customized.\n", "utf-8");
    expect(readFileSync(path.join(installRoot, "skills/internal/example/SKILL.md"), "utf-8")).toBe(
      "Locally customized.\n"
    );
    expect(
      ReleaseInstallManifestSchema.parse(
        JSON.parse(readFileSync(path.join(installRoot, "install-manifest.json"), "utf-8"))
      ).guidanceHashes
    ).toStrictEqual(release.manifest.guidanceHashes);
    expect(readFileSync(path.join(home, ".codex", "AGENTS.md"), "utf-8")).toContain(
      "Release baseline."
    );
  });

  test("a noninteractive Release install without targets activates core and recommends repair", async () => {
    const sandbox = makeTempDir("release-install-noninteractive");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const release = prepareReleaseBundle(sandbox);
    let stderr = "";

    await activateRelease({
      bundleRoot: release.bundleRoot,
      home,
      monkeHome,
      runtime: {
        onMultiSelect() {
          throw new Error("Noninteractive Release install must not prompt");
        },
        onStderr(text) {
          stderr += text;
        }
      },
      sandbox
    });

    expect(readlinkSync(path.join(monkeHome, "current"))).toBe(
      path.join("installs", "release-1.2.3-linux-x64")
    );
    expect(loadGlobalMonkeConfig(monkeHome).skillInstallPreference).toBeUndefined();
    expect(existsSync(path.join(home, ".codex", "skills", "monke-tools"))).toBeFalsy();
    expect(stderr).toContain("mt skills configure");

    const installRoot = path.join(monkeHome, "installs", "release-1.2.3-linux-x64");
    const backupRoot = path.join(monkeHome, "install-backups", path.basename(installRoot));
    cpSync(installRoot, backupRoot, { recursive: true });
    writeCollisionRecovery(backupRoot, null);
    await runCliAsync(
      ["skills", "configure"],
      createRuntime({
        cwd: sandbox,
        env: { HOME: home, MONKE_HOME: monkeHome },
        multiSelectValues: [["codex"]],
        onStderr() {},
        onStdout() {},
        toolInstallRoot: installRoot
      })
    );
    expect(readlinkSync(path.join(home, ".codex", "skills", "monke-tools", "internal"))).toBe(
      path.join(installRoot, "skills", "internal")
    );
    expect(existsSync(path.join(monkeHome, "install-backups"))).toBeFalsy();
  });

  test("automation can install Release guidance into an explicit Custom Skill target", async () => {
    const sandbox = makeTempDir("release-install-custom-target");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const customTarget = path.join(sandbox, "agent", "skills");
    const release = prepareReleaseBundle(sandbox);

    await activateRelease({
      args: ["--custom-target", customTarget],
      bundleRoot: release.bundleRoot,
      home,
      monkeHome,
      sandbox
    });

    expect(loadGlobalMonkeConfig(monkeHome)).toStrictEqual({
      skillInstallPreference: { targets: [{ kind: "custom", path: customTarget }] },
      version: 1
    });
    expect(readlinkSync(path.join(customTarget, "monke-tools", "internal"))).toBe(
      path.join(monkeHome, "installs", "release-1.2.3-linux-x64", "skills", "internal")
    );
  });

  test("an interactive Release install asks for targets only after core activation", async () => {
    const sandbox = makeTempDir("release-install-interactive");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const release = prepareReleaseBundle(sandbox);
    let activeWhenPrompted = false;

    await activateRelease({
      args: ["--interactive"],
      bundleRoot: release.bundleRoot,
      home,
      monkeHome,
      runtime: {
        multiSelectValues: [["cursor"]],
        onMultiSelect() {
          activeWhenPrompted = existsSync(path.join(monkeHome, "current"));
        }
      },
      sandbox
    });

    expect(activeWhenPrompted).toBeTruthy();
    expect(readlinkSync(path.join(home, ".cursor", "skills", "monke-tools", "internal"))).toBe(
      path.join(monkeHome, "installs", "release-1.2.3-linux-x64", "skills", "internal")
    );
  });

  test("known Global instruction failures are rejected before Release activation", async () => {
    const sandbox = makeTempDir("release-install-preflight");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const release = prepareReleaseBundle(sandbox);
    mkdirSync(path.join(home, ".codex", "AGENTS.md"), { recursive: true });

    await expect(
      activateRelease({
        args: ["--targets", "codex"],
        bundleRoot: release.bundleRoot,
        home,
        monkeHome,
        sandbox
      })
    ).rejects.toThrow(/Global agent instructions/u);

    expect(existsSync(path.join(monkeHome, "current"))).toBeFalsy();
    expect(existsSync(path.join(monkeHome, "installs"))).toBeFalsy();
  });

  test.each([
    ["read-only", 0o555],
    ["unsearchable", 0o666]
  ])("a %s Skill destination is rejected before Release activation", async (_state, mode) => {
    const sandbox = makeTempDir("release-install-read-only-skills");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const release = prepareReleaseBundle(sandbox);
    const skillRoot = path.join(home, ".codex", "skills");
    mkdirSync(skillRoot, { recursive: true });
    chmodSync(skillRoot, mode);

    try {
      await expect(
        activateRelease({
          args: ["--targets", "codex"],
          bundleRoot: release.bundleRoot,
          home,
          monkeHome,
          sandbox
        })
      ).rejects.toThrow(/destination preflight failed[\s\S]*not writable/u);
    } finally {
      chmodSync(skillRoot, 0o755);
    }

    expect(existsSync(path.join(monkeHome, "current"))).toBeFalsy();
    expect(existsSync(path.join(monkeHome, "installs"))).toBeFalsy();
  });

  test("invalid Release guidance leaves installation state unchanged", async () => {
    const sandbox = makeTempDir("release-install-invalid-guidance");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const release = prepareReleaseBundle(sandbox);
    writeFileSync(path.join(release.bundleRoot, "skills/internal/example/SKILL.md"), "changed\n");

    await expect(
      activateRelease({
        args: ["--targets", "codex"],
        bundleRoot: release.bundleRoot,
        home,
        monkeHome,
        sandbox
      })
    ).rejects.toThrow(/original hashes/u);

    expect(existsSync(monkeHome)).toBeFalsy();
  });

  test.each(["destination", "parent"])(
    "unwritable Global instruction %s is rejected before Release activation",
    async (unwritablePathKind) => {
      const sandbox = makeTempDir("release-install-unwritable-instructions");
      const home = path.join(sandbox, "home");
      const monkeHome = path.join(sandbox, "monke-home");
      const release = prepareReleaseBundle(sandbox);
      const configDirectory = path.join(home, ".codex");
      const instructionsPath = path.join(home, ".codex", "AGENTS.md");
      if (unwritablePathKind === "destination") {
        write(home, ".codex/AGENTS.md", "User instructions.\n");
        chmodSync(instructionsPath, 0o444);
      } else {
        mkdirSync(configDirectory, { recursive: true });
        chmodSync(configDirectory, 0o555);
      }

      try {
        await expect(
          activateRelease({
            args: ["--targets", "codex"],
            bundleRoot: release.bundleRoot,
            home,
            monkeHome,
            sandbox
          })
        ).rejects.toThrow(/not writable/u);
      } finally {
        chmodSync(
          unwritablePathKind === "destination" ? instructionsPath : configDirectory,
          unwritablePathKind === "destination" ? 0o644 : 0o755
        );
      }

      expect(existsSync(path.join(monkeHome, "current"))).toBeFalsy();
      expect(existsSync(path.join(monkeHome, "installs"))).toBeFalsy();
    }
  );

  test("saved deselected Global instructions are preflighted before Release activation", async () => {
    const sandbox = makeTempDir("release-install-saved-target-preflight");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const release = prepareReleaseBundle(sandbox);
    saveGlobalMonkeConfig(monkeHome, {
      skillInstallPreference: { targets: [{ kind: "claude" }] },
      version: 1
    });
    mkdirSync(path.join(home, ".claude", "CLAUDE.md"), { recursive: true });

    await expect(
      activateRelease({
        args: ["--targets", "cursor"],
        bundleRoot: release.bundleRoot,
        home,
        monkeHome,
        sandbox
      })
    ).rejects.toThrow(/Global agent instructions/u);

    expect(existsSync(path.join(monkeHome, "current"))).toBeFalsy();
    expect(existsSync(path.join(monkeHome, "installs"))).toBeFalsy();
  });

  test.each(["absent", "unmanaged"])(
    "saved deselected %s Global instructions remain a no-op during preflight",
    async (instructionState) => {
      const sandbox = makeTempDir("release-install-noop-removal-preflight");
      const home = path.join(sandbox, "home");
      const monkeHome = path.join(sandbox, "monke-home");
      const release = prepareReleaseBundle(sandbox);
      const claudeDirectory = path.join(home, ".claude");
      const instructionsPath = path.join(claudeDirectory, "CLAUDE.md");
      saveGlobalMonkeConfig(monkeHome, {
        skillInstallPreference: { targets: [{ kind: "claude" }] },
        version: 1
      });
      if (instructionState === "unmanaged") {
        write(home, ".claude/CLAUDE.md", "User instructions.\n");
        chmodSync(instructionsPath, 0o444);
      } else {
        mkdirSync(claudeDirectory, { recursive: true });
        chmodSync(claudeDirectory, 0o555);
      }

      try {
        await activateRelease({
          args: ["--targets", "cursor"],
          bundleRoot: release.bundleRoot,
          home,
          monkeHome,
          sandbox
        });
      } finally {
        chmodSync(
          instructionState === "unmanaged" ? instructionsPath : claudeDirectory,
          instructionState === "unmanaged" ? 0o644 : 0o755
        );
      }

      expect(readlinkSync(path.join(monkeHome, "current"))).toBe(
        path.join("installs", "release-1.2.3-linux-x64")
      );
    }
  );

  test("predictable Skill projection collisions fail before Release activation", async () => {
    const sandbox = makeTempDir("release-install-projection-failure");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const release = prepareReleaseBundle(sandbox);
    mkdirSync(path.join(home, ".codex", "skills", "monke-tools", "internal"), {
      recursive: true
    });

    await expect(
      activateRelease({
        args: ["--targets", "codex"],
        bundleRoot: release.bundleRoot,
        home,
        monkeHome,
        sandbox
      })
    ).rejects.toThrow(/preflight failed[\s\S]*Refusing to overwrite non-managed Skill folder/u);

    expect(existsSync(path.join(monkeHome, "current"))).toBeFalsy();
  });

  test("Codiff failure after activation leaves the new Release install active", async () => {
    const sandbox = makeTempDir("release-install-codiff-failure");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const release = prepareReleaseBundle(sandbox, { platform: "macos-arm64" });

    await expect(
      activateRelease({
        bundleRoot: release.bundleRoot,
        home,
        monkeHome,
        runtime: {
          architecture: "arm64",
          env: {
            PATH: path.join(sandbox, "empty-bin")
          },
          platform: "darwin"
        },
        sandbox
      })
    ).rejects.toThrow(/Release install is active[\s\S]*Retry with: mt install-dependencies/u);

    expect(readlinkSync(path.join(monkeHome, "current"))).toBe(
      path.join("installs", "release-1.2.3-macos-arm64")
    );
  });

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

  test("Local refresh rejects a staged mt without execute permission", async () => {
    const sandbox = makeTempDir("local-install-not-executable");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const sourceCheckout = path.join(sandbox, "source");
    prepareSource(sourceCheckout);

    await expect(
      activateLocal({
        executableMode: 0o644,
        home,
        installId: "local-not-executable",
        monkeHome,
        sourceCheckout
      })
    ).rejects.toThrow("Staged mt executable is not executable");
    expect(existsSync(path.join(monkeHome, "current"))).toBeFalsy();
  });

  test("Release activation identifies a missing installer", async () => {
    const sandbox = makeTempDir("release-install-missing-installer");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const release = prepareReleaseBundle(sandbox);
    rmSync(path.join(release.bundleRoot, "install.sh"));

    await expect(
      activateRelease({
        bundleRoot: release.bundleRoot,
        home,
        monkeHome,
        sandbox
      })
    ).rejects.toThrow("Release installer is missing");
    expect(existsSync(path.join(monkeHome, "current"))).toBeFalsy();
  });

  test("Release activation rejects a manifest outside the selected catalog identity", async () => {
    const sandbox = makeTempDir("release-install-catalog-mismatch");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const release = prepareReleaseBundle(sandbox);

    await expect(
      activateRelease({
        bundleRoot: release.bundleRoot,
        home,
        monkeHome,
        runtime: {
          env: {
            MONKE_TOOLS_EXPECTED_ARTIFACT_NAME: release.manifest.artifactName,
            MONKE_TOOLS_EXPECTED_RELEASE_TAG: release.manifest.releaseTag,
            MONKE_TOOLS_EXPECTED_RELEASE_VERSION: release.manifest.releaseVersion,
            MONKE_TOOLS_EXPECTED_SOURCE_COMMIT: "f".repeat(40)
          }
        },
        sandbox
      })
    ).rejects.toThrow("does not match the selected GitHub Release");
    expect(existsSync(monkeHome)).toBeFalsy();
  });

  test("Local refresh rejects an unwritable stable command destination before activation", async () => {
    const sandbox = makeTempDir("local-install-stable-command-preflight");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const sourceCheckout = path.join(sandbox, "source");
    prepareSource(sourceCheckout);
    mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    chmodSync(path.join(home, ".local", "bin"), 0o555);

    await expect(
      activateLocal({ home, installId: "local-no-command", monkeHome, sourceCheckout })
    ).rejects.toThrow("Stable command destination is not writable and searchable");
    expect(existsSync(path.join(monkeHome, "current"))).toBeFalsy();
    expect(existsSync(path.join(monkeHome, "installs", "local-no-command"))).toBeFalsy();
    chmodSync(path.join(home, ".local", "bin"), 0o755);
  });

  test("Local refresh replaces a Release install and projects source-backed guidance", async () => {
    const sandbox = makeTempDir("release-to-local-refresh");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const sourceCheckout = path.join(sandbox, "source");
    const release = prepareReleaseBundle(sandbox);
    prepareSource(sourceCheckout);

    await activateRelease({
      args: ["--targets", "codex"],
      bundleRoot: release.bundleRoot,
      home,
      monkeHome,
      sandbox
    });
    const releaseInstall = path.join(monkeHome, "installs", "release-1.2.3-linux-x64");

    await activateLocal({
      home,
      installId: "local-after-release",
      monkeHome,
      sourceCheckout
    });

    expect(readlinkSync(path.join(monkeHome, "current"))).toBe(
      path.join("installs", "local-after-release")
    );
    expect(existsSync(releaseInstall)).toBeTruthy();
    expect(readlinkSync(path.join(home, ".codex", "skills", "monke-tools", "internal"))).toBe(
      path.join(sourceCheckout, "skills", "internal")
    );
  });

  test("ordinary CLI commands do not acquire or wait for the installation lock", async () => {
    const sandbox = makeTempDir("ordinary-command-installation-lock");
    const monkeHome = path.join(sandbox, "monke-home");
    const lockPath = path.join(monkeHome, "locks", "installation.lock");
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ acquiredAt: Date.now(), pid: process.pid }), "utf-8");
    let stdout = "";

    await runCliAsync(
      ["home"],
      createRuntime({
        cwd: sandbox,
        env: { HOME: path.join(sandbox, "home"), MONKE_HOME: monkeHome },
        onStderr() {},
        onStdout(text) {
          stdout += text;
        }
      })
    );

    expect(stdout).toBe(`${monkeHome}\n`);
    expect(existsSync(lockPath)).toBeTruthy();
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
    cpSync(
      path.join(monkeHome, "installs", "local-first"),
      path.join(monkeHome, "install-backups", "local-first"),
      { recursive: true }
    );
    writeCollisionRecovery(path.join(monkeHome, "install-backups", "local-first"), null);
    await activateLocal({ home, installId: "local-second", monkeHome, sourceCheckout });
    await activateLocal({ home, installId: "local-third", monkeHome, sourceCheckout });

    expect(readlinkSync(stableCommand)).toBe(path.join(monkeHome, "current", "mt"));
    expect(lstatSync(stableCommand).ino).toBe(originalStableLink.ino);
    expect(existsSync(path.join(monkeHome, "installs", "local-first"))).toBeFalsy();
    expect(existsSync(path.join(monkeHome, "installs", "local-second"))).toBeTruthy();
    expect(existsSync(path.join(monkeHome, "installs", "local-third"))).toBeTruthy();
    expect(existsSync(path.join(monkeHome, "install-backups"))).toBeFalsy();
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
    ).rejects.toThrow(/Staged Local tool install is not a real directory/u);

    expect(readlinkSync(path.join(monkeHome, "current"))).toBe(
      path.join("installs", "local-second")
    );
    expect(existsSync(path.join(monkeHome, "installs", "local-first"))).toBeTruthy();
    expect(existsSync(path.join(monkeHome, "installs", "local-second"))).toBeTruthy();
  });

  test("Local refresh preflights predictable Skill collisions before activation", async () => {
    const sandbox = makeTempDir("local-install-projection-preflight");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const sourceCheckout = path.join(sandbox, "source");
    prepareSource(sourceCheckout);
    await activateLocal({ home, installId: "local-first", monkeHome, sourceCheckout });
    mkdirSync(path.join(home, ".cursor", "skills", "monke-tools", "internal"), {
      recursive: true
    });

    await expect(
      activateLocal({
        home,
        installId: "local-collision",
        monkeHome,
        sourceCheckout,
        targetKinds: ["cursor"]
      })
    ).rejects.toThrow(/destination preflight failed[\s\S]*non-managed Skill folder/u);

    expect(readlinkSync(path.join(monkeHome, "current"))).toBe(
      path.join("installs", "local-first")
    );
    expect(existsSync(path.join(monkeHome, "installs", "local-collision"))).toBeFalsy();
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

  test("unexpected Local projection failure reports the Active core and repair command", async () => {
    const sandbox = makeTempDir("local-install-projection-failure");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const sourceCheckout = path.join(sandbox, "source");
    const installId = "local-projection-failure";
    prepareSource(sourceCheckout);
    let collisionInjected = false;

    const activation = activateLocal({
      home,
      installId,
      monkeHome,
      onMutationOutput() {
        if (collisionInjected || !existsSync(path.join(monkeHome, "current"))) {
          return;
        }
        if (readlinkSync(path.join(monkeHome, "current")) !== path.join("installs", installId)) {
          return;
        }
        mkdirSync(path.join(home, ".cursor", "skills", "monke-tools", "internal"), {
          recursive: true
        });
        collisionInjected = true;
      },
      sourceCheckout,
      targetKinds: ["cursor"]
    });

    await expect(activation).rejects.toThrow(
      /Local tool install is active[\s\S]*Retry with: mt skills configure/u
    );
    expect(collisionInjected).toBeTruthy();
    expect(readlinkSync(path.join(monkeHome, "current"))).toBe(path.join("installs", installId));
  });

  test("Skills Configure rejects a fixed install root that stopped being Active", async () => {
    const sandbox = makeTempDir("local-install-configure");
    const home = path.join(sandbox, "home");
    const physicalRoot = path.join(sandbox, "physical-root");
    const aliasedRoot = path.join(sandbox, "aliased-root");
    mkdirSync(physicalRoot);
    symlinkSync(physicalRoot, aliasedRoot, "dir");
    const monkeHome = path.join(aliasedRoot, "monke-home");
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
    const fixedToolAlias = path.join(sandbox, "fixed-tool-root");
    symlinkSync(
      path.join(physicalRoot, "monke-home", "installs", "local-first"),
      fixedToolAlias,
      "dir"
    );

    const runningCommand = createRuntime({
      cwd: sandbox,
      env: {
        HOME: home,
        MONKE_HOME: monkeHome
      },
      multiSelectValues: [["cursor"]],
      onStderr() {},
      onStdout() {},
      toolInstallRoot: fixedToolAlias
    });
    await activateLocal({
      home,
      installId: "local-second",
      monkeHome,
      sourceCheckout: secondSourceCheckout
    });

    await expect(runCliAsync(["skills", "configure"], runningCommand)).rejects.toThrow(
      /Active tool install changed[\s\S]*rerun mt skills configure/u
    );

    expect(loadGlobalMonkeConfig(monkeHome)).toStrictEqual({
      skillInstallPreference: { targets: [{ kind: "codex" }] },
      version: 1
    });
    expect(existsSync(path.join(home, ".cursor", "skills", "monke-tools"))).toBeFalsy();
  });
});
