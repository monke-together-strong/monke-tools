import { existsSync } from "node:fs";

import { CheckoutResourceStore, resourceOwner } from "./checkout-resource-store.ts";
import { resourceCommandsForRelease } from "./resource-lifecycle.ts";
import type { SessionAction } from "./session-removal.ts";
import type { SessionState, SessionRepoState } from "./types.ts";

export interface FinalizationOptions {
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

/** One repo's Cleanup obligations, read from its canonical Checkout resource record. */
export function inspectRepoFinalization(
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

  const hasRetainedResources =
    record.resourceCommandOutputs.length > 0 || Boolean(record.legacyCleanupCommand);

  const { cleanupCommand: savedCleanupCommand } = repo;

  const cleanupOwnedByRelease =
    savedCleanupCommand === record.legacyCleanupCommand ||
    savedCleanupCommand === record.releasedLegacyCleanup;

  let cleanupCommand: string | undefined;

  if (recoveryCommand) {
    cleanupCommand = repo.cleanupObligated || hasRetainedResources ? recoveryCommand : undefined;
  } else if (repo.cleanupObligated && !cleanupOwnedByRelease) {
    cleanupCommand = savedCleanupCommand;
  }

  const releaseAction: SessionAction | undefined =
    !recoveryCommand && hasRetainedResources
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
