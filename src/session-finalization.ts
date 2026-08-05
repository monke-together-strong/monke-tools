import { existsSync } from "node:fs";

import { errorMessage, MonkeError } from "./errors.ts";
import { removeSessionState } from "./registry.ts";
import type { Runtime, SessionState } from "./types.ts";
import { assertCanonicalSourceCheckout } from "./worktree-safety.ts";

const CLEANUP_COMMAND_TIMEOUT_SECONDS = 60;

/** Finalize one already-dead Session using only lifecycle data saved in its state. */
export function finalizeSession(runtime: Runtime, home: string, state: SessionState): void {
  const liveRepo = state.repos.find((repo) => existsSync(repo.worktreePath));
  if (liveRepo !== undefined) {
    throw new MonkeError(
      `Cannot finalize session ${state.session} while worktree ${liveRepo.worktreePath} exists`
    );
  }

  for (const repoState of state.repos) {
    assertCanonicalSourceCheckout(runtime, repoState.sourceRoot);
  }

  for (const repoState of [...state.repos].toReversed()) {
    const { cleanupCommand } = repoState;
    if (!cleanupCommand) {
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

    try {
      runtime.exec("sh", ["-c", cleanupCommand], {
        cwd: repoState.sourceRoot,
        env: {
          ...resourceEnv,
          ...resourceCommandEnv,
          MONKE_SESSION: state.session,
          MONKE_SOURCE_ROOT: repoState.sourceRoot,
          MONKE_WORKTREE_PATH: repoState.worktreePath
        },
        timeoutSeconds: CLEANUP_COMMAND_TIMEOUT_SECONDS
      });
    } catch (error) {
      throw new MonkeError(
        `Cleanup command failed for session ${state.session} repo ${repoState.sourceRoot}: ${cleanupCommand}\n${errorMessage(error)}`
      );
    }
  }

  removeSessionState(home, state.rootSourceRoot, state.session);
}
