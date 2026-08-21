import { createHash } from "node:crypto";
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

import { loadGlobalMonkeConfig, saveGlobalMonkeConfig } from "../src/global-config.ts";
import { runCliAsync } from "../src/index.ts";
import { loadLocalInstall, ReleaseInstallManifestSchema } from "../src/install-manifest.ts";
import { createRuntime } from "../src/runtime.ts";
import type { RuntimeOptions } from "../src/runtime.ts";
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

function prepareReleaseBundle(
  sandbox: string,
  options: { platform?: "linux-x64" | "macos-arm64" } = {}
) {
  const bundleRoot = path.join(sandbox, "bundle");
  const platform = options.platform ?? "linux-x64";
  const skillContents = "---\nname: example\n---\n";
  const referenceContents = "Release reference.\n";
  write(bundleRoot, "skills/internal/example/SKILL.md", skillContents);
  write(bundleRoot, "skills/references/internal/example.md", referenceContents);
  write(bundleRoot, "instructions/GLOBAL.md", "Release baseline.\n");
  write(bundleRoot, "skills/codex/.keep", "\n");
  write(bundleRoot, "skills/imported/.keep", "\n");
  write(bundleRoot, "install.sh", "#!/bin/sh\nexit 0\n");
  write(bundleRoot, "mt", "#!/bin/sh\nprintf '1.2.3\\n'\n");
  chmodSync(path.join(bundleRoot, "install.sh"), 0o755);
  chmodSync(path.join(bundleRoot, "mt"), 0o755);
  const hash = (contents: string) => createHash("sha256").update(contents).digest("hex");
  const manifest = {
    artifactName: `monke-tools-v1.2.3-${platform}.tar.gz`,
    guidanceHashes: {
      "skills/codex/.keep": hash("\n"),
      "skills/imported/.keep": hash("\n"),
      "skills/internal/example/SKILL.md": hash(skillContents),
      "skills/references/internal/example.md": hash(referenceContents)
    },
    installKind: "release",
    minimumCodiffVersion: "1.9.0",
    platform,
    releaseTag: "monke-tools-v1.2.3",
    releaseVersion: "1.2.3",
    schemaVersion: 1,
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    toolBuildIdentity: "1.2.3"
  } as const;
  write(bundleRoot, "install-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return { bundleRoot, manifest };
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

function activateRelease(options: {
  args?: string[];
  bundleRoot: string;
  home: string;
  monkeHome: string;
  runtime?: RuntimeOptions;
  sandbox: string;
}) {
  const runtimeOptions = options.runtime ?? {};
  return runCliAsync(
    ["activate-release-install", options.bundleRoot, ...(options.args ?? [])],
    createRuntime({
      architecture: "x64",
      onStderr() {},
      onStdout() {},
      platform: "linux",
      toolBuildIdentity: "1.2.3",
      ...runtimeOptions,
      cwd: options.sandbox,
      env: {
        CODEX_HOME: path.join(options.home, ".codex"),
        HOME: options.home,
        MONKE_HOME: options.monkeHome,
        PATH: "/usr/bin:/bin",
        SHELL: "/bin/zsh",
        ...runtimeOptions.env
      }
    })
  );
}

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

  test("post-activation projection failure leaves Release core active with repair guidance", async () => {
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
    ).rejects.toThrow(/Release install is active[\s\S]*mt skills configure[\s\S]*\.codex\/skills/u);

    expect(readlinkSync(path.join(monkeHome, "current"))).toBe(
      path.join("installs", "release-1.2.3-linux-x64")
    );
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
