import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  getExpectedWorktreePath,
  resolveRepoContext,
  validateWorktreeForSession
} from "../src/git.ts";
import { createRuntime } from "../src/runtime.ts";
import { createRepo, git, makeTempDir } from "./helpers.ts";

describe("Git operations", () => {
  it("infers slash-delimited Session names from a linked worktree in resolveRepoContext", () => {
    const sandbox = makeTempDir("git-slash-session");
    const sourceRoot = createRepo(path.join(sandbox, "root"), { "note.txt": "base\n" });
    const home = path.join(sandbox, "home");
    const worktreeRoot = getExpectedWorktreePath(home, sourceRoot, "feature/foo");
    git(sourceRoot, ["worktree", "add", "-b", "feature/foo", worktreeRoot]);

    expect(resolveRepoContext(createRuntime(), worktreeRoot, home).sessionName).toBe("feature/foo");
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
});
