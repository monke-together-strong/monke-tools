import { existsSync } from "node:fs";

import { CheckoutResourceStore, resourceOwner } from "./checkout-resource-store.ts";
import { errorMessage, MonkeError, ThrownValueSchema } from "./errors.ts";
import { releaseCheckoutResources, resourceCommandsForRelease } from "./resource-lifecycle.ts";
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

interface FinalizationOptions {
  cleanupFromSource?: boolean;
  recoveryCommand?: string;
}

/** Inspect retained obligations without migrating records or running cleanup. */
export function inspectSessionFinalization(
  home: string,
  state: SessionState,
  options: FinalizationOptions = {}
) {
  const store = new CheckoutResourceStore(home, [state]);

  const repos = state.repos
    .toReversed()
    .map((repo) => inspectRepoFinalization(store, state, repo, options));

  return {
    actions: repos.flatMap(({ actions }) => actions),
    recoveryRequired: repos
      .filter((repo) => repo.recoveryRequired)
      .map((repo) => repo.record.owner.checkoutPath)
  };
}

function inspectRepoFinalization(
  store: CheckoutResourceStore,
  state: SessionState,
  repo: SessionRepoState,
  { cleanupFromSource, recoveryCommand }: FinalizationOptions
) {
  const record = store.get(resourceOwner(repo.sourceRoot, repo.worktreePath, state.session));
  const releaseCommands = resourceCommandsForRelease(record);

  const cleanupCwd =
    recoveryCommand || (cleanupFromSource && !existsSync(repo.worktreePath))
      ? repo.sourceRoot
      : repo.worktreePath;

  const cleanupCommand = recoveryCommand
    ? repo.cleanupEligible ||
      record.resourceCommandOutputs.length > 0 ||
      record.legacyCleanupCommand
      ? recoveryCommand
      : undefined
    : repo.cleanupEligible &&
        repo.cleanupCommand !== record.legacyCleanupCommand &&
        repo.cleanupCommand !== record.releasedLegacyCleanup
      ? repo.cleanupCommand
      : undefined;

  const releaseAction: SessionAction | undefined =
    !recoveryCommand && (record.resourceCommandOutputs.length > 0 || record.legacyCleanupCommand)
      ? {
          command: record.legacyCleanupCommand,
          resources: releaseCommands.map(({ name, run }) => ({ name, run })),
          sourceRoot: repo.sourceRoot,
          step: "resource-release",
          worktreePath: repo.worktreePath
        }
      : undefined;

  const cleanupAction: SessionAction | undefined = cleanupCommand
    ? {
        command: cleanupCommand,
        recoveryCommand,
        sourceRoot: repo.sourceRoot,
        step: "cleanup-command",
        worktreePath: repo.worktreePath
      }
    : undefined;

  const needsCheckout =
    cleanupAction !== undefined ||
    (releaseAction !== undefined &&
      Boolean(record.legacyCleanupCommand || releaseCommands.some((command) => command.run)));

  return {
    actions: [releaseAction, cleanupAction].filter((action) => action !== undefined),
    cleanupAction,
    cleanupCommand,
    cleanupCwd,
    record,
    recoveryRequired: needsCheckout && !existsSync(cleanupCwd),
    releaseAction
  };
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
  const options = { cleanupFromSource, recoveryCommand };

  for (const repo of state.repos) {
    observer.beforeStep?.({
      sourceRoot: repo.sourceRoot,
      step: "revalidation",
      worktreePath: repo.worktreePath
    });
    assertCanonicalSourceCheckout(runtime, repo.sourceRoot);
    assertCleanupWorktree(inspectRepoFinalization(store, state, repo, options));
  }

  for (const repo of state.repos.toReversed()) {
    // Earlier cleanup can change a sibling's obligations. Read its current record under the locks.
    const pending = inspectRepoFinalization(store, state, repo, options);
    assertCleanupWorktree(pending);
    const { cleanupAction, cleanupCommand, cleanupCwd, record, releaseAction } = pending;
    store.save(record);

    if (releaseAction) {
      observer.beforeStep?.(releaseAction);
      observer.beforeEffect?.(releaseAction);

      try {
        releaseCheckoutResources(runtime, store, record, cleanupCwd);
      } catch (cause) {
        throw new MonkeError(
          `Resource release failed for session ${state.session} repo ${repo.sourceRoot}\n${errorMessage(ThrownValueSchema.parse(cause))}`,
          { cause }
        );
      }

      observer.completed?.(releaseAction);
    }

    if (!cleanupAction || !cleanupCommand) {
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

    observer.beforeStep?.(cleanupAction);
    observer.beforeEffect?.(cleanupAction);

    try {
      runtime.exec("sh", ["-c", cleanupCommand], {
        cwd: cleanupCwd,
        env: {
          ...resourceEnv,
          ...resourceCommandEnv,
          MONKE_RESOURCE_OUTPUTS: JSON.stringify(resourceCommandEnv),
          MONKE_SESSION: state.session,
          MONKE_SOURCE_ROOT: repo.sourceRoot,
          MONKE_WORKTREE_PATH: repo.worktreePath
        },
        timeoutSeconds: CLEANUP_COMMAND_TIMEOUT_SECONDS
      });

      if (recoveryCommand) {
        record.resourceCommandOutputs = [];
        delete record.legacyCleanupCommand;
        record.releasedLegacyCleanup = recoveryCommand;
        store.save(record);
      }

      observer.completed?.(cleanupAction);
    } catch (cause) {
      throw new MonkeError(
        `Cleanup command failed for session ${state.session} repo ${repo.sourceRoot}: ${cleanupCommand}\n${errorMessage(ThrownValueSchema.parse(cause))}`,
        { cause }
      );
    }
  }
}

function assertCleanupWorktree(pending: ReturnType<typeof inspectRepoFinalization>) {
  if (pending.recoveryRequired) {
    throw new MonkeError(
      `Cannot run cleanup: Session worktree is missing: ${pending.record.owner.checkoutPath}. ` +
        `Restore the worktree and retry. Only if the recorded commands are safe from source checkouts, ` +
        `use mt chop <session> --cleanup-from-source for explicit recovery. Session state is retained.`
    );
  }
}
