import { expect, test } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getExpectedWorktreePath } from "../src/git.ts";
import { SHELL_DIRECTORY_DIRECTIVE_ENV } from "../src/shell.ts";
import { createRepo, makeTempDir, read, runMonke } from "./helpers.ts";

test("create writes an active shell directory directive", () => {
  const sandbox = makeTempDir("shell-create-active");
  const home = path.join(sandbox, "home");
  const directivePath = path.join(sandbox, "directive");
  writeFileSync(directivePath, "", "utf8");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "hello\n",
  });

  const result = runMonke({
    cwd: repoRoot,
    args: ["create", "banana"],
    monkeHome: home,
    extraEnv: {
      [SHELL_DIRECTORY_DIRECTIVE_ENV]: directivePath,
    },
  });

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
  expect(readFileSync(directivePath, "utf8")).toBe(worktreeRoot);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`Created or updated session banana\nSwitched to ${worktreeRoot}`);
});

test("create distinguishes configured but inactive shell integration", () => {
  const sandbox = makeTempDir("shell-create-configured-inactive");
  const monkeHome = path.join(sandbox, "monke-home");
  const shellHome = path.join(sandbox, "shell-home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "hello\n",
  });

  runMonke({
    cwd: repoRoot,
    args: ["shell", "install", "--binary", "/opt/monke-tools"],
    monkeHome,
    extraEnv: {
      HOME: shellHome,
    },
  });

  const result = runMonke({
    cwd: repoRoot,
    args: ["create", "banana"],
    monkeHome,
    extraEnv: {
      HOME: shellHome,
      SHELL: "/bin/zsh",
    },
  });

  const worktreeRoot = getExpectedWorktreePath(monkeHome, repoRoot, "banana");
  expect(result.stdout).toBe(`${worktreeRoot}\n`);
  expect(result.stderr).toContain(`Switch to ${worktreeRoot}`);
  expect(result.stderr).toContain(
    "Shell integration is configured but not active; restart your shell or invoke mt through the shell adapter.",
  );
});

test("repo commands cannot write an active shell directory directive", () => {
  const sandbox = makeTempDir("shell-directive-child-env");
  const home = path.join(sandbox, "home");
  const directivePath = path.join(sandbox, "directive");
  writeFileSync(directivePath, "", "utf8");
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
`,
  });
  runMonke({ cwd: repoRoot, args: ["create", "banana"], monkeHome: home });
  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");

  runMonke({
    cwd: worktreeRoot,
    args: ["materialize"],
    monkeHome: home,
    extraEnv: {
      [SHELL_DIRECTORY_DIRECTIVE_ENV]: directivePath,
    },
  });

  expect(readFileSync(directivePath, "utf8")).toBe("");
});

test("shell init emits bash and zsh adapters", () => {
  const sandbox = makeTempDir("shell-init");
  const monkeHome = path.join(sandbox, "monke-home");

  const bash = runMonke({
    cwd: sandbox,
    args: ["shell", "init", "bash", "--binary", "/opt/monke-tools"],
    monkeHome,
  });
  const zsh = runMonke({
    cwd: sandbox,
    args: ["shell", "init", "zsh", "--binary", "/opt/monke-tools"],
    monkeHome,
  });

  expect(bash.stdout).toContain("# monke-tools shell integration for bash");
  expect(bash.stdout).toContain(
    `${SHELL_DIRECTORY_DIRECTIVE_ENV}="$__monke_mt_directive" '/opt/monke-tools' "$@"`,
  );
  expect(zsh.stdout).toContain("# monke-tools shell integration for zsh");
  expect(zsh.stdout).toContain('cd -- "$__monke_mt_target"');
  expect(bash.stderr).toBe("");
  expect(zsh.stderr).toBe("");
});

test("shell install refreshes bash and zsh startup files idempotently", () => {
  const sandbox = makeTempDir("shell-install");
  const monkeHome = path.join(sandbox, "monke-home");
  const shellHome = path.join(sandbox, "shell-home");

  for (let index = 0; index < 2; index += 1) {
    runMonke({
      cwd: sandbox,
      args: ["shell", "install", "--binary", "/opt/monke-tools"],
      monkeHome,
      extraEnv: {
        HOME: shellHome,
      },
    });
  }

  for (const startupFile of [".bashrc", ".zshrc"]) {
    const contents = read(shellHome, startupFile);
    expect(contents.match(/monke-tools shell integration/g)).toHaveLength(2);
    expect(contents).toContain("'/opt/monke-tools' shell init");
    expect(existsSync(path.join(shellHome, startupFile))).toBe(true);
  }
});
