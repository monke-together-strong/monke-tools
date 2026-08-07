import type { RepoContext, Runtime } from "./types.ts";

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
