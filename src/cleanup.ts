import { teardownSession } from "./chop.ts";
import { readOnlyCleanupRuntime } from "./cleanup-eligibility.ts";
import { errorMessage, MonkeError, ThrownValueSchema } from "./errors.ts";
import { listWorktrees } from "./git.ts";
import { containsPath, samePath, worktreePathsOverlap } from "./path-identity.ts";
import { getMonkeHome, withGlobalLockAsync } from "./runtime.ts";
import type { OperationLock } from "./runtime.ts";
import { inspectSessionCleanup, revalidateSessionMember } from "./session-cleanup-eligibility.ts";
import {
  createSessionCleanupReport,
  formatSessionCleanupReport
} from "./session-cleanup-report.ts";
import type { SessionCleanupExecution } from "./session-cleanup-report.ts";
import { cleanupCommandActions, sessionRemovalRank } from "./session-lifecycle-progress.ts";
import type { SessionAction } from "./session-lifecycle-progress.ts";
import { inspectSessionRepoRegistration } from "./session-safety.ts";
import { scanSessionStates } from "./session-state-store.ts";
import type { Runtime, SessionState } from "./types.ts";

class GlobalCleanupError extends MonkeError {
  constructor(message: string) {
    super(message);
    this.name = "GlobalCleanupError";
  }
}
type Inventory = Awaited<ReturnType<typeof inspectSessionCleanup>>;
type SessionReport = ReturnType<typeof createSessionCleanupReport>;

/** Both modes use the same eligibility policy. Only execution acquires the operation lock. */
export async function runCleanup(runtime: Runtime, options: { dryRun: boolean; json: boolean }) {
  const home = getMonkeHome(runtime);
  let inventory: Inventory | undefined;
  const sessions: SessionReport[] = [];
  let globalFailure: string | null = null;
  try {
    if (options.dryRun) {
      inventory = await inspectSessionCleanup(runtime, home);
      for (const row of inventory.sessions) {
        sessions.push(reportSession(row, { outcome: "not-attempted" }, true, runtime.cwd));
      }
    } else {
      await withGlobalLockAsync(home, async (lock) => {
        inventory = await inspectSessionCleanup(runtime, home, [], { operationLock: lock });
        assertGlobalSafety(lock, inventory);
        await executeInventory(runtime, home, lock, inventory, sessions);
      });
    }
  } catch (error) {
    globalFailure = errorMessage(ThrownValueSchema.parse(error));
  }
  // Include every inspected Session even when a global failure stops execution.
  for (const row of inventory?.sessions ?? []) {
    if (!sessions.some((session) => session.stateFile === row.snapshot.filePath)) {
      sessions.push(
        createSessionCleanupReport(row.snapshot, {
          message: globalFailure ?? "Execution stopped",
          outcome: "skipped",
          sourceRoot: row.snapshot.rootSourceRoot ?? home,
          step: "revalidation"
        })
      );
    }
  }
  const exitCode = cleanupExitCode(sessions, inventory, globalFailure);
  const report = {
    dryRun: options.dryRun,
    exitCode,
    globalFailure,
    inspectedAt: inventory?.inspectedAt ?? new Date().toISOString(),
    schemaVersion: 1,
    sessions,
    unavailableSources: inventory?.unavailableSources ?? [],
    unownedWorktrees: inventory?.unownedWorktrees ?? []
  };
  writeCleanupReport(runtime, report, options.json);
  if (exitCode !== 0) {
    throw new MonkeError(
      "Cleanup incomplete; see the report for inspection errors, failed actions, and retained Sessions."
    );
  }
}

function cleanupExitCode(
  sessions: SessionReport[],
  inventory: Inventory | undefined,
  globalFailure: string | null
) {
  const inspectionError =
    sessions.some((session) => session.inspectionFailed) ||
    (inventory?.unavailableSources.length ?? 0) > 0;
  return globalFailure ||
    inspectionError ||
    sessions.some(
      (session) => session.outcome === "failed" || session.execution.outcome === "skipped"
    )
    ? 1
    : 0;
}

async function executeInventory(
  runtime: Runtime,
  home: string,
  lock: OperationLock,
  inventory: Inventory,
  sessions: SessionReport[]
) {
  for (const original of inventory.sessions) {
    // Earlier Cleanup commands may change later Sessions, Git refs, or provider evidence.
    // Sessions execute serially because Cleanup commands can affect later candidates.
    // oxlint-disable-next-line no-await-in-loop
    const fresh = await inspectSessionCleanup(runtime, home, [], {
      operationLock: lock,
      sessionFile: original.snapshot.filePath
    });
    assertGlobalSafety(lock, fresh);
    const [row] = fresh.sessions;
    if (!row) {
      throw new GlobalCleanupError(
        `Retained Session disappeared before inspection: ${original.snapshot.filePath}`
      );
    }
    if (!row.decision.eligible) {
      sessions.push(reportSession(row, { outcome: "not-attempted" }, false, runtime.cwd));
      continue;
    }
    const result = executeSession(runtime, home, lock, fresh, row);
    sessions.push(result.report);
    if (result.globalFailure) {
      throw new GlobalCleanupError(result.globalFailure);
    }
  }
}

function writeCleanupReport(
  runtime: Runtime,
  report: {
    dryRun: boolean;
    globalFailure: string | null;
    sessions: SessionReport[];
    unavailableSources: string[];
    unownedWorktrees: Inventory["unownedWorktrees"];
  },
  json: boolean
) {
  const { globalFailure, sessions } = report;
  if (json) {
    runtime.writeStdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const session of sessions) {
      runtime.writeStdout(formatSessionCleanupReport(session));
    }
    if (sessions.length === 0) {
      runtime.writeStdout("No retained Sessions inspected.\n");
    }
    for (const worktree of report.unownedWorktrees) {
      runtime.writeStdout(
        `Unowned (untouched): ${worktree.sourceRoot} — ${worktree.worktreePath}\n`
      );
    }
    for (const source of report.unavailableSources) {
      runtime.writeStdout(`Source unavailable for unowned-worktree inspection: ${source}\n`);
    }
    if (globalFailure) {
      runtime.writeStdout(`Cleanup stopped: ${globalFailure}\n`);
    }
  }
}

function assertGlobalSafety(lock: OperationLock, inventory: Inventory) {
  try {
    lock.assertHeld();
  } catch (error) {
    throw new GlobalCleanupError(errorMessage(ThrownValueSchema.parse(error)));
  }
  if (inventory.unboundedOwnership) {
    throw new GlobalCleanupError(
      "Invalid retained state has unbounded ownership; no further Sessions can be cleaned."
    );
  }
  if (
    inventory.sessions.some((row) =>
      row.snapshot.blockers.includes("state-changed-during-inspection")
    )
  ) {
    throw new GlobalCleanupError("Retained Session state changed during inspection.");
  }
}

function reportSession(
  row: Inventory["sessions"][number],
  execution: SessionCleanupExecution,
  dryRun: boolean,
  cwd: string
) {
  const { snapshot } = row;
  const state = row.decision.eligible ? row.state : null;
  const plannedActions: SessionAction[] = state
    ? [
        ...state.repos
          .filter((repo) =>
            snapshot.members.some(
              (member) =>
                samePath(member.worktreePath, repo.worktreePath) &&
                (member.mode === "live" || member.mode === "stale")
            )
          )
          .toSorted(
            (left, right) =>
              sessionRemovalRank(left, cwd, state.rootSourceRoot) -
              sessionRemovalRank(right, cwd, state.rootSourceRoot)
          )
          .map((member) => ({
            sourceRoot: member.sourceRoot,
            step: "worktree-removal" as const,
            worktreePath: member.worktreePath
          })),
        ...cleanupCommandActions(state),
        { sourceRoot: state.rootSourceRoot, step: "state-removal" }
      ]
    : [];
  return createSessionCleanupReport(snapshot, execution, { dryRun, plannedActions });
}

function executeSession(
  runtime: Runtime,
  home: string,
  lock: OperationLock,
  inventory: Inventory,
  row: Inventory["sessions"][number]
) {
  const { snapshot } = row;
  const { state } = row;
  if (!state) {
    throw new GlobalCleanupError("Eligible Session has no retained state");
  }
  const planned = reportSession(row, { outcome: "not-attempted" }, false, runtime.cwd);
  const completedActions: SessionAction[] = [];
  let current: SessionAction = { sourceRoot: state.rootSourceRoot, step: "revalidation" };
  let attemptedAction: SessionAction | undefined;
  let started = false;
  const readOnly = readOnlyCleanupRuntime(runtime);
  const scan = scanSessionStates(home);
  const states = scan.records.flatMap((record) => (record.state ? [record.state] : []));
  // Match the inspector's discovery scope. An unavailable unrelated Source is
  // reported separately; a previously available Source failing revalidation blocks removal.
  const sources = [
    ...new Set(states.flatMap((retained) => retained.repos.map((repo) => repo.sourceRoot)))
  ].filter(
    (source) => !inventory.unavailableSources.some((unavailable) => samePath(source, unavailable))
  );
  function guard() {
    assertGlobalSafety(lock, inventory);
    if (scanSessionStates(home).fingerprint !== inventory.stateFingerprint) {
      throw new GlobalCleanupError("Retained Session state changed after inspection.");
    }
  }
  try {
    guard();
    const invocation = state.repos.find((repo) => containsPath(repo.worktreePath, runtime.cwd));
    teardownSession(
      { ...runtime, writeStdout: runtime.writeStderr },
      home,
      invocation?.worktreePath ?? runtime.cwd,
      { allStates: states, kind: "session", state },
      { force: false },
      {
        beforeEffect(action) {
          guard();
          if (action.step !== "worktree-removal") {
            assertFinalizationReady(readOnly, home, state);
          }
          started = true;
          attemptedAction = action;
        },
        beforeStep(action) {
          current = action;
          attemptedAction = undefined;
          guard();
        },
        completed(action) {
          completedActions.push(action);
          attemptedAction = undefined;
        },
        revalidateMember(repo) {
          const member = snapshot.members.find((candidate) =>
            samePath(candidate.worktreePath, repo.worktreePath)
          );
          if (!member) {
            throw new MonkeError(`Missing member evidence: ${repo.worktreePath}`);
          }
          revalidateSessionMember(runtime, readOnly, home, state, repo, member);
          assertNoNewOverlaps(readOnly, sources, repo.worktreePath);
        }
      }
    );
    assertGlobalSafety(lock, inventory);
    return {
      globalFailure: null,
      report: createSessionCleanupReport(
        snapshot,
        { completedActions, outcome: "cleaned", remainingActions: [] },
        { plannedActions: planned.plannedActions }
      )
    };
  } catch (error) {
    const message = errorMessage(ThrownValueSchema.parse(error));
    const remainingActions = planned.plannedActions.filter(
      (action) =>
        !completedActions.some(
          (done) => done.step === action.step && done.sourceRoot === action.sourceRoot
        )
    );
    const execution: SessionCleanupExecution = {
      attemptedAction,
      completedActions,
      message,
      outcome: started ? "failed" : "skipped",
      remainingActions,
      retryCleanupCommands: cleanupCommandActions(state),
      sourceRoot: current.sourceRoot,
      step: current.step
    };
    return {
      globalFailure: error instanceof GlobalCleanupError ? message : null,
      report: createSessionCleanupReport(snapshot, execution, {
        plannedActions: planned.plannedActions
      })
    };
  }
}

function assertFinalizationReady(runtime: Runtime, home: string, state: SessionState) {
  for (const repo of state.repos) {
    if (inspectSessionRepoRegistration(runtime, home, state, repo).mode !== "gone") {
      throw new MonkeError(`Session member reappeared before finalization: ${repo.worktreePath}`);
    }
  }
}

function assertNoNewOverlaps(runtime: Runtime, sources: string[], worktreePath: string) {
  for (const source of sources) {
    for (const worktree of listWorktrees(runtime, source)) {
      if (
        !samePath(worktree.path, source) &&
        !samePath(worktree.path, worktreePath) &&
        worktreePathsOverlap(worktree.path, worktreePath)
      ) {
        throw new MonkeError(
          `Worktree ${worktreePath} overlaps registered worktree ${worktree.path}`
        );
      }
    }
  }
}
