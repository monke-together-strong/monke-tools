import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { saveGlobalMonkeConfig, loadGlobalMonkeConfig } from "../src/global-config.ts";
import { runCliAsync } from "../src/index.ts";
import { createRuntime } from "../src/runtime.ts";
import type { MultiSelectPrompt } from "../src/types.ts";
import { isCaseInsensitiveFilesystem, makeTempDir, write } from "./helpers.ts";

const CASE_INSENSITIVE_FILESYSTEM = isCaseInsensitiveFilesystem();

describe("skills CLI", () => {
  test("mt skills configure uses a multi-select and reconciles selected targets", async () => {
    const sandbox = makeTempDir("skills-configure");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n"
    );
    saveGlobalMonkeConfig(monkeHome, {
      installedSourceCheckout: sourceCheckout,
      version: 1
    });

    let stdout = "";
    let stderr = "";
    let prompt: MultiSelectPrompt | undefined;
    const runtime = createRuntime({
      cwd: sandbox,
      env: {
        HOME: osHome,
        MONKE_HOME: monkeHome
      },
      multiSelectValues: [["codex", "custom"]],
      onMultiSelect(value) {
        prompt = value;
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
  });

  test.each([
    { label: "lexical path", useAlias: false },
    { label: "symlink alias", useAlias: true }
  ])("mt skills configure does not save a duplicate root through $label", async ({ useAlias }) => {
    const sandbox = makeTempDir("skills-configure-duplicate-root");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    const codexSkillRoot = path.join(osHome, ".codex", "skills");
    const customSkillRoot = useAlias ? path.join(osHome, "codex-skills-alias") : codexSkillRoot;
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n"
    );
    saveGlobalMonkeConfig(monkeHome, {
      installedSourceCheckout: sourceCheckout,
      version: 1
    });
    if (useAlias) {
      mkdirSync(osHome, { recursive: true });
      symlinkSync(codexSkillRoot, customSkillRoot, "dir");
    }

    await expect(
      runCliAsync(
        ["skills", "configure"],
        createRuntime({
          cwd: sandbox,
          env: {
            HOME: osHome,
            MONKE_HOME: monkeHome
          },
          multiSelectValues: [["codex", "custom"]],
          onStderr() {},
          onStdout() {},
          stdinText: `${customSkillRoot}\n`
        })
      )
    ).rejects.toThrow(/same Agent skill root/u);
    expect(loadGlobalMonkeConfig(monkeHome).skillInstallPreference).toBeUndefined();
    expect(existsSync(codexSkillRoot)).toBeFalsy();
  });

  test.runIf(CASE_INSENSITIVE_FILESYSTEM)(
    "mt skills configure does not save a case-insensitive root alias",
    async () => {
      const sandbox = makeTempDir("skills-configure-case-alias");
      const monkeHome = path.join(sandbox, "monke-home");
      const osHome = path.join(sandbox, "home");
      const sourceCheckout = path.join(sandbox, "source");
      const codexSkillRoot = path.join(osHome, ".codex", "skills");
      const customSkillRoot = path.join(osHome, ".CODEX", "skills");
      write(
        sourceCheckout,
        "skills/internal/monke-tools-core/SKILL.md",
        "---\nname: monke-tools-core\n---\n"
      );
      mkdirSync(codexSkillRoot, { recursive: true });
      saveGlobalMonkeConfig(monkeHome, {
        installedSourceCheckout: sourceCheckout,
        version: 1
      });

      await expect(
        runCliAsync(
          ["skills", "configure"],
          createRuntime({
            cwd: sandbox,
            env: {
              HOME: osHome,
              MONKE_HOME: monkeHome
            },
            multiSelectValues: [["codex", "custom"]],
            onStderr() {},
            onStdout() {},
            stdinText: `${customSkillRoot}\n`
          })
        )
      ).rejects.toThrow(/same Agent skill root/u);
      expect(loadGlobalMonkeConfig(monkeHome).skillInstallPreference).toBeUndefined();
      expect(existsSync(path.join(codexSkillRoot, "monke-tools"))).toBeFalsy();
    }
  );

  test("mt skills configure resolves symlinks before parent path segments", async () => {
    const sandbox = makeTempDir("skills-configure-component-order-alias");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    const customSkillRoot = path.join(sandbox, "codex-skills-alias");
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n"
    );
    mkdirSync(path.join(osHome, "nested"), { recursive: true });
    symlinkSync(path.join(osHome, "nested"), path.join(sandbox, "hop"), "dir");
    symlinkSync("hop/../.codex/skills", customSkillRoot, "dir");
    saveGlobalMonkeConfig(monkeHome, {
      installedSourceCheckout: sourceCheckout,
      version: 1
    });

    await expect(
      runCliAsync(
        ["skills", "configure"],
        createRuntime({
          cwd: sandbox,
          env: {
            HOME: osHome,
            MONKE_HOME: monkeHome
          },
          multiSelectValues: [["codex", "custom"]],
          onStderr() {},
          onStdout() {},
          stdinText: `${customSkillRoot}\n`
        })
      )
    ).rejects.toThrow(/same Agent skill root/u);
    expect(loadGlobalMonkeConfig(monkeHome).skillInstallPreference).toBeUndefined();
    expect(existsSync(path.join(osHome, ".codex", "skills"))).toBeFalsy();
  });

  test("mt skills configure does not save a root inside a planned projection", async () => {
    const sandbox = makeTempDir("skills-configure-planned-alias");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    const customSkillRoot = path.join(osHome, ".codex", "skills", "monke-tools", "codex");
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n"
    );
    write(sourceCheckout, "skills/codex/codex-only/SKILL.md", "---\nname: codex-only\n---\n");
    saveGlobalMonkeConfig(monkeHome, {
      installedSourceCheckout: sourceCheckout,
      version: 1
    });

    await expect(
      runCliAsync(
        ["skills", "configure"],
        createRuntime({
          cwd: sandbox,
          env: {
            HOME: osHome,
            MONKE_HOME: monkeHome
          },
          multiSelectValues: [["codex", "custom"]],
          onStderr() {},
          onStdout() {},
          stdinText: `${customSkillRoot}\n`
        })
      )
    ).rejects.toThrow(/managed Skill projection/u);
    expect(loadGlobalMonkeConfig(monkeHome).skillInstallPreference).toBeUndefined();
    expect(existsSync(path.join(osHome, ".codex", "skills"))).toBeFalsy();
    expect(existsSync(path.join(sourceCheckout, "skills", "codex", "monke-tools"))).toBeFalsy();
  });

  test("mt skills configure preserves the previous preference when skill identities collide", async () => {
    const sandbox = makeTempDir("skills-configure-identity-collision");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    write(
      sourceCheckout,
      "skills/internal/browser-control/SKILL.md",
      "---\nname: browser-control\n---\n"
    );
    write(
      sourceCheckout,
      "skills/codex/codex-browser/SKILL.md",
      "---\nname: browser-control\n---\n"
    );
    saveGlobalMonkeConfig(monkeHome, {
      installedSourceCheckout: sourceCheckout,
      skillInstallPreference: { targets: [{ kind: "cursor" }] },
      version: 1
    });

    await expect(
      runCliAsync(
        ["skills", "configure"],
        createRuntime({
          cwd: sandbox,
          env: {
            HOME: osHome,
            MONKE_HOME: monkeHome
          },
          multiSelectValues: [["codex"]],
          onStderr() {},
          onStdout() {}
        })
      )
    ).rejects.toThrow(/duplicate Agent skill name browser-control/u);
    expect(loadGlobalMonkeConfig(monkeHome).skillInstallPreference).toStrictEqual({
      targets: [{ kind: "cursor" }]
    });
    expect(existsSync(path.join(osHome, ".codex", "skills"))).toBeFalsy();
  });

  test("mt skills configure preselects existing targets when reconfiguring", async () => {
    const sandbox = makeTempDir("skills-configure-e2e");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    const customRoot = path.join(osHome, "custom-skills");
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n"
    );
    saveGlobalMonkeConfig(monkeHome, {
      installedSourceCheckout: sourceCheckout,
      version: 1
    });

    await runCliAsync(
      ["skills", "configure"],
      createRuntime({
        cwd: sandbox,
        env: {
          HOME: osHome,
          MONKE_HOME: monkeHome
        },
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
        env: {
          HOME: osHome,
          MONKE_HOME: monkeHome
        },
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

  test("mt skills local-install records the source checkout and configures skills when no preference exists", async () => {
    const sandbox = makeTempDir("skills-local-install-first");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n"
    );

    await runCliAsync(
      ["skills", "local-install", sourceCheckout],
      createRuntime({
        cwd: sandbox,
        env: {
          HOME: osHome,
          MONKE_HOME: monkeHome
        },
        multiSelectValues: [["codex"]],
        onStderr() {},
        onStdout() {}
      })
    );

    expect(loadGlobalMonkeConfig(monkeHome)).toStrictEqual({
      installedSourceCheckout: sourceCheckout,
      skillInstallPreference: {
        targets: [{ kind: "codex" }]
      },
      version: 1
    });
    expect(
      lstatSync(path.join(osHome, ".codex", "skills", "monke-tools")).isDirectory()
    ).toBeTruthy();
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
    write(
      newCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n"
    );
    saveGlobalMonkeConfig(monkeHome, {
      installedSourceCheckout: oldCheckout,
      skillInstallPreference: {
        targets: [{ kind: "codex" }]
      },
      version: 1
    });
    write(path.dirname(namespacePath), ".keep", "\n");
    symlinkSync(path.join(oldCheckout, "skills"), namespacePath, "dir");

    await runCliAsync(
      ["skills", "local-install", newCheckout],
      createRuntime({
        cwd: sandbox,
        env: {
          HOME: osHome,
          MONKE_HOME: monkeHome
        },
        onStderr() {},
        onStdout() {}
      })
    );

    expect(loadGlobalMonkeConfig(monkeHome).installedSourceCheckout).toBe(newCheckout);
    expect(lstatSync(namespacePath).isDirectory()).toBeTruthy();
    expect(readlinkSync(path.join(namespacePath, "internal"))).toBe(
      path.join(newCheckout, "skills", "internal")
    );
  });

  test("mt skills local-install preserves existing config and links when the new checkout is invalid", async () => {
    const sandbox = makeTempDir("skills-local-install-invalid-checkout");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const oldCheckout = path.join(sandbox, "old-source");
    const invalidCheckout = path.join(sandbox, "invalid-source");
    const namespacePath = path.join(osHome, ".codex", "skills", "monke-tools");
    write(
      oldCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n"
    );
    write(
      invalidCheckout,
      "skills/internal/browser-control/SKILL.md",
      "---\nname: browser-control\n---\n"
    );
    write(
      invalidCheckout,
      "skills/codex/codex-browser/SKILL.md",
      "---\nname: browser-control\n---\n"
    );
    const originalConfig = {
      installedSourceCheckout: oldCheckout,
      skillInstallPreference: {
        targets: [{ kind: "codex" as const }]
      },
      version: 1 as const
    };
    saveGlobalMonkeConfig(monkeHome, originalConfig);
    mkdirSync(path.dirname(namespacePath), { recursive: true });
    symlinkSync(path.join(oldCheckout, "skills"), namespacePath, "dir");

    await expect(
      runCliAsync(
        ["skills", "local-install", invalidCheckout],
        createRuntime({
          cwd: sandbox,
          env: {
            HOME: osHome,
            MONKE_HOME: monkeHome
          },
          onStderr() {},
          onStdout() {}
        })
      )
    ).rejects.toThrow(/duplicate Agent skill name browser-control/u);
    expect(loadGlobalMonkeConfig(monkeHome)).toStrictEqual(originalConfig);
    expect(lstatSync(namespacePath).isSymbolicLink()).toBeTruthy();
    expect(readlinkSync(namespacePath)).toBe(path.join(oldCheckout, "skills"));
  });

  test("mt skills configure fails clearly when the installed source checkout is missing", async () => {
    const sandbox = makeTempDir("skills-configure-missing-source");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const missingCheckout = path.join(sandbox, "missing-source");
    saveGlobalMonkeConfig(monkeHome, {
      installedSourceCheckout: missingCheckout,
      version: 1
    });

    await expect(
      runCliAsync(
        ["skills", "configure"],
        createRuntime({
          cwd: sandbox,
          env: {
            HOME: osHome,
            MONKE_HOME: monkeHome
          },
          onStderr() {},
          onStdout() {}
        })
      )
    ).rejects.toThrow(`Installed source checkout is missing: ${missingCheckout}`);
    expect(loadGlobalMonkeConfig(monkeHome).skillInstallPreference).toBeUndefined();
  });
});
