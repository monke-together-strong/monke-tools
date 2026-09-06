import { containsPath, samePath } from "./path-identity.ts";
import type { SessionRepoState, SessionState } from "./types.ts";

export interface SessionAction {
  command?: string;
  sourceRoot: string;
  step: "revalidation" | "worktree-removal" | "cleanup-command" | "state-removal";
  worktreePath?: string;
}

/** Effects are attempted only after beforeEffect returns; completion means the call succeeded. */
export interface SessionLifecycleObserver {
  beforeEffect?: (action: SessionAction) => void;
  beforeStep?: (action: SessionAction) => void;
  completed?: (action: SessionAction) => void;
  revalidateMember?: (repo: SessionRepoState) => void;
}

export function cleanupCommandActions(state: SessionState): SessionAction[] {
  return [...state.repos].toReversed().flatMap((repo) =>
    repo.cleanupEligible && repo.cleanupCommand
      ? [
          {
            command: repo.cleanupCommand,
            sourceRoot: repo.sourceRoot,
            step: "cleanup-command" as const,
            worktreePath: repo.worktreePath
          }
        ]
      : []
  );
}

/** Keep the invoking member last, otherwise keep the Root member last. */
export function sessionRemovalRank(
  repo: SessionRepoState,
  invocationPath: string,
  rootSourceRoot: string
) {
  if (containsPath(repo.worktreePath, invocationPath)) {
    return 2;
  }
  return samePath(repo.sourceRoot, rootSourceRoot) ? 1 : 0;
}
