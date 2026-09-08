import { existsSync } from "node:fs";

import { errorMessage, MonkeError, ThrownValueSchema } from "./errors.ts";
import type { SessionAction, SessionLifecycleObserver } from "./session-lifecycle-progress.ts";
import type { SessionStateStore } from "./session-state-store.ts";
import type { Runtime, SessionState } from "./types.ts";
import { assertCanonicalSourceCheckout } from "./worktree-safety.ts";

const CLEANUP_COMMAND_TIMEOUT_SECONDS = 60;

/** Remove state only after every recorded worktree is gone. */
export function finalizeSession(
  store: SessionStateStore,
  state: SessionState,
  observer: SessionLifecycleObserver = {}
) {
  const liveRepo = state.repos.find((repo) => existsSync(repo.worktreePath));
  if (liveRepo !== undefined) {
    throw new MonkeError(
      `Cannot finalize session ${state.session} while worktree ${liveRepo.worktreePath} exists`
    );
  }

  const action: SessionAction = { sourceRoot: state.rootSourceRoot, step: "state-removal" };
  observer.beforeStep?.(action);
  observer.beforeEffect?.(action);
  store.remove(state);
  observer.completed?.(action);
}

/** Run recorded commands while Session worktrees are still available. */
export function cleanupSessionResources(
  runtime: Runtime,
  state: SessionState,
  observer: SessionLifecycleObserver = {},
  cleanupFromSource = false
) {
  for (const repoState of state.repos) {
    observer.beforeStep?.({
      sourceRoot: repoState.sourceRoot,
      step: "revalidation",
      worktreePath: repoState.worktreePath
    });
    assertCanonicalSourceCheckout(runtime, repoState.sourceRoot);
    if (
      repoState.cleanupEligible &&
      repoState.cleanupCommand &&
      !existsSync(repoState.worktreePath) &&
      !cleanupFromSource
    ) {
      throw new MonkeError(
        `Cannot run cleanup: Session worktree is missing: ${repoState.worktreePath}. ` +
          `Restore the worktree and retry. Only if the recorded commands are safe from source checkouts, ` +
          `use mt chop <session> --cleanup-from-source for explicit recovery. Session state is retained.`
      );
    }
  }

  for (const repoState of [...state.repos].toReversed()) {
    const { cleanupCommand } = repoState;
    if (!repoState.cleanupEligible || !cleanupCommand) {
      continue;
    }

    const resourceEnv = Object.fromEntries(
      (repoState.resourceValues ?? []).map((resource) => [resource.env, resource.value])
    );
    const resourceCommandEnv = Object.fromEntries(
      (repoState.resourceCommandOutputs ?? []).flatMap((command) =>
        command.outputs.map((resource) => [resource.env, resource.value])
      )
    );

    const action: SessionAction = {
      command: cleanupCommand,
      sourceRoot: repoState.sourceRoot,
      step: "cleanup-command",
      worktreePath: repoState.worktreePath
    };
    observer.beforeStep?.(action);
    observer.beforeEffect?.(action);
    try {
      runtime.exec("sh", ["-c", cleanupCommand], {
        cwd:
          cleanupFromSource && !existsSync(repoState.worktreePath)
            ? repoState.sourceRoot
            : repoState.worktreePath,
        env: {
          ...resourceEnv,
          ...resourceCommandEnv,
          MONKE_SESSION: state.session,
          MONKE_SOURCE_ROOT: repoState.sourceRoot,
          MONKE_WORKTREE_PATH: repoState.worktreePath
        },
        timeoutSeconds: CLEANUP_COMMAND_TIMEOUT_SECONDS
      });
      observer.completed?.(action);
    } catch (error) {
      throw new MonkeError(
        `Cleanup command failed for session ${state.session} repo ${repoState.sourceRoot}: ${cleanupCommand}\n${errorMessage(ThrownValueSchema.parse(error))}`
      );
    }
  }
}
