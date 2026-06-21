import { expect, test } from "vitest";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getExpectedWorktreePath } from "../src/git.ts";
import { createRepo, makeTempDir, runMonke } from "./helpers.ts";

test("swing navigates to an existing root repo Session worktree without creating one", () => {
  const sandbox = makeTempDir("swing-session");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "hello\n",
  });
  runMonke({ cwd: repoRoot, args: ["create", "banana"], monkeHome: home });

  const result = runMonke({ cwd: repoRoot, args: ["swing", "banana"], monkeHome: home });

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
  expect(result.stdout).toBe(`${worktreeRoot}\n`);
  expect(result.stderr).toContain(`Switch to ${worktreeRoot}`);
});

test("swing without a target opens a picker and selects a Session by number", () => {
  const sandbox = makeTempDir("swing-picker-number");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "hello\n",
  });
  runMonke({ cwd: repoRoot, args: ["create", "banana"], monkeHome: home });

  const result = runMonke({
    cwd: repoRoot,
    args: ["swing"],
    monkeHome: home,
    stdinText: "2\n",
  });

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
  expect(result.stdout).toContain("Swing targets:");
  expect(result.stdout).toContain("1. ^ Source checkout [current]");
  expect(result.stdout).toContain("2. banana Session banana");
  expect(result.stdout.endsWith(`${worktreeRoot}\n`)).toBe(true);
  expect(result.stderr).toContain(worktreeRoot);
});

test("swing picker accepts a Session name directly", () => {
  const sandbox = makeTempDir("swing-picker-name");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "hello\n",
  });
  runMonke({ cwd: repoRoot, args: ["create", "banana"], monkeHome: home });

  const result = runMonke({
    cwd: repoRoot,
    args: ["swing"],
    monkeHome: home,
    stdinText: "banana\n",
  });

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
  expect(result.stdout.endsWith(`${worktreeRoot}\n`)).toBe(true);
  expect(result.stderr).toContain(worktreeRoot);
});

test("swing picker can select the Source checkout from a Session worktree", () => {
  const sandbox = makeTempDir("swing-picker-source");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "hello\n",
  });
  runMonke({ cwd: repoRoot, args: ["create", "banana"], monkeHome: home });
  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");

  const result = runMonke({
    cwd: worktreeRoot,
    args: ["swing"],
    monkeHome: home,
    stdinText: "source\n",
  });

  expect(result.stdout).toContain("2. banana Session banana [current]");
  expect(result.stdout.endsWith(`${repoRoot}\n`)).toBe(true);
  expect(result.stderr).toContain(repoRoot);
});

test("swing picker rejects empty and unknown selections", () => {
  const sandbox = makeTempDir("swing-picker-invalid");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "hello\n",
  });
  runMonke({ cwd: repoRoot, args: ["create", "banana"], monkeHome: home });

  expect(() =>
    runMonke({ cwd: repoRoot, args: ["swing"], monkeHome: home, stdinText: "\n" }),
  ).toThrow(/Select a Swing target/);
  expect(() =>
    runMonke({ cwd: repoRoot, args: ["swing"], monkeHome: home, stdinText: "missing\n" }),
  ).toThrow(/Unknown Swing target selection: missing/);
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
  runMonke({ cwd: repoRoot, args: ["create", "feature@alice"], monkeHome: home });

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
  runMonke({ cwd: repoRoot, args: ["create", "banana"], monkeHome: home });
  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");

  const result = runMonke({ cwd: worktreeRoot, args: ["swing", "^"], monkeHome: home });

  expect(result.stdout).toBe(`${repoRoot}\n`);
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
  runMonke({ cwd: firstRepo, args: ["create", "banana"], monkeHome: home });
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
  runMonke({ cwd: repoRoot, args: ["create", "feature/pr-123"], monkeHome: home });
  runMonke({ cwd: repoRoot, args: ["create", "feature/pr-125"], monkeHome: home });
  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "feature/pr-123");
  const caseFoldedWorktreeRoot = getExpectedWorktreePath(home, repoRoot, "feature/pr-125");

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

  expect(byNumber.stdout).toBe(`${worktreeRoot}\n`);
  expect(byUrl.stdout).toBe(`${worktreeRoot}\n`);
  expect(byCaseFoldedNumber.stdout).toBe(`${caseFoldedWorktreeRoot}\n`);
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
