import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { getExpectedWorktreePath } from "../src/git.ts";
import { SHELL_DIRECTORY_DIRECTIVE_ENV } from "../src/shell.ts";
import { createRepo, makeTempDir, read, runMonke } from "./helpers.ts";

type SupportedShell = "bash" | "zsh";

function isShellAvailable(shell: SupportedShell) {
  return spawnSync(shell, ["-c", "exit 0"], { stdio: "ignore" }).error === undefined;
}

function runGeneratedAdapter(shell: SupportedShell, mtStatus: number, targetExists: boolean) {
  const sandbox = makeTempDir(`shell-adapter-${shell}-${mtStatus}-${targetExists}`);
  const targetPath = path.join(sandbox, targetExists ? "target" : "missing");
  const binaryPath = path.join(sandbox, "fake-mt");
  if (targetExists) {
    mkdirSync(targetPath);
  }
  writeFileSync(
    binaryPath,
    `#!/bin/sh
printf '%s' "$MONKE_TEST_TARGET" > "$MONKE_SHELL_DIR_DIRECTIVE"
exit ${mtStatus}
`,
    "utf-8"
  );
  chmodSync(binaryPath, 0o755);
  const adapter = runMonke({
    args: ["shell", "init", shell, "--binary", binaryPath],
    cwd: sandbox,
    monkeHome: path.join(sandbox, "monke-home")
  }).stdout;
  const result = spawnSync(
    shell,
    [
      "-c",
      `${adapter}
monke 2>/dev/null
mt_status=$?
printf '%s\\n%s\\n' "$PWD" "$mt_status"
`
    ],
    {
      cwd: sandbox,
      encoding: "utf-8",
      env: {
        ...process.env,
        MONKE_TEST_TARGET: targetPath
      }
    }
  );
  if (result.error !== undefined || result.stdout === null) {
    throw new Error(`Could not run ${shell}: ${String(result.error ?? "no output")}`);
  }
  const [reportedPath = "", reportedStatus = ""] = result.stdout.trim().split("\n");
  return {
    processStatus: result.status,
    reportedPath,
    reportedStatus,
    sandbox,
    targetPath
  };
}

describe("shell navigation", () => {
  test("spawn writes an active shell directory directive", () => {
    const sandbox = makeTempDir("shell-spawn-active");
    const home = path.join(sandbox, "home");
    const directivePath = path.join(sandbox, "directive");
    writeFileSync(directivePath, "", "utf-8");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "apps: {}\n",
      "README.md": "hello\n"
    });

    const result = runMonke({
      args: ["spawn", "banana"],
      cwd: repoRoot,
      extraEnv: {
        [SHELL_DIRECTORY_DIRECTIVE_ENV]: directivePath
      },
      monkeHome: home
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    expect(readFileSync(directivePath, "utf-8")).toBe(worktreeRoot);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      `Spawned or updated session banana\nSwitched to ${worktreeRoot}`
    );
  });

  test("spawn distinguishes configured but inactive shell integration", () => {
    const sandbox = makeTempDir("shell-spawn-configured-inactive");
    const monkeHome = path.join(sandbox, "monke-home");
    const shellHome = path.join(sandbox, "shell-home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "apps: {}\n",
      "README.md": "hello\n"
    });

    runMonke({
      args: ["shell", "install", "--binary", "/opt/mt"],
      cwd: repoRoot,
      extraEnv: {
        HOME: shellHome,
        SHELL: "/bin/zsh"
      },
      monkeHome
    });

    const result = runMonke({
      args: ["spawn", "banana"],
      cwd: repoRoot,
      extraEnv: {
        HOME: shellHome,
        SHELL: "/bin/zsh"
      },
      monkeHome
    });

    const worktreeRoot = getExpectedWorktreePath(monkeHome, repoRoot, "banana");
    expect(result.stdout).toBe(`${worktreeRoot}\n`);
    expect(result.stderr).toContain(`Switch to ${worktreeRoot}`);
    expect(result.stderr).toContain(
      "Shell integration is configured but not active; restart your shell or invoke mt through the shell adapter."
    );
  });

  test("spawn treats unreadable shell startup files as inactive integration", () => {
    const sandbox = makeTempDir("shell-spawn-unreadable-startup");
    const monkeHome = path.join(sandbox, "monke-home");
    const shellHome = path.join(sandbox, "shell-home");
    const startupFile = path.join(shellHome, ".zshrc");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "apps: {}\n",
      "README.md": "hello\n"
    });
    mkdirSync(shellHome, { recursive: true });
    writeFileSync(startupFile, "# >>> monke-tools shell integration >>>\n", "utf-8");
    chmodSync(startupFile, 0o000);

    try {
      const result = runMonke({
        args: ["spawn", "banana"],
        cwd: repoRoot,
        extraEnv: {
          HOME: shellHome,
          SHELL: "/bin/zsh"
        },
        monkeHome
      });

      const worktreeRoot = getExpectedWorktreePath(monkeHome, repoRoot, "banana");
      expect(result.stdout).toBe(`${worktreeRoot}\n`);
      expect(result.stderr).toContain(`Switch to ${worktreeRoot}`);
      expect(result.stderr).toContain("Enable automatic switching with: mt shell install");
    } finally {
      chmodSync(startupFile, 0o600);
    }
  });

  test("repo commands cannot write an active shell directory directive", () => {
    const sandbox = makeTempDir("shell-directive-child-env");
    const home = path.join(sandbox, "home");
    const directivePath = path.join(sandbox, "directive");
    writeFileSync(directivePath, "", "utf-8");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env": "PORT=3000\n",
      "monke.yml": `bootstrapCommand: |
  if [ -n "\${MONKE_SHELL_DIR_DIRECTIVE:-}" ]; then
    printf '%s' /tmp/hijacked > "$MONKE_SHELL_DIR_DIRECTIVE"
  fi
apps:
  api:
    path: apps/api
    mappings:
      - port: API_PORT
        env: PORT
`
    });
    runMonke({ args: ["spawn", "banana"], cwd: repoRoot, monkeHome: home });
    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");

    runMonke({
      args: ["materialize"],
      cwd: worktreeRoot,
      extraEnv: {
        [SHELL_DIRECTORY_DIRECTIVE_ENV]: directivePath
      },
      monkeHome: home
    });

    expect(readFileSync(directivePath, "utf-8")).toBe("");
  });

  describe.each(["bash", "zsh"] as const)("%s adapter", (shell) => {
    const available = isShellAvailable(shell);
    const availability = available ? "" : " (shell unavailable)";

    test.skipIf(!available)(
      `honors a directory request and preserves a nonzero mt status${availability}`,
      () => {
        const result = runGeneratedAdapter(shell, 23, true);

        expect(result.processStatus).toBe(0);
        expect(result.reportedPath).toBe(result.targetPath);
        expect(result.reportedStatus).toBe("23");
      }
    );

    test.skipIf(!available)(
      `handles a failed directory request after mt status 0${availability}`,
      () => {
        const result = runGeneratedAdapter(shell, 0, false);

        expect(result.processStatus).toBe(0);
        expect(result.reportedPath).toBe(result.sandbox);
        expect(result.reportedStatus).toBe("1");
      }
    );

    test.skipIf(!available)(
      `handles a failed directory request after mt status 23${availability}`,
      () => {
        const result = runGeneratedAdapter(shell, 23, false);

        expect(result.processStatus).toBe(0);
        expect(result.reportedPath).toBe(result.sandbox);
        expect(result.reportedStatus).toBe("23");
      }
    );
  });

  test.each([
    ["bash", ".bashrc", ".zshrc"],
    ["zsh", ".zshrc", ".bashrc"]
  ] as const)(
    "%s shell install reports and idempotently refreshes only its startup file",
    (shell, startupFile, otherStartupFile) => {
      const sandbox = makeTempDir(`shell-install-${shell}`);
      const monkeHome = path.join(sandbox, "monke-home");
      const shellHome = path.join(sandbox, "shell-home");
      const stableBinary = path.join(shellHome, ".local", "bin", "mt");
      const results = [];

      for (const _attempt of [1, 2]) {
        results.push(
          runMonke({
            args: ["shell", "install", "--binary", stableBinary],
            cwd: sandbox,
            extraEnv: {
              HOME: shellHome,
              SHELL: `/bin/${shell}`
            },
            monkeHome
          })
        );
      }

      const contents = read(shellHome, startupFile);
      expect(contents.match(/monke-tools shell integration/gu)).toHaveLength(2);
      expect(contents).toContain(`'${stableBinary}' shell init`);
      expect(existsSync(path.join(shellHome, otherStartupFile))).toBeFalsy();
      for (const result of results) {
        expect(result.stderr).toContain(
          `Installed shell integration in ${path.join(shellHome, startupFile)}`
        );
        expect(result.stderr).toContain("Restart your shell");
      }
    }
  );

  test("zsh install and configured-state detection honor relative ZDOTDIR", () => {
    const sandbox = makeTempDir("shell-install-zdotdir");
    const monkeHome = path.join(sandbox, "monke-home");
    const shellHome = path.join(sandbox, "shell-home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "apps: {}\n",
      "README.md": "hello\n"
    });
    const startupFile = path.join(repoRoot, "config", "zsh", ".zshrc");
    const shellEnvironment = {
      HOME: shellHome,
      SHELL: "/bin/zsh",
      ZDOTDIR: "config/zsh"
    };

    runMonke({
      args: ["shell", "install", "--binary", "/opt/mt"],
      cwd: repoRoot,
      extraEnv: shellEnvironment,
      monkeHome
    });
    const result = runMonke({
      args: ["spawn", "banana"],
      cwd: repoRoot,
      extraEnv: shellEnvironment,
      monkeHome
    });

    expect(readFileSync(startupFile, "utf-8")).toContain("monke-tools shell integration");
    expect(existsSync(path.join(shellHome, ".zshrc"))).toBeFalsy();
    expect(result.stderr).toContain("Shell integration is configured but not active");
  });

  test("shell install leaves startup files untouched for an unsupported current shell", () => {
    const sandbox = makeTempDir("shell-install-unsupported");
    const shellHome = path.join(sandbox, "shell-home");

    const result = runMonke({
      args: ["shell", "install", "--binary", "/opt/mt"],
      cwd: sandbox,
      extraEnv: {
        HOME: shellHome,
        SHELL: "/usr/local/bin/fish"
      },
      monkeHome: path.join(sandbox, "monke-home")
    });

    expect(existsSync(path.join(shellHome, ".bashrc"))).toBeFalsy();
    expect(existsSync(path.join(shellHome, ".zshrc"))).toBeFalsy();
    expect(result.stderr).toContain("Shell integration is not available for /usr/local/bin/fish");
    expect(result.stderr).toContain("No startup file was changed");
  });
});
