import { expect, test } from "vitest";
import path from "node:path";

import {
  getExpectedWorktreePath,
  inferSessionName,
  validateWorktreeForSession,
} from "../src/git.ts";
import { createRuntime } from "../src/runtime.ts";
import { createRepo, git, makeTempDir } from "./helpers.ts";

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
