import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { listWorktrees, resolveRepoContext } from "./git.ts";
import { samePath } from "./path-identity.ts";
import { getSessionStateFilePath, listSessionStates } from "./registry.ts";
import type { Runtime } from "./types.ts";

export interface LocalWorktreeTarget {
  branch: string | null;
  kind: "ordinary-worktree" | "session" | "source";
  label: string;
  path: string;
  session?: string;
  updatedAt: number;
}

/** Discover existing local checkout targets in Swing's deterministic order. */
export function listLocalWorktreeTargets(runtime: Runtime, home: string, sourceRoot: string) {
  const worktrees = listWorktrees(runtime, sourceRoot).filter(
    (entry) => !entry.prunable && existsSync(entry.path)
  );
  const worktreeByPath = new Map(
    worktrees.map((entry) => [path.normalize(entry.path), entry] as const)
  );
  const branchCommitTimes = listBranchCommitTimes(runtime, sourceRoot);
  const candidates: LocalWorktreeTarget[] = [];
  const claimedPaths = new Set<string>();

  for (const state of listSessionStates(home)) {
    const repo = state.repos.find((candidate) => samePath(candidate.sourceRoot, sourceRoot));
    if (repo === undefined) {
      continue;
    }
    const normalizedPath = path.normalize(repo.worktreePath);
    const worktree = worktreeByPath.get(normalizedPath);
    if (worktree === undefined || normalizedPath === path.normalize(sourceRoot)) {
      continue;
    }
    claimedPaths.add(normalizedPath);
    candidates.push({
      branch: worktree.branch,
      kind: "session",
      label: state.session,
      path: worktree.path,
      session: state.session,
      updatedAt: Math.max(
        worktree.branch === null ? 0 : (branchCommitTimes.get(worktree.branch) ?? 0),
        statSync(getSessionStateFilePath(home, state.rootSourceRoot, state.session)).mtimeMs
      )
    });
  }

  for (const worktree of worktrees) {
    const normalizedPath = path.normalize(worktree.path);
    if (normalizedPath === path.normalize(sourceRoot) || claimedPaths.has(normalizedPath)) {
      continue;
    }
    candidates.push({
      branch: worktree.branch,
      kind: "ordinary-worktree",
      label: worktree.branch ?? detachedLabel(runtime, worktree.path),
      path: worktree.path,
      updatedAt: worktree.branch === null ? 0 : (branchCommitTimes.get(worktree.branch) ?? 0)
    });
  }

  const sourceWorktree = worktreeByPath.get(path.normalize(sourceRoot));
  const source = sourceWorktree
    ? [
        {
          branch: sourceWorktree.branch,
          kind: "source" as const,
          label: sourceWorktree.branch ?? detachedLabel(runtime, sourceWorktree.path),
          path: sourceWorktree.path,
          updatedAt: 0
        }
      ]
    : [];
  return [
    ...source,
    ...candidates.toSorted(
      (left, right) => right.updatedAt - left.updatedAt || left.label.localeCompare(right.label)
    )
  ];
}

/** Re-resolve a discovered target and reject stale, cross-repo, or branch-changed paths. */
export function resolveLocalWorktreeTarget(
  runtime: Runtime,
  home: string,
  sourceRoot: string,
  gitCommonDir: string,
  selected: Pick<LocalWorktreeTarget, "branch" | "path">
) {
  let resolvedTarget: LocalWorktreeTarget | undefined;
  try {
    const context = resolveRepoContext(runtime, selected.path, null, { inferSessionName: false });
    if (
      !samePath(context.gitCommonDir, gitCommonDir) ||
      context.currentBranch !== (selected.branch ?? "HEAD")
    ) {
      return;
    }
    resolvedTarget = listLocalWorktreeTargets(runtime, home, sourceRoot).find(
      (target) => samePath(target.path, selected.path) && target.branch === selected.branch
    );
  } catch {
    // A stale or missing worktree has no resolvable target.
  }
  return resolvedTarget;
}

/** Resolve an attached target to a full ref and a detached target to its exact commit. */
export function resolveLocalWorktreeTargetBase(runtime: Runtime, target: LocalWorktreeTarget) {
  return target.branch === null
    ? runtime.exec("git", ["rev-parse", "HEAD"], { cwd: target.path }).stdout.trim()
    : `refs/heads/${target.branch}`;
}

function listBranchCommitTimes(runtime: Runtime, sourceRoot: string) {
  const result = runtime.exec(
    "git",
    ["for-each-ref", "--format=%(refname:lstrip=2)\t%(committerdate:unix)", "refs/heads"],
    { allowFailure: true, cwd: sourceRoot }
  );
  if (result.exitCode !== 0) {
    return new Map<string, number>();
  }

  const activityByBranch = new Map<string, number>();
  for (const line of result.stdout.trim().split("\n").filter(Boolean)) {
    const [branch, seconds] = line.split("\t");
    if (branch !== undefined && seconds !== undefined) {
      activityByBranch.set(branch, Number(seconds) * 1000);
    }
  }
  return activityByBranch;
}

function detachedLabel(runtime: Runtime, worktreePath: string) {
  const commit = runtime
    .exec("git", ["rev-parse", "--short=8", "HEAD"], {
      cwd: worktreePath
    })
    .stdout.trim();
  return `detached ${commit}`;
}
