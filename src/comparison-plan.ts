import type { RepoContext, Runtime } from "./types.ts";

export interface BranchComparisonPlan {
  baseRef: string;
  kind: "branch-working-tree";
  worktreePath: string;
}

export type ComparisonPlan = { kind: "working-tree"; worktreePath: string } | BranchComparisonPlan;

interface DefaultBranchCandidate {
  mergeBase: string;
  ref: string;
}

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
  const rememberedMergeBase = resolveMergeBase(runtime, context, rememberedBaseRef);
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
  const candidates = refs.flatMap((ref): DefaultBranchCandidate[] => {
    const mergeBase = resolveMergeBase(runtime, context, ref);
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
  return maximalCandidates.toSorted(compareDefaultBranchCandidates)[0]?.ref;
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

function resolveMergeBase(
  runtime: Runtime,
  context: RepoContext,
  baseRef: string
): string | undefined {
  const result = runtime.exec("git", ["merge-base", baseRef, "HEAD"], {
    allowFailure: true,
    cwd: context.worktreeRoot
  });
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
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
  return (
    /^refs\/heads\/(?:main|master)$/u.test(ref) ||
    /^refs\/remotes\/[^/]+\/(?:main|master)$/u.test(ref)
  );
}

function compareDefaultBranchCandidates(
  left: DefaultBranchCandidate,
  right: DefaultBranchCandidate
): number {
  return (
    defaultBranchRefPriority(left.ref) - defaultBranchRefPriority(right.ref) ||
    left.ref.localeCompare(right.ref)
  );
}

function defaultBranchRefPriority(ref: string): number {
  if (ref === "refs/remotes/origin/main") {
    return 0;
  }
  if (ref === "refs/remotes/origin/master") {
    return 1;
  }
  if (ref === "refs/heads/main") {
    return 2;
  }
  if (ref === "refs/heads/master") {
    return 3;
  }
  return ref.endsWith("/main") ? 4 : 5;
}
