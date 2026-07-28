import { describe, expect, test } from "vite-plus/test";

import { decideMergedWorktreeCleanup } from "../src/cleanup-merged.ts";
import type { MergedCleanupSnapshot, MergedPrMatch } from "../src/cleanup-merged.ts";

const SESSION = "feature/done";
const DEFAULT_BRANCH = "main";
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("merged worktree cleanup", () => {
  test("decideMergedWorktreeCleanup accepts an exact clean same-repository merged PR match", () => {
    const decision = decideMergedWorktreeCleanup(baseSnapshot());

    expect(decision).toMatchObject({ eligible: true, reasons: [] });
  });

  test.each([
    {
      name: "dirty tracked files",
      patch: { statusLines: [" M app.ts"] },
      reason: "worktree has 1 dirty/untracked status line(s)"
    },
    {
      name: "untracked files",
      patch: { statusLines: ["?? scratch.txt"] },
      reason: "worktree has 1 dirty/untracked status line(s)"
    },
    {
      name: "local commit drift",
      patch: { localHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      reason: "local HEAD bbbbbbbb differs from merged PR head aaaaaaaa"
    },
    {
      name: "branch mismatch",
      patch: { branch: "feature/other" },
      reason: "worktree branch feature/other does not match session feature/done"
    },
    {
      name: "detached worktrees",
      patch: { branch: null },
      reason: "worktree is detached"
    },
    {
      name: "wrong repo paths",
      patch: { sameGitRepository: false },
      reason: "session worktree path belongs to a different Git repository"
    },
    {
      name: "missing PRs",
      patch: { matchingMergedPrs: [] },
      reason: "no exact merged PR match for session branch and default branch"
    },
    {
      name: "multiple matching PRs",
      patch: { matchingMergedPrs: [mergedPr(1), mergedPr(2)] },
      reason: "2 merged PR matches; branch history is ambiguous"
    },
    {
      name: "forked PRs",
      patch: {
        matchingMergedPrs: [
          {
            ...mergedPr(1),
            headRepository: { name: "repo" },
            headRepositoryOwner: { login: "fork-owner" },
            isCrossRepository: true
          }
        ]
      },
      reason: "merged PR head repository does not match source repository"
    },
    {
      name: "missing worktree paths",
      patch: { worktreeExists: false },
      reason: "session worktree path is missing"
    },
    {
      name: "non-worktree paths",
      patch: { worktreeIsGitRoot: false },
      reason: "session worktree path is not a Git worktree root"
    },
    {
      name: "source checkout paths",
      patch: { isSourceCheckout: true },
      reason: "session worktree path points at the source checkout"
    },
    {
      name: "GitHub lookup failures",
      patch: { lookupError: "GitHub merged PR lookup failed: auth expired" },
      reason: "GitHub merged PR lookup failed: auth expired"
    },
    {
      name: "failed status checks",
      patch: { statusError: "unable to read normal Git status: index corrupt" },
      reason: "unable to read normal Git status: index corrupt"
    }
  ])("decideMergedWorktreeCleanup skips $name with an explicit reason", ({ patch, reason }) => {
    const decision = decideMergedWorktreeCleanup(baseSnapshot(patch));

    expect(decision.eligible).toBeFalsy();
    expect(decision.reasons).toContain(reason);
  });

  function baseSnapshot(patch: Partial<MergedCleanupSnapshot> = {}): MergedCleanupSnapshot {
    return {
      branch: SESSION,
      defaultBranch: DEFAULT_BRANCH,
      isSourceCheckout: false,
      localHead: HEAD,
      lookupError: null,
      matchingMergedPrs: [mergedPr(1)],
      repositoryFullName: "owner/repo",
      sameGitRepository: true,
      session: SESSION,
      sourceRoot: "/repo",
      statusError: null,
      statusLines: [],
      worktreeExists: true,
      worktreeIsGitRoot: true,
      worktreePath: "/worktree",
      ...patch
    };
  }

  function mergedPr(number: number): MergedPrMatch {
    return {
      baseRefName: DEFAULT_BRANCH,
      headRefName: SESSION,
      headRefOid: HEAD,
      headRepository: { name: "repo" },
      headRepositoryOwner: { login: "owner" },
      isCrossRepository: false,
      mergedAt: "2026-06-16T00:00:00Z",
      number,
      url: `https://github.com/owner/repo/pull/${number}`
    };
  }
});
