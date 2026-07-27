import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";

import { reconcileSkillNamespaces, resolveSkillInstallTargets } from "../src/skills.ts";
import { makeTempDir, write } from "./helpers.ts";

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
          { kind: "custom", path: path.join(homeDirectory, "team-skills") },
        ],
      },
    });

    expect(targets.map((target) => target.agentSkillRoot)).toStrictEqual([
      path.join(homeDirectory, ".codex", "skills"),
      path.join(homeDirectory, ".claude", "skills"),
      path.join(homeDirectory, ".cursor", "skills"),
      path.join(homeDirectory, "team-skills"),
    ]);
    expect(targets.map((target) => target.agentSkillRoot)).not.toContain(monkeHome);
  });

  test("custom skill roots reject the managed namespace path itself", () => {
    const homeDirectory = makeTempDir("skill-target-custom-invalid");

    expect(() =>
      resolveSkillInstallTargets({
        homeDirectory,
        preference: {
          targets: [{ kind: "custom", path: path.join(homeDirectory, "skills", "monke-tools") }],
        },
      }),
    ).toThrow(/Agent skill root/u);
  });

  test("skill namespace reconciliation creates missing roots and links the namespace to the source tree", () => {
    const sandbox = makeTempDir("skill-reconcile-create");
    const sourceCheckout = path.join(sandbox, "source");
    const agentSkillRoot = path.join(sandbox, "agent", "skills");
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n",
    );

    reconcileSkillNamespaces({
      homeDirectory: sandbox,
      nextPreference: {
        targets: [{ kind: "custom", path: agentSkillRoot }],
      },
      previousPreference: null,
      sourceCheckout,
      writeMessage() {},
    });

    const namespacePath = path.join(agentSkillRoot, "monke-tools");
    expect(existsSync(agentSkillRoot)).toBeTruthy();
    expect(lstatSync(namespacePath).isSymbolicLink()).toBeTruthy();
    expect(readlinkSync(namespacePath)).toBe(path.join(sourceCheckout, "skills"));
  });

  test("Claude skill reconciliation flattens source categories into the Agent skill root", () => {
    const sandbox = makeTempDir("skill-reconcile-claude-flat");
    const sourceCheckout = path.join(sandbox, "source");
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n",
    );
    write(sourceCheckout, "skills/imported/tdd/SKILL.md", "---\nname: tdd\n---\n");

    reconcileSkillNamespaces({
      homeDirectory: sandbox,
      nextPreference: {
        targets: [{ kind: "claude" }],
      },
      previousPreference: null,
      sourceCheckout,
      writeMessage() {},
    });

    const claudeSkillRoot = path.join(sandbox, ".claude", "skills");
    const manifestPath = path.join(claudeSkillRoot, ".monke-tools-flat-skills.json");
    const coreLink = path.join(claudeSkillRoot, "monke-tools-core");
    const tddLink = path.join(claudeSkillRoot, "tdd");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.links).toStrictEqual([
      {
        name: "monke-tools-core",
        sourcePath: path.join(sourceCheckout, "skills", "internal", "monke-tools-core"),
      },
      {
        name: "tdd",
        sourcePath: path.join(sourceCheckout, "skills", "imported", "tdd"),
      },
    ]);
    expect(manifest).not.toHaveProperty("supportingLinks");
    expect(lstatSync(coreLink).isSymbolicLink()).toBeTruthy();
    expect(readlinkSync(coreLink)).toBe(
      path.join(sourceCheckout, "skills", "internal", "monke-tools-core"),
    );
    expect(lstatSync(tddLink).isSymbolicLink()).toBeTruthy();
    expect(readlinkSync(tddLink)).toBe(path.join(sourceCheckout, "skills", "imported", "tdd"));
    expect(existsSync(path.join(claudeSkillRoot, "monke-tools"))).toBeFalsy();

    reconcileSkillNamespaces({
      homeDirectory: sandbox,
      nextPreference: {
        targets: [{ kind: "codex" }],
      },
      previousPreference: {
        targets: [{ kind: "claude" }],
      },
      sourceCheckout,
      writeMessage() {},
    });

    expect(existsSync(coreLink)).toBeFalsy();
    expect(existsSync(tddLink)).toBeFalsy();
    expect(existsSync(manifestPath)).toBeFalsy();
    expect(
      lstatSync(path.join(sandbox, ".codex", "skills", "monke-tools")).isSymbolicLink(),
    ).toBeTruthy();
  });

  test("Reference-backed skills resolve packaged references from namespaced and Claude flat targets", () => {
    const sandbox = makeTempDir("skill-reconcile-reference-backed");
    const sourceCheckout = path.join(sandbox, "source");
    const customSkillRoot = path.join(sandbox, "custom", "skills");
    const wrapperRelativePath = "skills/internal/code-review/SKILL.md";
    const upstreamRelativePath = "../../references/imported/code-review/MAIN.md";
    const standardsRelativePath = "../../references/internal/CODING_STANDARDS.md";
    write(
      sourceCheckout,
      wrapperRelativePath,
      `Use [base](${upstreamRelativePath}) and [standards](${standardsRelativePath}).\n`,
    );
    write(
      sourceCheckout,
      "skills/references/imported/code-review/MAIN.md",
      "upstream review workflow\n",
    );
    write(
      sourceCheckout,
      "skills/references/internal/CODING_STANDARDS.md",
      "team coding baseline\n",
    );

    reconcileSkillNamespaces({
      homeDirectory: sandbox,
      nextPreference: {
        targets: [{ kind: "custom", path: customSkillRoot }, { kind: "claude" }],
      },
      previousPreference: null,
      sourceCheckout,
      writeMessage() {},
    });

    const installedWrapperDirectories = [
      path.join(customSkillRoot, "monke-tools", "internal", "code-review"),
      path.join(sandbox, ".claude", "skills", "code-review"),
    ];
    for (const wrapperDirectory of installedWrapperDirectories) {
      expect(readFileSync(path.join(wrapperDirectory, upstreamRelativePath), "utf-8")).toBe(
        "upstream review workflow\n",
      );
      expect(readFileSync(path.join(wrapperDirectory, standardsRelativePath), "utf-8")).toBe(
        "team coding baseline\n",
      );
    }
    expect(
      JSON.parse(
        readFileSync(
          path.join(sandbox, ".claude", "skills", ".monke-tools-flat-skills.json"),
          "utf-8",
        ),
      ).supportingLinks,
    ).toStrictEqual([
      {
        sourcePath: path.join(sourceCheckout, "skills", "references"),
        targetPath: path.join(sandbox, ".claude", "references"),
      },
    ]);
    expect(existsSync(path.join(sandbox, ".claude", "skills", "references"))).toBeFalsy();

    reconcileSkillNamespaces({
      homeDirectory: sandbox,
      nextPreference: {
        targets: [{ kind: "custom", path: customSkillRoot }],
      },
      previousPreference: {
        targets: [{ kind: "custom", path: customSkillRoot }, { kind: "claude" }],
      },
      sourceCheckout,
      writeMessage() {},
    });
    expect(existsSync(path.join(sandbox, ".claude", "references"))).toBeFalsy();
  });

  test("Claude skill reconciliation rejects unknown future flat manifest versions", () => {
    const sandbox = makeTempDir("skill-reconcile-future-manifest");
    const sourceCheckout = path.join(sandbox, "source");
    const claudeSkillRoot = path.join(sandbox, ".claude", "skills");
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n",
    );
    write(
      claudeSkillRoot,
      ".monke-tools-flat-skills.json",
      JSON.stringify({ links: [], managedBy: "monke-tools", version: 2 }),
    );

    expect(() => {
      reconcileSkillNamespaces({
        homeDirectory: sandbox,
        nextPreference: { targets: [{ kind: "claude" }] },
        previousPreference: { targets: [{ kind: "claude" }] },
        sourceCheckout,
        writeMessage() {},
      });
    }).toThrow(/Invalid monke-tools flat Skill manifest/u);
  });

  test("skill namespace reconciliation attempts every selected target before failing on unmanaged namespaces", () => {
    const sandbox = makeTempDir("skill-reconcile-partial");
    const sourceCheckout = path.join(sandbox, "source");
    const blockedSkillRoot = path.join(sandbox, "blocked", "skills");
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n",
    );
    mkdirSync(path.join(blockedSkillRoot, "monke-tools"), { recursive: true });

    expect(() => {
      reconcileSkillNamespaces({
        homeDirectory: sandbox,
        nextPreference: {
          targets: [{ kind: "codex" }, { kind: "custom", path: blockedSkillRoot }],
        },
        previousPreference: null,
        sourceCheckout,
        writeMessage() {},
      });
    }).toThrow(/Failed to reconcile 1 Skill install target/u);

    const codexNamespace = path.join(sandbox, ".codex", "skills", "monke-tools");
    expect(lstatSync(codexNamespace).isSymbolicLink()).toBeTruthy();
    expect(lstatSync(path.join(blockedSkillRoot, "monke-tools")).isDirectory()).toBeTruthy();
  });

  test("skill namespace reconciliation continues after deselected target cleanup failures", () => {
    const sandbox = makeTempDir("skill-reconcile-cleanup-partial");
    const sourceCheckout = path.join(sandbox, "source");
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n",
    );
    write(path.join(sandbox, ".claude", "skills"), ".monke-tools-flat-skills.json", "{}");

    expect(() => {
      reconcileSkillNamespaces({
        homeDirectory: sandbox,
        nextPreference: {
          targets: [{ kind: "codex" }],
        },
        previousPreference: {
          targets: [{ kind: "claude" }],
        },
        sourceCheckout,
        writeMessage() {},
      });
    }).toThrow(/Failed to reconcile 1 Skill install target/u);

    expect(
      lstatSync(path.join(sandbox, ".codex", "skills", "monke-tools")).isSymbolicLink(),
    ).toBeTruthy();
  });

  test("skill namespace reconciliation removes deselected managed namespaces", () => {
    const sandbox = makeTempDir("skill-reconcile-deselect");
    const sourceCheckout = path.join(sandbox, "source");
    const oldSkillRoot = path.join(sandbox, "old", "skills");
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n",
    );
    mkdirSync(oldSkillRoot, { recursive: true });
    symlinkSync(path.join(sourceCheckout, "skills"), path.join(oldSkillRoot, "monke-tools"), "dir");

    reconcileSkillNamespaces({
      homeDirectory: sandbox,
      nextPreference: {
        targets: [{ kind: "codex" }],
      },
      previousPreference: {
        targets: [{ kind: "custom", path: oldSkillRoot }],
      },
      sourceCheckout,
      writeMessage() {},
    });

    expect(existsSync(path.join(oldSkillRoot, "monke-tools"))).toBeFalsy();
    expect(
      lstatSync(path.join(sandbox, ".codex", "skills", "monke-tools")).isSymbolicLink(),
    ).toBeTruthy();
  });
});
