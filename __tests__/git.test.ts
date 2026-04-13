import { expect, test } from "vitest";
import { rmSync } from "node:fs";
import path from "node:path";

import {
  ensureSessionWorktree,
  getExpectedWorktreePath,
  inferSessionName,
  listWorktrees,
  validateWorktreeForSession,
} from "../src/git.ts";
import { createRuntime } from "../src/runtime.ts";
import { createRepo, git, makeTempDir } from "./helpers.ts";
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
