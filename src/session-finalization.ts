import { existsSync } from "node:fs";

import { CheckoutResourceStore, resourceOwner } from "./checkout-resource-store.ts";
import { errorMessage, MonkeError, ThrownValueSchema } from "./errors.ts";
import { releaseCheckoutResources } from "./resource-lifecycle.ts";
import { getMonkeHome } from "./runtime.ts";
import type { SessionAction, SessionLifecycleObserver } from "./session-lifecycle-progress.ts";
import type { SessionStateStore } from "./session-state-store.ts";
import type { Runtime, SessionState, SessionRepoState } from "./types.ts";
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
  const resources = new CheckoutResourceStore(store.home);
  for (const repo of state.repos) {
    resources.remove(resourceOwner(repo.sourceRoot, repo.worktreePath, state.session));
  }
  observer.completed?.(action);
}

/** Run recorded commands while Session worktrees are still available. */
export function cleanupSessionResources(
  runtime: Runtime,
  state: SessionState,
  observer: SessionLifecycleObserver = {},
  cleanupFromSource = false,
  recoveryCommand?: string
) {
  const store = new CheckoutResourceStore(getMonkeHome(runtime), [state]);
  validateCleanupWorktrees(runtime, state, observer, cleanupFromSource, recoveryCommand, store);
  for (const repoState of [...state.repos].toReversed()) {
    const { cleanupCwd, legacyCleanup, record } = releaseRepoResources(
      runtime,
      store,
      state,
      repoState,
      observer,
      cleanupFromSource,
      recoveryCommand
    );
    const cleanupCommand = recoveryCommand ?? repoState.cleanupCommand;
    if (
      (!repoState.cleanupEligible &&
        !(recoveryCommand && (record.resourceCommandOutputs.length || legacyCleanup))) ||
      !cleanupCommand ||
      ((legacyCleanup === cleanupCommand || record.releasedLegacyCleanup === cleanupCommand) &&
        !recoveryCommand)
    ) {
      continue;
    }

    const resourceEnv = Object.fromEntries(
      record.resourceValues.map((resource) => [resource.env, resource.value])
    );
    const resourceCommandEnv = Object.fromEntries(
      record.resourceCommandOutputs.flatMap((command) =>
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
        cwd: cleanupCwd,
        env: {
          ...resourceEnv,
          ...resourceCommandEnv,
          MONKE_RESOURCE_OUTPUTS: JSON.stringify(resourceCommandEnv),
          MONKE_SESSION: state.session,
          MONKE_SOURCE_ROOT: repoState.sourceRoot,
          MONKE_WORKTREE_PATH: repoState.worktreePath
        },
        timeoutSeconds: CLEANUP_COMMAND_TIMEOUT_SECONDS
      });
      if (recoveryCommand) {
        record.resourceCommandOutputs = [];
        delete record.legacyCleanupCommand;
        record.releasedLegacyCleanup = recoveryCommand;
        store.save(record);
      }
      observer.completed?.(action);
    } catch (error) {
      throw new MonkeError(
        `Cleanup command failed for session ${state.session} repo ${repoState.sourceRoot}: ${cleanupCommand}\n${errorMessage(ThrownValueSchema.parse(error))}`
      );
    }
  }
}

function releaseRepoResources(
  runtime: Runtime,
  store: CheckoutResourceStore,
  state: SessionState,
  repo: SessionRepoState,
  observer: SessionLifecycleObserver,
  cleanupFromSource: boolean,
  recoveryCommand?: string
) {
  const record = store.get(resourceOwner(repo.sourceRoot, repo.worktreePath, state.session));
  const cleanupCwd =
    recoveryCommand || (cleanupFromSource && !existsSync(repo.worktreePath))
      ? repo.sourceRoot
      : repo.worktreePath;
  const legacyCleanup = record.legacyCleanupCommand;
  if (
    (record.resourceCommandOutputs.some(
      (command) => command.run !== undefined && command.legacy !== true
    ) ||
      legacyCleanup) &&
    !existsSync(cleanupCwd)
  ) {
    throw new MonkeError(`Missing checkout for resource release: ${cleanupCwd}`);
  }
  store.save(record);
  if (!recoveryCommand && (record.resourceCommandOutputs.length || legacyCleanup)) {
    observer.beforeEffect?.({
      sourceRoot: repo.sourceRoot,
      step: "cleanup-command",
      worktreePath: repo.worktreePath
    });
    try {
      releaseCheckoutResources(runtime, store, record, cleanupCwd);
    } catch (error) {
      throw new MonkeError(
        `Cleanup command failed for session ${state.session} repo ${repo.sourceRoot} during resource release\n${errorMessage(ThrownValueSchema.parse(error))}`
      );
    }
  }
  return { cleanupCwd, legacyCleanup, record };
}

function validateCleanupWorktrees(
  runtime: Runtime,
  state: SessionState,
  observer: SessionLifecycleObserver,
  cleanupFromSource: boolean,
  recoveryCommand: string | undefined,
  store: CheckoutResourceStore
) {
  for (const repoState of state.repos) {
    observer.beforeStep?.({
      sourceRoot: repoState.sourceRoot,
      step: "revalidation",
      worktreePath: repoState.worktreePath
    });
    assertCanonicalSourceCheckout(runtime, repoState.sourceRoot);
    const record = store.get(
      resourceOwner(repoState.sourceRoot, repoState.worktreePath, state.session)
    );
    const needsCleanup = Boolean(
      (repoState.cleanupEligible && repoState.cleanupCommand) ||
      record.legacyCleanupCommand ||
      record.resourceCommandOutputs.some(
        (command) => command.run !== undefined && command.legacy !== true
      )
    );
    if (
      needsCleanup &&
      !existsSync(repoState.worktreePath) &&
      !cleanupFromSource &&
      !recoveryCommand
    ) {
      throw new MonkeError(
        `Cannot run cleanup: Session worktree is missing: ${repoState.worktreePath}. ` +
          `Restore the worktree and retry. Only if the recorded commands are safe from source checkouts, ` +
          `use mt chop <session> --cleanup-from-source for explicit recovery. Session state is retained.`
      );
    }
  }
}
