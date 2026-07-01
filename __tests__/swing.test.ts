import { expect, test } from "vitest";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getExpectedWorktreePath } from "../src/git.ts";
import { createRepo, git, makeTempDir, runMonke, runMonkeAsync } from "./helpers.ts";

test("swing navigates to an existing root repo Session worktree without creating one", () => {
  const sandbox = makeTempDir("swing-session");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "hello\n",
  });
  runMonke({ cwd: repoRoot, args: ["spawn", "banana"], monkeHome: home });

  const result = runMonke({ cwd: repoRoot, args: ["swing", "banana"], monkeHome: home });

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
  expect(result.stdout).toBe(`${worktreeRoot}\n`);
  expect(result.stderr).toContain(`Switch to ${worktreeRoot}`);
});

test("swing without a target opens a Swing picker and selects a Session", async () => {
  const sandbox = makeTempDir("swing-picker-number");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "hello\n",
  });
  runMonke({ cwd: repoRoot, args: ["spawn", "banana"], monkeHome: home });

  const result = await runMonkeAsync({
    cwd: repoRoot,
    args: ["swing"],
    monkeHome: home,
    selectValues: ["banana"],
  });

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
  expect(result.stdout.endsWith(`${worktreeRoot}\n`)).toBe(true);
  expect(result.stderr).toContain(worktreeRoot);
});

test("swing picker can select the Source checkout from a Session worktree", async () => {
  const sandbox = makeTempDir("swing-picker-source");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "hello\n",
  });
  runMonke({ cwd: repoRoot, args: ["spawn", "banana"], monkeHome: home });
  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");

  const result = await runMonkeAsync({
    cwd: worktreeRoot,
    args: ["swing"],
    monkeHome: home,
    selectValues: ["^"],
  });

  expect(result.stdout.endsWith(`${repoRoot}\n`)).toBe(true);
  expect(result.stderr).toContain(repoRoot);
});

test("swing picker selecting the current target preserves Previous Swing target history", async () => {
  const sandbox = makeTempDir("swing-picker-current-history");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "hello\n",
  });
  runMonke({ cwd: repoRoot, args: ["spawn", "banana"], monkeHome: home });
  runMonke({ cwd: repoRoot, args: ["spawn", "cherry"], monkeHome: home });
  const bananaWorktree = getExpectedWorktreePath(home, repoRoot, "banana");
  const cherryWorktree = getExpectedWorktreePath(home, repoRoot, "cherry");
  runMonke({ cwd: repoRoot, args: ["swing", "banana"], monkeHome: home });
  runMonke({ cwd: bananaWorktree, args: ["swing", "cherry"], monkeHome: home });

  const noOpResult = await runMonkeAsync({
    cwd: cherryWorktree,
    args: ["swing"],
    monkeHome: home,
    selectValues: ["cherry"],
  });
  const previousResult = runMonke({
    cwd: cherryWorktree,
    args: ["swing", "-"],
    monkeHome: home,
  });

  expect(noOpResult.stdout.endsWith(`${cherryWorktree}\n`)).toBe(true);
  expect(previousResult.stdout).toBe(`${bananaWorktree}\n`);
});

test("swing picker rejects unknown selections", async () => {
  const sandbox = makeTempDir("swing-picker-invalid");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "hello\n",
  });
  runMonke({ cwd: repoRoot, args: ["spawn", "banana"], monkeHome: home });

  await expect(
    runMonkeAsync({
      cwd: repoRoot,
      args: ["swing"],
      monkeHome: home,
      selectValues: ["missing"],
    }),
  ).rejects.toThrow(/Unknown selection: missing/);
});

test("swing fails clearly when the Session does not exist", () => {
  const sandbox = makeTempDir("swing-missing");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "hello\n",
  });

  expect(() => runMonke({ cwd: repoRoot, args: ["swing", "missing"], monkeHome: home })).toThrow(
    /Session "missing" does not exist/,
  );
});

test("swing treats @ inside Session names as ordinary branch text", () => {
  const sandbox = makeTempDir("swing-at-session");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "hello\n",
  });
  runMonke({ cwd: repoRoot, args: ["spawn", "feature@alice"], monkeHome: home });

  const result = runMonke({ cwd: repoRoot, args: ["swing", "feature@alice"], monkeHome: home });

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "feature@alice");
  expect(result.stdout).toBe(`${worktreeRoot}\n`);
  expect(result.stderr).toContain(`Switch to ${worktreeRoot}`);
});

test("swing caret returns from a Session worktree to the Source checkout", () => {
  const sandbox = makeTempDir("swing-source");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "hello\n",
  });
  runMonke({ cwd: repoRoot, args: ["spawn", "banana"], monkeHome: home });
  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");

  const result = runMonke({ cwd: worktreeRoot, args: ["swing", "^"], monkeHome: home });

  expect(result.stdout).toBe(`${repoRoot}\n`);
  expect(result.stderr).toContain(`Switch to ${repoRoot}`);
});

test("swing allows the current Session worktree to live outside Monke home with a warning", () => {
  const sandbox = makeTempDir("swing-external-worktree");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "hello\n",
  });
  const worktreeRoot = path.join(sandbox, "codex", "winters-echo");
  git(repoRoot, ["branch", "winters-echo"]);
  git(repoRoot, ["worktree", "add", worktreeRoot, "winters-echo"]);

  const result = runMonke({ cwd: worktreeRoot, args: ["swing", "^"], monkeHome: home });

  expect(result.stdout).toBe(`${repoRoot}\n`);
  expect(result.stderr).toContain(
    `Linked worktree ${worktreeRoot} is outside ${path.join(home, "worktrees", "root")}`,
  );
  expect(result.stderr).toContain(`Switch to ${repoRoot}`);
});

test("swing dash toggles to the Previous Swing target scoped by Root repo", () => {
  const sandbox = makeTempDir("swing-previous");
  const home = path.join(sandbox, "home");
  const firstRepo = createRepo(path.join(sandbox, "first"), {
    "README.md": "first\n",
  });
  const secondRepo = createRepo(path.join(sandbox, "second"), {
    "README.md": "second\n",
  });
  runMonke({ cwd: firstRepo, args: ["spawn", "banana"], monkeHome: home });
  const worktreeRoot = getExpectedWorktreePath(home, firstRepo, "banana");
  runMonke({ cwd: firstRepo, args: ["swing", "banana"], monkeHome: home });

  const backToSource = runMonke({ cwd: worktreeRoot, args: ["swing", "-"], monkeHome: home });
  const backToSession = runMonke({ cwd: firstRepo, args: ["swing", "-"], monkeHome: home });

  expect(backToSource.stdout).toBe(`${firstRepo}\n`);
  expect(backToSession.stdout).toBe(`${worktreeRoot}\n`);
  expect(() => runMonke({ cwd: secondRepo, args: ["swing", "-"], monkeHome: home })).toThrow(
    /No Previous Swing target/,
  );
});

test("swing resolves same-repo GitHub PR numbers and URLs to existing Sessions", () => {
  const sandbox = makeTempDir("swing-pr");
  const home = path.join(sandbox, "home");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "hello\n",
  });
  installSwingGhShim(binDirectory, {
    "123": {
      headRefName: "feature/pr-123",
      headRepositoryOwner: { login: "owner" },
      headRepository: { name: "root" },
    },
    "125": {
      headRefName: "feature/pr-125",
      headRepositoryOwner: { login: "OWNER" },
      headRepository: { name: "ROOT" },
    },
  });
  const openLogPath = installCodexUrlOpenShim(binDirectory);
  runMonke({ cwd: repoRoot, args: ["spawn", "feature/pr-123"], monkeHome: home });
  runMonke({ cwd: repoRoot, args: ["spawn", "feature/pr-125"], monkeHome: home });
  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "feature/pr-123");
  const caseFoldedWorktreeRoot = getExpectedWorktreePath(home, repoRoot, "feature/pr-125");
  const codexThreadUrl = `codex://threads/new?path=${encodeURIComponent(worktreeRoot)}`;

  const byNumber = runMonke({
    cwd: repoRoot,
    args: ["swing", "pr:123"],
    monkeHome: home,
    binDirectory,
  });
  const byUrl = runMonke({
    cwd: repoRoot,
    args: ["swing", "https://github.com/owner/root/pull/123"],
    monkeHome: home,
    binDirectory,
  });
  const byCaseFoldedNumber = runMonke({
    cwd: repoRoot,
    args: ["swing", "pr:125"],
    monkeHome: home,
    binDirectory,
  });
  const byCodexPr = runMonke({
    cwd: repoRoot,
    args: ["swing", "pr:123", "--codex"],
    monkeHome: home,
    binDirectory,
  });

  expect(byNumber.stdout).toBe(`${worktreeRoot}\n`);
  expect(byUrl.stdout).toBe(`${worktreeRoot}\n`);
  expect(byCaseFoldedNumber.stdout).toBe(`${caseFoldedWorktreeRoot}\n`);
  expect(byCodexPr.stdout).toBe(`${worktreeRoot}\n`);
  expect(byCodexPr.stderr).toContain(`Opened Codex thread for ${worktreeRoot}`);
  expect(readFileSync(openLogPath, "utf8")).toBe(`${codexThreadUrl}\n`);
});

test("swing creates a missing same-repo GitHub PR Session", () => {
  const sandbox = makeTempDir("swing-pr-create");
  const home = path.join(sandbox, "home");
  const binDirectory = path.join(sandbox, "bin");
  const prBranch = "feature/issue-81-flow-market-unit";
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "main\n",
  });
  const originRoot = path.join(sandbox, "origin.git");
  mkdirSync(originRoot, { recursive: true });
  git(originRoot, ["init", "--bare"]);
  git(repoRoot, ["remote", "add", "origin", originRoot]);
  git(repoRoot, ["switch", "-c", prBranch]);
  writeFileSync(path.join(repoRoot, "README.md"), "pr head\n", "utf8");
  mkdirSync(path.join(repoRoot, "apps/api"), { recursive: true });
  writeFileSync(path.join(repoRoot, "apps/api/.env.local"), "PORT=3000\n", "utf8");
  writeFileSync(
    path.join(repoRoot, "monke.yml"),
    `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
    "utf8",
  );
  git(repoRoot, ["add", "README.md"]);
  git(repoRoot, ["add", "apps/api/.env.local", "monke.yml"]);
  git(repoRoot, ["commit", "-m", "pr head"]);
  git(repoRoot, ["push", "origin", `${prBranch}:refs/pull/82/head`]);
  git(repoRoot, ["switch", "main"]);
  git(repoRoot, ["branch", "-D", prBranch]);
  installSwingGhShim(binDirectory, {
    "82": {
      headRefName: prBranch,
      headRepositoryOwner: { login: "owner" },
      headRepository: { name: "root" },
    },
  });
  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, prBranch);

  const result = runMonke({
    cwd: repoRoot,
    args: ["swing", "pr:82"],
    monkeHome: home,
    binDirectory,
  });

  expect(result.stdout).toBe(`${worktreeRoot}\n`);
  expect(readFileSync(path.join(worktreeRoot, "README.md"), "utf8")).toBe("pr head\n");
  expect(readFileSync(path.join(worktreeRoot, "apps/api/.env.local"), "utf8")).toBe("PORT=10000\n");
  expect(readFileSync(path.join(worktreeRoot, ".env"), "utf8")).toBe("API_PORT=10000\n");
  expect(result.stderr).toContain(`Spawned or updated session ${prBranch}`);
  expect(result.stderr).toContain(`Switch to ${worktreeRoot}`);
});

test("swing --codex escapes percent-encoded URLs for the Windows launcher", () => {
  const sandbox = makeTempDir("swing-codex-windows");
  const home = path.join(sandbox, "home");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "hello\n",
  });
  const cmdLogPath = installWindowsCmdShim(binDirectory);
  runMonke({ cwd: repoRoot, args: ["spawn", "banana"], monkeHome: home });
  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
  const codexThreadUrl = `codex://threads/new?path=${encodeURIComponent(worktreeRoot)}`;

  const result = withPlatform("win32", () =>
    runMonke({
      cwd: repoRoot,
      args: ["swing", "banana", "--codex"],
      monkeHome: home,
      binDirectory,
    }),
  );

  expect(result.stdout).toBe(`${worktreeRoot}\n`);
  expect(result.stderr).toContain(`Opened Codex thread for ${worktreeRoot}`);
  expect(readFileSync(cmdLogPath, "utf8")).toBe(
    `/c\nstart\n\n${codexThreadUrl.replaceAll("%", "^%")}\n`,
  );
});

test("swing rejects unsupported PR and target forms clearly", () => {
  const sandbox = makeTempDir("swing-unsupported");
  const home = path.join(sandbox, "home");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "hello\n",
  });
  installSwingGhShim(binDirectory, {
    "124": {
      headRefName: "fork/pr-124",
      headRepositoryOwner: { login: "contributor" },
      headRepository: { name: "root" },
    },
  });

  expect(() =>
    runMonke({ cwd: repoRoot, args: ["swing", "pr:124"], monkeHome: home, binDirectory }),
  ).toThrow(/Fork PR targets are not supported/);
  expect(() =>
    runMonke({
      cwd: repoRoot,
      args: ["swing", "https://github.com/other/root/pull/124"],
      monkeHome: home,
      binDirectory,
    }),
  ).toThrow(/Cross-repo PR URLs are not supported/);
  expect(() => runMonke({ cwd: repoRoot, args: ["swing", "mr:12"], monkeHome: home })).toThrow(
    /Merge request Swing targets are out of scope/,
  );
  expect(() => runMonke({ cwd: repoRoot, args: ["swing", "@"], monkeHome: home })).toThrow(
    /@ Swing targets are not supported/,
  );
});

function installSwingGhShim(
  binDirectory: string,
  prs: Record<
    string,
    {
      headRefName: string;
      headRepositoryOwner: { login: string };
      headRepository: { name: string };
    }
  >,
): void {
  mkdirSync(binDirectory, { recursive: true });
  const cases = Object.entries(prs)
    .map(([number, pr]) => `    ${number}) printf '%s\\n' '${JSON.stringify(pr)}'; exit 0 ;;`)
    .join("\n");
  const script = `#!/bin/sh
set -eu
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  printf '%s\\n' '{"nameWithOwner":"owner/root"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  case "$3" in
${cases}
  esac
fi
echo "unsupported gh invocation: $*" >&2
exit 1
`;
  const targetPath = path.join(binDirectory, "gh");
  writeFileSync(targetPath, script, "utf8");
  chmodSync(targetPath, 0o755);
}

function installCodexUrlOpenShim(binDirectory: string): string {
  mkdirSync(binDirectory, { recursive: true });
  const logPath = path.join(binDirectory, "open-url.log");
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const script = `#!/bin/sh
set -eu
printf '%s\\n' "$@" >> '${logPath.replaceAll("'", `'\\''`)}'
`;
  const targetPath = path.join(binDirectory, command);
  writeFileSync(targetPath, script, "utf8");
  chmodSync(targetPath, 0o755);
  return logPath;
}

function installWindowsCmdShim(binDirectory: string): string {
  mkdirSync(binDirectory, { recursive: true });
  const logPath = path.join(binDirectory, "cmd.log");
  const script = `#!/bin/sh
set -eu
printf '%s\\n' "$@" >> '${logPath.replaceAll("'", `'\\''`)}'
`;
  const targetPath = path.join(binDirectory, "cmd");
  writeFileSync(targetPath, script, "utf8");
  chmodSync(targetPath, 0o755);
  return logPath;
}

function withPlatform<T>(platform: NodeJS.Platform, callback: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  }
}
