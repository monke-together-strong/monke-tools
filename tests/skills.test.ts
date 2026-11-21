import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync
} from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { saveGlobalMonkeConfig } from "../src/global-config.ts";
import type { SkillInstallPreference } from "../src/global-config.ts";
import { createRuntime } from "../src/runtime.ts";
import {
  preflightInstallGuidance,
  reconcileSkillNamespaces,
  resolveSkillInstallTargets
} from "../src/skills.ts";
import { makeTempDir, write, writeGlobalInstructionsSource } from "./helpers.ts";

describe("skills", () => {
  it("rejects an empty preference for explicit Skill target selection before mutation", () => {
    const sandbox = makeTempDir("skill-target-empty-explicit");
    const homeDirectory = path.join(sandbox, "home");

    expect(() => {
      preflightInstallGuidance(
        createRuntime({
          cwd: sandbox,
          env: { HOME: homeDirectory, MONKE_HOME: path.join(sandbox, "monke-home") }
        }),
        path.join(sandbox, "guidance"),
        { builtInTargetKinds: [] }
      );
    }).toThrow(/explicit Skill install target selection[\s\S]*non-empty array/u);
    expect(existsSync(homeDirectory)).toBeFalsy();
  });

  it("resolves built-in skill install targets against OS home and normalizes custom skill roots", () => {
    const homeDirectory = makeTempDir("skill-target-home");

    const targets = resolveSkillInstallTargets({
      homeDirectory,
      preference: {
        targets: [
          { kind: "codex" },
          { kind: "claude" },
          { kind: "cursor" },
          { kind: "antigravity" },
          { kind: "custom", path: " ~/team-skills/ " }
        ]
      }
    });

    expect(targets.map((target) => target.agentSkillRoot)).toStrictEqual([
      path.join(homeDirectory, ".codex", "skills"),
      path.join(homeDirectory, ".claude", "skills"),
      path.join(homeDirectory, ".cursor", "skills"),
      path.join(homeDirectory, ".gemini", "config", "skills"),
      path.join(homeDirectory, "team-skills")
    ]);
  });

  it("rejects the managed namespace path itself as a custom skill root", () => {
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

  it("projects Codex-only skills only into Codex during skill namespace reconciliation", () => {
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
    write(sourceCheckout, "skills/codex/example/SKILL.md", "---\nname: example\n---\n");
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

  it.each([
    ["claude", [".claude", "skills"]],
    ["antigravity", [".gemini", "config", "skills"]]
  ] as const)(
    "flattens source categories into the %s Agent skill root during reconciliation",
    (kind, rootSegments) => {
      const sandbox = makeTempDir(`skill-reconcile-${kind}-flat`);
      const sourceCheckout = path.join(sandbox, "source");
      writeGlobalInstructionsSource(sourceCheckout);
      write(
        sourceCheckout,
        "skills/internal/monke-tools-core/SKILL.md",
        "---\nname: monke-tools-core\n---\n"
      );
      write(sourceCheckout, "skills/imported/tdd/SKILL.md", "---\nname: tdd\n---\n");
      write(sourceCheckout, "skills/codex/example/SKILL.md", "---\nname: example\n---\n");

      reconcileSkillNamespaces({
        cwd: sandbox,
        guidanceSourceRoot: sourceCheckout,
        homeDirectory: sandbox,
        nextPreference: {
          targets: [{ kind }]
        },
        previousPreference: null,
        writeMessage() {}
      });

      const agentSkillRoot = path.join(sandbox, ...rootSegments);
      const manifestPath = path.join(agentSkillRoot, ".monke-tools-flat-skills.json");
      const coreLink = path.join(agentSkillRoot, "monke-tools-core");
      const tddLink = path.join(agentSkillRoot, "tdd");
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
      expect(existsSync(path.join(agentSkillRoot, "example"))).toBeFalsy();
      expect(existsSync(path.join(agentSkillRoot, "monke-tools"))).toBeFalsy();

      reconcileSkillNamespaces({
        cwd: sandbox,
        guidanceSourceRoot: sourceCheckout,
        homeDirectory: sandbox,
        nextPreference: {
          targets: [{ kind: "codex" }]
        },
        previousPreference: {
          targets: [{ kind }]
        },
        writeMessage() {}
      });

      expect(existsSync(coreLink)).toBeFalsy();
      expect(existsSync(tddLink)).toBeFalsy();
      expect(existsSync(manifestPath)).toBeFalsy();
      const codexNamespace = path.join(sandbox, ".codex", "skills", "monke-tools");
      expect(lstatSync(codexNamespace).isDirectory()).toBeTruthy();
      expect(lstatSync(path.join(codexNamespace, "codex")).isSymbolicLink()).toBeTruthy();
    }
  );

  it("resolves packaged references for Reference-backed skills from namespaced and Claude flat targets", () => {
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

  it("rejects unknown future flat manifest versions during Claude skill reconciliation", () => {
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

  it.each(["../unrelated", "nested/skill", ".", "..", "skill\0name"])(
    "rejects unsafe Skill slug %j in the Claude manifest before removing links",
    (name) => {
      const sandbox = makeTempDir("skill-manifest-name-boundary");
      const sourceCheckout = path.join(sandbox, "source");
      writeGlobalInstructionsSource(sourceCheckout);
      write(sourceCheckout, "skills/internal/example/SKILL.md", "---\nname: example\n---\n");
      const skillRoot = path.join(sandbox, ".claude", "skills");
      const sourcePath = path.join(sourceCheckout, "skill");
      mkdirSync(skillRoot, { recursive: true });
      const unrelated = path.join(sandbox, ".claude", "unrelated");
      symlinkSync(sourcePath, unrelated);
      write(
        skillRoot,
        ".monke-tools-flat-skills.json",
        JSON.stringify({
          links: [{ name, sourcePath }],
          managedBy: "monke-tools",
          version: 1
        })
      );

      expect(() => {
        reconcileSkillNamespaces({
          cwd: sandbox,
          guidanceSourceRoot: sourceCheckout,
          homeDirectory: sandbox,
          nextPreference: { targets: [{ kind: "codex" }] },
          previousPreference: { targets: [{ kind: "claude" }] },
          writeMessage() {}
        });
      }).toThrow(/Invalid monke-tools flat Skill manifest/u);
      expect(readlinkSync(unrelated)).toBe(sourcePath);
    }
  );

  it("rejects supporting links outside the Claude manifest's references destination before removal", () => {
    const sandbox = makeTempDir("skill-manifest-supporting-boundary");
    const sourceCheckout = path.join(sandbox, "source");
    writeGlobalInstructionsSource(sourceCheckout);
    write(sourceCheckout, "skills/internal/example/SKILL.md", "---\nname: example\n---\n");
    const skillRoot = path.join(sandbox, ".claude", "skills");
    const sourcePath = path.join(sourceCheckout, "references");
    mkdirSync(skillRoot, { recursive: true });
    const unrelated = path.join(sandbox, "unrelated");
    symlinkSync(sourcePath, unrelated);
    write(
      skillRoot,
      ".monke-tools-flat-skills.json",
      JSON.stringify({
        links: [],
        managedBy: "monke-tools",
        supportingLinks: [{ sourcePath, targetPath: unrelated }],
        version: 1
      })
    );

    expect(() => {
      reconcileSkillNamespaces({
        cwd: sandbox,
        guidanceSourceRoot: sourceCheckout,
        homeDirectory: sandbox,
        nextPreference: { targets: [{ kind: "codex" }] },
        previousPreference: { targets: [{ kind: "claude" }] },
        writeMessage() {}
      });
    }).toThrow(/Invalid monke-tools flat Skill manifest/u);
    expect(readlinkSync(unrelated)).toBe(sourcePath);
  });

  it("attempts every selected target during skill namespace reconciliation before failing on unmanaged namespaces", () => {
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

  it("continues skill namespace reconciliation after deselected target cleanup failures", () => {
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

  it.each([
    {
      error: /Custom Agent skill root .* overlaps Antigravity/u,
      name: "Antigravity and Custom on the same root (flat first)",
      prepare(home: string): SkillInstallPreference {
        return {
          targets: [
            { kind: "antigravity" },
            { kind: "custom", path: path.join(home, ".gemini", "config", "skills") }
          ]
        };
      }
    },
    {
      error: /Custom Agent skill root .* overlaps Antigravity/u,
      name: "Antigravity and Custom on the same root (custom first)",
      prepare(home: string): SkillInstallPreference {
        return {
          targets: [
            { kind: "custom", path: path.join(home, ".gemini", "config", "skills") },
            { kind: "antigravity" }
          ]
        };
      }
    },
    {
      error: /Custom Agent skill root .* overlaps Claude/u,
      name: "Custom alone on an unselected built-in destination",
      prepare(home: string): SkillInstallPreference {
        return {
          targets: [{ kind: "custom", path: path.join(home, ".claude", "skills") }]
        };
      }
    },
    {
      error: /Custom Agent skill root .* overlaps Codex/u,
      name: "Custom aliased to a built-in root through a dangling symlink",
      prepare(home: string): SkillInstallPreference {
        const alias = path.join(home, "codex-alias");
        mkdirSync(home, { recursive: true });
        symlinkSync(path.join(home, ".codex", "skills"), alias, "dir");

        return {
          targets: [{ kind: "codex" }, { kind: "custom", path: alias }]
        };
      }
    },
    {
      error: /Claude at .* and Antigravity at .* overlap as Agent skill roots/u,
      name: "two flat built-in targets aliased to the same root",
      prepare(home: string): SkillInstallPreference {
        const antigravityRoot = path.join(home, ".gemini", "config", "skills");
        mkdirSync(antigravityRoot, { recursive: true });
        mkdirSync(path.join(home, ".claude"), { recursive: true });
        symlinkSync(antigravityRoot, path.join(home, ".claude", "skills"), "dir");

        return {
          targets: [{ kind: "claude" }, { kind: "antigravity" }]
        };
      }
    },
    {
      error: /Codex at .* and Cursor at .* overlap as Agent skill roots/u,
      name: "two namespaced built-in targets aliased to the same root",
      prepare(home: string): SkillInstallPreference {
        const cursorRoot = path.join(home, ".cursor", "skills");
        mkdirSync(cursorRoot, { recursive: true });
        mkdirSync(path.join(home, ".codex"), { recursive: true });
        symlinkSync(cursorRoot, path.join(home, ".codex", "skills"), "dir");

        return {
          targets: [{ kind: "codex" }, { kind: "cursor" }]
        };
      }
    },
    {
      error: /Custom Agent skill root .* overlaps Antigravity/u,
      name: "Custom nested inside a flat root before projection",
      prepare(home: string): SkillInstallPreference {
        return {
          targets: [
            { kind: "antigravity" },
            { kind: "custom", path: path.join(home, ".gemini", "config", "skills", "test") }
          ]
        };
      }
    },
    {
      error: /Custom Agent skill root .* overlaps Antigravity/u,
      name: "Custom nested inside a flat root through an existing projected skill symlink",
      prepare(home: string, sourceCheckout: string): SkillInstallPreference {
        const antigravityRoot = path.join(home, ".gemini", "config", "skills");
        mkdirSync(antigravityRoot, { recursive: true });
        symlinkSync(
          path.join(sourceCheckout, "skills", "internal", "test"),
          path.join(antigravityRoot, "test"),
          "dir"
        );

        return {
          targets: [
            { kind: "antigravity" },
            { kind: "custom", path: path.join(antigravityRoot, "test") }
          ]
        };
      }
    },
    {
      error: /Custom Agent skill root .* overlaps Claude/u,
      name: "Custom inside a flat target sibling references path",
      prepare(home: string, sourceCheckout: string): SkillInstallPreference {
        mkdirSync(path.join(home, ".claude"), { recursive: true });
        symlinkSync(
          path.join(sourceCheckout, "skills", "references"),
          path.join(home, ".claude", "references"),
          "dir"
        );

        return {
          targets: [
            { kind: "claude" },
            { kind: "custom", path: path.join(home, ".claude", "references", "nested") }
          ]
        };
      }
    },
    {
      error: /Custom Agent skill root .* overlaps Claude/u,
      name: "Custom wrapping a built-in destination",
      prepare(home: string): SkillInstallPreference {
        return {
          targets: [{ kind: "custom", path: path.join(home, ".claude") }]
        };
      }
    }
  ])("rejects overlapping Skill install targets before mutation: $name", ({ error, prepare }) => {
    const sandbox = makeTempDir("skill-target-overlap");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const sourceCheckout = path.join(sandbox, "source");
    writeGlobalInstructionsSource(sourceCheckout);
    write(sourceCheckout, "skills/internal/test/SKILL.md", "---\nname: test\n---\n");
    write(sourceCheckout, "skills/references/internal/GUIDE.md", "guide\n");

    const preference = prepare(home, sourceCheckout);
    saveGlobalMonkeConfig(monkeHome, { skillInstallPreference: preference, version: 1 });

    expect(() => {
      preflightInstallGuidance(
        createRuntime({ cwd: sandbox, env: { HOME: home, MONKE_HOME: monkeHome } }),
        sourceCheckout
      );
    }).toThrow(error);

    expect(() => {
      reconcileSkillNamespaces({
        cwd: sandbox,
        guidanceSourceRoot: sourceCheckout,
        homeDirectory: home,
        monkeHome,
        nextPreference: preference,
        previousPreference: null,
        writeMessage() {}
      });
    }).toThrow(error);

    expect(
      existsSync(path.join(sourceCheckout, "skills", "internal", "test", "monke-tools"))
    ).toBeFalsy();
    expect(existsSync(path.join(sourceCheckout, "skills", "references", "nested"))).toBeFalsy();
    expect(
      existsSync(path.join(home, ".gemini", "config", "skills", ".monke-tools-flat-skills.json"))
    ).toBeFalsy();
  });

  it("allows a sibling Custom root next to built-in roots and lets reconfiguration leave an overlapping saved preference", () => {
    const sandbox = makeTempDir("skill-target-sibling-and-recovery");
    const home = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    const antigravityRoot = path.join(home, ".gemini", "config", "skills");
    const siblingCustomRoot = path.join(home, ".claude", "skills-custom");
    writeGlobalInstructionsSource(sourceCheckout);
    write(sourceCheckout, "skills/internal/test/SKILL.md", "---\nname: test\n---\n");
    write(sourceCheckout, "skills/references/internal/GUIDE.md", "guide\n");

    reconcileSkillNamespaces({
      cwd: sandbox,
      guidanceSourceRoot: sourceCheckout,
      homeDirectory: home,
      nextPreference: {
        targets: [
          { kind: "claude" },
          { kind: "antigravity" },
          { kind: "custom", path: siblingCustomRoot }
        ]
      },
      previousPreference: null,
      writeMessage() {}
    });

    expect(lstatSync(path.join(home, ".claude", "skills", "test")).isSymbolicLink()).toBeTruthy();
    expect(lstatSync(path.join(antigravityRoot, "test")).isSymbolicLink()).toBeTruthy();
    expect(lstatSync(path.join(siblingCustomRoot, "monke-tools")).isDirectory()).toBeTruthy();

    // Recover from a previously saved overlapping configuration by deselecting the Custom target.
    const staleNamespace = path.join(antigravityRoot, "monke-tools");
    mkdirSync(staleNamespace, { recursive: true });
    const internalSource = path.join(sourceCheckout, "skills", "internal");
    symlinkSync(internalSource, path.join(staleNamespace, "internal"), "dir");
    write(
      staleNamespace,
      ".monke-tools-namespace.json",
      JSON.stringify({
        links: [{ name: "internal", sourcePath: internalSource }],
        managedBy: "monke-tools",
        version: 1
      })
    );

    reconcileSkillNamespaces({
      cwd: sandbox,
      guidanceSourceRoot: sourceCheckout,
      homeDirectory: home,
      nextPreference: { targets: [{ kind: "antigravity" }] },
      previousPreference: {
        targets: [{ kind: "antigravity" }, { kind: "custom", path: antigravityRoot }]
      },
      writeMessage() {}
    });

    expect(existsSync(staleNamespace)).toBeFalsy();
    expect(lstatSync(path.join(antigravityRoot, "test")).isSymbolicLink()).toBeTruthy();
  });

  it.each([
    { entryKind: "symlink" as const, kind: "claude" as const, rootSegments: [".claude", "skills"] },
    {
      entryKind: "directory" as const,
      kind: "claude" as const,
      rootSegments: [".claude", "skills"]
    },
    {
      entryKind: "symlink" as const,
      kind: "antigravity" as const,
      rootSegments: [".gemini", "config", "skills"]
    },
    {
      entryKind: "directory" as const,
      kind: "antigravity" as const,
      rootSegments: [".gemini", "config", "skills"]
    }
  ])(
    "preserves a user-owned monke-tools $entryKind in the $kind flat root across reconciliation and deselection",
    ({ entryKind, kind, rootSegments }) => {
      const sandbox = makeTempDir(`skill-flat-preserve-${kind}-${entryKind}`);
      const sourceCheckout = path.join(sandbox, "source");
      const userSkill = path.join(sandbox, "user-monke-tools");
      const userReferences = path.join(sandbox, "user-refs");
      writeGlobalInstructionsSource(sourceCheckout);
      write(sourceCheckout, "skills/internal/test/SKILL.md", "---\nname: test\n---\n");
      write(userSkill, "SKILL.md", "---\nname: monke-tools\n---\nUser skill.\n");
      write(userReferences, "NOTE.md", "user reference\n");

      const agentSkillRoot = path.join(sandbox, ...rootSegments);
      const userEntry = path.join(agentSkillRoot, "monke-tools");
      mkdirSync(agentSkillRoot, { recursive: true });

      if (entryKind === "symlink") {
        symlinkSync(userSkill, userEntry, "dir");
      } else {
        write(userEntry, "SKILL.md", "---\nname: monke-tools\n---\nUser skill.\n");
        symlinkSync(userReferences, path.join(userEntry, "references"), "dir");
      }

      reconcileSkillNamespaces({
        cwd: sandbox,
        guidanceSourceRoot: sourceCheckout,
        homeDirectory: sandbox,
        nextPreference: { targets: [{ kind }] },
        previousPreference: null,
        writeMessage() {}
      });

      reconcileSkillNamespaces({
        cwd: sandbox,
        guidanceSourceRoot: sourceCheckout,
        homeDirectory: sandbox,
        nextPreference: { targets: [{ kind: "codex" }] },
        previousPreference: { targets: [{ kind }] },
        writeMessage() {}
      });

      const expected =
        entryKind === "symlink"
          ? { isSymlink: true, linkedTarget: userSkill }
          : { isSymlink: false, linkedTarget: userReferences };

      const actual =
        entryKind === "symlink"
          ? {
              isSymlink: lstatSync(userEntry).isSymbolicLink(),
              linkedTarget: readlinkSync(userEntry)
            }
          : {
              isSymlink: lstatSync(userEntry).isSymbolicLink(),
              linkedTarget: readlinkSync(path.join(userEntry, "references"))
            };

      expect(actual).toStrictEqual(expected);
      expect(readFileSync(path.join(userEntry, "SKILL.md"), "utf-8")).toContain("User skill.");
    }
  );

  it.each([
    {
      expectedError: /Refusing to overwrite Skill namespace/u,
      name: "symlink at monke-tools",
      prepare(namespacePath: string, userTarget: string) {
        mkdirSync(path.dirname(namespacePath), { recursive: true });
        symlinkSync(userTarget, namespacePath, "dir");
      },
      verifyIntact(namespacePath: string, userTarget: string) {
        expect(lstatSync(namespacePath).isSymbolicLink()).toBeTruthy();
        expect(readlinkSync(namespacePath)).toBe(userTarget);
      }
    },
    {
      expectedError: /Refusing to overwrite Skill namespace/u,
      name: "user skill directory with SKILL.md and references symlink",
      prepare(namespacePath: string, userTarget: string) {
        write(namespacePath, "SKILL.md", "---\nname: monke-tools\n---\nUser skill.\n");
        symlinkSync(userTarget, path.join(namespacePath, "references"), "dir");
      },
      verifyIntact(namespacePath: string, userTarget: string) {
        expect(readFileSync(path.join(namespacePath, "SKILL.md"), "utf-8")).toContain(
          "User skill."
        );
        expect(readlinkSync(path.join(namespacePath, "references"))).toBe(userTarget);
      }
    },
    {
      expectedError: /Refusing to overwrite non-managed Skill folder/u,
      name: "unrelated references symlink inside monke-tools",
      prepare(namespacePath: string, userTarget: string) {
        mkdirSync(namespacePath, { recursive: true });
        symlinkSync(userTarget, path.join(namespacePath, "references"), "dir");
      },
      verifyIntact(namespacePath: string, userTarget: string) {
        expect(readlinkSync(path.join(namespacePath, "references"))).toBe(userTarget);
      }
    }
  ])(
    "refuses to overwrite and preserves non-managed namespace entry on deselection: $name",
    ({ expectedError, prepare, verifyIntact }) => {
      const sandbox = makeTempDir("skill-namespace-ownership");
      const home = path.join(sandbox, "home");
      const monkeHome = path.join(sandbox, "monke-home");
      const sourceCheckout = path.join(sandbox, "source");
      const userTarget = path.join(sandbox, "user-owned");
      writeGlobalInstructionsSource(sourceCheckout);
      write(sourceCheckout, "skills/internal/test/SKILL.md", "---\nname: test\n---\n");
      write(sourceCheckout, "skills/references/internal/GUIDE.md", "guide\n");
      write(userTarget, "SKILL.md", "---\nname: monke-tools\n---\nUser skill.\n");

      const namespacePath = path.join(home, ".codex", "skills", "monke-tools");
      prepare(namespacePath, userTarget);

      expect(() => {
        preflightInstallGuidance(
          createRuntime({ cwd: sandbox, env: { HOME: home, MONKE_HOME: monkeHome } }),
          sourceCheckout,
          { builtInTargetKinds: ["codex"] }
        );
      }).toThrow(expectedError);

      expect(() => {
        reconcileSkillNamespaces({
          cwd: sandbox,
          guidanceSourceRoot: sourceCheckout,
          homeDirectory: home,
          monkeHome,
          nextPreference: { targets: [{ kind: "codex" }] },
          previousPreference: null,
          writeMessage() {}
        });
      }).toThrow(expectedError);
      verifyIntact(namespacePath, userTarget);

      reconcileSkillNamespaces({
        cwd: sandbox,
        guidanceSourceRoot: sourceCheckout,
        homeDirectory: home,
        monkeHome,
        nextPreference: { targets: [{ kind: "cursor" }] },
        previousPreference: { targets: [{ kind: "codex" }] },
        writeMessage() {}
      });
      verifyIntact(namespacePath, userTarget);
    }
  );

  it("tracks namespace ownership via manifest, preserves user entries and replaced links, and rejects corrupt manifests", () => {
    const sandbox = makeTempDir("skill-namespace-manifest");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const sourceCheckout = path.join(sandbox, "source");
    const userRefs = path.join(sandbox, "user-refs");
    writeGlobalInstructionsSource(sourceCheckout);
    write(sourceCheckout, "skills/internal/test/SKILL.md", "---\nname: test\n---\n");
    write(sourceCheckout, "skills/references/internal/GUIDE.md", "guide\n");
    write(userRefs, "NOTE.md", "user refs\n");

    const namespacePath = path.join(home, ".codex", "skills", "monke-tools");
    const manifestPath = path.join(namespacePath, ".monke-tools-namespace.json");

    reconcileSkillNamespaces({
      cwd: sandbox,
      guidanceSourceRoot: sourceCheckout,
      homeDirectory: home,
      monkeHome,
      nextPreference: { targets: [{ kind: "codex" }] },
      previousPreference: null,
      writeMessage() {}
    });

    expect(JSON.parse(readFileSync(manifestPath, "utf-8"))).toStrictEqual({
      links: [
        { name: "internal", sourcePath: path.join(sourceCheckout, "skills", "internal") },
        { name: "references", sourcePath: path.join(sourceCheckout, "skills", "references") }
      ],
      managedBy: "monke-tools",
      version: 1
    });

    // User adds an unrelated note and replaces the references symlink with their own target.
    write(namespacePath, "user-note.txt", "keep me\n");
    rmSync(path.join(namespacePath, "references"));
    symlinkSync(userRefs, path.join(namespacePath, "references"), "dir");

    expect(() => {
      reconcileSkillNamespaces({
        cwd: sandbox,
        guidanceSourceRoot: sourceCheckout,
        homeDirectory: home,
        monkeHome,
        nextPreference: { targets: [{ kind: "codex" }] },
        previousPreference: { targets: [{ kind: "codex" }] },
        writeMessage() {}
      });
    }).toThrow(/Refusing to overwrite non-managed Skill folder/u);

    // Deselecting removes only links still matching the manifest and leaves user entries intact.
    reconcileSkillNamespaces({
      cwd: sandbox,
      guidanceSourceRoot: sourceCheckout,
      homeDirectory: home,
      monkeHome,
      nextPreference: { targets: [{ kind: "cursor" }] },
      previousPreference: { targets: [{ kind: "codex" }] },
      writeMessage() {}
    });

    expect(existsSync(path.join(namespacePath, "internal"))).toBeFalsy();
    expect(existsSync(manifestPath)).toBeFalsy();
    expect(readFileSync(path.join(namespacePath, "user-note.txt"), "utf-8")).toBe("keep me\n");
    expect(readlinkSync(path.join(namespacePath, "references"))).toBe(userRefs);

    // Corrupt namespace manifest blocks both reconciliation and deselection before mutation.
    const cursorNamespace = path.join(home, ".cursor", "skills", "monke-tools");
    write(
      cursorNamespace,
      ".monke-tools-namespace.json",
      JSON.stringify({ links: [], managedBy: "monke-tools", version: 2 })
    );

    expect(() => {
      reconcileSkillNamespaces({
        cwd: sandbox,
        guidanceSourceRoot: sourceCheckout,
        homeDirectory: home,
        monkeHome,
        nextPreference: { targets: [{ kind: "claude" }] },
        previousPreference: { targets: [{ kind: "cursor" }] },
        writeMessage() {}
      });
    }).toThrow(/Invalid monke-tools Skill namespace manifest/u);
    expect(lstatSync(path.join(cursorNamespace, "internal")).isSymbolicLink()).toBeTruthy();
  });

  it("upgrades and removes pre-manifest managed namespaces whose links point into Monke home", () => {
    const sandbox = makeTempDir("skill-namespace-legacy-upgrade");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const sourceCheckout = path.join(sandbox, "source");
    writeGlobalInstructionsSource(sourceCheckout);
    write(sourceCheckout, "skills/internal/test/SKILL.md", "---\nname: test\n---\n");

    const legacyReleaseInternal = path.join(
      monkeHome,
      "installs",
      "release-0.0.151-macos-arm64",
      "skills",
      "internal"
    );

    const codexNamespace = path.join(home, ".codex", "skills", "monke-tools");
    const cursorNamespace = path.join(home, ".cursor", "skills", "monke-tools");
    mkdirSync(codexNamespace, { recursive: true });
    mkdirSync(cursorNamespace, { recursive: true });
    symlinkSync(legacyReleaseInternal, path.join(codexNamespace, "internal"), "dir");
    symlinkSync(
      path.join(monkeHome, "skill-registry", "skills", "internal"),
      path.join(cursorNamespace, "internal"),
      "dir"
    );

    // Codex upgrades seamlessly and gains a manifest; Cursor is deselected and cleaned up.
    reconcileSkillNamespaces({
      cwd: sandbox,
      guidanceSourceRoot: sourceCheckout,
      homeDirectory: home,
      monkeHome,
      nextPreference: { targets: [{ kind: "codex" }] },
      previousPreference: { targets: [{ kind: "codex" }, { kind: "cursor" }] },
      writeMessage() {}
    });

    expect(readlinkSync(path.join(codexNamespace, "internal"))).toBe(
      path.join(sourceCheckout, "skills", "internal")
    );
    expect(existsSync(path.join(codexNamespace, ".monke-tools-namespace.json"))).toBeTruthy();
    expect(existsSync(cursorNamespace)).toBeFalsy();
  });
});
