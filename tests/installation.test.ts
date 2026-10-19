import { ok } from "node:assert/strict";
import { hash } from "node:crypto";
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

import { describe, expect, it } from "vite-plus/test";

import {
  readImportRecipeStore,
  writeImportRecipeStore,
  writeRepoImportRecipeStore
} from "../scripts/skill-import-recipes.ts";
import { rememberRestoredRecipe } from "../scripts/skill-lock.ts";
import { errorMessage, ThrownValueSchema } from "../src/errors.ts";
import { loadGlobalMonkeConfig, saveGlobalMonkeConfig } from "../src/global-config.ts";
import { runCliAsync } from "../src/index.ts";
import { loadToolInstall, ReleaseInstallManifestSchema } from "../src/install-manifest.ts";
import { writeCollisionRecovery } from "../src/install-recovery.ts";
import { createRepo, git, makeTempDir, write } from "./helpers.ts";
import {
  activateLocal,
  activateRelease,
  prepareReleaseBundle,
  prepareStagedInstall,
  prepareSource
} from "./installation-fixtures.ts";
import { createTestRuntime } from "./runtime-fixture.ts";
import { prepareActiveRelease, release as catalogRelease } from "./update-fixtures.ts";

describe("versioned installation lifecycle", () => {
  it("preserves the original hashed lock when installing and seeding a legacy Release", async () => {
    const sandbox = makeTempDir("legacy-release-registry-seeding");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const candidate = prepareReleaseBundle(sandbox);
    const importedSkill = "---\nname: legacy\ndescription: Legacy bundled skill.\n---\nAccepted.\n";

    const legacyLock = `${JSON.stringify({
      recipes: [
        {
          lock: {
            commit: "f".repeat(40),
            digest: "0".repeat(64),
            importerVersion: "1.7.0",
            materializerVersion: 1,
            repository: "https://example.invalid/legacy.git",
            subpath: "",
            updateRef: "HEAD"
          },
          skills: [{ kind: "skill", selector: "legacy", slug: "legacy" }],
          source: "https://example.invalid/legacy.git"
        }
      ],
      version: 3
    })}\n`;

    write(candidate.bundleRoot, "skills.lock.json", legacyLock);
    write(candidate.bundleRoot, "skills/imported/legacy/SKILL.md", importedSkill);
    write(
      candidate.bundleRoot,
      "install-manifest.json",
      `${JSON.stringify({
        ...candidate.manifest,
        guidanceHashes: {
          ...candidate.manifest.guidanceHashes,
          "skills.lock.json": hash("sha256", legacyLock, "hex"),
          "skills/imported/legacy/SKILL.md": hash("sha256", importedSkill, "hex")
        }
      })}\n`
    );

    await activateRelease({
      args: ["--targets", "codex"],
      bundleRoot: candidate.bundleRoot,
      home,
      monkeHome,
      sandbox
    });
    const installRoot = path.join(monkeHome, "installs", "release-1.2.3-linux-x64");
    let stdout = "";
    await runCliAsync(
      ["skills", "list"],
      createTestRuntime({
        cwd: sandbox,
        env: { HOME: home, MONKE_HOME: monkeHome },
        onStderr() {},
        onStdout(message) {
          stdout += message;
        },
        toolInstallRoot: installRoot
      })
    );

    expect(stdout).toContain("https://example.invalid/legacy.git\tgit\t1 skills");
    expect(readFileSync(path.join(candidate.bundleRoot, "skills.lock.json"), "utf-8")).toBe(
      legacyLock
    );
    expect(readFileSync(path.join(installRoot, "skills.lock.json"), "utf-8")).toBe(legacyLock);
    expect(
      readFileSync(path.join(monkeHome, "skill-registry", "skills.lock.json"), "utf-8")
    ).toContain('"version": 4');
    expect(
      readFileSync(path.join(home, ".codex/skills/monke-tools/imported/legacy/SKILL.md"), "utf-8")
    ).toBe(importedSkill);
  });

  it("lets current tooling check an unchanged legacy Release and detect changes to its lock", async () => {
    const sandbox = makeTempDir("legacy-release-update-check");
    const monkeHome = path.join(sandbox, "monke-home");
    const installRoot = prepareActiveRelease(monkeHome, "1.2.3");
    const legacyLock = '{"recipes":[],"version":3}\n';

    const manifest = ReleaseInstallManifestSchema.parse(
      JSON.parse(readFileSync(path.join(installRoot, "install-manifest.json"), "utf-8"))
    );

    manifest.guidanceHashes["skills.lock.json"] = hash("sha256", legacyLock, "hex");
    write(installRoot, "skills.lock.json", legacyLock);
    write(installRoot, "install-manifest.json", `${JSON.stringify(manifest)}\n`);
    let stderr = "";

    const runtime = createTestRuntime({
      architecture: "x64",
      cwd: sandbox,
      env: { HOME: path.join(sandbox, "home"), MONKE_HOME: monkeHome },
      onStderr(text) {
        stderr += text;
      },
      onStdout() {},
      platform: "linux",
      releaseDistribution: {
        async downloadReleaseAsset() {
          throw new Error("Update check must not download assets");
        },
        async listReleases(page) {
          return page === 1 ? [catalogRelease("1.2.3")] : [];
        }
      },
      toolBuildIdentity: "1.2.4",
      toolInstallRoot: installRoot
    });

    await runCliAsync(["update", "--check"], runtime);
    expect(stderr).toContain(
      "Active tool install 1.2.3 already matches the selected stable Release"
    );
    expect(readFileSync(path.join(installRoot, "skills.lock.json"), "utf-8")).toBe(legacyLock);

    write(installRoot, "skills.lock.json", "Edited legacy recipe.\n");
    await expect(runCliAsync(["update", "--check"], runtime)).rejects.toThrow(
      "Changed guidance paths:\n- skills.lock.json"
    );
  });

  it("restores accepted pins and honors removed repo declarations during Local tool install", async () => {
    const sandbox = makeTempDir("local-install-locked-imports");
    const sourceCheckout = path.join(sandbox, "source");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    prepareSource(sourceCheckout);
    createRepo(sourceCheckout, { "monke.yml": "skills: []\n" });

    const runtime = createTestRuntime({
      cwd: sourceCheckout,
      env: { HOME: home, MONKE_HOME: monkeHome },
      onStderr() {},
      onStdout() {}
    });

    const upstream = createRepo(path.join(sandbox, "upstream"), {
      "alpha/SKILL.md": "---\nname: alpha\ndescription: Lifecycle fixture\n---\n\nAccepted one.\n"
    });

    const originalCwd = process.cwd();
    const originalMonkeHome = process.env.MONKE_HOME;

    try {
      process.chdir(sourceCheckout);
      process.env.MONKE_HOME = monkeHome;
      await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "alpha"], runtime);
      const acceptedLock = readFileSync(path.join(sourceCheckout, "monke.yml"), "utf-8");
      rmSync(path.join(sourceCheckout, "skills/imported"), { recursive: true });
      await activateLocal({ home, installId: "locked-one", monkeHome, sourceCheckout });
      const projectedEntry = path.join(home, ".codex/skills/monke-tools/imported/alpha/SKILL.md");
      expect(readFileSync(projectedEntry, "utf-8")).toContain("Accepted one.");
      rmSync(path.join(sourceCheckout, "skills/imported"), { recursive: true });
      await runCliAsync(
        ["skills", "configure"],
        createTestRuntime({
          cwd: sourceCheckout,
          env: { HOME: home, MONKE_HOME: monkeHome },
          multiSelectValues: [["codex"]],
          onStderr() {},
          onStdout() {}
        })
      );
      expect(readFileSync(projectedEntry, "utf-8")).toContain("Accepted one.");

      write(
        upstream,
        "alpha/SKILL.md",
        "---\nname: alpha\ndescription: Lifecycle fixture\n---\n\nAccepted two.\n"
      );
      write(
        upstream,
        "bravo/SKILL.md",
        "---\nname: bravo\ndescription: Added lifecycle fixture\n---\n\nNew selection.\n"
      );
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Next pin"]);
      await runCliAsync(
        ["skills", "add", upstream, "--repo", "--skill", "alpha", "bravo"],
        runtime
      );
      expect(readFileSync(projectedEntry, "utf-8")).toContain("Accepted two.");
      expect(existsSync(path.join(sourceCheckout, "skills/imported/bravo/SKILL.md"))).toBeTruthy();
      write(sourceCheckout, "monke.yml", acceptedLock);
      await activateLocal({ home, installId: "locked-reverted", monkeHome, sourceCheckout });
      expect(readFileSync(projectedEntry, "utf-8")).toContain("Accepted one.");
      expect(existsSync(path.join(sourceCheckout, "skills/imported/bravo"))).toBeFalsy();
      expect(existsSync(path.join(home, ".codex/skills/monke-tools/imported/bravo"))).toBeFalsy();
      expect(readFileSync(path.join(sourceCheckout, "monke.yml"), "utf-8")).toBe(acceptedLock);

      const invalid = readImportRecipeStore(sourceCheckout);
      const [invalidPin] = invalid.recipes;
      ok(invalidPin);
      delete invalidPin.commit;
      writeRepoImportRecipeStore(sourceCheckout, invalid);
      await expect(
        activateLocal({ home, installId: "locked-invalid", monkeHome, sourceCheckout })
      ).rejects.toThrow("mt skills update --repo");
      expect(readlinkSync(path.join(monkeHome, "current"))).toBe("installs/locked-reverted");
      expect(readFileSync(projectedEntry, "utf-8")).toContain("Accepted one.");

      write(sourceCheckout, "monke.yml", acceptedLock);
      writeImportRecipeStore(sourceCheckout, readImportRecipeStore(sourceCheckout));
      write(sourceCheckout, "monke.yml", "apps: {}\n");
      await activateLocal({ home, installId: "locked-removed", monkeHome, sourceCheckout });
      expect(existsSync(path.join(sourceCheckout, "skills/imported/alpha"))).toBeFalsy();
      expect(existsSync(projectedEntry)).toBeFalsy();
      await runCliAsync(["skills", "list"], runtime);
      expect(
        JSON.parse(
          readFileSync(path.join(monkeHome, "skill-registry", "skills.lock.json"), "utf-8")
        )
      ).toMatchObject({ recipes: [], version: 4 });

      rmSync(path.join(sourceCheckout, "monke.yml"));
      write(sourceCheckout, "skills/imported/alpha/SKILL.md", "Leftover imported bytes.\n");
      await runCliAsync(
        ["skills", "configure"],
        createTestRuntime({
          cwd: sourceCheckout,
          env: { HOME: home, MONKE_HOME: monkeHome },
          multiSelectValues: [["codex"]],
          onStderr() {},
          onStdout() {}
        })
      );
      expect(existsSync(path.join(sourceCheckout, "skills/imported/alpha"))).toBeFalsy();
      expect(
        JSON.parse(
          readFileSync(path.join(monkeHome, "skill-registry", "skills.lock.json"), "utf-8")
        )
      ).toMatchObject({ recipes: [], version: 4 });

      write(sourceCheckout, "skills/imported/alpha/SKILL.md", "Leftover imported bytes.\n");
      await runCliAsync(["skills", "local-install", sourceCheckout], runtime);
      expect(existsSync(path.join(sourceCheckout, "skills/imported/alpha"))).toBeFalsy();
      expect(existsSync(projectedEntry)).toBeFalsy();
      expect(
        JSON.parse(
          readFileSync(path.join(monkeHome, "skill-registry", "skills.lock.json"), "utf-8")
        )
      ).toMatchObject({ recipes: [], version: 4 });
    } finally {
      process.chdir(originalCwd);
      process.env.MONKE_HOME = originalMonkeHome;
    }
  }, 30_000);

  it("activates one complete Release install with writable projected guidance from a verified bundle", async () => {
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

  it("activates core and recommends repair for a noninteractive Release install without targets", async () => {
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
      createTestRuntime({
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

  it("lets automation install Release guidance into an explicit Custom Skill target", async () => {
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

  it("asks for targets in an interactive Release install only after core activation", async () => {
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

  it("rejects known Global instruction failures before Release activation", async () => {
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

  it.each([
    ["read-only", 0o555],
    ["unsearchable", 0o666]
  ])("rejects a %s Skill destination before Release activation", async (_state, mode) => {
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

  it("leaves installation state unchanged for invalid Release guidance", async () => {
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

  it.each(["destination", "parent"])(
    "rejects an unwritable Global instruction %s before Release activation",
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

  it("preflights saved deselected Global instructions before Release activation", async () => {
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

  it.each(["absent", "unmanaged"])(
    "treats saved deselected %s Global instructions as a no-op during preflight",
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

  it("fails on predictable Skill projection collisions before Release activation", async () => {
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

  it("leaves the new Release install active on Codiff failure after activation", async () => {
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

  it("rejects a manifest whose Codiff minimum cannot be consumed", () => {
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

    expect(() => loadToolInstall(installRoot)).toThrow(/minimumCodiffVersion/u);
  });

  it("atomically activates a self-describing install behind the stable command during Local install refresh", async () => {
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
      minimumCodiffVersion: "1.14.0",
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

  it("rejects a staged mt without execute permission during Local install refresh", async () => {
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

  it("identifies a missing installer during Release install activation", async () => {
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

  it("rejects a manifest outside the selected catalog identity during Release install activation", async () => {
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

  it("rejects an unwritable stable command destination during Local install refresh before activation", async () => {
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

  it("replaces a Release install during Local install refresh and projects source-backed guidance", async () => {
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

  it("does not acquire or wait for the installation lock in ordinary CLI commands", async () => {
    const sandbox = makeTempDir("ordinary-command-installation-lock");
    const monkeHome = path.join(sandbox, "monke-home");
    const lockPath = path.join(monkeHome, "locks", "installation.lock");
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ acquiredAt: Date.now(), pid: process.pid }), "utf-8");
    let stdout = "";

    await runCliAsync(
      ["home"],
      createTestRuntime({
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

  it("keeps the stable command link and only one predecessor during Local install refresh", async () => {
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

  it("preserves the configured Skill preference during Local install refresh", async () => {
    const sandbox = makeTempDir("local-install-config");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const sourceCheckout = path.join(sandbox, "source");
    prepareSource(sourceCheckout);
    write(
      monkeHome,
      "config.yml",
      `version: 1
skillInstallPreference:
  targets:
    - kind: cursor
`
    );

    await activateLocal({
      home,
      installId: "local-preferred",
      monkeHome,
      sourceCheckout,
      targetKinds: []
    });

    expect(loadGlobalMonkeConfig(monkeHome)).toStrictEqual({
      skillInstallPreference: { targets: [{ kind: "cursor" }] },
      version: 1
    });
    expect(readlinkSync(path.join(home, ".cursor", "skills", "monke-tools", "internal"))).toBe(
      path.join(sourceCheckout, "skills", "internal")
    );
  });

  it("preserves the previous Active tool install and skips cleanup on failed activation", async () => {
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
        createTestRuntime({
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

  it("preflights predictable Skill collisions during Local install refresh before activation", async () => {
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

  it.each(["personal target", "owned duplicate", "removed bundled import"] as const)(
    "preflights the retained registry for a %s during Local install refresh",
    async (scenario) => {
      const sandbox = makeTempDir("local-install-registry-preflight");
      const home = path.join(sandbox, "home");
      const monkeHome = path.join(sandbox, "monke-home");
      const sourceCheckout = path.join(sandbox, "source");
      prepareSource(sourceCheckout);
      await activateLocal({
        home,
        installId: "local-first",
        monkeHome,
        sourceCheckout,
        targetKinds: ["claude"]
      });
      const personal = path.join(sandbox, "personal");
      write(
        personal,
        "personal/SKILL.md",
        "---\nname: personal\ndescription: Personal skill\n---\nPersonal instructions.\n"
      );

      const runtime = createTestRuntime({
        cwd: sandbox,
        env: { HOME: home, MONKE_HOME: monkeHome },
        onStderr() {},
        onStdout() {}
      });

      await runCliAsync(["skills", "add", personal], runtime);
      const registryLink = path.join(monkeHome, "skill-registry/skills/internal");
      const previousLink = readlinkSync(registryLink);
      const candidate = path.join(sandbox, "candidate");
      prepareSource(candidate);

      if (scenario === "removed bundled import") {
        // The registry's selection is authoritative, even when the candidate still bundles this slug.
        write(
          candidate,
          "skills/imported/obsolete/SKILL.md",
          "---\nname: obsolete\n---\nBundled skill.\n"
        );
        write(home, ".claude/skills/obsolete/SKILL.md", "User-owned obsolete skill.\n");
      }

      if (scenario === "personal target") {
        rmSync(path.join(home, ".claude/skills/personal"));
        write(home, ".claude/skills/personal/SKILL.md", "User-owned personal skill.\n");
      } else if (scenario === "owned duplicate") {
        write(
          candidate,
          "skills/internal/personal/SKILL.md",
          "---\nname: personal\n---\nNew owned skill.\n"
        );
      }

      const protectedEntry = path.join(
        home,
        ".claude/skills",
        scenario === "removed bundled import" ? "obsolete" : "personal",
        "SKILL.md"
      );

      const protectedBytes = readFileSync(protectedEntry, "utf-8");
      let outcome = "activated";

      try {
        await activateLocal({
          home,
          installId: "local-collision",
          monkeHome,
          sourceCheckout: candidate,
          targetKinds: ["claude"]
        });
      } catch (cause) {
        outcome = errorMessage(ThrownValueSchema.parse(cause));
      }

      const succeeds = scenario === "removed bundled import";
      expect(outcome).toMatch(succeeds ? /^activated$/u : /preflight failed/u);
      expect(readlinkSync(path.join(monkeHome, "current"))).toBe(
        path.join("installs", succeeds ? "local-collision" : "local-first")
      );
      expect(readlinkSync(registryLink)).toBe(
        succeeds ? path.join(candidate, "skills/internal") : previousLink
      );
      expect(existsSync(path.join(monkeHome, "installs/local-collision"))).toBe(succeeds);
      expect(readFileSync(protectedEntry, "utf-8")).toBe(protectedBytes);
    }
  );

  it.each(["retained imports", "provider collision", "registry collision"] as const)(
    "reconciles a newly bundled source with %s during Local install refresh",
    async (scenario) => {
      const sandbox = makeTempDir("local-install-new-bundle");
      const home = path.join(sandbox, "home");
      const monkeHome = path.join(sandbox, "monke-home");
      const sourceCheckout = path.join(sandbox, "source");
      prepareSource(sourceCheckout);
      await activateLocal({ home, installId: "local-first", monkeHome, sourceCheckout });
      const personal = path.join(sandbox, "personal-source");
      write(personal, "personal/SKILL.md", "---\nname: personal\n---\nPersonal instructions.\n");

      const runtime = createTestRuntime({
        cwd: sandbox,
        env: { HOME: home, MONKE_HOME: monkeHome },
        onStderr() {},
        onStdout() {}
      });

      await runCliAsync(["skills", "add", personal, "--link", "--command", "exit 42"], runtime);
      await runCliAsync(
        ["skills", "policy", "personal-source", "--model-invocation", "deny"],
        runtime
      );
      const registry = path.join(monkeHome, "skill-registry");
      const accepted = readImportRecipeStore(registry);
      const slug = scenario === "registry collision" ? "personal" : "bundled";
      const skills = [{ kind: "skill" as const, selector: slug, slug }];
      write(
        sourceCheckout,
        `skills/imported/${slug}/SKILL.md`,
        `---\nname: ${slug}\n---\nBundled instructions.\n`
      );
      writeRepoImportRecipeStore(sourceCheckout, {
        recipes: [
          {
            commit: "0".repeat(40),
            skills,
            source: "https://example.com/bundled"
          }
        ],
        version: 4
      });

      for (const recipe of readImportRecipeStore(sourceCheckout).recipes) {
        rememberRestoredRecipe(sourceCheckout, recipe);
      }

      if (scenario === "provider collision") {
        write(home, ".claude/skills/bundled/SKILL.md", "User-owned skill.\n");
      }

      let outcome = "activated";

      try {
        await activateLocal({
          home,
          installId: "local-second",
          monkeHome,
          sourceCheckout,
          targetKinds: ["claude", "codex", "cursor"]
        });
      } catch (cause) {
        outcome = errorMessage(ThrownValueSchema.parse(cause));
      }

      const succeeds = scenario === "retained imports";
      expect(outcome).toMatch(
        succeeds
          ? /^activated$/u
          : scenario === "provider collision"
            ? /preflight failed/u
            : /owned by both/u
      );
      const { recipes } = readImportRecipeStore(registry);
      expect(
        recipes.filter((recipe) => recipe.source !== "https://example.com/bundled")
      ).toStrictEqual(accepted.recipes);
      expect(recipes).toHaveLength(accepted.recipes.length + Number(succeeds));
      expect(readlinkSync(path.join(monkeHome, "current"))).toBe(
        succeeds ? "installs/local-second" : "installs/local-first"
      );
      expect(realpathSync(path.join(home, ".codex/skills/monke-tools/imported/personal"))).toBe(
        path.join(personal, "personal")
      );
      expect(readFileSync(path.join(personal, "personal/SKILL.md"), "utf-8")).toContain(
        "disable-model-invocation: true"
      );

      for (const relative of [
        ".claude/skills",
        ".codex/skills/monke-tools/imported",
        ".cursor/skills/monke-tools/imported"
      ]) {
        const entry = path.join(home, relative, "bundled/SKILL.md");
        const contents = existsSync(entry) ? readFileSync(entry, "utf-8") : "";
        expect(contents).toBe(
          succeeds
            ? "---\nname: bundled\n---\nBundled instructions.\n"
            : scenario === "provider collision" && relative === ".claude/skills"
              ? "User-owned skill.\n"
              : ""
        );
      }
    }
  );

  it.each(["unnarrowed", "narrowed"] as const)(
    "follows publisher changes to a retained bundled source whose selection is %s during Local install refresh",
    async (selection) => {
      const sandbox = makeTempDir("local-install-bundled-changes");
      const home = path.join(sandbox, "home");
      const monkeHome = path.join(sandbox, "monke-home");
      const sourceCheckout = path.join(sandbox, "source");
      const source = "https://example.com/bundled";
      const skill = (slug: string) => ({ kind: "skill" as const, selector: slug, slug });
      prepareSource(sourceCheckout);

      const publish = (
        skills: { kind: "reference" | "skill"; selector: string; slug: string }[]
      ) => {
        writeRepoImportRecipeStore(sourceCheckout, {
          recipes: [{ commit: "0".repeat(40), skills, source }],
          version: 4
        });

        for (const recipe of readImportRecipeStore(sourceCheckout).recipes) {
          rememberRestoredRecipe(sourceCheckout, recipe);
        }
      };

      write(
        sourceCheckout,
        "skills/imported/diagnose/SKILL.md",
        "---\nname: diagnose\n---\nUpstream.\n"
      );
      write(sourceCheckout, "skills/imported/tidy/SKILL.md", "---\nname: tidy\n---\nTidy.\n");
      publish([skill("diagnose"), skill("tidy")]);
      await activateLocal({
        home,
        installId: "local-first",
        monkeHome,
        sourceCheckout,
        targetKinds: ["claude"]
      });
      // Any global Skill command creates the registry, as a personal import does.
      await runCliAsync(
        ["skills", "list"],
        createTestRuntime({
          cwd: sandbox,
          env: { HOME: home, MONKE_HOME: monkeHome },
          onStderr() {},
          onStdout() {}
        })
      );
      const registry = path.join(monkeHome, "skill-registry");

      if (selection === "narrowed") {
        const store = readImportRecipeStore(registry);
        writeImportRecipeStore(registry, {
          ...store,
          recipes: store.recipes.map((recipe) => ({ ...recipe, selection: ["diagnose", "tidy"] }))
        });
      }

      rmSync(path.join(sourceCheckout, "skills/imported/diagnose"), { recursive: true });
      write(sourceCheckout, "skills/references/imported/diagnose/MAIN.md", "Upstream.\n");
      write(sourceCheckout, "skills/imported/teach/SKILL.md", "---\nname: teach\n---\nTeach.\n");
      write(
        sourceCheckout,
        "skills/internal/diagnose/SKILL.md",
        "---\nname: diagnose\n---\nWrap.\n"
      );
      publish([{ ...skill("diagnose"), kind: "reference" }, skill("teach"), skill("tidy")]);
      await activateLocal({
        home,
        installId: "local-second",
        monkeHome,
        sourceCheckout,
        targetKinds: ["claude"]
      });

      const [recipe] = readImportRecipeStore(registry).recipes;
      expect(recipe?.skills).toStrictEqual(
        selection === "narrowed"
          ? [{ ...skill("diagnose"), kind: "reference" }, skill("tidy")]
          : readImportRecipeStore(sourceCheckout).recipes[0]?.skills
      );
      expect(existsSync(path.join(registry, "skills/imported/diagnose"))).toBeFalsy();
      expect(readFileSync(path.join(home, ".claude/skills/diagnose/SKILL.md"), "utf-8")).toContain(
        "Wrap."
      );
      expect(
        readFileSync(path.join(home, ".claude/references/imported/diagnose/MAIN.md"), "utf-8")
      ).toBe("Upstream.\n");
      expect(existsSync(path.join(home, ".claude/skills/teach"))).toBe(selection === "unnarrowed");
    }
  );

  it("completes guidance during Local install activation and reports both shell and Codiff failures", async () => {
    const sandbox = makeTempDir("local-install-codiff-failure");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const sourceCheckout = path.join(sandbox, "source");
    const installId = "local-codiff-failure";
    const stagedInstall = prepareStagedInstall(monkeHome, installId);
    prepareSource(sourceCheckout);
    mkdirSync(path.join(home, ".zshrc"), { recursive: true });

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
        createTestRuntime({
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
    ).rejects.toThrow(
      /Local tool install is active[\s\S]*Retry with: mt shell install[\s\S]*Retry with: mt install-dependencies/u
    );

    expect(readlinkSync(path.join(monkeHome, "current"))).toBe(path.join("installs", installId));
    expect(existsSync(path.join(monkeHome, "installs", installId, "mt"))).toBeTruthy();
    expect(
      existsSync(
        path.join(
          home,
          ".codex",
          "skills",
          "monke-tools",
          "internal",
          "monke-tools-core",
          "SKILL.md"
        )
      )
    ).toBeTruthy();
    expect(realpathSync(path.join(home, ".local", "bin", "mt"))).toBe(
      path.join(monkeHome, "installs", installId, "mt")
    );
  });

  it("reports the Active core and repair command on unexpected Local projection failure", async () => {
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

  it("rejects a fixed install root in Skills Configure after it stops being Active", async () => {
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

    const runningCommand = createTestRuntime({
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
