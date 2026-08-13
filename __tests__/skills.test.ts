import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { reconcileSkillNamespaces, resolveSkillInstallTargets } from "../src/skills.ts";
import { isCaseInsensitiveFilesystem, makeTempDir, write } from "./helpers.ts";

const CASE_INSENSITIVE_FILESYSTEM = isCaseInsensitiveFilesystem();
const HFS_ATTACH_DEVICE_PATTERN = /^(?<device>\/dev\/disk\d+s\d+)\s+Apple_HFS\s+/mu;
const RUN_EMPTY_VOLUME_TEST = process.platform === "darwin";

function runSystemCommand(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function writeCoreSkill(sourceCheckout: string) {
  write(
    sourceCheckout,
    "skills/internal/monke-tools-core/SKILL.md",
    "---\nname: monke-tools-core\n---\n"
  );
}

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

  test.each([
    { label: "lexical path", useAlias: false },
    { label: "symlink alias", useAlias: true }
  ])("skill reconciliation rejects a duplicate Agent skill root through $label", ({ useAlias }) => {
    const sandbox = makeTempDir("skill-reconcile-duplicate-root");
    const sourceCheckout = path.join(sandbox, "source");
    const codexSkillRoot = path.join(sandbox, ".codex", "skills");
    const customSkillRoot = useAlias ? path.join(sandbox, "codex-skills-alias") : codexSkillRoot;
    writeCoreSkill(sourceCheckout);
    if (useAlias) {
      symlinkSync(codexSkillRoot, customSkillRoot, "dir");
    }

    expect(() => {
      reconcileSkillNamespaces({
        homeDirectory: sandbox,
        nextPreference: {
          targets: [{ kind: "codex" }, { kind: "custom", path: customSkillRoot }]
        },
        previousPreference: null,
        sourceCheckout,
        writeMessage() {}
      });
    }).toThrow(/same Agent skill root/u);
    expect(existsSync(codexSkillRoot)).toBeFalsy();
  });

  test.runIf(CASE_INSENSITIVE_FILESYSTEM)(
    "skill reconciliation rejects a case-insensitive Agent skill root alias",
    () => {
      const sandbox = makeTempDir("skill-reconcile-case-alias");
      const sourceCheckout = path.join(sandbox, "source");
      const codexSkillRoot = path.join(sandbox, ".codex", "skills");
      const customSkillRoot = path.join(sandbox, ".CODEX", "skills");
      writeCoreSkill(sourceCheckout);
      mkdirSync(codexSkillRoot, { recursive: true });

      expect(() => {
        reconcileSkillNamespaces({
          homeDirectory: sandbox,
          nextPreference: {
            targets: [{ kind: "codex" }, { kind: "custom", path: customSkillRoot }]
          },
          previousPreference: null,
          sourceCheckout,
          writeMessage() {}
        });
      }).toThrow(/same Agent skill root/u);
      expect(existsSync(path.join(codexSkillRoot, "monke-tools"))).toBeFalsy();
    }
  );

  test.runIf(RUN_EMPTY_VOLUME_TEST).each([
    { aliasesRoot: true, filesystem: "HFS+" },
    { aliasesRoot: false, filesystem: "Case-sensitive HFS+" }
  ])(
    "skill reconciliation resolves case aliases on an empty $filesystem volume",
    ({ aliasesRoot, filesystem }) => {
      const sandbox = makeTempDir("skill-reconcile-empty-case-volume");
      const sourceCheckout = path.join(sandbox, "source");
      const imagePath = path.join(sandbox, "case-insensitive");
      const mountPath = path.join(sandbox, "mount");
      writeCoreSkill(sourceCheckout);
      mkdirSync(mountPath);
      runSystemCommand("/usr/bin/hdiutil", [
        "create",
        "-quiet",
        "-type",
        "SPARSE",
        "-size",
        "10m",
        "-fs",
        filesystem,
        "-volname",
        "MonkeCaseProbe",
        imagePath
      ]);
      const attachOutput = runSystemCommand("/usr/bin/hdiutil", [
        "attach",
        "-nobrowse",
        "-mountpoint",
        mountPath,
        `${imagePath}.sparseimage`
      ]);
      const mountedDevice = HFS_ATTACH_DEVICE_PATTERN.exec(attachOutput)?.groups?.device;

      try {
        if (!mountedDevice) {
          throw new Error(`Could not identify mounted test volume from: ${attachOutput}`);
        }
        let reconciliationError: unknown;
        try {
          reconcileSkillNamespaces({
            homeDirectory: mountPath,
            nextPreference: {
              targets: [
                { kind: "codex" },
                { kind: "custom", path: path.join(mountPath, ".CODEX", "skills") }
              ]
            },
            previousPreference: null,
            sourceCheckout,
            writeMessage() {}
          });
        } catch (error) {
          reconciliationError = error;
        }
        expect(
          reconciliationError instanceof Error &&
            reconciliationError.message.includes("same Agent skill root")
        ).toBe(aliasesRoot);
        expect(existsSync(path.join(mountPath, ".codex", "skills", "monke-tools"))).toBe(
          !aliasesRoot
        );
        expect(existsSync(path.join(mountPath, ".CODEX", "skills", "monke-tools"))).toBe(
          !aliasesRoot
        );
      } finally {
        runSystemCommand("/usr/bin/hdiutil", ["detach", mountedDevice ?? mountPath]);
      }
    }
  );

  test("skill reconciliation resolves symlinks before parent path segments", () => {
    const sandbox = makeTempDir("skill-reconcile-component-order-alias");
    const homeDirectory = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    const customSkillRoot = path.join(sandbox, "codex-skills-alias");
    writeCoreSkill(sourceCheckout);
    mkdirSync(path.join(homeDirectory, "nested"), { recursive: true });
    symlinkSync(path.join(homeDirectory, "nested"), path.join(sandbox, "hop"), "dir");
    symlinkSync("hop/../.codex/skills", customSkillRoot, "dir");

    expect(() => {
      reconcileSkillNamespaces({
        homeDirectory,
        nextPreference: {
          targets: [{ kind: "codex" }, { kind: "custom", path: customSkillRoot }]
        },
        previousPreference: null,
        sourceCheckout,
        writeMessage() {}
      });
    }).toThrow(/same Agent skill root/u);
    expect(existsSync(path.join(homeDirectory, ".codex", "skills"))).toBeFalsy();
  });

  test.each([
    {
      customSkillRoot(relativeHome: string) {
        return path.join(relativeHome, ".codex", "skills", "monke-tools", "codex");
      },
      target: "codex" as const
    },
    {
      customSkillRoot(relativeHome: string) {
        return path.join(relativeHome, ".claude", "references");
      },
      target: "claude" as const
    }
  ])(
    "skill reconciliation rejects a custom root inside a planned $target projection",
    ({ customSkillRoot, target }) => {
      const sandbox = makeTempDir("skill-reconcile-planned-alias");
      const sourceCheckout = path.join(sandbox, "source");
      const sourceSkillTree = path.join(sourceCheckout, "skills");
      const customRoot = customSkillRoot(sandbox);
      writeCoreSkill(sourceCheckout);
      write(sourceCheckout, "skills/codex/codex-only/SKILL.md", "---\nname: codex-only\n---\n");
      write(sourceCheckout, "skills/references/internal/README.md", "shared reference\n");

      expect(() => {
        reconcileSkillNamespaces({
          homeDirectory: sandbox,
          nextPreference: {
            targets: [{ kind: target }, { kind: "custom", path: customRoot }]
          },
          previousPreference: null,
          sourceCheckout,
          writeMessage() {}
        });
      }).toThrow(/managed Skill projection/u);
      expect(existsSync(customRoot)).toBeFalsy();
      expect(existsSync(path.join(sourceSkillTree, "codex", "monke-tools"))).toBeFalsy();
      expect(existsSync(path.join(sourceSkillTree, "references", "monke-tools"))).toBeFalsy();
    }
  );

  test("skill namespace reconciliation projects Codex-only skills only into Codex", () => {
    const sandbox = makeTempDir("skill-reconcile-create");
    const sourceCheckout = path.join(sandbox, "source");
    const customSkillRoot = path.join(sandbox, "custom", "skills");
    writeCoreSkill(sourceCheckout);
    write(sourceCheckout, "skills/imported/tdd/SKILL.md", "---\nname: tdd\n---\n");
    write(
      sourceCheckout,
      "skills/codex/codex-chrome-use/SKILL.md",
      "---\nname: codex-chrome-use\n---\n"
    );
    write(sourceCheckout, "skills/references/internal/README.md", "shared reference\n");

    reconcileSkillNamespaces({
      homeDirectory: sandbox,
      nextPreference: {
        targets: [{ kind: "codex" }, { kind: "cursor" }, { kind: "custom", path: customSkillRoot }]
      },
      previousPreference: null,
      sourceCheckout,
      writeMessage() {}
    });

    const namespaces = [
      { path: path.join(sandbox, ".codex", "skills", "monke-tools"), seesCodex: true },
      { path: path.join(sandbox, ".cursor", "skills", "monke-tools"), seesCodex: false },
      { path: path.join(customSkillRoot, "monke-tools"), seesCodex: false }
    ];
    for (const namespace of namespaces) {
      expect(lstatSync(namespace.path).isDirectory()).toBeTruthy();
      for (const sourceFolder of ["internal", "imported", "references"]) {
        const installedPath = path.join(namespace.path, sourceFolder);
        expect(lstatSync(installedPath).isSymbolicLink()).toBeTruthy();
        expect(readlinkSync(installedPath)).toBe(path.join(sourceCheckout, "skills", sourceFolder));
      }
      expect(existsSync(path.join(namespace.path, "codex"))).toBe(namespace.seesCodex);
    }
    expect(readlinkSync(path.join(sandbox, ".codex", "skills", "monke-tools", "codex"))).toBe(
      path.join(sourceCheckout, "skills", "codex")
    );
  });

  test("skill namespace reconciliation migrates and refreshes managed projections", () => {
    const sandbox = makeTempDir("skill-reconcile-refresh-projection");
    const firstSourceCheckout = path.join(sandbox, "first-source");
    const nextSourceCheckout = path.join(sandbox, "next-source");
    const cursorSkillRoot = path.join(sandbox, ".cursor", "skills");
    const namespacePath = path.join(cursorSkillRoot, "monke-tools");
    for (const sourceCheckout of [firstSourceCheckout, nextSourceCheckout]) {
      writeCoreSkill(sourceCheckout);
    }
    mkdirSync(cursorSkillRoot, { recursive: true });
    symlinkSync(path.join(firstSourceCheckout, "skills"), namespacePath, "dir");

    reconcileSkillNamespaces({
      homeDirectory: sandbox,
      nextPreference: { targets: [{ kind: "cursor" }] },
      previousPreference: { targets: [{ kind: "cursor" }] },
      sourceCheckout: firstSourceCheckout,
      writeMessage() {}
    });
    expect(lstatSync(namespacePath).isDirectory()).toBeTruthy();

    reconcileSkillNamespaces({
      homeDirectory: sandbox,
      nextPreference: { targets: [{ kind: "cursor" }] },
      previousPreference: { targets: [{ kind: "cursor" }] },
      sourceCheckout: nextSourceCheckout,
      writeMessage() {}
    });
    expect(readlinkSync(path.join(namespacePath, "internal"))).toBe(
      path.join(nextSourceCheckout, "skills", "internal")
    );
  });

  test("skill reconciliation rejects a Codex-only slug that collides with a shared skill", () => {
    const sandbox = makeTempDir("skill-reconcile-duplicate-slug");
    const sourceCheckout = path.join(sandbox, "source");
    write(
      sourceCheckout,
      "skills/internal/browser-control/SKILL.md",
      "---\nname: shared-browser-control\n---\n"
    );
    write(
      sourceCheckout,
      "skills/codex/browser-control/SKILL.md",
      "---\nname: codex-browser-control\n---\n"
    );

    expect(() => {
      reconcileSkillNamespaces({
        homeDirectory: sandbox,
        nextPreference: { targets: [{ kind: "codex" }, { kind: "cursor" }] },
        previousPreference: null,
        sourceCheckout,
        writeMessage() {}
      });
    }).toThrow(/duplicate Skill slug browser-control/u);
    expect(existsSync(path.join(sandbox, ".codex", "skills", "monke-tools"))).toBeFalsy();
    expect(existsSync(path.join(sandbox, ".cursor", "skills", "monke-tools"))).toBeFalsy();
  });

  test("skill reconciliation rejects a Codex-only agent name that collides with a shared skill", () => {
    const sandbox = makeTempDir("skill-reconcile-duplicate-agent-name");
    const sourceCheckout = path.join(sandbox, "source");
    write(
      sourceCheckout,
      "skills/internal/shared-browser/SKILL.md",
      "---\nname: browser-control\n---\n"
    );
    write(
      sourceCheckout,
      "skills/codex/codex-browser/SKILL.md",
      "---\nname: browser-control\n---\n"
    );

    expect(() => {
      reconcileSkillNamespaces({
        homeDirectory: sandbox,
        nextPreference: { targets: [{ kind: "codex" }] },
        previousPreference: null,
        sourceCheckout,
        writeMessage() {}
      });
    }).toThrow(/duplicate Agent skill name browser-control/u);
    expect(existsSync(path.join(sandbox, ".codex", "skills", "monke-tools"))).toBeFalsy();
  });

  test("Claude skill reconciliation flattens source categories into the Agent skill root", () => {
    const sandbox = makeTempDir("skill-reconcile-claude-flat");
    const sourceCheckout = path.join(sandbox, "source");
    writeCoreSkill(sourceCheckout);
    write(sourceCheckout, "skills/imported/tdd/SKILL.md", "---\nname: tdd\n---\n");
    write(
      sourceCheckout,
      "skills/codex/codex-chrome-use/SKILL.md",
      "---\nname: codex-chrome-use\n---\n"
    );

    reconcileSkillNamespaces({
      homeDirectory: sandbox,
      nextPreference: {
        targets: [{ kind: "claude" }]
      },
      previousPreference: null,
      sourceCheckout,
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
      homeDirectory: sandbox,
      nextPreference: {
        targets: [{ kind: "codex" }]
      },
      previousPreference: {
        targets: [{ kind: "claude" }]
      },
      sourceCheckout,
      writeMessage() {}
    });

    expect(existsSync(coreLink)).toBeFalsy();
    expect(existsSync(tddLink)).toBeFalsy();
    expect(existsSync(manifestPath)).toBeFalsy();
    expect(
      lstatSync(path.join(sandbox, ".codex", "skills", "monke-tools")).isDirectory()
    ).toBeTruthy();
    expect(
      lstatSync(path.join(sandbox, ".codex", "skills", "monke-tools", "codex")).isSymbolicLink()
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
      `---\nname: code-review\n---\n\nUse [base](${upstreamRelativePath}) and [standards](${standardsRelativePath}).\n`
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
      homeDirectory: sandbox,
      nextPreference: {
        targets: [{ kind: "custom", path: customSkillRoot }, { kind: "claude" }]
      },
      previousPreference: null,
      sourceCheckout,
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
      homeDirectory: sandbox,
      nextPreference: {
        targets: [{ kind: "custom", path: customSkillRoot }]
      },
      previousPreference: {
        targets: [{ kind: "custom", path: customSkillRoot }, { kind: "claude" }]
      },
      sourceCheckout,
      writeMessage() {}
    });
    expect(existsSync(path.join(sandbox, ".claude", "references"))).toBeFalsy();
  });

  test("Claude skill reconciliation rejects unknown future flat manifest versions", () => {
    const sandbox = makeTempDir("skill-reconcile-future-manifest");
    const sourceCheckout = path.join(sandbox, "source");
    const claudeSkillRoot = path.join(sandbox, ".claude", "skills");
    writeCoreSkill(sourceCheckout);
    write(
      claudeSkillRoot,
      ".monke-tools-flat-skills.json",
      JSON.stringify({ links: [], managedBy: "monke-tools", version: 2 })
    );

    expect(() => {
      reconcileSkillNamespaces({
        homeDirectory: sandbox,
        nextPreference: { targets: [{ kind: "claude" }] },
        previousPreference: { targets: [{ kind: "claude" }] },
        sourceCheckout,
        writeMessage() {}
      });
    }).toThrow(/Invalid monke-tools flat Skill manifest/u);
  });

  test("skill namespace reconciliation rejects unknown future projection manifest versions", () => {
    const sandbox = makeTempDir("skill-reconcile-future-namespace-manifest");
    const sourceCheckout = path.join(sandbox, "source");
    const cursorNamespace = path.join(sandbox, ".cursor", "skills", "monke-tools");
    writeCoreSkill(sourceCheckout);
    write(
      cursorNamespace,
      ".monke-tools-namespace-skills.json",
      JSON.stringify({ links: [], managedBy: "monke-tools", version: 2 })
    );

    expect(() => {
      reconcileSkillNamespaces({
        homeDirectory: sandbox,
        nextPreference: { targets: [{ kind: "cursor" }] },
        previousPreference: { targets: [{ kind: "cursor" }] },
        sourceCheckout,
        writeMessage() {}
      });
    }).toThrow(/Invalid monke-tools Skill namespace manifest/u);
    expect(
      existsSync(path.join(cursorNamespace, ".monke-tools-namespace-skills.json"))
    ).toBeTruthy();
  });

  test("skill namespace reconciliation attempts every selected target before failing on unmanaged namespaces", () => {
    const sandbox = makeTempDir("skill-reconcile-partial");
    const sourceCheckout = path.join(sandbox, "source");
    const blockedSkillRoot = path.join(sandbox, "blocked", "skills");
    writeCoreSkill(sourceCheckout);
    mkdirSync(path.join(blockedSkillRoot, "monke-tools"), { recursive: true });

    expect(() => {
      reconcileSkillNamespaces({
        homeDirectory: sandbox,
        nextPreference: {
          targets: [{ kind: "codex" }, { kind: "custom", path: blockedSkillRoot }]
        },
        previousPreference: null,
        sourceCheckout,
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
    writeCoreSkill(sourceCheckout);
    write(path.join(sandbox, ".claude", "skills"), ".monke-tools-flat-skills.json", "{}");

    expect(() => {
      reconcileSkillNamespaces({
        homeDirectory: sandbox,
        nextPreference: {
          targets: [{ kind: "codex" }]
        },
        previousPreference: {
          targets: [{ kind: "claude" }]
        },
        sourceCheckout,
        writeMessage() {}
      });
    }).toThrow(/Failed to reconcile 1 Skill install target/u);

    expect(
      lstatSync(path.join(sandbox, ".codex", "skills", "monke-tools")).isDirectory()
    ).toBeTruthy();
  });

  test("skill namespace reconciliation removes deselected managed projections", () => {
    const sandbox = makeTempDir("skill-reconcile-deselect-projection");
    const sourceCheckout = path.join(sandbox, "source");
    const oldSkillRoot = path.join(sandbox, "old", "skills");
    writeCoreSkill(sourceCheckout);
    reconcileSkillNamespaces({
      homeDirectory: sandbox,
      nextPreference: { targets: [{ kind: "custom", path: oldSkillRoot }] },
      previousPreference: null,
      sourceCheckout,
      writeMessage() {}
    });

    reconcileSkillNamespaces({
      homeDirectory: sandbox,
      nextPreference: { targets: [{ kind: "codex" }] },
      previousPreference: { targets: [{ kind: "custom", path: oldSkillRoot }] },
      sourceCheckout,
      writeMessage() {}
    });

    expect(existsSync(path.join(oldSkillRoot, "monke-tools"))).toBeFalsy();
    expect(
      lstatSync(path.join(sandbox, ".codex", "skills", "monke-tools")).isDirectory()
    ).toBeTruthy();
  });

  test("skill namespace reconciliation removes deselected legacy namespace symlinks", () => {
    const sandbox = makeTempDir("skill-reconcile-deselect");
    const sourceCheckout = path.join(sandbox, "source");
    const oldSkillRoot = path.join(sandbox, "old", "skills");
    writeCoreSkill(sourceCheckout);
    mkdirSync(oldSkillRoot, { recursive: true });
    symlinkSync(path.join(sourceCheckout, "skills"), path.join(oldSkillRoot, "monke-tools"), "dir");

    reconcileSkillNamespaces({
      homeDirectory: sandbox,
      nextPreference: {
        targets: [{ kind: "codex" }]
      },
      previousPreference: {
        targets: [{ kind: "custom", path: oldSkillRoot }]
      },
      sourceCheckout,
      writeMessage() {}
    });

    expect(existsSync(path.join(oldSkillRoot, "monke-tools"))).toBeFalsy();
    expect(
      lstatSync(path.join(sandbox, ".codex", "skills", "monke-tools")).isDirectory()
    ).toBeTruthy();
  });

  test("skill namespace cleanup preserves non-managed projection entries", () => {
    const sandbox = makeTempDir("skill-reconcile-projection-extra-entry");
    const sourceCheckout = path.join(sandbox, "source");
    const customSkillRoot = path.join(sandbox, "custom", "skills");
    const customNamespace = path.join(customSkillRoot, "monke-tools");
    writeCoreSkill(sourceCheckout);
    reconcileSkillNamespaces({
      homeDirectory: sandbox,
      nextPreference: { targets: [{ kind: "custom", path: customSkillRoot }] },
      previousPreference: null,
      sourceCheckout,
      writeMessage() {}
    });
    write(customNamespace, "personal-notes.md", "do not remove\n");

    expect(() => {
      reconcileSkillNamespaces({
        homeDirectory: sandbox,
        nextPreference: { targets: [{ kind: "codex" }] },
        previousPreference: { targets: [{ kind: "custom", path: customSkillRoot }] },
        sourceCheckout,
        writeMessage() {}
      });
    }).toThrow(/Failed to reconcile 1 Skill install target/u);
    expect(readFileSync(path.join(customNamespace, "personal-notes.md"), "utf-8")).toBe(
      "do not remove\n"
    );
    expect(
      lstatSync(path.join(sandbox, ".codex", "skills", "monke-tools")).isDirectory()
    ).toBeTruthy();
  });
});
