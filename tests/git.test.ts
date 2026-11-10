import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
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
});
