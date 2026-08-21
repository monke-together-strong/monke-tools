import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { reconcileSkillNamespaces, resolveSkillInstallTargets } from "../src/skills.ts";
import { makeTempDir, write, writeGlobalInstructionsSource } from "./helpers.ts";

describe("skills", () => {
  test("skill install targets resolve built-ins against OS home and normalize custom skill roots", () => {
    const homeDirectory = makeTempDir("skill-target-home");
    const monkeHome = makeTempDir("skill-target-monke-home");

    const targets = resolveSkillInstallTargets({
      homeDirectory,
      preference: {
        targets: [
          { kind: "codex" },
          { kind: "claude" },
          { kind: "cursor" },
          { kind: "custom", path: path.join(homeDirectory, "team-skills") }
        ]
      }
    });

    expect(targets.map((target) => target.agentSkillRoot)).toStrictEqual([
      path.join(homeDirectory, ".codex", "skills"),
      path.join(homeDirectory, ".claude", "skills"),
      path.join(homeDirectory, ".cursor", "skills"),
      path.join(homeDirectory, "team-skills")
    ]);
    expect(targets.map((target) => target.agentSkillRoot)).not.toContain(monkeHome);
  });

  test("custom skill roots reject the managed namespace path itself", () => {
    const homeDirectory = makeTempDir("skill-target-custom-invalid");

    expect(() =>
      resolveSkillInstallTargets({
        homeDirectory,
        preference: {
          targets: [{ kind: "custom", path: path.join(homeDirectory, "skills", "monke-tools") }]
        }
      })
    ).toThrow(/Agent skill root/u);
  });

  test("skill namespace reconciliation projects Codex-only skills only into Codex", () => {
    const sandbox = makeTempDir("skill-reconcile-project");
    const sourceCheckout = path.join(sandbox, "source");
    writeGlobalInstructionsSource(sourceCheckout);
    const customSkillRoot = path.join(sandbox, "custom", "skills");
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n"
    );
    write(sourceCheckout, "skills/imported/tdd/SKILL.md", "---\nname: tdd\n---\n");
    write(
      sourceCheckout,
      "skills/codex/codex-chrome-use/SKILL.md",
      "---\nname: codex-chrome-use\n---\n"
    );
    write(sourceCheckout, "skills/references/internal/README.md", "shared reference\n");

    reconcileSkillNamespaces({
      cwd: sandbox,
      guidanceSourceRoot: sourceCheckout,
      homeDirectory: sandbox,
      nextPreference: {
        targets: [{ kind: "codex" }, { kind: "cursor" }, { kind: "custom", path: customSkillRoot }]
      },
      previousPreference: null,
      writeMessage() {}
    });

    const projections = [
      { path: path.join(sandbox, ".codex", "skills", "monke-tools"), seesCodex: true },
      { path: path.join(sandbox, ".cursor", "skills", "monke-tools"), seesCodex: false },
      { path: path.join(customSkillRoot, "monke-tools"), seesCodex: false }
    ];
    for (const projection of projections) {
      expect(lstatSync(projection.path).isDirectory()).toBeTruthy();
      for (const sourceFolder of ["imported", "internal", "references"]) {
        const installedPath = path.join(projection.path, sourceFolder);
        expect(lstatSync(installedPath).isSymbolicLink()).toBeTruthy();
        expect(readlinkSync(installedPath)).toBe(path.join(sourceCheckout, "skills", sourceFolder));
      }
      expect(existsSync(path.join(projection.path, "codex"))).toBe(projection.seesCodex);
    }
  });

  test("Claude skill reconciliation flattens source categories into the Agent skill root", () => {
    const sandbox = makeTempDir("skill-reconcile-claude-flat");
    const sourceCheckout = path.join(sandbox, "source");
    writeGlobalInstructionsSource(sourceCheckout);
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n"
    );
    write(sourceCheckout, "skills/imported/tdd/SKILL.md", "---\nname: tdd\n---\n");
    write(
      sourceCheckout,
      "skills/codex/codex-chrome-use/SKILL.md",
      "---\nname: codex-chrome-use\n---\n"
    );

    reconcileSkillNamespaces({
      cwd: sandbox,
      guidanceSourceRoot: sourceCheckout,
      homeDirectory: sandbox,
      nextPreference: {
        targets: [{ kind: "claude" }]
      },
      previousPreference: null,
      writeMessage() {}
    });

    const claudeSkillRoot = path.join(sandbox, ".claude", "skills");
    const manifestPath = path.join(claudeSkillRoot, ".monke-tools-flat-skills.json");
    const coreLink = path.join(claudeSkillRoot, "monke-tools-core");
    const tddLink = path.join(claudeSkillRoot, "tdd");
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest).toMatchObject({
      links: [
        {
          name: "monke-tools-core",
          sourcePath: path.join(sourceCheckout, "skills", "internal", "monke-tools-core")
        },
        {
          name: "tdd",
          sourcePath: path.join(sourceCheckout, "skills", "imported", "tdd")
        }
      ]
    });
    expect(manifest).not.toHaveProperty("supportingLinks");
    expect(lstatSync(coreLink).isSymbolicLink()).toBeTruthy();
    expect(readlinkSync(coreLink)).toBe(
      path.join(sourceCheckout, "skills", "internal", "monke-tools-core")
    );
    expect(lstatSync(tddLink).isSymbolicLink()).toBeTruthy();
    expect(readlinkSync(tddLink)).toBe(path.join(sourceCheckout, "skills", "imported", "tdd"));
    expect(existsSync(path.join(claudeSkillRoot, "codex-chrome-use"))).toBeFalsy();
    expect(existsSync(path.join(claudeSkillRoot, "monke-tools"))).toBeFalsy();

    reconcileSkillNamespaces({
      cwd: sandbox,
      guidanceSourceRoot: sourceCheckout,
      homeDirectory: sandbox,
      nextPreference: {
        targets: [{ kind: "codex" }]
      },
      previousPreference: {
        targets: [{ kind: "claude" }]
      },
      writeMessage() {}
    });

    expect(existsSync(coreLink)).toBeFalsy();
    expect(existsSync(tddLink)).toBeFalsy();
    expect(existsSync(manifestPath)).toBeFalsy();
    const codexNamespace = path.join(sandbox, ".codex", "skills", "monke-tools");
    expect(lstatSync(codexNamespace).isDirectory()).toBeTruthy();
    expect(lstatSync(path.join(codexNamespace, "codex")).isSymbolicLink()).toBeTruthy();
  });

  test("Reference-backed skills resolve packaged references from namespaced and Claude flat targets", () => {
    const sandbox = makeTempDir("skill-reconcile-reference-backed");
    const sourceCheckout = path.join(sandbox, "source");
    writeGlobalInstructionsSource(sourceCheckout);
    const customSkillRoot = path.join(sandbox, "custom", "skills");
    const wrapperRelativePath = "skills/internal/code-review/SKILL.md";
    const upstreamRelativePath = "../../references/imported/code-review/MAIN.md";
    const standardsRelativePath = "../../references/internal/CODING_STANDARDS.md";
    write(
      sourceCheckout,
      wrapperRelativePath,
      `Use [base](${upstreamRelativePath}) and [standards](${standardsRelativePath}).\n`
    );
    write(
      sourceCheckout,
      "skills/references/imported/code-review/MAIN.md",
      "upstream review workflow\n"
    );
    write(
      sourceCheckout,
      "skills/references/internal/CODING_STANDARDS.md",
      "team coding baseline\n"
    );

    reconcileSkillNamespaces({
      cwd: sandbox,
      guidanceSourceRoot: sourceCheckout,
      homeDirectory: sandbox,
      nextPreference: {
        targets: [{ kind: "custom", path: customSkillRoot }, { kind: "claude" }]
      },
      previousPreference: null,
      writeMessage() {}
    });

    const installedWrapperDirectories = [
      path.join(customSkillRoot, "monke-tools", "internal", "code-review"),
      path.join(sandbox, ".claude", "skills", "code-review")
    ];
    for (const wrapperDirectory of installedWrapperDirectories) {
      expect(readFileSync(path.join(wrapperDirectory, upstreamRelativePath), "utf-8")).toBe(
        "upstream review workflow\n"
      );
      expect(readFileSync(path.join(wrapperDirectory, standardsRelativePath), "utf-8")).toBe(
        "team coding baseline\n"
      );
    }
    expect(
      JSON.parse(
        readFileSync(
          path.join(sandbox, ".claude", "skills", ".monke-tools-flat-skills.json"),
          "utf-8"
        )
      )
    ).toMatchObject({
      supportingLinks: [
        {
          sourcePath: path.join(sourceCheckout, "skills", "references"),
          targetPath: path.join(sandbox, ".claude", "references")
        }
      ]
    });
    expect(existsSync(path.join(sandbox, ".claude", "skills", "references"))).toBeFalsy();

    reconcileSkillNamespaces({
      cwd: sandbox,
      guidanceSourceRoot: sourceCheckout,
      homeDirectory: sandbox,
      nextPreference: {
        targets: [{ kind: "custom", path: customSkillRoot }]
      },
      previousPreference: {
        targets: [{ kind: "custom", path: customSkillRoot }, { kind: "claude" }]
      },
      writeMessage() {}
    });
    expect(existsSync(path.join(sandbox, ".claude", "references"))).toBeFalsy();
  });

  test("Claude skill reconciliation rejects unknown future flat manifest versions", () => {
    const sandbox = makeTempDir("skill-reconcile-future-manifest");
    const sourceCheckout = path.join(sandbox, "source");
    writeGlobalInstructionsSource(sourceCheckout);
    const claudeSkillRoot = path.join(sandbox, ".claude", "skills");
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n"
    );
    write(
      claudeSkillRoot,
      ".monke-tools-flat-skills.json",
      JSON.stringify({ links: [], managedBy: "monke-tools", version: 2 })
    );

    expect(() => {
      reconcileSkillNamespaces({
        cwd: sandbox,
        guidanceSourceRoot: sourceCheckout,
        homeDirectory: sandbox,
        nextPreference: { targets: [{ kind: "claude" }] },
        previousPreference: { targets: [{ kind: "claude" }] },
        writeMessage() {}
      });
    }).toThrow(/Invalid monke-tools flat Skill manifest/u);
  });

  test("skill namespace reconciliation attempts every selected target before failing on unmanaged namespaces", () => {
    const sandbox = makeTempDir("skill-reconcile-partial");
    const sourceCheckout = path.join(sandbox, "source");
    writeGlobalInstructionsSource(sourceCheckout);
    const blockedSkillRoot = path.join(sandbox, "blocked", "skills");
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n"
    );
    mkdirSync(path.join(blockedSkillRoot, "monke-tools", "internal"), { recursive: true });

    expect(() => {
      reconcileSkillNamespaces({
        cwd: sandbox,
        guidanceSourceRoot: sourceCheckout,
        homeDirectory: sandbox,
        nextPreference: {
          targets: [{ kind: "codex" }, { kind: "custom", path: blockedSkillRoot }]
        },
        previousPreference: null,
        writeMessage() {}
      });
    }).toThrow(/Failed to reconcile 1 Skill install target/u);

    const codexNamespace = path.join(sandbox, ".codex", "skills", "monke-tools");
    expect(lstatSync(codexNamespace).isDirectory()).toBeTruthy();
    expect(lstatSync(path.join(blockedSkillRoot, "monke-tools")).isDirectory()).toBeTruthy();
  });

  test("skill namespace reconciliation continues after deselected target cleanup failures", () => {
    const sandbox = makeTempDir("skill-reconcile-cleanup-partial");
    const sourceCheckout = path.join(sandbox, "source");
    writeGlobalInstructionsSource(sourceCheckout);
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n"
    );
    write(path.join(sandbox, ".claude", "skills"), ".monke-tools-flat-skills.json", "{}");

    expect(() => {
      reconcileSkillNamespaces({
        cwd: sandbox,
        guidanceSourceRoot: sourceCheckout,
        homeDirectory: sandbox,
        nextPreference: {
          targets: [{ kind: "codex" }]
        },
        previousPreference: {
          targets: [{ kind: "claude" }]
        },
        writeMessage() {}
      });
    }).toThrow(/Failed to reconcile 1 Skill install target/u);

    expect(
      lstatSync(path.join(sandbox, ".codex", "skills", "monke-tools")).isDirectory()
    ).toBeTruthy();
  });

  test("skill namespace reconciliation removes deselected managed namespaces", () => {
    const sandbox = makeTempDir("skill-reconcile-deselect");
    const sourceCheckout = path.join(sandbox, "source");
    writeGlobalInstructionsSource(sourceCheckout);
    const oldSkillRoot = path.join(sandbox, "old", "skills");
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n"
    );
    reconcileSkillNamespaces({
      cwd: sandbox,
      guidanceSourceRoot: sourceCheckout,
      homeDirectory: sandbox,
      nextPreference: {
        targets: [{ kind: "custom", path: oldSkillRoot }]
      },
      previousPreference: null,
      writeMessage() {}
    });

    reconcileSkillNamespaces({
      cwd: sandbox,
      guidanceSourceRoot: sourceCheckout,
      homeDirectory: sandbox,
      nextPreference: {
        targets: [{ kind: "codex" }]
      },
      previousPreference: {
        targets: [{ kind: "custom", path: oldSkillRoot }]
      },
      writeMessage() {}
    });

    expect(existsSync(path.join(oldSkillRoot, "monke-tools"))).toBeFalsy();
    expect(
      lstatSync(path.join(sandbox, ".codex", "skills", "monke-tools")).isDirectory()
    ).toBeTruthy();
  });
});
