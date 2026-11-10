import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { getExpectedWorktreePath } from "../src/git.ts";
import { createInitialRepoLifecycleState } from "../src/repo-materialization.ts";
import { createRuntime } from "../src/runtime.ts";
import type { Runtime } from "../src/types.ts";
import {
  assertFreshSessionWorktreeAvailable,
  planWorktreePreparation,
  prepareWorktree
} from "../src/worktree-preparation.ts";
import { createRepo, git, makeTempDir } from "./helpers.ts";

describe("Worktree preparation", () => {
  it("requires recovering a stale worktree registration before recreating the Session worktree", async () => {
    const sandbox = makeTempDir("worktree-preparation-recreate");
    const sourceRoot = createRepo(path.join(sandbox, "root"), { "README.md": "base\n" });
    const runtime = createRuntime({ cwd: sourceRoot });
    const session = "banana";
    const home = path.join(sandbox, "home");
    const expectedPath = getExpectedWorktreePath(home, sourceRoot, session);

    git(sourceRoot, ["branch", session]);
    git(sourceRoot, ["worktree", "add", expectedPath, session]);
    rmSync(expectedPath, { force: true, recursive: true });

    await expect(prepareFromSessionBranch(runtime, home, sourceRoot, session)).rejects.toThrow(
      /Worktree registration needs recovery.*mt cleanup --dry-run/u
    );
    git(sourceRoot, ["worktree", "remove", expectedPath]);

    const prepared = await prepareFromSessionBranch(runtime, home, sourceRoot, session);

    expect(prepared.state.worktreePath).toBe(expectedPath);
    expect(git(expectedPath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(session);
  });

  it.each(["recreate", "fresh"])("preserves missing worktree indexes on %s", async (mode) => {
    const sandbox = makeTempDir("worktree-preparation-missing-index");
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
        await prepareFromSessionBranch(runtime, home, sourceRoot, session);
      }
    } catch (cause) {
      failure = cause;
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

  it("rejects invalid session names before worktree operations", async () => {
    const sandbox = makeTempDir("worktree-preparation-invalid-session");
    const sourceRoot = createRepo(path.join(sandbox, "root"), { "README.md": "base\n" });

    await expect(
      prepareFromSessionBranch(
        createRuntime({ cwd: sourceRoot }),
        path.join(sandbox, "home"),
        sourceRoot,
        "--help"
      )
    ).rejects.toThrow(/Invalid session name "--help"/u);
  });
});

async function prepareFromSessionBranch(
  runtime: Runtime,
  home: string,
  sourceRoot: string,
  session: string
) {
  const plan = planWorktreePreparation(runtime, {
    home,
    repos: [{ checkoutRoot: sourceRoot, sourceRoot }],
    session,
    source: { mode: "session-branch" }
  }).get(sourceRoot);

  if (!plan) {
    throw new Error(`Missing Worktree preparation plan for ${sourceRoot}`);
  }

  return await prepareWorktree(runtime, {
    existingState: createInitialRepoLifecycleState(
      { cleanupCommand: undefined, sourceRoot },
      getExpectedWorktreePath(home, sourceRoot, session)
    ),
    home,
    plan,
    seedPaths: [],
    session
  });
}
