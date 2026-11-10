import { existsSync } from "node:fs";
import path from "node:path";

import { RECENT_WORKTREE_MS, readOnlyCleanupRuntime } from "./cleanup-eligibility.ts";
import { cleanupOrdinaryWorktrees } from "./cleanup-ordinary.ts";
import { errorMessage, MonkeError, ThrownValueSchema } from "./errors.ts";
import { resolveRepoContext } from "./git.ts";
import { containsPath, samePath } from "./path-identity.ts";
import { getMonkeHome, withGlobalLockAsync } from "./runtime.ts";
import type { OperationLock } from "./runtime.ts";
import { inspectSessionCleanup, revalidateSessionMember } from "./session-cleanup-eligibility.ts";
import {
  createSessionCleanupReport,
  formatSessionCleanupReport
} from "./session-cleanup-report.ts";
import type { SessionCleanupExecution } from "./session-cleanup-report.ts";
import { planSessionRemoval, removeSession } from "./session-removal.ts";
import type { SessionAction, SessionRemovalProgress } from "./session-removal.ts";
import { inspectSessionRepoRegistration } from "./session-safety.ts";
import { scanSessionStates } from "./session-state-store.ts";
import type { Runtime, SessionState } from "./types.ts";
import {
  describeTree,
  scanWorktreeProcesses,
  stopStaleWorktreeProcesses
} from "./worktree-processes.ts";
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
  sources?: string[];
  targets?: string[];
}

/** Dry runs share execution's eligibility policy; only execution acquires the operation lock. */
export async function runCleanup(runtime: Runtime, options: CleanupOptions) {
  const { home, inspectionOptions, knownSources, ordinary, validateInputs } = prepareCleanup(
    runtime,
    options
  );

  let inventory: Inventory | undefined;
  const sessions: SessionReport[] = [];
  let globalFailure: string | null = null;

  try {
    if (options.dryRun) {
      inventory = await inspectSessionCleanup(runtime, home, [...knownSources], inspectionOptions);
      validateInputs(inventory);

      for (const row of inventory.sessions) {
        sessions.push(reportSession(row, { outcome: "not-attempted" }, true, runtime.cwd));
      }

      await ordinary(inventory);
    } else {
      await withGlobalLockAsync(home, async (lock) => {
        inventory = await inspectSessionCleanup(runtime, home, [...knownSources], {
          ...inspectionOptions,
          operationLock: lock
        });
        validateInputs(inventory);
        assertGlobalSafety(lock, inventory);
        await executeInventory(runtime, home, lock, inventory, sessions, options);
        await ordinary(inventory, lock);
      });
    }
  } catch (cause) {
    globalFailure = errorMessage(ThrownValueSchema.parse(cause));
  }

  // Include every inspected Session even when a global failure stops execution.
  for (const row of inventory?.sessions ?? []) {
    if (!sessions.some((session) => session.stateFile === row.snapshot.filePath)) {
      sessions.push(
        createSessionCleanupReport(row, {
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
    sources: inventory?.sources ?? [],
    unavailableSources: inventory?.unavailableSources ?? [],
    unownedWorktrees: inventory?.unownedWorktrees ?? []
  };

  writeCleanupReport(runtime, { ...report, summary: cleanupSummary(report) }, options);

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
  const explicitSources = new Set<string>();
  const sources = options.sources?.map((source) => path.resolve(runtime.cwd, source)) ?? [];

  for (const candidate of [runtime.cwd, ...(targets ?? []), ...sources]) {
    const explicit = sources.includes(candidate);

    if (!existsSync(candidate)) {
      if (explicit) {
        knownSources.add(candidate);
        explicitSources.add(candidate);
      }

      continue;
    }

    try {
      const source = resolveRepoContext(runtime, candidate, null, {
        inferSessionName: false
      }).sourceRoot;

      knownSources.add(source);

      if (explicit) {
        explicitSources.add(source);
      }
    } catch {
      // Discovery also works from outside a checkout.
      if (explicit) {
        knownSources.add(candidate);
        explicitSources.add(candidate);
      }
    }
  }

  const validateInputs = (inventory: Inventory) => {
    for (const sourceRoot of explicitSources) {
      const source = inventory.sources.find((row) => samePath(row.sourceRoot, sourceRoot));

      if (source?.status !== "inspected") {
        throw new MonkeError(
          `Cannot inspect requested Source ${sourceRoot}: ${source?.message ?? source?.status ?? "not discovered"}`
        );
      }
    }

    for (const target of targets ?? []) {
      const owned = inventory.sessions.some(
        (row) =>
          samePath(row.snapshot.filePath, target) ||
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
      (repo) =>
        (targets?.length ?? 0) === 0 ||
        targets?.some((target) => samePath(target, repo.worktreePath))
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

  return { home, inspectionOptions, knownSources, ordinary, validateInputs };
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
  options: CleanupOptions
) {
  for (const original of inventory.sessions) {
    // Reuse the global unowned-worktree discovery; revalidateMember rechecks overlaps live.
    // oxlint-disable-next-line no-await-in-loop -- Earlier Cleanup commands may change later Sessions, Git refs, or provider evidence.
    const fresh = await inspectSessionCleanup(runtime, home, [], {
      archiveUntracked: options.archiveUntracked,
      discovered: {
        sourceRoots: inventory.sourceRoots,
        sources: inventory.sources,
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
      sessions.push(reportSession(row, { outcome: "not-attempted" }, false, runtime.cwd));
      continue;
    }

    const result = executeSession(runtime, home, lock, fresh, row, options);
    sessions.push(result.report);

    if (result.globalFailure) {
      throw new GlobalCleanupError(result.globalFailure);
    }
  }
}

interface CleanupReport {
  dryRun: boolean;
  globalFailure: string | null;
  sessions: SessionReport[];
  sources: Inventory["sources"];
  unavailableSources: string[];
  unownedWorktrees: Inventory["unownedWorktrees"];
}

function cleanupSummary(report: CleanupReport) {
  const planned = report.sessions
    .filter((session) => session.outcome === "would-clean")
    .flatMap((session) => session.plannedActions);

  const completed = report.sessions.flatMap((session) => session.execution.completedActions ?? []);

  const removalCount = (actions: SessionAction[], outcome: "would-clean" | "cleaned") =>
    actions.filter((action) => action.step === "worktree-removal").length +
    report.unownedWorktrees.filter((worktree) => worktree.outcome === outcome).length;

  return {
    registeredWorktrees: report.sources.reduce(
      (total, source) => total + (source.worktreeCount ?? 0),
      0
    ),
    removedWorktrees: removalCount(completed, "cleaned"),
    sessionsInspected: report.sessions.length,
    sourcesInspected: report.sources.filter((source) => source.status === "inspected").length,
    sourcesSkipped: report.sources.filter((source) => source.status !== "inspected").length,
    wouldRemoveWorktrees: removalCount(planned, "would-clean")
  };
}

function quantity(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function writeCleanupReport(
  runtime: Runtime,
  report: CleanupReport & { summary: ReturnType<typeof cleanupSummary> },
  options: Pick<CleanupOptions, "eligibleOnly" | "json">
) {
  const { globalFailure, sessions } = report;

  if (options.json) {
    runtime.writeStdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    runtime.writeStdout(`${summarizeCleanup(report)}\n`);

    for (const source of report.sources) {
      runtime.writeStdout(
        `Source (${source.status}): ${source.sourceRoot}${source.worktreeCount !== null ? `; ${quantity(source.worktreeCount, "registered worktree")}` : ""}${source.message ? `: ${source.message}` : ""}\n`
      );
    }

    for (const session of sessions) {
      if (!options.eligibleOnly || session.outcome !== "skipped") {
        runtime.writeStdout(formatSessionCleanupReport(session));
      }
    }

    for (const worktree of report.unownedWorktrees) {
      runtime.writeStdout(
        `Unowned (${worktree.outcome ?? "untouched"}): ${worktree.sourceRoot} — ${worktree.worktreePath}${worktree.reason ? `: ${worktree.reason}` : ""}\n`
      );

      for (const detail of worktree.details ?? []) {
        runtime.writeStdout(`  ${detail}\n`);
      }
    }

    if (globalFailure) {
      runtime.writeStdout(`Cleanup stopped: ${globalFailure}\n`);
    }
  }
}

function summarizeCleanup(report: CleanupReport & { summary: ReturnType<typeof cleanupSummary> }) {
  const { sessions } = report;

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
    report.summary.sourcesSkipped > 0 ? `${report.summary.sourcesSkipped} Sources skipped` : null,
    report.summary.wouldRemoveWorktrees > 0
      ? `would remove ${report.summary.wouldRemoveWorktrees} worktrees`
      : null,
    report.summary.removedWorktrees > 0
      ? `${report.summary.removedWorktrees} worktrees removed`
      : null,
    inspectionErrors > 0 ? `${inspectionErrors} with inspection errors` : null,
    report.unownedWorktrees.length > 0
      ? `${report.unownedWorktrees.length} unowned worktrees reported`
      : null
  ].filter((note) => note !== null);

  return `Inspected ${quantity(report.summary.sourcesInspected, "Source")}, ${quantity(report.summary.registeredWorktrees, "registered worktree")}, ${quantity(sessions.length, "Session")}${parts.length > 0 ? `: ${parts.join(", ")}` : "."}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
}

function assertGlobalSafety(lock: OperationLock, inventory: Inventory) {
  try {
    lock.assertHeld();
  } catch (cause) {
    throw new GlobalCleanupError(errorMessage(ThrownValueSchema.parse(cause)));
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

  const plannedActions = state
    ? planSessionRemoval(
        state,
        snapshot.members,
        snapshot.obligations?.actions ?? [],
        invocationPath(state, cwd)
      )
    : [];

  return createSessionCleanupReport(row, execution, { dryRun, plannedActions });
}

function invocationPath(state: SessionState, cwd: string) {
  return state.repos.find((repo) => containsPath(repo.worktreePath, cwd))?.worktreePath ?? cwd;
}

function executeSession(
  runtime: Runtime,
  home: string,
  lock: OperationLock,
  inventory: Inventory,
  row: Inventory["sessions"][number],
  options: CleanupOptions
) {
  const { snapshot } = row;
  const { state } = row;

  if (!state) {
    throw new GlobalCleanupError("Eligible Session has no retained state");
  }

  const planned = reportSession(row, { outcome: "not-attempted" }, false, runtime.cwd);
  const readOnly = readOnlyCleanupRuntime(runtime);
  const scan = scanSessionStates(home);
  const states = scan.records.flatMap((record) => (record.state ? [record.state] : []));
  const sources = [...inventory.sourceRoots, ...inventory.unavailableSources];
  let processes: ReturnType<typeof scanWorktreeProcesses> | undefined;

  function guard() {
    assertGlobalSafety(lock, inventory);

    if (scanSessionStates(home).fingerprint !== inventory.stateFingerprint) {
      throw new GlobalCleanupError("Retained Session state changed after inspection.");
    }
  }

  const inspectProcesses = (progress: SessionRemovalProgress, afterCleanup = false) => {
    const scanned = scanWorktreeProcesses(
      runtime,
      state.repos.map((repo) => repo.worktreePath)
    );

    for (const repo of state.repos) {
      const active = scanned
        .treesUnder(repo.worktreePath)
        .filter((tree) => tree.ageMs < RECENT_WORKTREE_MS || (afterCleanup && tree.attached));

      if (active.length > 0) {
        progress.step(processStop(repo));
        throw new MonkeError(
          `Worktree ${repo.worktreePath} is in use: ${active.map(describeTree).join("; ")}`
        );
      }
    }

    return scanned;
  };

  const result = removeSession(
    { ...runtime, writeStdout: runtime.writeStderr },
    home,
    { allStates: states, state },
    {
      force: false,
      invocationPath: invocationPath(state, runtime.cwd),
      members: snapshot.members,
      recoveryCommand: options.recoveryCommand
    },
    {
      beforeEffect(action, progress) {
        guard();

        if (
          action.step === "resource-release" ||
          action.step === "cleanup-command" ||
          action.step === "worktree-removal"
        ) {
          // Commands may activate any sibling; refresh before the next destructive effect.
          inspectProcesses(progress, true);
        }

        if (action.step === "state-removal") {
          assertFinalizationReady(readOnly, home, state);
        }
      },
      beforeStart(progress) {
        guard();
        // Check every member before archives, process stops, or resource effects.
        processes = inspectProcesses(progress);
      },
      prepareMember(repo, progress) {
        const action = processStop(repo);
        progress.step(action);

        if (!processes || processes.treesUnder(repo.worktreePath).length === 0) {
          return;
        }

        guard();

        const outcome = stopStaleWorktreeProcesses(runtime, processes, repo.worktreePath, {
          beforeKill() {
            progress.attempt(action);
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
          progress.complete({ ...action, command: outcome.killed.map(describeTree).join("; ") });
        }

        if (outcome.recent.length > 0) {
          throw new MonkeError(
            `Worktree ${repo.worktreePath} is in use: ${outcome.recent.map(describeTree).join("; ")}. Processes under a day old are never stopped.`
          );
        }
      },
      revalidateMember(repo) {
        const member = snapshot.members.find((candidate) =>
          samePath(candidate.worktreePath, repo.worktreePath)
        );

        if (!member) {
          throw new MonkeError(`Missing member evidence: ${repo.worktreePath}`);
        }

        revalidateSessionMember(runtime, readOnly, home, state, repo, member);
        assertNoOverlappingCheckouts(readOnly, sources, repo.worktreePath);
      }
    }
  );

  if (result.outcome === "removed") {
    try {
      assertGlobalSafety(lock, inventory);
    } catch (cause) {
      return failedReport(row, planned, result.completed, cause);
    }

    return {
      globalFailure: null,
      report: createSessionCleanupReport(
        row,
        { completedActions: result.completed, outcome: "cleaned", remainingActions: [] },
        { plannedActions: planned.plannedActions }
      )
    };
  }

  const message = [
    errorMessage(ThrownValueSchema.parse(result.cause)),
    ...(result.retryInspectionFailure
      ? [`Retry cleanup inspection failed: ${result.retryInspectionFailure}`]
      : [])
  ].join("\n");

  const execution: SessionCleanupExecution = {
    attemptedAction: result.attempted,
    completedActions: result.completed,
    message,
    outcome: result.outcome === "failed" ? "failed" : "skipped",
    // Nothing took effect before removal planned, so the preview is still what remains.
    remainingActions:
      result.remaining ?? (result.retryObligations ? planned.plannedActions : undefined),
    retryCleanupActions: result.retryObligations,
    sourceRoot: result.current.sourceRoot,
    step: result.current.step
  };

  return {
    globalFailure: result.cause instanceof GlobalCleanupError ? message : null,
    report: createSessionCleanupReport(row, execution, { plannedActions: planned.plannedActions })
  };
}

/** Removal completed, but the global lock or retained state no longer allows continuing. */
function failedReport(
  row: Inventory["sessions"][number],
  planned: SessionReport,
  completedActions: SessionAction[],
  cause: unknown
) {
  const message = errorMessage(ThrownValueSchema.parse(cause));

  return {
    globalFailure: cause instanceof GlobalCleanupError ? message : null,
    report: createSessionCleanupReport(
      row,
      {
        completedActions,
        message,
        outcome: "failed",
        remainingActions: [],
        sourceRoot: row.snapshot.rootSourceRoot ?? "",
        step: "revalidation"
      },
      { plannedActions: planned.plannedActions }
    )
  };
}

function processStop(repo: SessionState["repos"][number]): SessionAction {
  return { sourceRoot: repo.sourceRoot, step: "process-stop", worktreePath: repo.worktreePath };
}

function assertFinalizationReady(runtime: Runtime, home: string, state: SessionState) {
  for (const repo of state.repos) {
    if (inspectSessionRepoRegistration(runtime, home, state, repo).mode !== "gone") {
      throw new MonkeError(`Session member reappeared before finalization: ${repo.worktreePath}`);
    }
  }
}
