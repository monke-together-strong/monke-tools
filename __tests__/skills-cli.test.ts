import { existsSync, lstatSync, readlinkSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";

import { saveGlobalMonkeConfig, loadGlobalMonkeConfig } from "../src/global-config.ts";
import { runCli } from "../src/index.ts";
import { createRuntime } from "../src/runtime.ts";
import { makeTempDir, write } from "./helpers.ts";

describe("skills CLI", () => {
  test("mt skills configure saves selected targets and reconciles them", () => {
    const sandbox = makeTempDir("skills-configure");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n",
    );
    saveGlobalMonkeConfig(monkeHome, {
      installedSourceCheckout: sourceCheckout,
      version: 1,
    });

    let stdout = "";
    let stderr = "";
    const runtime = createRuntime({
      cwd: sandbox,
      env: {
        HOME: osHome,
        MONKE_HOME: monkeHome,
      },
      onStderr(text) {
        stderr += text;
      },
      onStdout(text) {
        stdout += text;
      },
      stdinText: "codex,custom\n~/team-skills\n",
    });

    runCli(["skills", "configure"], runtime);

    expect(loadGlobalMonkeConfig(monkeHome).skillInstallPreference).toStrictEqual({
      targets: [{ kind: "codex" }, { kind: "custom", path: path.join(osHome, "team-skills") }],
    });
    expect(
      lstatSync(path.join(osHome, ".codex", "skills", "monke-tools")).isSymbolicLink(),
    ).toBeTruthy();
    expect(
      lstatSync(path.join(osHome, "team-skills", "monke-tools")).isSymbolicLink(),
    ).toBeTruthy();
    expect(stdout).toContain("Skill install targets:");
    expect(stderr).toContain("Configured monke-tools skills");
  });

  test("mt skills configure can reconfigure all target kinds down to Claude and Codex", () => {
    const sandbox = makeTempDir("skills-configure-e2e");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    const customRoot = path.join(osHome, "custom-skills");
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n",
    );
    saveGlobalMonkeConfig(monkeHome, {
      installedSourceCheckout: sourceCheckout,
      version: 1,
    });

    runCli(
      ["skills", "configure"],
      createRuntime({
        cwd: sandbox,
        env: {
          HOME: osHome,
          MONKE_HOME: monkeHome,
        },
        onStderr() {},
        onStdout() {},
        stdinText: "codex,claude,cursor,custom\n~/custom-skills\n",
      }),
    );
    runCli(
      ["skills", "configure"],
      createRuntime({
        cwd: sandbox,
        env: {
          HOME: osHome,
          MONKE_HOME: monkeHome,
        },
        onStderr() {},
        onStdout() {},
        stdinText: "claude,codex\n",
      }),
    );

    expect(loadGlobalMonkeConfig(monkeHome).skillInstallPreference).toStrictEqual({
      targets: [{ kind: "claude" }, { kind: "codex" }],
    });
    expect(
      lstatSync(path.join(osHome, ".claude", "skills", "monke-tools-core")).isSymbolicLink(),
    ).toBeTruthy();
    expect(readlinkSync(path.join(osHome, ".claude", "skills", "monke-tools-core"))).toBe(
      path.join(sourceCheckout, "skills", "internal", "monke-tools-core"),
    );
    expect(existsSync(path.join(osHome, ".claude", "skills", "monke-tools"))).toBeFalsy();
    expect(
      lstatSync(path.join(osHome, ".codex", "skills", "monke-tools")).isSymbolicLink(),
    ).toBeTruthy();
    expect(existsSync(path.join(osHome, ".cursor", "skills", "monke-tools"))).toBeFalsy();
    expect(existsSync(path.join(customRoot, "monke-tools"))).toBeFalsy();
  });

  test("mt skills local-install records the source checkout and configures skills when no preference exists", () => {
    const sandbox = makeTempDir("skills-local-install-first");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const sourceCheckout = path.join(sandbox, "source");
    write(
      sourceCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n",
    );

    runCli(
      ["skills", "local-install", sourceCheckout],
      createRuntime({
        cwd: sandbox,
        env: {
          HOME: osHome,
          MONKE_HOME: monkeHome,
        },
        onStderr() {},
        onStdout() {},
        stdinText: "codex\n",
      }),
    );

    expect(loadGlobalMonkeConfig(monkeHome)).toStrictEqual({
      installedSourceCheckout: sourceCheckout,
      skillInstallPreference: {
        targets: [{ kind: "codex" }],
      },
      version: 1,
    });
    expect(
      lstatSync(path.join(osHome, ".codex", "skills", "monke-tools")).isSymbolicLink(),
    ).toBeTruthy();
  });

  test("mt skills local-install reuses an existing preference and relinks after a checkout move", () => {
    const sandbox = makeTempDir("skills-local-install-refresh");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const oldCheckout = path.join(sandbox, "old-source");
    const newCheckout = path.join(sandbox, "new-source");
    const namespacePath = path.join(osHome, ".codex", "skills", "monke-tools");
    write(
      oldCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n",
    );
    write(
      newCheckout,
      "skills/internal/monke-tools-core/SKILL.md",
      "---\nname: monke-tools-core\n---\n",
    );
    saveGlobalMonkeConfig(monkeHome, {
      installedSourceCheckout: oldCheckout,
      skillInstallPreference: {
        targets: [{ kind: "codex" }],
      },
      version: 1,
    });
    write(path.dirname(namespacePath), ".keep", "\n");
    symlinkSync(path.join(oldCheckout, "skills"), namespacePath, "dir");

    runCli(
      ["skills", "local-install", newCheckout],
      createRuntime({
        cwd: sandbox,
        env: {
          HOME: osHome,
          MONKE_HOME: monkeHome,
        },
        onStderr() {},
        onStdout() {},
      }),
    );

    expect(loadGlobalMonkeConfig(monkeHome).installedSourceCheckout).toBe(newCheckout);
    expect(readlinkSync(namespacePath)).toBe(path.join(newCheckout, "skills"));
  });

  test("mt skills configure fails clearly when the installed source checkout is missing", () => {
    const sandbox = makeTempDir("skills-configure-missing-source");
    const monkeHome = path.join(sandbox, "monke-home");
    const osHome = path.join(sandbox, "home");
    const missingCheckout = path.join(sandbox, "missing-source");
    saveGlobalMonkeConfig(monkeHome, {
      installedSourceCheckout: missingCheckout,
      version: 1,
    });

    expect(() => {
      runCli(
        ["skills", "configure"],
        createRuntime({
          cwd: sandbox,
          env: {
            HOME: osHome,
            MONKE_HOME: monkeHome,
          },
          onStderr() {},
          onStdout() {},
          stdinText: "codex\n",
        }),
      );
    }).toThrow(`Installed source checkout is missing: ${missingCheckout}`);
    expect(loadGlobalMonkeConfig(monkeHome).skillInstallPreference).toBeUndefined();
  });
});
