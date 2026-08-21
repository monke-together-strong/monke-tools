import { existsSync, lstatSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { saveGlobalMonkeConfig, loadGlobalMonkeConfig } from "../src/global-config.ts";
import { runCliAsync } from "../src/index.ts";
import { createRuntime } from "../src/runtime.ts";
import type { MultiSelectPrompt } from "../src/types.ts";
import { makeTempDir, write, writeGlobalInstructionsSource } from "./helpers.ts";

function managedInstructions(body: string) {
  return `<!-- monke-rules:start -->

${body}<!-- monke-rules:end -->
`;
}

function writeSkillSource(sourceCheckout: string, body = "Team baseline.\n") {
  write(
    sourceCheckout,
    "skills/internal/monke-tools-core/SKILL.md",
    "---\nname: monke-tools-core\n---\n"
  );
  writeGlobalInstructionsSource(sourceCheckout, body);
}

function skillsEnvironment(osHome: string, monkeHome: string) {
  return {
    CLAUDE_CONFIG_DIR: path.join(osHome, ".claude"),
    CODEX_HOME: path.join(osHome, ".codex"),
    HOME: osHome,
    MONKE_HOME: monkeHome
  };
}

function selectActiveLocalInstall(monkeHome: string, sourceCheckout: string) {
  const installId = "local-fixture";
  write(
    monkeHome,
    `installs/${installId}/install-manifest.json`,
    `${JSON.stringify(
      {
        createdAt: "2026-08-20T12:34:56.000Z",
        createdBy: "bun run install:local",
        installId,
        installKind: "local",
        minimumCodiffVersion: "1.9.0",
        platform: "darwin-arm64",
        schemaVersion: 1,
        sourceCheckout,
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        sourceDirty: false,
        toolBuildIdentity: "local+0123456"
      },
      null,
      2
    )}\n`
  );
  symlinkSync(path.join("installs", installId), path.join(monkeHome, "current"), "dir");
}

function selectActiveReleaseInstall(monkeHome: string) {
  const installId = "release-1.2.3-linux-x64";
  write(
    monkeHome,
    `installs/${installId}/install-manifest.json`,
    `${JSON.stringify({
      artifactDigest: "0".repeat(64),
      artifactName: "monke-tools-v1.2.3-linux-x64.tar.gz",
      createdAt: "2026-08-20T12:34:56.000Z",
      guidanceHashes: {},
      installKind: "release",
      minimumCodiffVersion: "1.9.0",
      platform: "linux-x64",
      releaseTag: "monke-tools-v1.2.3",
      releaseVersion: "1.2.3",
      schemaVersion: 1,
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      toolBuildIdentity: "1.2.3"
    })}\n`
  );
  symlinkSync(path.join("installs", installId), path.join(monkeHome, "current"), "dir");
}

describe("skills CLI", () => {
  test("mt skills local-install rejects an Active Release install", async () => {
    const sandbox = makeTempDir("skills-local-install-release");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    writeSkillSource(sourceCheckout);
    selectActiveReleaseInstall(monkeHome);

    await expect(
      runCliAsync(
        ["skills", "local-install", sourceCheckout, "--targets", "codex"],
        createRuntime({
          cwd: sandbox,
          env: skillsEnvironment(osHome, monkeHome),
          onStderr() {},
          onStdout() {}
        })
      )
    ).rejects.toThrow("requires an Active Local tool install");
    expect(existsSync(path.join(osHome, ".codex", "skills", "monke-tools"))).toBeFalsy();
  });

  test("mt skills local-install rejects a checkout other than the Active Local checkout", async () => {
    const sandbox = makeTempDir("skills-local-install-checkout-mismatch");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const activeCheckout = path.join(sandbox, "active-source");
    const requestedCheckout = path.join(sandbox, "requested-source");
    writeSkillSource(requestedCheckout);
    selectActiveLocalInstall(monkeHome, activeCheckout);

    await expect(
      runCliAsync(
        ["skills", "local-install", requestedCheckout, "--targets", "codex"],
        createRuntime({
          cwd: sandbox,
          env: skillsEnvironment(osHome, monkeHome),
          onStderr() {},
          onStdout() {}
        })
      )
    ).rejects.toThrow("does not match the Active Local install");
  });

  test("failed deselected-target cleanup remains repairable with mt skills configure", async () => {
    const sandbox = makeTempDir("skills-local-install-cleanup-repair");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    const flatManifest = path.join(osHome, ".claude", "skills", ".monke-tools-flat-skills.json");
    writeSkillSource(sourceCheckout);
    selectActiveLocalInstall(monkeHome, sourceCheckout);
    saveGlobalMonkeConfig(monkeHome, {
      skillInstallPreference: { targets: [{ kind: "claude" }] },
      version: 1
    });
    write(path.dirname(flatManifest), path.basename(flatManifest), "{}\n");

    await expect(
      runCliAsync(
        ["skills", "local-install", sourceCheckout, "--targets", "codex"],
        createRuntime({
          cwd: sandbox,
          env: skillsEnvironment(osHome, monkeHome),
          onStderr() {},
          onStdout() {}
        })
      )
    ).rejects.toThrow("Failed to reconcile 1 Skill install target");
    expect(loadGlobalMonkeConfig(monkeHome).skillInstallPreference).toStrictEqual({
      targets: [{ kind: "claude" }]
    });

    write(
      path.dirname(flatManifest),
      path.basename(flatManifest),
      `${JSON.stringify({
        links: [],
        managedBy: "monke-tools",
        supportingLinks: [],
        version: 1
      })}\n`
    );
    await runCliAsync(
      ["skills", "configure"],
      createRuntime({
        cwd: sandbox,
        env: skillsEnvironment(osHome, monkeHome),
        multiSelectValues: [["codex"]],
        onStderr() {},
        onStdout() {}
      })
    );
    expect(loadGlobalMonkeConfig(monkeHome).skillInstallPreference).toStrictEqual({
      targets: [{ kind: "codex" }]
    });
  });

  test("mt skills local-install installs shared Global agent instructions for Codex and Claude", async () => {
    const sandbox = makeTempDir("skills-local-install-instructions");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    writeSkillSource(sourceCheckout);
    selectActiveLocalInstall(monkeHome, sourceCheckout);

    await runCliAsync(
      ["skills", "local-install", sourceCheckout, "--targets", "codex", "claude", "cursor"],
      createRuntime({
        cwd: sandbox,
        env: skillsEnvironment(osHome, monkeHome),
        onStderr() {},
        onStdout() {}
      })
    );

    const expected = managedInstructions("Team baseline.\n");
    expect(readFileSync(path.join(osHome, ".codex", "AGENTS.md"), "utf-8")).toBe(expected);
    expect(readFileSync(path.join(osHome, ".claude", "CLAUDE.md"), "utf-8")).toBe(expected);
    expect(existsSync(path.join(osHome, ".cursor", "AGENTS.md"))).toBeFalsy();
  });

  test("mt skills local-install installs Global agent instructions for a Claude-only selection", async () => {
    const sandbox = makeTempDir("skills-local-install-instructions-claude-only");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    writeSkillSource(sourceCheckout);
    selectActiveLocalInstall(monkeHome, sourceCheckout);

    await runCliAsync(
      ["skills", "local-install", sourceCheckout, "--targets", "claude"],
      createRuntime({
        cwd: sandbox,
        env: skillsEnvironment(osHome, monkeHome),
        onStderr() {},
        onStdout() {}
      })
    );

    expect(readFileSync(path.join(osHome, ".claude", "CLAUDE.md"), "utf-8")).toContain(
      "Team baseline."
    );
    expect(existsSync(path.join(osHome, ".codex", "AGENTS.md"))).toBeFalsy();
  });

  test("mt skills configure leaves instructions untouched for a Custom-only selection", async () => {
    const sandbox = makeTempDir("skills-configure-instructions-skills-only");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n"
    );
    write(osHome, ".codex/AGENTS.md", "Personal Codex guidance.\n");
    write(osHome, ".claude/CLAUDE.md", "Personal Claude guidance.\n");
    selectActiveLocalInstall(monkeHome, sourceCheckout);

    await runCliAsync(
      ["skills", "configure"],
      createRuntime({
        cwd: sandbox,
        env: skillsEnvironment(osHome, monkeHome),
        multiSelectValues: [["custom"]],
        onStderr() {},
        onStdout() {},
        stdinText: "~/custom-skills\n"
      })
    );

    expect(readFileSync(path.join(osHome, ".codex", "AGENTS.md"), "utf-8")).toBe(
      "Personal Codex guidance.\n"
    );
    expect(readFileSync(path.join(osHome, ".claude", "CLAUDE.md"), "utf-8")).toBe(
      "Personal Claude guidance.\n"
    );
  });

  test("mt skills local-install leaves instructions untouched for a Cursor-only selection", async () => {
    const sandbox = makeTempDir("skills-local-install-instructions-cursor-only");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n"
    );
    write(osHome, ".codex/AGENTS.md", "Personal Codex guidance.\n");
    write(osHome, ".claude/CLAUDE.md", "Personal Claude guidance.\n");
    selectActiveLocalInstall(monkeHome, sourceCheckout);

    await runCliAsync(
      ["skills", "local-install", sourceCheckout, "--targets", "cursor"],
      createRuntime({
        cwd: sandbox,
        env: skillsEnvironment(osHome, monkeHome),
        onStderr() {},
        onStdout() {}
      })
    );

    expect(readFileSync(path.join(osHome, ".codex", "AGENTS.md"), "utf-8")).toBe(
      "Personal Codex guidance.\n"
    );
    expect(readFileSync(path.join(osHome, ".claude", "CLAUDE.md"), "utf-8")).toBe(
      "Personal Claude guidance.\n"
    );
  });

  test("mt skills local-install preserves user guidance while refreshing its Managed instruction section", async () => {
    const sandbox = makeTempDir("skills-local-install-instructions-refresh");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    writeSkillSource(sourceCheckout, "First team baseline.\n");
    write(osHome, ".codex/AGENTS.md", "Personal Codex guidance.\n");
    write(osHome, ".claude/CLAUDE.md", "Personal Claude guidance.\n");
    selectActiveLocalInstall(monkeHome, sourceCheckout);

    const runtime = createRuntime({
      cwd: sandbox,
      env: skillsEnvironment(osHome, monkeHome),
      onStderr() {},
      onStdout() {}
    });
    await runCliAsync(
      ["skills", "local-install", sourceCheckout, "--targets", "codex", "claude"],
      runtime
    );
    writeGlobalInstructionsSource(sourceCheckout, "Updated team baseline.\n");

    await runCliAsync(["skills", "local-install", sourceCheckout], runtime);

    const managed = managedInstructions("Updated team baseline.\n");
    expect(readFileSync(path.join(osHome, ".codex", "AGENTS.md"), "utf-8")).toBe(
      `Personal Codex guidance.\n${managed}`
    );
    expect(readFileSync(path.join(osHome, ".claude", "CLAUDE.md"), "utf-8")).toBe(
      `Personal Claude guidance.\n${managed}`
    );
  });

  test.each(["refresh", "remove"] as const)(
    "mt skills local-install consumes a CRLF boundary after Managed instructions during %s",
    async (operation) => {
      const sandbox = makeTempDir(`skills-local-install-instructions-crlf-${operation}`);
      const monkeHome = path.join(sandbox, "monke-home");
      const osHome = path.join(sandbox, "home");
      const sourceCheckout = path.join(sandbox, "source");
      writeSkillSource(sourceCheckout, "Updated team baseline.\n");
      write(
        osHome,
        ".codex/AGENTS.md",
        "Personal guidance.\n<!-- monke-rules:start -->\r\n\r\nOld team baseline.\r\n<!-- monke-rules:end -->\r\nFollowing guidance.\n"
      );
      saveGlobalMonkeConfig(monkeHome, {
        skillInstallPreference: { targets: [{ kind: "codex" }] },
        version: 1
      });
      selectActiveLocalInstall(monkeHome, sourceCheckout);

      await runCliAsync(
        [
          "skills",
          "local-install",
          sourceCheckout,
          "--targets",
          operation === "refresh" ? "codex" : "cursor"
        ],
        createRuntime({
          cwd: sandbox,
          env: skillsEnvironment(osHome, monkeHome),
          onStderr() {},
          onStdout() {}
        })
      );

      const expected =
        operation === "refresh"
          ? `Personal guidance.\n${managedInstructions("Updated team baseline.\n")}Following guidance.\n`
          : "Personal guidance.\nFollowing guidance.\n";
      expect(readFileSync(path.join(osHome, ".codex", "AGENTS.md"), "utf-8")).toBe(expected);
    }
  );

  test("mt skills local-install adopts only a whole-file Codex instructions match", async () => {
    const sandbox = makeTempDir("skills-local-install-instructions-adopt");
    const sourceCheckout = path.join(sandbox, "source");
    writeSkillSource(sourceCheckout);

    const exactHome = path.join(sandbox, "exact-home");
    const exactMonkeHome = path.join(sandbox, "exact-monke-home");
    write(exactHome, ".codex/AGENTS.md", "Team baseline.\n");
    selectActiveLocalInstall(exactMonkeHome, sourceCheckout);
    await runCliAsync(
      ["skills", "local-install", sourceCheckout, "--targets", "codex"],
      createRuntime({
        cwd: sandbox,
        env: skillsEnvironment(exactHome, exactMonkeHome),
        onStderr() {},
        onStdout() {}
      })
    );

    const managed = managedInstructions("Team baseline.\n");
    expect(readFileSync(path.join(exactHome, ".codex", "AGENTS.md"), "utf-8")).toBe(managed);

    const partialHome = path.join(sandbox, "partial-home");
    const partialMonkeHome = path.join(sandbox, "partial-monke-home");
    write(partialHome, ".codex/AGENTS.md", "Team baseline.\nPersonal addition.\n");
    selectActiveLocalInstall(partialMonkeHome, sourceCheckout);
    await runCliAsync(
      ["skills", "local-install", sourceCheckout, "--targets", "codex"],
      createRuntime({
        cwd: sandbox,
        env: skillsEnvironment(partialHome, partialMonkeHome),
        onStderr() {},
        onStdout() {}
      })
    );
    const partialManaged = managedInstructions("Team baseline.\n");
    expect(readFileSync(path.join(partialHome, ".codex", "AGENTS.md"), "utf-8")).toBe(
      `Team baseline.\nPersonal addition.\n${partialManaged}`
    );
  });

  test("mt skills local-install removes only Managed instruction sections when targets are deselected", async () => {
    const sandbox = makeTempDir("skills-local-install-instructions-deselect");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    writeSkillSource(sourceCheckout);
    write(osHome, ".claude/CLAUDE.md", "Personal Claude guidance.\n");
    selectActiveLocalInstall(monkeHome, sourceCheckout);
    const runtime = createRuntime({
      cwd: sandbox,
      env: skillsEnvironment(osHome, monkeHome),
      onStderr() {},
      onStdout() {}
    });

    await runCliAsync(
      ["skills", "local-install", sourceCheckout, "--targets", "codex", "claude"],
      runtime
    );
    await runCliAsync(["skills", "local-install", sourceCheckout, "--targets", "cursor"], runtime);

    expect(readFileSync(path.join(osHome, ".codex", "AGENTS.md"), "utf-8")).toBe("");
    expect(readFileSync(path.join(osHome, ".claude", "CLAUDE.md"), "utf-8")).toBe(
      "Personal Claude guidance.\n"
    );
  });

  test.each([
    "No trailing newline",
    "One trailing newline\n",
    "Two trailing newlines\n\n",
    "One CRLF trailing newline\r\n",
    "Two CRLF trailing newlines\r\n\r\n"
  ])(
    "mt skills local-install preserves user whitespace exactly when instructions are deselected: %j",
    async (userGuidance) => {
      const sandbox = makeTempDir("skills-local-install-instructions-whitespace");
      const monkeHome = path.join(sandbox, "monke-home");
      const osHome = path.join(sandbox, "home");
      const sourceCheckout = path.join(sandbox, "source");
      writeSkillSource(sourceCheckout);
      write(osHome, ".codex/AGENTS.md", userGuidance);
      selectActiveLocalInstall(monkeHome, sourceCheckout);
      const runtime = createRuntime({
        cwd: sandbox,
        env: skillsEnvironment(osHome, monkeHome),
        onStderr() {},
        onStdout() {}
      });

      await runCliAsync(["skills", "local-install", sourceCheckout, "--targets", "codex"], runtime);
      const installed = readFileSync(path.join(osHome, ".codex", "AGENTS.md"), "utf-8");
      expect(installed.startsWith(`${userGuidance}<!-- monke-rules:start -->`)).toBeTruthy();
      await runCliAsync(
        ["skills", "local-install", sourceCheckout, "--targets", "cursor"],
        runtime
      );

      expect(readFileSync(path.join(osHome, ".codex", "AGENTS.md"), "utf-8")).toBe(userGuidance);
    }
  );

  test("mt skills local-install preserves a pre-existing empty instruction file on deselection", async () => {
    const sandbox = makeTempDir("skills-local-install-instructions-empty");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    const destinationPath = path.join(osHome, ".codex", "AGENTS.md");
    writeSkillSource(sourceCheckout);
    write(osHome, ".codex/AGENTS.md", "");
    selectActiveLocalInstall(monkeHome, sourceCheckout);
    const runtime = createRuntime({
      cwd: sandbox,
      env: skillsEnvironment(osHome, monkeHome),
      onStderr() {},
      onStdout() {}
    });

    await runCliAsync(["skills", "local-install", sourceCheckout, "--targets", "codex"], runtime);
    await runCliAsync(["skills", "local-install", sourceCheckout, "--targets", "cursor"], runtime);

    expect(existsSync(destinationPath)).toBeTruthy();
    expect(readFileSync(destinationPath, "utf-8")).toBe("");
  });

  test("mt skills local-install honors harness config directories and preserves instruction symlinks", async () => {
    const sandbox = makeTempDir("skills-local-install-instructions-config");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    const codexHome = path.join(osHome, "codex-config");
    const claudeConfig = path.join(osHome, "claude-config");
    const dotfileTarget = path.join(sandbox, "dotfiles", "AGENTS.md");
    writeSkillSource(sourceCheckout);
    write(sandbox, "dotfiles/AGENTS.md", "Personal Codex guidance.\n");
    write(codexHome, ".keep", "\n");
    symlinkSync(dotfileTarget, path.join(codexHome, "AGENTS.md"));
    selectActiveLocalInstall(monkeHome, sourceCheckout);

    await runCliAsync(
      ["skills", "local-install", sourceCheckout, "--targets", "codex", "claude"],
      createRuntime({
        cwd: sandbox,
        env: {
          ...skillsEnvironment(osHome, monkeHome),
          CLAUDE_CONFIG_DIR: path.relative(sandbox, claudeConfig),
          CODEX_HOME: path.relative(sandbox, codexHome)
        },
        onStderr() {},
        onStdout() {}
      })
    );

    expect(lstatSync(path.join(codexHome, "AGENTS.md")).isSymbolicLink()).toBeTruthy();
    expect(readFileSync(dotfileTarget, "utf-8")).toContain(
      "Personal Codex guidance.\n<!-- monke-rules:start -->"
    );
    expect(readFileSync(path.join(claudeConfig, "CLAUDE.md"), "utf-8")).toContain("Team baseline.");
    expect(existsSync(path.join(osHome, ".codex", "AGENTS.md"))).toBeFalsy();
    expect(existsSync(path.join(osHome, ".claude", "CLAUDE.md"))).toBeFalsy();
  });

  test.each([
    ["CODEX_HOME", "codex"],
    ["CLAUDE_CONFIG_DIR", "claude"]
  ] as const)("mt skills local-install rejects whitespace-only %s", async (variable, target) => {
    const sandbox = makeTempDir("skills-local-install-instructions-empty-config");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    writeSkillSource(sourceCheckout);
    selectActiveLocalInstall(monkeHome, sourceCheckout);

    await expect(
      runCliAsync(
        ["skills", "local-install", sourceCheckout, "--targets", target],
        createRuntime({
          cwd: sandbox,
          env: {
            ...skillsEnvironment(osHome, monkeHome),
            [variable]: " \t "
          },
          onStderr() {},
          onStdout() {}
        })
      )
    ).rejects.toThrow(`Invalid ${variable} environment variable`);
  });

  test("mt skills local-install keeps an instruction symlink valid when deselection empties its target", async () => {
    const sandbox = makeTempDir("skills-local-install-instructions-symlink-deselect");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    const destinationPath = path.join(osHome, ".codex", "AGENTS.md");
    const dotfileTarget = path.join(sandbox, "dotfiles", "AGENTS.md");
    writeSkillSource(sourceCheckout);
    write(sandbox, "dotfiles/AGENTS.md", "");
    write(osHome, ".codex/.keep", "\n");
    symlinkSync(dotfileTarget, destinationPath);
    selectActiveLocalInstall(monkeHome, sourceCheckout);
    const runtime = createRuntime({
      cwd: sandbox,
      env: skillsEnvironment(osHome, monkeHome),
      onStderr() {},
      onStdout() {}
    });

    await runCliAsync(["skills", "local-install", sourceCheckout, "--targets", "codex"], runtime);
    await runCliAsync(["skills", "local-install", sourceCheckout, "--targets", "cursor"], runtime);

    expect(lstatSync(destinationPath).isSymbolicLink()).toBeTruthy();
    expect(readFileSync(dotfileTarget, "utf-8")).toBe("");
  });

  test.each(["broken", "cyclic", "non-file"] as const)(
    "mt skills local-install refuses a %s instruction symlink and continues other targets",
    async (symlinkState) => {
      const sandbox = makeTempDir(`skills-local-install-instructions-${symlinkState}`);
      const monkeHome = path.join(sandbox, "monke-home");
      const osHome = path.join(sandbox, "home");
      const sourceCheckout = path.join(sandbox, "source");
      const codexHome = path.join(osHome, ".codex");
      const destinationPath = path.join(codexHome, "AGENTS.md");
      writeSkillSource(sourceCheckout);
      write(codexHome, ".keep", "\n");
      if (symlinkState === "broken") {
        symlinkSync("missing.md", destinationPath);
      } else if (symlinkState === "cyclic") {
        symlinkSync("cycle.md", destinationPath);
        symlinkSync("AGENTS.md", path.join(codexHome, "cycle.md"));
      } else {
        write(codexHome, "directory-target/.keep", "\n");
        symlinkSync(path.join(codexHome, "directory-target"), destinationPath, "dir");
      }
      selectActiveLocalInstall(monkeHome, sourceCheckout);

      await expect(
        runCliAsync(
          ["skills", "local-install", sourceCheckout, "--targets", "codex", "claude"],
          createRuntime({
            cwd: sandbox,
            env: skillsEnvironment(osHome, monkeHome),
            onStderr() {},
            onStdout() {}
          })
        )
      ).rejects.toThrow(
        `Refusing to modify Global agent instructions at ${destinationPath}: destination symlink must resolve to a regular file`
      );
      expect(lstatSync(destinationPath).isSymbolicLink()).toBeTruthy();
      expect(readFileSync(path.join(osHome, ".claude", "CLAUDE.md"), "utf-8")).toContain(
        "Team baseline."
      );
    }
  );

  test.each([
    ["unmatched", "<!-- monke-rules:start -->\nOld body.\n"],
    ["reversed", "<!-- monke-rules:end -->\nOld body.\n<!-- monke-rules:start -->\n"],
    [
      "nested",
      "<!-- monke-rules:start -->\n<!-- monke-rules:start -->\nOld body.\n<!-- monke-rules:end -->\n<!-- monke-rules:end -->\n"
    ],
    [
      "duplicate",
      "<!-- monke-rules:start -->\nOne.\n<!-- monke-rules:end -->\n<!-- monke-rules:start -->\nTwo.\n<!-- monke-rules:end -->\n"
    ]
  ] as const)(
    "mt skills local-install refuses %s Managed instruction markers without stopping other targets",
    async (_markerState, malformedContent) => {
      const sandbox = makeTempDir("skills-local-install-instructions-markers");
      const monkeHome = path.join(sandbox, "monke-home");
      const osHome = path.join(sandbox, "home");
      const sourceCheckout = path.join(sandbox, "source");
      const codexInstructions = path.join(osHome, ".codex", "AGENTS.md");
      writeSkillSource(sourceCheckout);
      write(osHome, ".codex/AGENTS.md", malformedContent);
      selectActiveLocalInstall(monkeHome, sourceCheckout);

      await expect(
        runCliAsync(
          ["skills", "local-install", sourceCheckout, "--targets", "codex", "claude"],
          createRuntime({
            cwd: sandbox,
            env: skillsEnvironment(osHome, monkeHome),
            onStderr() {},
            onStdout() {}
          })
        )
      ).rejects.toThrow("Refusing to modify malformed Global agent instructions markers");
      expect(readFileSync(codexInstructions, "utf-8")).toBe(malformedContent);
      expect(readFileSync(path.join(osHome, ".claude", "CLAUDE.md"), "utf-8")).toContain(
        "Team baseline."
      );
    }
  );

  test("mt skills configure uses a multi-select and reconciles selected targets", async () => {
    const sandbox = makeTempDir("skills-configure");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    writeSkillSource(sourceCheckout);
    selectActiveLocalInstall(monkeHome, sourceCheckout);

    let stdout = "";
    let stderr = "";
    let installationLockObserved = false;
    let prompt: MultiSelectPrompt | undefined;
    const runtime = createRuntime({
      cwd: sandbox,
      env: skillsEnvironment(osHome, monkeHome),
      multiSelectValues: [["codex", "custom"]],
      onMultiSelect(value) {
        prompt = value;
        installationLockObserved = existsSync(path.join(monkeHome, "locks", "installation.lock"));
      },
      onStderr(text) {
        stderr += text;
      },
      onStdout(text) {
        stdout += text;
      },
      stdinText: "~/team-skills\n"
    });

    await runCliAsync(["skills", "configure"], runtime);

    expect(prompt).toStrictEqual({
      initialValues: [],
      message: "Skill install targets",
      options: [
        { label: "Codex", value: "codex" },
        { label: "Claude", value: "claude" },
        { label: "Cursor", value: "cursor" },
        { label: "Custom", value: "custom" }
      ],
      required: true
    });
    expect(loadGlobalMonkeConfig(monkeHome).skillInstallPreference).toStrictEqual({
      targets: [{ kind: "codex" }, { kind: "custom", path: path.join(osHome, "team-skills") }]
    });
    expect(
      lstatSync(path.join(osHome, ".codex", "skills", "monke-tools")).isDirectory()
    ).toBeTruthy();
    expect(lstatSync(path.join(osHome, "team-skills", "monke-tools")).isDirectory()).toBeTruthy();
    expect(stdout).not.toContain("comma-separated");
    expect(stderr).toContain("Configured monke-tools skills");
    expect(installationLockObserved).toBeTruthy();
    expect(existsSync(path.join(monkeHome, "locks", "installation.lock"))).toBeFalsy();
  });

  test("mt skills configure preselects existing targets when reconfiguring", async () => {
    const sandbox = makeTempDir("skills-configure-e2e");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    const customRoot = path.join(osHome, "custom-skills");
    writeSkillSource(sourceCheckout);
    selectActiveLocalInstall(monkeHome, sourceCheckout);

    await runCliAsync(
      ["skills", "configure"],
      createRuntime({
        cwd: sandbox,
        env: skillsEnvironment(osHome, monkeHome),
        multiSelectValues: [["codex", "claude", "cursor", "custom"]],
        onStderr() {},
        onStdout() {},
        stdinText: "~/custom-skills\n"
      })
    );
    let prompt: MultiSelectPrompt | undefined;
    await runCliAsync(
      ["skills", "configure"],
      createRuntime({
        cwd: sandbox,
        env: skillsEnvironment(osHome, monkeHome),
        multiSelectValues: [["claude", "codex"]],
        onMultiSelect(value) {
          prompt = value;
        },
        onStderr() {},
        onStdout() {}
      })
    );

    expect(prompt?.initialValues).toStrictEqual(["codex", "claude", "cursor", "custom"]);
    expect(loadGlobalMonkeConfig(monkeHome).skillInstallPreference).toStrictEqual({
      targets: [{ kind: "claude" }, { kind: "codex" }]
    });
    expect(
      lstatSync(path.join(osHome, ".claude", "skills", "monke-tools-core")).isSymbolicLink()
    ).toBeTruthy();
    expect(readlinkSync(path.join(osHome, ".claude", "skills", "monke-tools-core"))).toBe(
      path.join(sourceCheckout, "skills", "internal", "monke-tools-core")
    );
    expect(existsSync(path.join(osHome, ".claude", "skills", "monke-tools"))).toBeFalsy();
    expect(
      lstatSync(path.join(osHome, ".codex", "skills", "monke-tools")).isDirectory()
    ).toBeTruthy();
    expect(existsSync(path.join(osHome, ".cursor", "skills", "monke-tools"))).toBeFalsy();
    expect(existsSync(path.join(customRoot, "monke-tools"))).toBeFalsy();
  });

  test("mt skills local-install configures skills without duplicating Active install identity", async () => {
    const sandbox = makeTempDir("skills-local-install-first");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    writeSkillSource(sourceCheckout);
    selectActiveLocalInstall(monkeHome, sourceCheckout);

    await runCliAsync(
      ["skills", "local-install", sourceCheckout],
      createRuntime({
        cwd: sandbox,
        env: skillsEnvironment(osHome, monkeHome),
        multiSelectValues: [["codex"]],
        onStderr() {},
        onStdout() {}
      })
    );

    expect(loadGlobalMonkeConfig(monkeHome)).toStrictEqual({
      skillInstallPreference: {
        targets: [{ kind: "codex" }]
      },
      version: 1
    });
    expect(
      lstatSync(path.join(osHome, ".codex", "skills", "monke-tools")).isDirectory()
    ).toBeTruthy();
  });

  test("mt skills local-install accepts built-in targets without prompting", async () => {
    const sandbox = makeTempDir("skills-local-install-targets");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    writeSkillSource(sourceCheckout);
    selectActiveLocalInstall(monkeHome, sourceCheckout);

    await runCliAsync(
      ["skills", "local-install", sourceCheckout, "--targets", "claude", "cursor", "codex"],
      createRuntime({
        cwd: sandbox,
        env: skillsEnvironment(osHome, monkeHome),
        onMultiSelect() {
          throw new Error("Target arguments must bypass the interactive prompt");
        },
        onStderr() {},
        onStdout() {}
      })
    );

    expect(loadGlobalMonkeConfig(monkeHome)).toStrictEqual({
      skillInstallPreference: {
        targets: [{ kind: "claude" }, { kind: "cursor" }, { kind: "codex" }]
      },
      version: 1
    });
    expect(
      lstatSync(path.join(osHome, ".claude", "skills", "monke-tools-core")).isSymbolicLink()
    ).toBeTruthy();
    expect(
      lstatSync(path.join(osHome, ".cursor", "skills", "monke-tools")).isDirectory()
    ).toBeTruthy();
    expect(
      lstatSync(path.join(osHome, ".codex", "skills", "monke-tools")).isDirectory()
    ).toBeTruthy();
  });

  test("mt skills local-install replaces the saved preference when targets are explicit", async () => {
    const sandbox = makeTempDir("skills-local-install-reconfigure");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    writeSkillSource(sourceCheckout);
    saveGlobalMonkeConfig(monkeHome, {
      skillInstallPreference: {
        targets: [{ kind: "cursor" }]
      },
      version: 1
    });
    selectActiveLocalInstall(monkeHome, sourceCheckout);

    await runCliAsync(
      ["skills", "local-install", sourceCheckout, "--targets", "codex", "claude"],
      createRuntime({
        cwd: sandbox,
        env: skillsEnvironment(osHome, monkeHome),
        onStderr() {},
        onStdout() {}
      })
    );

    expect(loadGlobalMonkeConfig(monkeHome).skillInstallPreference).toStrictEqual({
      targets: [{ kind: "codex" }, { kind: "claude" }]
    });
    expect(existsSync(path.join(osHome, ".cursor", "skills", "monke-tools"))).toBeFalsy();
  });

  test("mt skills local-install reuses an existing preference and relinks after a checkout move", async () => {
    const sandbox = makeTempDir("skills-local-install-refresh");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const oldCheckout = path.join(sandbox, "old-source");
    const newCheckout = path.join(sandbox, "new-source");
    const namespacePath = path.join(osHome, ".codex", "skills", "monke-tools");
    write(
      oldCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n"
    );
    writeSkillSource(newCheckout);
    saveGlobalMonkeConfig(monkeHome, {
      skillInstallPreference: {
        targets: [{ kind: "codex" }]
      },
      version: 1
    });
    write(path.dirname(namespacePath), ".keep", "\n");
    symlinkSync(path.join(oldCheckout, "skills"), namespacePath, "dir");
    selectActiveLocalInstall(monkeHome, newCheckout);

    await runCliAsync(
      ["skills", "local-install", newCheckout],
      createRuntime({
        cwd: sandbox,
        env: skillsEnvironment(osHome, monkeHome),
        onStderr() {},
        onStdout() {}
      })
    );

    expect(loadGlobalMonkeConfig(monkeHome)).toStrictEqual({
      skillInstallPreference: { targets: [{ kind: "codex" }] },
      version: 1
    });
    expect(lstatSync(namespacePath).isDirectory()).toBeTruthy();
    expect(readlinkSync(path.join(namespacePath, "internal"))).toBe(
      path.join(newCheckout, "skills", "internal")
    );
  });

  test("mt skills configure fails clearly when the guidance source root is missing", async () => {
    const sandbox = makeTempDir("skills-configure-missing-source");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const missingCheckout = path.join(sandbox, "missing-source");
    selectActiveLocalInstall(monkeHome, missingCheckout);

    await expect(
      runCliAsync(
        ["skills", "configure"],
        createRuntime({
          cwd: sandbox,
          env: skillsEnvironment(osHome, monkeHome),
          onStderr() {},
          onStdout() {}
        })
      )
    ).rejects.toThrow(`Guidance source root is missing: ${missingCheckout}`);
    expect(loadGlobalMonkeConfig(monkeHome).skillInstallPreference).toBeUndefined();
  });
});
