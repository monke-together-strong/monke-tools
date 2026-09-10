import { containsPath, samePath } from "./path-identity.ts";
import type { SessionRepoState, SessionState } from "./types.ts";

export interface SessionAction {
  command?: string;
  recoveryCommand?: string;
  retainedRef?: string;
  sourceRoot: string;
  step:
    | "revalidation"
    | "head-preservation"
    | "process-stop"
    | "worktree-removal"
    | "cleanup-command"
    | "state-removal";
  worktreePath?: string;
}

/** Effects are attempted only after beforeEffect returns; completion means the call succeeded. */
export interface SessionLifecycleObserver {
  /** Validate a specific preservation proof before authorizing removal of its pending work. */
  authorizePreservedWork?: (repo: SessionRepoState) => boolean;
  beforeEffect?: (action: SessionAction) => void;
  /** Runs after revalidation, before any cleanup commands or removals; may stop processes. */
  beforeRemoval?: (repo: SessionRepoState) => void;
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
  repo: Pick<SessionRepoState, "sourceRoot" | "worktreePath">,
  invocationPath: string,
  rootSourceRoot: string
) {
  if (containsPath(repo.worktreePath, invocationPath)) {
    return 2;
  }
  return samePath(repo.sourceRoot, rootSourceRoot) ? 1 : 0;
}
