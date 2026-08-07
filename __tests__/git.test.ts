import { rmSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import {
  ensureSessionWorktree,
  getExpectedWorktreePath,
  inferSessionName,
  listWorktrees,
  validateWorktreeForSession
} from "../src/git.ts";
import { createRuntime } from "../src/runtime.ts";
import type { Runtime } from "../src/types.ts";
import { createRepo, git, makeTempDir } from "./helpers.ts";

describe("Git operations", () => {
  test("inferSessionName supports slash-delimited session names", () => {
    const sourceRoot = path.join("/tmp", "monke-root");
    const home = path.join("/tmp", "monke-home");
    const worktreeRoot = getExpectedWorktreePath(home, sourceRoot, "feature/foo");

    expect(inferSessionName(home, sourceRoot, worktreeRoot, "feature/foo")).toBe("feature/foo");
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
`
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
`
    });
    const home = path.join(sandbox, "home");
    const worktreePath = getExpectedWorktreePath(home, sourceRoot, "banana");

    git(otherSourceRoot, ["branch", "banana"]);
    git(otherSourceRoot, ["worktree", "add", worktreePath, "banana"]);

    expect(() => {
      validateWorktreeForSession(
        createRuntime({ cwd: sourceRoot, env: { MONKE_HOME: home } }),
        home,
        sourceRoot,
        worktreePath,
        "banana"
      );
    }).toThrow(/Expected worktree .* to belong to /u);
  });

  test("listWorktrees parses prunable entries from porcelain output", () => {
    const runtime: Runtime = {
      cwd: "/tmp",
      env: {},
      exec(command, args) {
        expect(command).toBe("git");
        expect(args).toStrictEqual(["worktree", "list", "--porcelain"]);
        return {
          exitCode: 0,
          stderr: "",
          stdout: `worktree /tmp/root
branch refs/heads/main

worktree /tmp/worktree
branch refs/heads/feature/foo
prunable gitdir file points to non-existent location
`
        };
      },
      execAsync() {
        return Promise.reject(new Error("unexpected execAsync"));
      },
      multiSelect() {
        return Promise.reject(new Error("unexpected multiSelect"));
      },
      readLine() {
        throw new Error("unexpected readLine");
      },
      select() {
        return Promise.reject(new Error("unexpected select"));
      },
      writeStderr() {},
      writeStdout() {}
    };

    expect(listWorktrees(runtime, "/tmp/root")).toStrictEqual([
      { branch: "main", locked: null, path: "/tmp/root", prunable: false },
      { branch: "feature/foo", locked: null, path: "/tmp/worktree", prunable: true }
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
`
    });
    const runtime = createRuntime({ cwd: sourceRoot });
    const session = "banana";
    const home = path.join(sandbox, "home");
    const expectedPath = getExpectedWorktreePath(home, sourceRoot, session);

    git(sourceRoot, ["branch", session]);
    git(sourceRoot, ["worktree", "add", expectedPath, session]);
    rmSync(expectedPath, { force: true, recursive: true });

    const result = ensureSessionWorktree(runtime, home, sourceRoot, session);

    expect(result).toStrictEqual({ created: true, path: expectedPath });
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
`
    });

    expect(() =>
      ensureSessionWorktree(
        createRuntime({ cwd: sourceRoot }),
        path.join(sandbox, "home"),
        sourceRoot,
        "--help"
      )
    ).toThrow(/Invalid session name "--help"/u);
  });
});
