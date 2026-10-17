import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  assertFreshSessionWorktreeAvailable,
  ensureSessionWorktreeAsync,
  getExpectedWorktreePath,
  inferSessionName,
  listWorktrees,
  validateWorktreeForSession
} from "../src/git.ts";
import { createRuntime } from "../src/runtime.ts";
import type { Runtime } from "../src/types.ts";
import { createRepo, git, makeTempDir } from "./helpers.ts";

describe("Git operations", () => {
  it("supports slash-delimited session names in inferSessionName", () => {
    const sourceRoot = path.join("/tmp", "monke-root");
    const home = path.join("/tmp", "monke-home");
    const worktreeRoot = getExpectedWorktreePath(home, sourceRoot, "feature/foo");

    expect(inferSessionName(home, sourceRoot, worktreeRoot, "feature/foo")).toBe("feature/foo");
  });

  it("rejects worktrees from a different repository in validateWorktreeForSession", () => {
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

  it("parses prunable entries from porcelain output in listWorktrees", () => {
    const runtime: Runtime = {
      ...createRuntime({ cwd: "/tmp" }),
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

  it("requires cleanup in ensureSessionWorktreeAsync before recreating missing worktrees", async () => {
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

    await expect(ensureSessionWorktreeAsync(runtime, home, sourceRoot, session)).rejects.toThrow(
      /Worktree registration needs recovery.*mt cleanup --dry-run/u
    );
    git(sourceRoot, ["worktree", "remove", expectedPath]);

    const result = await ensureSessionWorktreeAsync(runtime, home, sourceRoot, session);

    expect(result).toStrictEqual({ created: true, path: expectedPath });
    expect(git(expectedPath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(session);
  });

  it.each(["recreate", "fresh"])("preserves missing worktree indexes on %s", async (mode) => {
    const sandbox = makeTempDir("git-preserve-missing-index");
    const sourceRoot = createRepo(path.join(sandbox, "root"), { "note.txt": "base\n" });
    const runtime = createRuntime({ cwd: sourceRoot });
    const home = path.join(sandbox, "home");
    const session = "banana";

    const retained = [session, "unrelated"].map((branch) => {
      const worktree = getExpectedWorktreePath(home, sourceRoot, branch);
      git(sourceRoot, ["worktree", "add", "-b", branch, worktree]);
      writeFileSync(path.join(worktree, "note.txt"), `${branch} staged copy\n`);
      git(worktree, ["add", "note.txt"]);
      const admin = git(worktree, ["rev-parse", "--absolute-git-dir"]);
      const index = readFileSync(path.join(admin, "index"));
      rmSync(worktree, { force: true, recursive: true });

      return { admin, branch, index, worktree };
    });

    let failure;

    try {
      if (mode === "fresh") {
        assertFreshSessionWorktreeAvailable(runtime, home, sourceRoot, session);
      } else {
        await ensureSessionWorktreeAsync(runtime, home, sourceRoot, session);
      }
    } catch (error) {
      failure = error;
    }

    for (const entry of retained) {
      expect(existsSync(path.join(entry.admin, "index"))).toBeTruthy();
      expect(readFileSync(path.join(entry.admin, "index"))).toStrictEqual(entry.index);
      expect(git(sourceRoot, [`--git-dir=${entry.admin}`, "show", ":note.txt"])).toBe(
        `${entry.branch} staged copy`
      );
      expect(existsSync(entry.worktree)).toBeFalsy();
    }

    expect(failure).toBeInstanceOf(Error);
  });

  it("rejects invalid session names in ensureSessionWorktreeAsync before worktree operations", async () => {
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

    await expect(
      ensureSessionWorktreeAsync(
        createRuntime({ cwd: sourceRoot }),
        path.join(sandbox, "home"),
        sourceRoot,
        "--help"
      )
    ).rejects.toThrow(/Invalid session name "--help"/u);
  });
});
