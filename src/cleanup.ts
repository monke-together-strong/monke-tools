import { existsSync } from "node:fs";
import path from "node:path";

import { teardownSession } from "./chop.ts";
import { archiveCleanupFiles, assertCleanupArchive } from "./cleanup-archive.ts";
import { readOnlyCleanupRuntime } from "./cleanup-eligibility.ts";
import { cleanupOrdinaryWorktrees } from "./cleanup-ordinary.ts";
import {
  assertRetainedHead,
  preserveDetachedHead,
  retainedHeadAction
} from "./cleanup-retained-head.ts";
import { errorMessage, MonkeError, ThrownValueSchema } from "./errors.ts";
import { resolveRepoContext } from "./git.ts";
import { containsPath, samePath } from "./path-identity.ts";
import { getMonkeHome, withGlobalLockAsync } from "./runtime.ts";
import type { OperationLock } from "./runtime.ts";
import { inspectSessionCleanup, revalidateSessionMember } from "./session-cleanup-eligibility.ts";
import type { SessionCleanupMember } from "./session-cleanup-eligibility.ts";
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
import {
  describeTree,
  scanWorktreeProcesses,
  stopStaleWorktreeProcesses
} from "./worktree-processes.ts";
import type { WorktreeProcessScan } from "./worktree-processes.ts";
import { assertNoOverlappingCheckouts } from "./worktree-safety.ts";

class GlobalCleanupError extends MonkeError {
  constructor(message: string) {
    super(message);
    this.name = "GlobalCleanupError";
  }
}
type Inventory = Awaited<ReturnType<typeof inspectSessionCleanup>>;
type SessionReport = ReturnType<typeof createSessionCleanupReport>;

export interface CleanupOptions {
  archiveUntracked?: boolean;
  dryRun: boolean;
  /** Hide skipped Sessions in human output. JSON always includes every inspected Session. */
  eligibleOnly: boolean;
  includeUnowned?: boolean;
  json: boolean;
  recoveryCommand?: string;
  targets?: string[];
}

/** Both modes use the same eligibility policy. Only execution acquires the operation lock. */
export async function runCleanup(runtime: Runtime, options: CleanupOptions) {
  const { home, inspectionOptions, knownSources, ordinary, validateTargets } = prepareCleanup(
    runtime,
    options
  );
  let inventory: Inventory | undefined;
  const sessions: SessionReport[] = [];
  let globalFailure: string | null = null;
  try {
    if (options.dryRun) {
      inventory = await inspectSessionCleanup(runtime, home, [...knownSources], inspectionOptions);
      validateTargets(inventory);
      for (const row of inventory.sessions) {
        sessions.push(
          reportSession(
            row,
            { outcome: "not-attempted" },
            true,
            runtime.cwd,
            options.recoveryCommand
          )
        );
      }
      await ordinary(inventory);
    } else {
      await withGlobalLockAsync(home, async (lock) => {
        inventory = await inspectSessionCleanup(runtime, home, [...knownSources], {
          ...inspectionOptions,
          operationLock: lock
        });
        validateTargets(inventory);
        assertGlobalSafety(lock, inventory);
        // One process-table pass for the whole run; members index it before removal.
        const processes = scanWorktreeProcesses(runtime, [path.join(home, "worktrees")]);
        await executeInventory(runtime, home, lock, inventory, sessions, processes, options);
        await ordinary(inventory, lock);
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
  writeCleanupReport(runtime, report, options);
  if (exitCode !== 0) {
    throw new MonkeError(
      "Cleanup incomplete; see the report for inspection errors, failed actions, and retained Sessions."
    );
  }
}

function prepareCleanup(runtime: Runtime, options: CleanupOptions) {
  const home = getMonkeHome(runtime);
  const targets = options.targets?.map((target) => path.resolve(runtime.cwd, target));
  if (options.recoveryCommand !== undefined) {
    if (options.recoveryCommand.trim().length === 0) {
      throw new MonkeError("--recover-with requires a nonempty recovery command");
    }
    if ((targets?.length ?? 0) === 0) {
      throw new MonkeError("--recover-with requires explicit worktree targets");
    }
  }
  const inspectionOptions = {
    archiveUntracked: options.archiveUntracked,
    recoveryCommand: options.recoveryCommand,
    targets
  };
  const knownSources = new Set<string>();
  for (const candidate of [runtime.cwd, ...(targets ?? [])]) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      knownSources.add(
        resolveRepoContext(runtime, candidate, null, { inferSessionName: false }).sourceRoot
      );
    } catch {
      // Discovery also works from outside a checkout.
    }
  }
  const validateTargets = (inventory: Inventory) => {
    for (const target of targets ?? []) {
      const owned = inventory.sessions.some(
        (row) =>
          row.snapshot.filePath === target ||
          row.state?.repos.some((repo) => samePath(repo.worktreePath, target))
      );
      const unowned = inventory.unownedWorktrees.some((repo) =>
        samePath(repo.worktreePath, target)
      );
      if (!owned && !(options.includeUnowned && unowned)) {
        throw new MonkeError(`Cleanup target not found or requires --include-unowned: ${target}`);
      }
    }
  };
  const ordinary = async (inventory: Inventory, lock?: OperationLock) => {
    if (!options.includeUnowned) {
      return;
    }
    const selected = inventory.unownedWorktrees.filter(
      (repo) => (targets?.length ?? 0) === 0 || targets?.includes(repo.worktreePath)
    );
    const results = await cleanupOrdinaryWorktrees(
      runtime,
      home,
      selected,
      {
        ...options,
        // Failed discovery still leaves known ownership that removal must recheck.
        sourceRoots: [...inventory.sourceRoots, ...inventory.unavailableSources]
      },
      lock
    );
    inventory.unownedWorktrees = inventory.unownedWorktrees.map(
      (repo) => results.find((result) => result.worktreePath === repo.worktreePath) ?? repo
    );
  };
  return { home, inspectionOptions, knownSources, ordinary, validateTargets };
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
    inventory?.unownedWorktrees.some(
      (repo) => repo.outcome === "failed" || repo.inspectionFailed
    ) ||
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
  sessions: SessionReport[],
  processes: WorktreeProcessScan,
  options: CleanupOptions
) {
  for (const original of inventory.sessions) {
    // Earlier Cleanup commands may change later Sessions, Git refs, or provider evidence.
    // Sessions execute serially because Cleanup commands can affect later candidates.
    // Reuse the global unowned-worktree discovery; revalidateMember rechecks overlaps live.
    // oxlint-disable-next-line no-await-in-loop
    const fresh = await inspectSessionCleanup(runtime, home, [], {
      archiveUntracked: options.archiveUntracked,
      discovered: {
        sourceRoots: inventory.sourceRoots,
        unavailableSources: inventory.unavailableSources,
        unownedWorktrees: inventory.unownedWorktrees
      },
      operationLock: lock,
      recoveryCommand: options.recoveryCommand,
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
      sessions.push(
        reportSession(
          row,
          { outcome: "not-attempted" },
          false,
          runtime.cwd,
          options.recoveryCommand
        )
      );
      continue;
    }
    const result = executeSession(runtime, home, lock, fresh, row, processes, options);
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
  options: Pick<CleanupOptions, "eligibleOnly" | "json">
) {
  const { globalFailure, sessions } = report;
  if (options.json) {
    runtime.writeStdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    runtime.writeStdout(`${summarizeCleanup(report)}\n`);
    for (const session of sessions) {
      if (!options.eligibleOnly || session.outcome !== "skipped") {
        runtime.writeStdout(formatSessionCleanupReport(session));
      }
    }
    for (const worktree of report.unownedWorktrees) {
      runtime.writeStdout(
        `Unowned (${worktree.outcome ?? "untouched"}): ${worktree.sourceRoot} — ${worktree.worktreePath}${worktree.reason ? `: ${worktree.reason}` : ""}\n`
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

function summarizeCleanup(report: {
  sessions: SessionReport[];
  unavailableSources: string[];
  unownedWorktrees: unknown[];
}) {
  const { sessions } = report;
  if (sessions.length === 0) {
    return "No retained Sessions inspected.";
  }
  const count = (outcome: SessionReport["outcome"]) =>
    sessions.filter((session) => session.outcome === outcome).length;
  const inspectionErrors = sessions.filter((session) => session.inspectionFailed).length;
  const parts = (
    [
      ["would clean", count("would-clean")],
      ["eligible", count("eligible")],
      ["cleaned", count("cleaned")],
      ["failed", count("failed")],
      ["skipped", count("skipped")]
    ] as const
  )
    .filter(([, total]) => total > 0)
    .map(([label, total]) => `${total} ${label}`);
  const notes = [
    inspectionErrors > 0 ? `${inspectionErrors} with inspection errors` : null,
    report.unownedWorktrees.length > 0
      ? `${report.unownedWorktrees.length} unowned worktrees reported`
      : null,
    report.unavailableSources.length > 0
      ? `${report.unavailableSources.length} Sources unavailable`
      : null
  ].filter((note) => note !== null);
  return `Inspected ${sessions.length} Session${sessions.length === 1 ? "" : "s"}: ${parts.join(", ")}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
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

function detachedMemberHead(member: SessionCleanupMember | undefined): string | null {
  return member?.mode === "live" && member.evidence?.branch === null ? member.evidence.head : null;
}

function reportSession(
  row: Inventory["sessions"][number],
  execution: SessionCleanupExecution,
  dryRun: boolean,
  cwd: string,
  recoveryCommand?: string
) {
  const { snapshot } = row;
  const state = row.decision.eligible ? row.state : null;
  const plannedActions: SessionAction[] = state
    ? [
        ...snapshot.members
          .toSorted(
            (left, right) =>
              sessionRemovalRank(left, cwd, state.rootSourceRoot) -
              sessionRemovalRank(right, cwd, state.rootSourceRoot)
          )
          .flatMap((member) => {
            const head = detachedMemberHead(member);
            return head ? [retainedHeadAction(member.sourceRoot, member.worktreePath, head)] : [];
          }),
        ...snapshot.members
          .filter((member) => member.evidence?.pendingWork?.kind === "untracked-archive")
          .map((member) => ({
            sourceRoot: member.sourceRoot,
            step: "file-archive" as const,
            worktreePath: member.worktreePath
          })),
        ...cleanupCommandActions(state, recoveryCommand),
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
  row: Inventory["sessions"][number],
  processes: WorktreeProcessScan,
  options: CleanupOptions
) {
  const { snapshot } = row;
  const { state } = row;
  if (!state) {
    throw new GlobalCleanupError("Eligible Session has no retained state");
  }
  const planned = reportSession(
    row,
    { outcome: "not-attempted" },
    false,
    runtime.cwd,
    options.recoveryCommand
  );
  const completedActions: SessionAction[] = [];
  const archives = new Map<string, string>();
  let current: SessionAction = { sourceRoot: state.rootSourceRoot, step: "revalidation" };
  let attemptedAction: SessionAction | undefined;
  let started = false;
  const readOnly = readOnlyCleanupRuntime(runtime);
  const scan = scanSessionStates(home);
  const states = scan.records.flatMap((record) => (record.state ? [record.state] : []));
  const sources = inventory.sourceRoots;
  function guard() {
    assertGlobalSafety(lock, inventory);
    if (scanSessionStates(home).fingerprint !== inventory.stateFingerprint) {
      throw new GlobalCleanupError("Retained Session state changed after inspection.");
    }
  }
  const revalidateMember = (repo: SessionState["repos"][number]) => {
    const member = snapshot.members.find((candidate) =>
      samePath(candidate.worktreePath, repo.worktreePath)
    );
    if (!member) {
      throw new MonkeError(`Missing member evidence: ${repo.worktreePath}`);
    }
    revalidateSessionMember(runtime, readOnly, home, state, repo, member);
    assertNoOverlappingCheckouts(readOnly, sources, repo.worktreePath);
  };
  try {
    guard();
    for (const member of snapshot.members) {
      if (member.evidence?.pendingWork?.kind === "untracked-archive") {
        guard();
        const repo = state.repos.find((candidate) =>
          samePath(candidate.worktreePath, member.worktreePath)
        );
        if (!repo) {
          throw new MonkeError("Missing archive member");
        }
        revalidateMember(repo);
        current = {
          sourceRoot: member.sourceRoot,
          step: "file-archive",
          worktreePath: member.worktreePath
        };
        attemptedAction = current;
        started = true;
        const archivePath = archiveCleanupFiles(runtime, home, member.evidence);
        archives.set(member.worktreePath, archivePath);
        attemptedAction = undefined;
        completedActions.push({
          archivePath,
          sourceRoot: member.sourceRoot,
          step: "file-archive",
          worktreePath: member.worktreePath
        });
      }
    }
    const invocation = state.repos.find((repo) => containsPath(repo.worktreePath, runtime.cwd));
    teardownSession(
      { ...runtime, writeStdout: runtime.writeStderr },
      home,
      invocation?.worktreePath ?? runtime.cwd,
      { allStates: states, kind: "session", state },
      { force: false, recoveryCommand: options.recoveryCommand },
      {
        authorizePreservedWork(repo) {
          revalidateMember(repo);
          return snapshot.members.some(
            (member) =>
              samePath(member.worktreePath, repo.worktreePath) &&
              member.evidence?.pendingWork !== undefined
          );
        },
        beforeEffect(action) {
          guard();
          if (action.step === "worktree-removal") {
            const repo = state.repos.find((candidate) =>
              samePath(candidate.worktreePath, action.worktreePath ?? "")
            );
            if (!repo) {
              throw new MonkeError("Missing removal member");
            }
            revalidateMember(repo);
            const member = snapshot.members.find((candidate) =>
              samePath(candidate.worktreePath, repo.worktreePath)
            );
            const archive = archives.get(repo.worktreePath);
            if (member?.evidence?.pendingWork?.kind === "untracked-archive") {
              if (!archive) {
                throw new MonkeError("Missing required file archive");
              }
              assertCleanupArchive(runtime, archive, member.evidence);
            }
            const head = detachedMemberHead(member);
            if (head) {
              assertRetainedHead(runtime, repo.sourceRoot, repo.worktreePath, head);
            }
          }
          if (action.step === "state-removal") {
            assertFinalizationReady(readOnly, home, state);
          }
          started = true;
          attemptedAction = action;
        },
        beforeRemoval(repo) {
          const member = snapshot.members.find((candidate) =>
            samePath(candidate.worktreePath, repo.worktreePath)
          );
          const head = detachedMemberHead(member);
          if (head) {
            const preservation = retainedHeadAction(repo.sourceRoot, repo.worktreePath, head);
            current = preservation;
            guard();
            revalidateMember(repo);
            started = true;
            attemptedAction = preservation;
            preserveDetachedHead(runtime, repo.sourceRoot, repo.worktreePath, head);
            completedActions.push(preservation);
            attemptedAction = undefined;
          }
          const action: SessionAction = {
            sourceRoot: repo.sourceRoot,
            step: "process-stop",
            worktreePath: repo.worktreePath
          };
          current = action;
          attemptedAction = undefined;
          if (processes.treesUnder(repo.worktreePath).length === 0) {
            return;
          }
          guard();
          const outcome = stopStaleWorktreeProcesses(runtime, processes, repo.worktreePath, {
            beforeKill() {
              started = true;
              attemptedAction = action;
            }
          });
          for (const tree of outcome.killed) {
            runtime.writeStderr(
              `Stopped stale process in ${repo.worktreePath}: ${describeTree(tree)}\n`
            );
          }
          for (const tree of outcome.bystanders) {
            runtime.writeStderr(
              `Left running; not attached to ${repo.worktreePath}: ${describeTree(tree)}\n`
            );
          }
          if (outcome.killed.length > 0) {
            completedActions.push({
              ...action,
              command: outcome.killed.map(describeTree).join("; ")
            });
          }
          attemptedAction = undefined;
          if (outcome.recent.length > 0) {
            throw new MonkeError(
              `Worktree ${repo.worktreePath} is in use: ${outcome.recent.map(describeTree).join("; ")}. Processes under a day old are never stopped.`
            );
          }
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
        revalidateMember
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
      retryCleanupCommands: cleanupCommandActions(state, options.recoveryCommand),
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
