import {
  collectCleanupEvidence,
  createCleanupEvidenceCache,
  decideCleanupEligibility,
  revalidateCleanupEvidence
} from "./cleanup-eligibility.ts";
import { assertRetainedHead, preserveDetachedHead } from "./cleanup-retained-head.ts";
import { inspectStaleRegistration } from "./cleanup-stale-registration.ts";
import { errorMessage, MonkeError, ThrownValueSchema } from "./errors.ts";
import { containsPath, samePath, worktreePathsOverlap } from "./path-identity.ts";
import type { OperationLock } from "./runtime.ts";
import type { UnownedWorktree } from "./session-cleanup-eligibility.ts";
import { listSessionStatesRelevantToWorktrees, scanSessionStates } from "./session-state-store.ts";
import { requestShellDirectoryAfterRemoval } from "./shell.ts";
import type { Runtime } from "./types.ts";
import { scanWorktreeProcesses, stopStaleWorktreeProcesses } from "./worktree-processes.ts";
import {
  assertNoOverlappingCheckouts,
  preflightWorktreeRemoval,
  validateRegisteredWorktreeForRemoval
} from "./worktree-safety.ts";

export async function cleanupOrdinaryWorktrees(
  runtime: Runtime,
  home: string,
  worktrees: UnownedWorktree[],
  options: { dryRun: boolean; recoveryCommand?: string; sourceRoots: string[] },
  lock?: OperationLock
): Promise<UnownedWorktree[]> {
  const result: UnownedWorktree[] = [];
  for (const worktree of worktrees) {
    let attempted = false;
    try {
      assertUnowned(runtime, home, worktree, options.sourceRoots);
      const stale = inspectStaleRegistration(runtime, worktree.sourceRoot, worktree.worktreePath);
      if (stale) {
        if (!options.dryRun) {
          removeStaleRegistration(runtime, home, worktree, options.sourceRoots, stale, lock, () => {
            attempted = true;
          });
        }
        result.push({
          ...worktree,
          eligible: true,
          outcome: options.dryRun ? "would-clean" : "cleaned",
          reason: "stale-registration"
        });
        continue;
      }
      validateRegisteredWorktreeForRemoval(runtime, worktree.sourceRoot, worktree.worktreePath);
      // oxlint-disable-next-line no-await-in-loop
      const evidence = await collectCleanupEvidence(
        runtime,
        {
          allowDetached: true,
          sourceRoot: worktree.sourceRoot,
          worktreePath: worktree.worktreePath
        },
        createCleanupEvidenceCache()
      );
      const decision = decideCleanupEligibility(evidence);
      if (!decision.eligible || !options.recoveryCommand) {
        result.push({
          ...worktree,
          eligible: false,
          outcome: "skipped",
          reason: decision.eligible ? "resource-recovery-required" : decision.code
        });
        continue;
      }
      if (options.dryRun) {
        result.push({ ...worktree, eligible: true, outcome: "would-clean", reason: decision.code });
        continue;
      }
      const { fingerprint } = scanSessionStates(home);
      const guard = () => {
        if (!lock) {
          throw new MonkeError("Ordinary cleanup requires the operation lock");
        }
        lock.assertHeld();
        if (scanSessionStates(home).fingerprint !== fingerprint) {
          throw new MonkeError("Session ownership changed during ordinary cleanup");
        }
        assertUnowned(runtime, home, worktree, options.sourceRoots);
        validateRegisteredWorktreeForRemoval(runtime, worktree.sourceRoot, worktree.worktreePath);
        const changed = revalidateCleanupEvidence(runtime, evidence);
        if (changed) {
          throw new MonkeError(`Ordinary worktree changed: ${changed.code}`);
        }
      };
      guard();
      const processes = scanWorktreeProcesses(runtime, [worktree.worktreePath]);
      const stopped = stopStaleWorktreeProcesses(runtime, processes, worktree.worktreePath, {
        beforeKill() {
          guard();
          attempted = true;
        }
      });
      if (stopped.recent.length > 0) {
        throw new MonkeError("Ordinary worktree has recent running processes");
      }
      if (evidence.branch === null && evidence.head) {
        guard();
        preserveDetachedHead(runtime, worktree.sourceRoot, worktree.worktreePath, evidence.head);
      }
      guard();
      attempted = true;
      runtime.exec("sh", ["-c", options.recoveryCommand], {
        cwd: worktree.sourceRoot,
        env: {
          MONKE_SESSION: evidence.branch ?? "",
          MONKE_SOURCE_ROOT: worktree.sourceRoot,
          MONKE_WORKTREE_PATH: worktree.worktreePath
        },
        timeoutSeconds: 60
      });
      guard();
      // Re-scan after the recovery command: it must not leave a new process in the worktree.
      if (
        scanWorktreeProcesses(runtime, [worktree.worktreePath]).treesUnder(worktree.worktreePath)
          .length > 0
      ) {
        throw new MonkeError("Ordinary worktree became active during recovery");
      }
      const checked = preflightWorktreeRemoval(
        runtime,
        worktree.sourceRoot,
        worktree.worktreePath,
        { force: false }
      );
      if (evidence.branch === null && evidence.head) {
        assertRetainedHead(runtime, worktree.sourceRoot, worktree.worktreePath, evidence.head);
      }
      runtime.exec(
        "git",
        [
          "worktree",
          "remove",
          ...(checked.forceGitRemoval ? ["--force"] : []),
          worktree.worktreePath
        ],
        { cwd: worktree.sourceRoot }
      );
      if (containsPath(worktree.worktreePath, runtime.cwd)) {
        requestShellDirectoryAfterRemoval(runtime, worktree.sourceRoot);
      }
      result.push({ ...worktree, eligible: true, outcome: "cleaned", reason: decision.code });
    } catch (error) {
      result.push({
        ...worktree,
        eligible: false,
        inspectionFailed: !attempted,
        outcome: attempted ? "failed" : "skipped",
        reason: errorMessage(ThrownValueSchema.parse(error))
      });
    }
  }
  return result;
}

function assertUnowned(
  runtime: Runtime,
  home: string,
  worktree: UnownedWorktree,
  sources: string[]
) {
  const owners = listSessionStatesRelevantToWorktrees(home, [worktree.worktreePath]);
  if (
    owners.some((state) =>
      state.repos.some((repo) => worktreePathsOverlap(repo.worktreePath, worktree.worktreePath))
    )
  ) {
    throw new MonkeError(`A retained Session owns ${worktree.worktreePath}`);
  }
  if (
    samePath(worktree.sourceRoot, worktree.worktreePath) ||
    containsPath(worktree.worktreePath, home)
  ) {
    throw new MonkeError("Cannot remove a Source checkout or the Monke home");
  }
  assertNoOverlappingCheckouts(runtime, sources, worktree.worktreePath);
}

function removeStaleRegistration(
  runtime: Runtime,
  home: string,
  worktree: UnownedWorktree,
  sources: string[],
  stale: string,
  lock: OperationLock | undefined,
  beforeRemove: () => void
) {
  const { fingerprint } = scanSessionStates(home);
  if (
    scanWorktreeProcesses(runtime, [worktree.worktreePath]).treesUnder(worktree.worktreePath)
      .length > 0
  ) {
    throw new MonkeError("Stale registration still has running processes");
  }
  if (!lock) {
    throw new MonkeError("Ordinary cleanup requires the operation lock");
  }
  lock.assertHeld();
  assertUnowned(runtime, home, worktree, sources);
  if (
    scanSessionStates(home).fingerprint !== fingerprint ||
    inspectStaleRegistration(runtime, worktree.sourceRoot, worktree.worktreePath) !== stale
  ) {
    throw new MonkeError("Stale registration changed before removal");
  }
  beforeRemove();
  runtime.exec("git", ["worktree", "remove", worktree.worktreePath], {
    cwd: worktree.sourceRoot
  });
}
