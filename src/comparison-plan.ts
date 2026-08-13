import { resolveDefaultBranchRef } from "./git.ts";
import type { RepoContext, Runtime } from "./types.ts";

const LOCAL_DEFAULT_BRANCH_REF_PATTERN = /^refs\/heads\/(?:main|master)$/u;
const REMOTE_DEFAULT_BRANCH_REF_PATTERN = /^refs\/remotes\/[^/]+\/(?:main|master)$/u;

export interface BranchComparisonPlan {
  baseRef: string;
  kind: "branch-working-tree";
  worktreePath: string;
}

export type ComparisonPlan = { kind: "working-tree"; worktreePath: string } | BranchComparisonPlan;

/** Plan a local-working-tree comparison without inspecting Codiff behavior. */
export function planWorkingTreeComparison(context: RepoContext): ComparisonPlan {
  return { kind: "working-tree", worktreePath: context.worktreeRoot };
}

/** Plan a branch comparison only when its commit and merge-base are valid. */
export function planBranchComparison(
  runtime: Runtime,
  context: RepoContext,
  baseRef: string
): BranchComparisonPlan | undefined {
  const resolved = runtime.exec(
    "git",
    ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`],
    {
      allowFailure: true,
      cwd: context.worktreeRoot
    }
  );
  if (resolved.exitCode !== 0) {
    return undefined;
  }
  if (
    runtime.exec("git", ["merge-base", baseRef, "HEAD"], {
      allowFailure: true,
      cwd: context.worktreeRoot
    }).exitCode !== 0
  ) {
    return undefined;
  }
  return { baseRef, kind: "branch-working-tree", worktreePath: context.worktreeRoot };
}

/** Find an unambiguous main/master ref with newer shared history than a remembered base. */
export function findNewerDefaultBranchBase(
  runtime: Runtime,
  context: RepoContext,
  rememberedBaseRef: string
): string | undefined {
  const rememberedMergeBase = resolveUniqueMergeBase(runtime, context, rememberedBaseRef);
  if (rememberedMergeBase === undefined) {
    return undefined;
  }

  const refs = runtime
    .exec("git", ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"], {
      allowFailure: true,
      cwd: context.worktreeRoot
    })
    .stdout.trim()
    .split("\n")
    .filter((ref) => isDefaultBranchRef(ref) && ref !== rememberedBaseRef);
  const candidates = refs.flatMap((ref) => {
    const mergeBase = resolveUniqueMergeBase(runtime, context, ref);
    return mergeBase !== undefined &&
      mergeBase !== rememberedMergeBase &&
      isAncestor(runtime, context, rememberedMergeBase, mergeBase)
      ? [{ mergeBase, ref }]
      : [];
  });
  const maximalCandidates = candidates.filter((candidate) =>
    candidates.every(
      (other) =>
        candidate.mergeBase === other.mergeBase ||
        !isAncestor(runtime, context, candidate.mergeBase, other.mergeBase)
    )
  );
  if (new Set(maximalCandidates.map((candidate) => candidate.mergeBase)).size !== 1) {
    return undefined;
  }
  const preferredRef = resolvePreferredDefaultBranchRef(runtime, context);
  return maximalCandidates.toSorted((left, right) => {
    if (left.ref === preferredRef) {
      return -1;
    }
    if (right.ref === preferredRef) {
      return 1;
    }
    return left.ref.localeCompare(right.ref);
  })[0]?.ref;
}

/** Report whether one checkout contains staged, unstaged, or untracked changes. */
export function hasWorkingTreeChanges(runtime: Runtime, worktreePath: string): boolean {
  return Boolean(
    runtime
      .exec("git", ["status", "--porcelain", "--untracked-files=normal"], {
        cwd: worktreePath
      })
      .stdout.trim()
  );
}

function resolveUniqueMergeBase(
  runtime: Runtime,
  context: RepoContext,
  baseRef: string
): string | undefined {
  const result = runtime.exec("git", ["merge-base", "--all", baseRef, "HEAD"], {
    allowFailure: true,
    cwd: context.worktreeRoot
  });
  const mergeBases = result.stdout.trim().split("\n").filter(Boolean);
  return result.exitCode === 0 && mergeBases.length === 1 ? mergeBases[0] : undefined;
}

function isAncestor(
  runtime: Runtime,
  context: RepoContext,
  ancestor: string,
  descendant: string
): boolean {
  return (
    runtime.exec("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      allowFailure: true,
      cwd: context.worktreeRoot
    }).exitCode === 0
  );
}

function isDefaultBranchRef(ref: string): boolean {
  return LOCAL_DEFAULT_BRANCH_REF_PATTERN.test(ref) || REMOTE_DEFAULT_BRANCH_REF_PATTERN.test(ref);
}

function resolvePreferredDefaultBranchRef(
  runtime: Runtime,
  context: RepoContext
): string | undefined {
  try {
    return resolveDefaultBranchRef(runtime, context.sourceRoot, { refresh: false }).ref;
  } catch {
    return undefined;
  }
}
