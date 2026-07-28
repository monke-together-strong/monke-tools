import path from "node:path";

import { branchExists, listWorktrees, resolveRepoContext } from "./git.ts";
import { MonkeError } from "./errors.ts";
import { createLogger } from "./logger.ts";
import { getMonkeHome, withGlobalLock } from "./runtime.ts";
import { requestShellDirectoryAfterRemoval } from "./shell.ts";
import type { Runtime } from "./types.ts";
import { preflightCleanWorktreeRemoval } from "./worktree-safety.ts";

/** Remove one explicitly selected Ordinary worktree while preserving its branch. */
export function runChop(runtime: Runtime, target: string | undefined): void {
  const home = getMonkeHome(runtime);
  const removed = withGlobalLock(home, () => {
    const invocation = resolveRepoContext(runtime, runtime.cwd, null, {
      inferSessionName: false,
    });
    if (target === undefined && invocation.isSourceCheckout) {
      throw new MonkeError("mt chop from a Source checkout requires an explicit target");
    }

    const selectedPath = resolveOrdinaryTargetPath(runtime, invocation, target);
    assertOutsideManagedWorktrees(home, selectedPath);
    const preflight = preflightCleanWorktreeRemoval(runtime, invocation.sourceRoot, selectedPath);
    runtime.exec(
      "git",
      [
        "worktree",
        "remove",
        ...(preflight.forceGitRemoval ? ["--force"] : []),
        preflight.worktree.path,
      ],
      {
        cwd: invocation.sourceRoot,
      },
    );

    return {
      removedInvocation:
        path.normalize(invocation.worktreeRoot) === path.normalize(preflight.worktree.path),
      sourceRoot: invocation.sourceRoot,
      worktreePath: preflight.worktree.path,
    };
  });

  createLogger(runtime).success(`Chopped Ordinary worktree ${removed.worktreePath}`);
  if (removed.removedInvocation) {
    requestShellDirectoryAfterRemoval(runtime, removed.sourceRoot);
  }
}

function resolveOrdinaryTargetPath(
  runtime: Runtime,
  invocation: ReturnType<typeof resolveRepoContext>,
  target: string | undefined,
): string {
  if (target === undefined) {
    return invocation.worktreeRoot;
  }

  const worktrees = listWorktrees(runtime, invocation.sourceRoot);
  const branchMatch = worktrees.find((worktree) => worktree.branch === target);
  if (branchMatch !== undefined) {
    return branchMatch.path;
  }
  if (branchExists(runtime, invocation.sourceRoot, target)) {
    throw new MonkeError(`Local branch "${target}" has no registered worktree to Chop`);
  }

  const targetPath = path.isAbsolute(target) ? target : path.resolve(runtime.cwd, target);
  const pathMatch = worktrees.find(
    (worktree) => path.normalize(worktree.path) === path.normalize(targetPath),
  );
  if (pathMatch === undefined) {
    throw new MonkeError(
      `No registered worktree in ${invocation.sourceRoot} matches target "${target}"`,
    );
  }
  return pathMatch.path;
}

function assertOutsideManagedWorktrees(home: string, worktreePath: string): void {
  const managedRoot = path.join(home, "worktrees");
  const relative = path.relative(managedRoot, worktreePath);
  const isOutside =
    path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`);
  if (!isOutside) {
    throw new MonkeError(`Cannot Chop managed worktree ${worktreePath} as an Ordinary worktree`);
  }
}
