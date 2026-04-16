import { expect, test } from "vitest";
import { rmSync } from "node:fs";
import path from "node:path";

import {
  determineReviewerTarget,
  ensureSessionWorktree,
  getHeadCommitInfo,
  getExpectedWorktreePath,
  inferSessionName,
  inspectCheckoutState,
  listWorktrees,
  validateWorktreeForSession,
} from "../src/git.ts";
import { createRuntime } from "../src/runtime.ts";
import { createRepo, git, makeTempDir, write } from "./helpers.ts";
import type { Runtime } from "../src/types.ts";

test("inferSessionName supports slash-delimited session names", () => {
  const sourceRoot = path.join("/tmp", "monke-root");
  const worktreeRoot = getExpectedWorktreePath(sourceRoot, "feature/foo");

  expect(inferSessionName(sourceRoot, worktreeRoot, "feature/foo")).toBe("feature/foo");
});

test("validateWorktreeForSession rejects worktrees from a different repository", () => {
  const sandbox = makeTempDir("git-repo-identity");
  const sourceRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });
  const otherSourceRoot = createRepo(path.join(sandbox, "other"), {
    "apps/db/.env.local": "PORT=5432\n",
    "monke.yml": `apps:
  db:
    path: apps/db
    envFile: .env.local
    mappings:
      - port: DB_PORT
        env: PORT
`,
  });
  const worktreePath = getExpectedWorktreePath(sourceRoot, "banana");

  git(otherSourceRoot, ["branch", "banana"]);
  git(otherSourceRoot, ["worktree", "add", worktreePath, "banana"]);

  expect(() =>
    validateWorktreeForSession(
      createRuntime({ cwd: sourceRoot }),
      sourceRoot,
      worktreePath,
      "banana",
    ),
  ).toThrow(/live under|to belong to/);
});

test("listWorktrees parses prunable entries from porcelain output", () => {
  const runtime: Runtime = {
    cwd: "/tmp",
    env: {},
    exec(command, args) {
      expect(command).toBe("git");
      expect(args).toEqual(["worktree", "list", "--porcelain"]);
      return {
        stdout: `worktree /tmp/root
branch refs/heads/main

worktree /tmp/worktree
branch refs/heads/feature/foo
prunable gitdir file points to non-existent location
`,
        stderr: "",
        exitCode: 0,
      };
    },
    writeStdout() {},
    writeStderr() {},
  };

  expect(listWorktrees(runtime, "/tmp/root")).toEqual([
    { path: "/tmp/root", branch: "main", prunable: false },
    { path: "/tmp/worktree", branch: "feature/foo", prunable: true },
  ]);
});

test("ensureSessionWorktree recreates missing cached worktrees", () => {
  const sandbox = makeTempDir("git-recreate-worktree");
  const sourceRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });
  const runtime = createRuntime({ cwd: sourceRoot });
  const session = "banana";
  const expectedPath = getExpectedWorktreePath(sourceRoot, session);

  git(sourceRoot, ["branch", session]);
  git(sourceRoot, ["worktree", "add", expectedPath, session]);
  rmSync(expectedPath, { recursive: true, force: true });

  const result = ensureSessionWorktree(runtime, sourceRoot, session);

  expect(result).toEqual({ path: expectedPath, created: true });
  expect(git(expectedPath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(session);
});

test("ensureSessionWorktree rejects invalid session names before worktree operations", () => {
  const sandbox = makeTempDir("git-invalid-session");
  const sourceRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });

  expect(() =>
    ensureSessionWorktree(createRuntime({ cwd: sourceRoot }), sourceRoot, "--help"),
  ).toThrow(/Invalid session name "--help"/);
});

test("inspectCheckoutState reports staged, unstaged, and untracked changes as dirty", () => {
  const sandbox = makeTempDir("git-checkout-state");
  const sourceRoot = createRepo(path.join(sandbox, "root"), {
    "tracked.txt": "before\n",
    "unstaged.txt": "before\n",
  });

  write(sourceRoot, "tracked.txt", "after staged\n");
  git(sourceRoot, ["add", "tracked.txt"]);
  write(sourceRoot, "unstaged.txt", "after unstaged\n");
  write(sourceRoot, "untracked.txt", "brand new\n");

  const state = inspectCheckoutState(createRuntime({ cwd: sourceRoot }), sourceRoot);

  expect(state.isDirty).toBe(true);
  expect(state.statusLines).toEqual(
    expect.arrayContaining(["M  tracked.txt", " M unstaged.txt", "?? untracked.txt"]),
  );
});

test("getHeadCommitInfo returns the latest commit sha and subject", () => {
  const sandbox = makeTempDir("git-head-commit");
  const sourceRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "# sandbox\n",
  });

  const head = getHeadCommitInfo(createRuntime({ cwd: sourceRoot }), sourceRoot);

  expect(head).not.toBeNull();
  expect(head?.subject).toBe("init");
  expect(head?.sha).toMatch(/^[0-9a-f]{40}$/);
});

test("determineReviewerTarget selects the working tree diff when the checkout is dirty", () => {
  const sandbox = makeTempDir("git-review-target-dirty");
  const sourceRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "# sandbox\n",
  });

  write(sourceRoot, "dirty.txt", "left behind\n");

  expect(determineReviewerTarget(createRuntime({ cwd: sourceRoot }), sourceRoot)).toEqual({
    kind: "working-tree-diff",
    statusLines: ["?? dirty.txt"],
  });
});

test("determineReviewerTarget selects the last commit when the checkout is clean", () => {
  const sandbox = makeTempDir("git-review-target-clean");
  const sourceRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "# sandbox\n",
  });

  expect(determineReviewerTarget(createRuntime({ cwd: sourceRoot }), sourceRoot)).toEqual({
    kind: "last-commit",
    commit: {
      sha: expect.stringMatching(/^[0-9a-f]{40}$/),
      subject: "init",
    },
  });
});
