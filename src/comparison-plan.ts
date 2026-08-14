import { resolveDefaultBranchRef } from "./git.ts";
import type { RepoContext, Runtime } from "./types.ts";

const LOCAL_DEFAULT_BRANCH_REF_PATTERN = /^refs\/heads\/(?:main|master)$/u;
const REMOTE_DEFAULT_BRANCH_REF_PATTERN = /^refs\/remotes\/[^/]+\/(?:main|master)$/u;

export interface BranchComparisonPlan {
  baseRef: string;
  kind: "branch-working-tree";
  worktreePath: string;
}

interface DefaultBranchCandidate {
  mergeBase: string;
  ref: string;
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
    return;
  }
  if (
    runtime.exec("git", ["merge-base", baseRef, "HEAD"], {
      allowFailure: true,
      cwd: context.worktreeRoot
    }).exitCode !== 0
  ) {
    return;
  }
  return { baseRef, kind: "branch-working-tree", worktreePath: context.worktreeRoot };
}

/** Find an unambiguous main/master ref for a checkout that has no remembered Diff base. */
export function findInitialDefaultBranchBase(runtime: Runtime, context: RepoContext) {
  if (isDefaultBranchRef(`refs/heads/${context.currentBranch}`)) {
    return;
  }
  const head = resolveCommit(runtime, context, "HEAD");
  if (head === undefined) {
    return;
  }

  const candidates: DefaultBranchCandidate[] = [];
  for (const ref of listDefaultBranchRefs(runtime, context)) {
    const commit = resolveCommit(runtime, context, ref);
    if (commit === undefined || commit === head) {
      continue;
    }
    const mergeBases = resolveMergeBases(runtime, context, ref);
    if (mergeBases === undefined || mergeBases.length === 0) {
      continue;
    }
    if (mergeBases.length !== 1) {
      return;
    }
    const [mergeBase] = mergeBases;
    if (mergeBase !== undefined) {
      candidates.push({ mergeBase, ref });
    }
  }
  const selected = selectDefaultBranchCandidate(runtime, context, candidates);
  if (
    selected === undefined ||
    hasCompetingBranchBase(runtime, context, head, selected.mergeBase)
  ) {
    return;
  }
  return selected.ref;
}

/** Find an unambiguous main/master ref with newer shared history than a remembered base. */
export function findNewerDefaultBranchBase(
  runtime: Runtime,
  context: RepoContext,
  rememberedBaseRef: string
) {
  const rememberedMergeBases = resolveMergeBases(runtime, context, rememberedBaseRef);
  if (rememberedMergeBases?.length !== 1) {
    return;
  }
  const [rememberedMergeBase] = rememberedMergeBases;
  if (rememberedMergeBase === undefined) {
    return;
  }

  const candidates: DefaultBranchCandidate[] = [];
  for (const ref of listDefaultBranchRefs(runtime, context)) {
    if (ref === rememberedBaseRef) {
      continue;
    }
    const mergeBases = resolveMergeBases(runtime, context, ref);
    if (
      mergeBases === undefined ||
      !mergeBases.some((mergeBase) =>
        hasNewerSharedHistory(runtime, context, rememberedMergeBase, mergeBase)
      )
    ) {
      continue;
    }
    if (mergeBases.length !== 1) {
      return;
    }
    const [mergeBase] = mergeBases;
    if (mergeBase !== undefined) {
      candidates.push({ mergeBase, ref });
    }
  }
  return selectDefaultBranchCandidate(runtime, context, candidates)?.ref;
}

function selectDefaultBranchCandidate(
  runtime: Runtime,
  context: RepoContext,
  candidates: DefaultBranchCandidate[]
) {
  const maximalCandidates = candidates.filter((candidate) =>
    candidates.every(
      (other) =>
        candidate.mergeBase === other.mergeBase ||
        !isAncestor(runtime, context, candidate.mergeBase, other.mergeBase)
    )
  );
  if (new Set(maximalCandidates.map((candidate) => candidate.mergeBase)).size !== 1) {
    return;
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
  })[0];
}

/** Report whether one checkout contains staged, unstaged, or untracked changes. */
export function hasWorkingTreeChanges(runtime: Runtime, worktreePath: string) {
  return Boolean(
    runtime
      .exec("git", ["status", "--porcelain", "--untracked-files=normal"], {
        cwd: worktreePath
      })
      .stdout.trim()
  );
}

function resolveMergeBases(runtime: Runtime, context: RepoContext, baseRef: string) {
  const result = runtime.exec("git", ["merge-base", "--all", baseRef, "HEAD"], {
    allowFailure: true,
    cwd: context.worktreeRoot
  });
  return result.exitCode === 0 ? result.stdout.trim().split("\n").filter(Boolean) : undefined;
}

function resolveCommit(runtime: Runtime, context: RepoContext, ref: string) {
  const result = runtime.exec("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    allowFailure: true,
    cwd: context.worktreeRoot
  });
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

function listBranchRefs(runtime: Runtime, context: RepoContext) {
  return runtime
    .exec("git", ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"], {
      allowFailure: true,
      cwd: context.worktreeRoot
    })
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
}

function listDefaultBranchRefs(runtime: Runtime, context: RepoContext) {
  return listBranchRefs(runtime, context).filter(isDefaultBranchRef);
}

function hasCompetingBranchBase(
  runtime: Runtime,
  context: RepoContext,
  head: string,
  defaultMergeBase: string
) {
  for (const ref of listBranchRefs(runtime, context)) {
    if (isDefaultBranchRef(ref) || isCurrentBranchRef(ref, context.currentBranch)) {
      continue;
    }
    const commit = resolveCommit(runtime, context, ref);
    if (commit === undefined || commit === head) {
      continue;
    }
    const mergeBases = resolveMergeBases(runtime, context, ref);
    if (mergeBases === undefined || mergeBases.length === 0) {
      continue;
    }
    if (mergeBases.length !== 1) {
      return true;
    }
    const [mergeBase] = mergeBases;
    if (
      mergeBase !== undefined &&
      mergeBase !== defaultMergeBase &&
      !isAncestor(runtime, context, mergeBase, defaultMergeBase)
    ) {
      return true;
    }
  }
  return false;
}

function hasNewerSharedHistory(
  runtime: Runtime,
  context: RepoContext,
  rememberedMergeBase: string,
  candidateMergeBase: string
) {
  return (
    candidateMergeBase !== rememberedMergeBase &&
    isAncestor(runtime, context, rememberedMergeBase, candidateMergeBase)
  );
}

function isAncestor(runtime: Runtime, context: RepoContext, ancestor: string, descendant: string) {
  return (
    runtime.exec("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      allowFailure: true,
      cwd: context.worktreeRoot
    }).exitCode === 0
  );
}

function isDefaultBranchRef(ref: string) {
  return LOCAL_DEFAULT_BRANCH_REF_PATTERN.test(ref) || REMOTE_DEFAULT_BRANCH_REF_PATTERN.test(ref);
}

function isCurrentBranchRef(ref: string, currentBranch: string) {
  if (ref === `refs/heads/${currentBranch}`) {
    return true;
  }
  const remoteBranch = /^refs\/remotes\/[^/]+\/(?<branch>.+)$/u.exec(ref)?.groups?.branch;
  return remoteBranch === currentBranch;
}

function resolvePreferredDefaultBranchRef(runtime: Runtime, context: RepoContext) {
  let ref: string | undefined;
  try {
    ({ ref } = resolveDefaultBranchRef(runtime, context.sourceRoot, { refresh: false }));
  } catch {
    // A repository without a resolvable default branch has no preferred ref.
  }
  return ref;
}
