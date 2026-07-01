import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { loadResolvedGraph } from "./config.ts";
import {
  inspectMergedWorktreeCleanup,
  removeMergeCleanableWorktree,
  type MergedCleanupDecision,
} from "./cleanup-merged.ts";
import {
  syncRootEnvFile,
  syncRootEnvFileWithRemovals,
  rewriteManagedEnvFiles,
  seedWorktreeFilesFromRoot,
  collectBaselinePortsFromRoot,
} from "./env.ts";
import {
  assertCleanCheckoutForSessionBranchCreation,
  assertFreshSessionWorktreeAvailable,
  ensureSessionWorktree,
  ensureFreshSessionWorktreeFromRef,
  getExpectedWorktreePath,
  removeSessionWorktreeAndBranch,
  resolveDefaultBranchRef,
  resolveRepoContext,
  validateWorktreeForSession,
} from "./git.ts";
import { MonkeError } from "./errors.ts";
import { createLogger } from "./logger.ts";
import { resolveResourceCommands, resolveResourceValues } from "./resources.ts";
import { getMonkeHome, withGlobalLock } from "./runtime.ts";
import { requestShellDirectory } from "./shell.ts";
import {
  allocateLocalPorts,
  ensureSessionPrefix,
  getOrCreateReservation,
  getSessionStateFilePath,
  listSessionStates,
  loadSessionState,
  recordRepoSuccess,
  removeSessionState,
  saveSessionState,
  toAssignedPorts,
} from "./registry.ts";
import type { DefaultBranchRef } from "./git.ts";
import type {
  AssignedPort,
  RepoConfig,
  RepoMaterializationResult,
  ResourceCommandState,
  ResourceValueState,
  Runtime,
  SessionRepoState,
  SessionState,
} from "./types.ts";

const CLEANUP_COMMAND_TIMEOUT_SECONDS = 60;

/** Options controlling how `mt spawn` chooses source content. */
export type SpawnOptions =
  | {
      /** Spawn from the source checkout's current HEAD. */
      mode: "current-head";
      /** Whether dirty source state is copied into newly created Session worktrees. */
      copyDirty: boolean;
    }
  | {
      /** Spawn from each repo's resolved default branch ref. */
      mode: "default-branch";
    };

interface DirtySnapshot {
  stagedPatch: string;
  unstagedPatch: string;
  untrackedPaths: string[];
}

/** Options controlling `mt cleanup` lifecycle behavior. */
export type CleanupOptions =
  | {
      /** Run only default dead Session state cleanup. */
      mode: "dead-only";
    }
  | {
      /** Inspect merge-cleanable Session worktrees before dead-state cleanup. */
      mode: "merged";
      /** Whether to report merge-cleanable decisions without removing worktrees or state. */
      dryRun: boolean;
    };

/** Spawn or refresh a Session from the source checkout. */
export function runSpawn(runtime: Runtime, session: string, options: SpawnOptions): void {
  if (!session) {
    throw new MonkeError("mt spawn requires a session name");
  }

  const home = getMonkeHome(runtime);
  const context = resolveRepoContext(runtime, runtime.cwd, home);
  if (!context.isSourceCheckout) {
    throw new MonkeError("mt spawn must run from the source checkout");
  }

  const rootWorktreePath = withGlobalLock(home, () =>
    spawnSessionFromSourceRootLocked(runtime, home, context.sourceRoot, session, options),
  );

  createLogger(runtime).success(`Spawned or updated session ${session}`);
  requestShellDirectory(runtime, rootWorktreePath);
}

/** Create or refresh a Session while the caller holds the Monke global lock. */
export function spawnSessionFromSourceRootLocked(
  runtime: Runtime,
  home: string,
  rootSourceRoot: string,
  session: string,
  options: SpawnOptions,
): string {
  if (!session) {
    throw new MonkeError("mt spawn requires a session name");
  }

  const rootWorktreePath = getExpectedWorktreePath(home, rootSourceRoot, session);
  const spawnFromDefaultBranch = options.mode === "default-branch";

  if (
    spawnFromDefaultBranch &&
    existsSync(getSessionStateFilePath(home, rootSourceRoot, session))
  ) {
    throw new MonkeError(
      `Session state already exists for "${session}"; default branch spawn mode requires a fresh Session`,
    );
  }

  const defaultRefs = new Map<string, DefaultBranchRef>();
  const getDefaultRef = (sourceRoot: string): DefaultBranchRef => {
    let defaultRef = defaultRefs.get(sourceRoot);
    if (!defaultRef) {
      defaultRef = resolveDefaultBranchRef(runtime, sourceRoot);
      defaultRefs.set(sourceRoot, defaultRef);
    }
    return defaultRef;
  };
  const rootDefaultRef = spawnFromDefaultBranch ? getDefaultRef(rootSourceRoot) : null;
  const rootConfigExists = rootDefaultRef
    ? gitPathExistsAtRef(runtime, rootSourceRoot, rootDefaultRef.ref, "monke.yml")
    : existsSync(path.join(rootSourceRoot, "monke.yml"));
  if (!rootConfigExists) {
    assertNoGlobalWorktreePathStateCollisions(home, session, [{ sourceRoot: rootSourceRoot }]);
    const dirtySnapshot = shouldCopyDirty(options)
      ? captureDirtySnapshot(runtime, rootSourceRoot)
      : null;
    const worktree = rootDefaultRef
      ? ensureFreshSessionWorktreeFromRef(
          runtime,
          home,
          rootSourceRoot,
          session,
          rootDefaultRef.ref,
        )
      : ensureSessionWorktree(runtime, home, rootSourceRoot, session, {
          skipCleanCheck: shouldCopyDirty(options),
        });
    if (dirtySnapshot && worktree.created) {
      applyDirtySnapshot(runtime, rootSourceRoot, worktree.path, dirtySnapshot);
    }
    const sessionState = {
      ...loadSessionState(home, rootSourceRoot, session),
      graphSource: spawnFromDefaultBranch ? ("session-branch" as const) : undefined,
    };
    saveSessionState(
      home,
      recordRepoSuccess(
        sessionState,
        buildSessionRepoState({
          sourceRoot: rootSourceRoot,
          worktreePath: worktree.path,
          assignedPorts: [],
          resourceValues: [],
          resourceCommandOutputs: [],
          isComplete: false,
        }),
      ),
    );
    runtime.writeStderr(
      `Warning: no monke.yml found for ${rootSourceRoot}; spawned session worktree without materializing it.\n`,
    );
    return rootWorktreePath;
  }

  let graph: ReturnType<typeof loadResolvedGraph>;
  if (spawnFromDefaultBranch) {
    graph = loadResolvedGraph(runtime, rootSourceRoot, {
      readRepoConfig(sourceRoot) {
        return readGitPathAtRef(runtime, sourceRoot, getDefaultRef(sourceRoot).ref, "monke.yml");
      },
      pathExists(sourceRoot, relativePath) {
        return gitPathExistsAtRef(runtime, sourceRoot, getDefaultRef(sourceRoot).ref, relativePath);
      },
    });
  } else {
    graph = loadResolvedGraph(runtime, rootSourceRoot);
  }
  if (options.mode === "current-head" && !options.copyDirty) {
    assertCleanCheckoutsForCurrentHeadSpawn(runtime, graph.reposInMaterializationOrder, session);
  }
  const dirtySnapshots = shouldCopyDirty(options)
    ? captureDirtySnapshots(runtime, graph.reposInMaterializationOrder)
    : new Map<string, DirtySnapshot>();
  let sessionState = loadSessionState(home, rootSourceRoot, session);
  if (spawnFromDefaultBranch) {
    sessionState = { ...sessionState, graphSource: "session-branch" };
  } else {
    sessionState = { ...sessionState, graphSource: undefined };
  }
  ensureSessionPrefix(
    sessionState,
    graph.reposInMaterializationOrder.map((repo) => repo.sourceRoot),
  );
  assertUniqueExpectedWorktreePaths(home, session, graph.reposInMaterializationOrder);
  assertNoGlobalWorktreePathStateCollisions(home, session, graph.reposInMaterializationOrder);
  if (spawnFromDefaultBranch) {
    for (const repoConfig of graph.reposInMaterializationOrder) {
      assertFreshSessionWorktreeAvailable(runtime, home, repoConfig.sourceRoot, session);
    }
  }

  const currentRepoRoot = rootSourceRoot;
  const currentIndex = graph.reposInMaterializationOrder.findIndex(
    (repo) => repo.sourceRoot === currentRepoRoot,
  );
  let firstWorkIndex = 0;
  if (!spawnFromDefaultBranch) {
    firstWorkIndex = findFirstIndexNeedingWork(
      runtime,
      home,
      graph.reposInMaterializationOrder,
      sessionState,
      session,
      currentIndex,
    );
  }

  const results = new Map<string, RepoMaterializationResult>();
  const createdDefaultWorktrees: Array<{ sourceRoot: string; worktreePath: string }> = [];
  try {
    for (const [index, repoConfig] of graph.reposInMaterializationOrder.entries()) {
      const existingState = sessionState.repos.find(
        (repo) => repo.sourceRoot === repoConfig.sourceRoot,
      );
      const shouldSkip = index < firstWorkIndex && repoConfig.sourceRoot !== currentRepoRoot;

      if (shouldSkip && existingState) {
        validateWorktreeForSession(
          runtime,
          home,
          repoConfig.sourceRoot,
          existingState.worktreePath,
          session,
        );
        results.set(repoConfig.sourceRoot, {
          state: existingState,
          localAssignments: new Map(
            existingState.assignedPorts.map((entry) => [entry.key, entry.value]),
          ),
        });
        continue;
      }

      let worktree: { path: string; created: boolean };
      if (spawnFromDefaultBranch) {
        worktree = ensureFreshSessionWorktreeFromRef(
          runtime,
          home,
          repoConfig.sourceRoot,
          session,
          getDefaultRef(repoConfig.sourceRoot).ref,
        );
        createdDefaultWorktrees.push({
          sourceRoot: repoConfig.sourceRoot,
          worktreePath: worktree.path,
        });
      } else {
        worktree = ensureSessionWorktree(runtime, home, repoConfig.sourceRoot, session, {
          skipCleanCheck: shouldCopyDirty(options),
        });
        const dirtySnapshot = dirtySnapshots.get(repoConfig.sourceRoot);
        if (dirtySnapshot && worktree.created) {
          applyDirtySnapshot(runtime, repoConfig.sourceRoot, worktree.path, dirtySnapshot);
        }
      }

      const materialized = materializeRepo({
        runtime,
        home,
        rootSourceRoot,
        session,
        repoConfig,
        worktreePath: worktree.path,
        seedMaterialRoot: spawnFromDefaultBranch ? worktree.path : repoConfig.sourceRoot,
        baselinePortsRoot: repoConfig.sourceRoot,
        worktreeCreated: worktree.created,
        existingState,
        dependencyResults: results,
        persistRepoState(repoState) {
          sessionState = recordRepoSuccess(sessionState, repoState);
          saveSessionState(home, sessionState);
        },
      });

      results.set(repoConfig.sourceRoot, materialized);
      sessionState = recordRepoSuccess(sessionState, materialized.state);
      saveSessionState(home, sessionState);
    }
  } catch (error) {
    if (spawnFromDefaultBranch) {
      rollbackDefaultBranchSpawn({
        runtime,
        home,
        rootSourceRoot,
        session,
        createdWorktrees: createdDefaultWorktrees,
      });
    }
    throw error;
  }

  return rootWorktreePath;
}

function shouldCopyDirty(options: SpawnOptions): boolean {
  return options.mode === "current-head" && options.copyDirty;
}

function assertCleanCheckoutsForCurrentHeadSpawn(
  runtime: Runtime,
  reposInOrder: RepoConfig[],
  session: string,
): void {
  for (const repoConfig of reposInOrder) {
    assertCleanCheckoutForSessionBranchCreation(runtime, repoConfig.sourceRoot, session);
  }
}

function captureDirtySnapshots(
  runtime: Runtime,
  reposInOrder: RepoConfig[],
): Map<string, DirtySnapshot> {
  return new Map(
    reposInOrder.map((repoConfig) => [
      repoConfig.sourceRoot,
      captureDirtySnapshot(runtime, repoConfig.sourceRoot),
    ]),
  );
}

function captureDirtySnapshot(runtime: Runtime, sourceRoot: string): DirtySnapshot {
  const untrackedOutput = runGit(runtime, sourceRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);

  return {
    stagedPatch: runGit(runtime, sourceRoot, ["diff", "--cached", "--binary", "--no-ext-diff"]),
    unstagedPatch: runGit(runtime, sourceRoot, ["diff", "--binary", "--no-ext-diff"]),
    untrackedPaths: untrackedOutput.split("\0").filter((entry) => entry.length > 0),
  };
}

function applyDirtySnapshot(
  runtime: Runtime,
  sourceRoot: string,
  worktreePath: string,
  snapshot: DirtySnapshot,
): void {
  applyPatch(runtime, worktreePath, snapshot.stagedPatch);
  applyPatch(runtime, worktreePath, snapshot.unstagedPatch);
  copyUntrackedPaths(sourceRoot, worktreePath, snapshot.untrackedPaths);
}

function applyPatch(runtime: Runtime, worktreePath: string, patch: string): void {
  if (!patch) {
    return;
  }

  runtime.exec("git", ["apply", "--3way"], { cwd: worktreePath, stdin: patch });
}

function copyUntrackedPaths(
  sourceRoot: string,
  worktreePath: string,
  untrackedPaths: string[],
): void {
  for (const relativePath of untrackedPaths) {
    const sourcePath = path.join(sourceRoot, relativePath);
    if (!existsSync(sourcePath)) {
      throw new MonkeError(`Untracked source path disappeared before copy: ${sourcePath}`);
    }

    const targetPath = path.join(worktreePath, relativePath);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    const sourceStat = statSync(sourcePath);
    if (sourceStat.isDirectory()) {
      cpSync(sourcePath, targetPath, { recursive: true });
      continue;
    }

    copyFileSync(sourcePath, targetPath);
  }
}

function rollbackDefaultBranchSpawn(options: {
  runtime: Runtime;
  home: string;
  rootSourceRoot: string;
  session: string;
  createdWorktrees: Array<{ sourceRoot: string; worktreePath: string }>;
}): void {
  let fullyRolledBack = true;
  for (const created of [...options.createdWorktrees].reverse()) {
    const removed = removeSessionWorktreeAndBranch(
      options.runtime,
      created.sourceRoot,
      created.worktreePath,
      options.session,
      (message) => options.runtime.writeStderr(`${message}\n`),
    );
    fullyRolledBack &&= removed;
  }

  if (fullyRolledBack) {
    removeSessionState(options.home, options.rootSourceRoot, options.session);
    return;
  }

  options.runtime.writeStderr(
    `Default branch spawn failed and rollback was incomplete for session "${options.session}"; run mt cleanup after removing leftover worktrees manually.\n`,
  );
}

function assertNoGlobalWorktreePathStateCollisions(
  home: string,
  session: string,
  repoConfigs: Array<{ sourceRoot: string }>,
): void {
  const states = listSessionStates(home);
  for (const repoConfig of repoConfigs) {
    const expectedPath = getExpectedWorktreePath(home, repoConfig.sourceRoot, session);
    const collision = states
      .flatMap((state) => state.repos)
      .find(
        (repoState) =>
          path.normalize(repoState.worktreePath) === path.normalize(expectedPath) &&
          path.normalize(repoState.sourceRoot) !== path.normalize(repoConfig.sourceRoot),
      );

    if (collision) {
      throw new MonkeError(
        `Session worktree path collision at ${expectedPath}; already recorded for ${collision.sourceRoot}. Repo-name/session worktree paths must be unique within MONKE_HOME.`,
      );
    }
  }
}

function loadResolvedGraphForSession(
  runtime: Runtime,
  rootSourceRoot: string,
  sessionState: SessionState,
): ReturnType<typeof loadResolvedGraph> {
  if (sessionState.graphSource !== "session-branch" || sessionState.repos.length === 0) {
    return loadResolvedGraph(runtime, rootSourceRoot);
  }

  const sessionRepoRoots = new Set(sessionState.repos.map((repo) => repo.sourceRoot));
  return loadResolvedGraph(runtime, rootSourceRoot, {
    readRepoConfig(sourceRoot) {
      if (sessionRepoRoots.has(sourceRoot)) {
        return readGitPathAtRef(runtime, sourceRoot, sessionState.session, "monke.yml");
      }
      return readFileSync(path.join(sourceRoot, "monke.yml"), "utf8");
    },
    pathExists(sourceRoot, relativePath) {
      if (sessionRepoRoots.has(sourceRoot)) {
        return gitPathExistsAtRef(runtime, sourceRoot, sessionState.session, relativePath);
      }
      return existsSync(path.join(sourceRoot, relativePath));
    },
  });
}

export function runInstallDependencies(runtime: Runtime): void {
  createLogger(runtime).success("Verified monke-tools runtime dependencies");
}

export function runMaterialize(runtime: Runtime): void {
  const home = getMonkeHome(runtime);
  const context = resolveRepoContext(runtime, runtime.cwd, home);
  if (context.isSourceCheckout) {
    throw new MonkeError("mt materialize must run inside a session worktree");
  }
  if (!context.sessionName) {
    throw new MonkeError("Unable to infer the current session");
  }
  const session = context.sessionName;

  withGlobalLock(home, () => {
    let sessionState = loadSessionState(home, context.sourceRoot, session);
    const graph = loadResolvedGraphForSession(runtime, context.sourceRoot, sessionState);
    ensureSessionPrefix(
      sessionState,
      graph.reposInMaterializationOrder.map((repo) => repo.sourceRoot),
    );

    const currentRepoRoot = context.sourceRoot;
    const results = new Map<string, RepoMaterializationResult>();
    for (const repoConfig of graph.reposInMaterializationOrder) {
      const existingState = sessionState.repos.find(
        (repo) => repo.sourceRoot === repoConfig.sourceRoot,
      );
      const isCurrentRepo = repoConfig.sourceRoot === currentRepoRoot;
      const dependencyWorktree = isCurrentRepo
        ? null
        : ensureSessionWorktree(runtime, home, repoConfig.sourceRoot, session);
      const worktreePath = dependencyWorktree?.path ?? context.worktreeRoot;
      const worktreeCreated = dependencyWorktree?.created ?? false;

      if (isCurrentRepo) {
        validateWorktreeForSession(runtime, home, repoConfig.sourceRoot, worktreePath, session);
      }

      const materialized = materializeRepo({
        runtime,
        home,
        rootSourceRoot: context.sourceRoot,
        session,
        repoConfig,
        worktreePath,
        seedMaterialRoot:
          sessionState.graphSource === "session-branch" ? worktreePath : repoConfig.sourceRoot,
        baselinePortsRoot: repoConfig.sourceRoot,
        worktreeCreated,
        existingState,
        dependencyResults: results,
        persistRepoState(repoState) {
          sessionState = recordRepoSuccess(sessionState, repoState);
          saveSessionState(home, sessionState);
        },
      });

      results.set(repoConfig.sourceRoot, materialized);
      sessionState = recordRepoSuccess(sessionState, materialized.state);
      saveSessionState(home, sessionState);
    }
  });

  createLogger(runtime).success(`Materialized session ${session}`);
}

/** Clean up dead Session state and optionally remove merge-cleanable Session worktrees first. */
export function runCleanup(runtime: Runtime, options: CleanupOptions): void {
  const home = getMonkeHome(runtime);
  const context = resolveRepoContext(runtime, runtime.cwd, home);
  const dryRun = options.mode === "merged" && options.dryRun;

  const mergedResults: MergedCleanupResult[] = [];
  let removedDeadSessions = 0;
  withGlobalLock(home, () => {
    if (options.mode === "merged") {
      mergedResults.push(
        ...cleanupMergedWorktrees(runtime, home, context.sourceRoot, options.dryRun),
      );
    }

    if (!dryRun) {
      removedDeadSessions = removeDeadSessionStates(runtime, home, context.sourceRoot);
    }
  });

  if (options.mode === "merged") {
    writeMergedCleanupSummary(runtime, mergedResults, options.dryRun);
  }

  if (!dryRun) {
    createLogger(runtime).success(
      `Removed ${removedDeadSessions} dead session${removedDeadSessions === 1 ? "" : "s"}`,
    );
  }
}

interface MergedCleanupResult {
  session: string;
  sourceRoot: string;
  worktreePath: string;
  decision: MergedCleanupDecision;
  removed: boolean;
}

function cleanupMergedWorktrees(
  runtime: Runtime,
  home: string,
  rootSourceRoot: string,
  dryRun: boolean,
): MergedCleanupResult[] {
  const results: MergedCleanupResult[] = [];

  for (const state of listSessionStates(home)) {
    if (state.rootSourceRoot !== rootSourceRoot) {
      continue;
    }

    for (const repoState of state.repos) {
      const candidate = {
        sourceRoot: repoState.sourceRoot,
        session: state.session,
        worktreePath: repoState.worktreePath,
      };
      const decision = inspectMergedWorktreeCleanup(runtime, candidate, {
        refreshDefaultBranch: !dryRun,
      });
      let removed = false;

      if (decision.eligible && !dryRun) {
        removeMergeCleanableWorktree(runtime, candidate);
        removed = true;
      }

      results.push({
        session: state.session,
        sourceRoot: repoState.sourceRoot,
        worktreePath: repoState.worktreePath,
        decision,
        removed,
      });
    }
  }

  return results;
}

function removeDeadSessionStates(runtime: Runtime, home: string, rootSourceRoot: string): number {
  let removed = 0;

  for (const state of listSessionStates(home)) {
    if (state.rootSourceRoot !== rootSourceRoot) {
      continue;
    }

    const allGone = state.repos.every((repo) => !existsSync(repo.worktreePath));
    if (!allGone) {
      continue;
    }

    runCleanupCommands(
      runtime,
      loadResolvedGraphForSession(runtime, rootSourceRoot, state).reposByRoot,
      state,
    );
    removeSessionState(home, state.rootSourceRoot, state.session);
    removed += 1;
  }

  return removed;
}

function writeMergedCleanupSummary(
  runtime: Runtime,
  results: MergedCleanupResult[],
  dryRun: boolean,
): void {
  const logger = createLogger(runtime);
  let eligible = 0;
  let skipped = 0;
  let removed = 0;

  for (const result of results) {
    if (result.decision.eligible) {
      eligible += 1;
      if (result.removed) {
        removed += 1;
      }
      logger.info(
        `${dryRun ? "Would remove" : "Removed"} merged worktree ${result.session} ${
          result.sourceRoot
        }: ${result.worktreePath}`,
      );
      continue;
    }

    skipped += 1;
    logger.info(
      `Skipped merged worktree ${result.session} ${result.sourceRoot}: ${result.decision.reasons.join(
        "; ",
      )}`,
    );
  }

  if (dryRun) {
    logger.info(
      `Merged cleanup dry-run: would remove ${formatWorktreeCount(eligible)}, skipped ${formatWorktreeCount(
        skipped,
      )}`,
    );
    return;
  }

  logger.info(
    `Merged cleanup: removed ${formatWorktreeCount(removed)}, skipped ${formatWorktreeCount(
      skipped,
    )}`,
  );
}

function formatWorktreeCount(count: number): string {
  return `${count} worktree${count === 1 ? "" : "s"}`;
}

export function runSetup(runtime: Runtime): void {
  const home = getMonkeHome(runtime);
  const context = resolveRepoContext(runtime, runtime.cwd, home);
  if (!context.isSourceCheckout) {
    throw new MonkeError("mt setup must run from the source checkout");
  }

  const graph = loadResolvedGraph(runtime, context.sourceRoot);
  const repoConfig = graph.reposByRoot.get(context.sourceRoot);
  if (!repoConfig) {
    throw new MonkeError(`Missing repo config for ${context.sourceRoot}`);
  }

  syncRootEnvFile(
    context.sourceRoot,
    repoConfig.externalInOrder.map((externalRepo) => ({
      env: externalRepo.pathEnv,
      value: path.relative(context.sourceRoot, externalRepo.absoluteRepoRoot) || ".",
    })),
  );

  createLogger(runtime).success(`Updated root .env for ${path.basename(context.sourceRoot)}`);
}

function materializeRepo(options: {
  runtime: Runtime;
  home: string;
  rootSourceRoot: string;
  session: string;
  repoConfig: RepoConfig;
  worktreePath: string;
  seedMaterialRoot: string;
  baselinePortsRoot: string;
  worktreeCreated: boolean;
  existingState: SessionRepoState | undefined;
  dependencyResults: Map<string, RepoMaterializationResult>;
  persistRepoState: (repoState: SessionRepoState) => void;
}): RepoMaterializationResult {
  const {
    home,
    rootSourceRoot,
    session,
    repoConfig,
    worktreePath,
    seedMaterialRoot,
    baselinePortsRoot,
    worktreeCreated,
    existingState,
    dependencyResults,
  } = options;

  if (worktreeCreated) {
    seedWorktreeFilesFromRoot({
      config: repoConfig,
      sourceRoot: seedMaterialRoot,
      worktreeRoot: worktreePath,
      onWarning(message) {
        options.runtime.writeStderr(`${message}\n`);
      },
    });
  }

  options.persistRepoState(
    buildSessionRepoState({
      sourceRoot: repoConfig.sourceRoot,
      worktreePath,
      assignedPorts: existingState?.assignedPorts ?? [],
      cleanupCommand: repoConfig.cleanupCommand,
      resourceValues: existingState?.resourceValues ?? [],
      resourceCommandOutputs: existingState?.resourceCommandOutputs ?? [],
      isComplete: false,
    }),
  );

  const resolvedResourceValues = resolveResourceValues({
    home,
    rootSourceRoot,
    session,
    repoConfig,
    existingRepoState: existingState,
    env: options.runtime.env,
  });
  const persistResolvedResourceCommands = (
    resourceCommandOutputs: ResourceCommandState[],
    assignedPorts: AssignedPort[],
  ): void => {
    options.persistRepoState(
      buildSessionRepoState({
        sourceRoot: repoConfig.sourceRoot,
        worktreePath,
        assignedPorts,
        cleanupCommand: repoConfig.cleanupCommand,
        resourceValues: preserveStaleResourceValues(
          existingState?.resourceValues ?? [],
          resolvedResourceValues.values,
        ),
        resourceCommandOutputs,
        isComplete: false,
      }),
    );
  };
  let resolvedResourceCommands: ReturnType<typeof resolveResourceCommands> | undefined;
  if (!repoConfig.bootstrapCommand) {
    resolvedResourceCommands = resolveResourceCommands({
      runtime: options.runtime,
      home,
      session,
      repoConfig,
      existingRepoState: existingState,
      worktreePath,
      resourceValues: resolvedResourceValues.values,
      onResolvedCommandOutputs(resourceCommandOutputs) {
        persistResolvedResourceCommands(resourceCommandOutputs, existingState?.assignedPorts ?? []);
      },
    });
  }
  const reservation = getOrCreateReservation(
    home,
    repoConfig.sourceRoot,
    repoConfig.localPortOrder.length,
  );
  const baselinePorts = collectBaselinePortsFromRoot({
    config: repoConfig,
    sourceRoot: baselinePortsRoot,
  });
  const localAssignments = allocateLocalPorts({
    home,
    rootSourceRoot,
    session,
    repoConfig,
    existingRepoState: existingState,
    reservation,
    baselinePorts,
  });

  const externalAssignments = resolveExternalAssignments(repoConfig, dependencyResults);
  const externalPathAssignments = resolveExternalPathAssignments(
    repoConfig,
    worktreePath,
    dependencyResults,
  );
  rewriteManagedEnvFiles(repoConfig, worktreePath, localAssignments, externalAssignments);
  const localAssignedPorts = toAssignedPorts(repoConfig, localAssignments);
  const rootEnvAssignmentsBeforeCommands = [
    ...externalPathAssignments,
    ...toRootEnvAssignments(localAssignedPorts),
    ...toRootEnvAssignments(dedupeAssignedPorts(externalAssignments)),
    ...toResourceEnvAssignments(resolvedResourceValues.values),
  ];
  const existingResourceCommandEnvNames = toResourceCommandEnvNames(
    existingState?.resourceCommandOutputs ?? [],
  );

  if (repoConfig.bootstrapCommand) {
    syncRootEnvFileWithRemovals(worktreePath, rootEnvAssignmentsBeforeCommands, [
      ...resolvedResourceValues.removedEnvNames,
      ...existingResourceCommandEnvNames,
    ]);
    options.persistRepoState(
      buildSessionRepoState({
        sourceRoot: repoConfig.sourceRoot,
        worktreePath,
        assignedPorts: localAssignedPorts,
        cleanupCommand: repoConfig.cleanupCommand,
        resourceValues: preserveStaleResourceValues(
          existingState?.resourceValues ?? [],
          resolvedResourceValues.values,
        ),
        resourceCommandOutputs: existingState?.resourceCommandOutputs ?? [],
        isComplete: false,
      }),
    );
    runBootstrapCommand(options.runtime, repoConfig, worktreePath, externalPathAssignments);
    resolvedResourceCommands = resolveResourceCommands({
      runtime: options.runtime,
      home,
      session,
      repoConfig,
      existingRepoState: existingState,
      worktreePath,
      resourceValues: resolvedResourceValues.values,
      onResolvedCommandOutputs(resourceCommandOutputs) {
        persistResolvedResourceCommands(resourceCommandOutputs, localAssignedPorts);
      },
    });
  }

  if (!resolvedResourceCommands) {
    throw new MonkeError(`Resource commands were not resolved for ${repoConfig.sourceRoot}`);
  }

  syncRootEnvFileWithRemovals(
    worktreePath,
    [
      ...rootEnvAssignmentsBeforeCommands,
      ...toResourceCommandEnvAssignments(resolvedResourceCommands.commands),
    ],
    [...resolvedResourceValues.removedEnvNames, ...resolvedResourceCommands.removedEnvNames],
  );
  if (!repoConfig.bootstrapCommand) {
    runBootstrapCommand(options.runtime, repoConfig, worktreePath, externalPathAssignments);
  }

  return {
    state: buildSessionRepoState({
      sourceRoot: repoConfig.sourceRoot,
      worktreePath,
      assignedPorts: localAssignedPorts,
      cleanupCommand: repoConfig.cleanupCommand,
      resourceValues: resolvedResourceValues.values,
      resourceCommandOutputs: resolvedResourceCommands.commands,
      isComplete: true,
    }),
    localAssignments,
  };
}

function resolveExternalAssignments(
  repoConfig: RepoConfig,
  dependencyResults: Map<string, RepoMaterializationResult>,
): AssignedPort[] {
  const assignments: AssignedPort[] = [];
  for (const externalRepo of repoConfig.externalInOrder) {
    const dependency = dependencyResults.get(externalRepo.absoluteRepoRoot);
    if (!dependency) {
      throw new MonkeError(
        `Missing dependency materialization result for ${externalRepo.absoluteRepoRoot}`,
      );
    }

    for (const mapping of externalRepo.mappings) {
      const value = dependency.localAssignments.get(mapping.portKey);
      if (value === undefined) {
        throw new MonkeError(
          `Dependency ${externalRepo.absoluteRepoRoot} did not materialize local port ${mapping.portKey}`,
        );
      }
      assignments.push({ key: mapping.portKey, value });
    }
  }
  return assignments;
}

function resolveExternalPathAssignments(
  repoConfig: RepoConfig,
  worktreePath: string,
  dependencyResults: Map<string, RepoMaterializationResult>,
): Array<{ env: string; value: string }> {
  return repoConfig.externalInOrder.map((externalRepo) => {
    const dependency = dependencyResults.get(externalRepo.absoluteRepoRoot);
    if (!dependency) {
      throw new MonkeError(
        `Missing dependency materialization result for ${externalRepo.absoluteRepoRoot}`,
      );
    }

    const relativePath = path.relative(worktreePath, dependency.state.worktreePath) || ".";
    return {
      env: externalRepo.pathEnv,
      value: relativePath,
    };
  });
}

function toRootEnvAssignments(assignments: AssignedPort[]): Array<{ env: string; value: string }> {
  return assignments.map((assignment) => ({
    env: assignment.key,
    value: String(assignment.value),
  }));
}

function dedupeAssignedPorts(assignments: AssignedPort[]): AssignedPort[] {
  const deduped = new Map<string, AssignedPort>();
  for (const assignment of assignments) {
    deduped.set(assignment.key, assignment);
  }
  return [...deduped.values()];
}

function toResourceEnvAssignments(
  assignments: ResourceValueState[],
): Array<{ env: string; value: string }> {
  return assignments.map((assignment) => ({
    env: assignment.env,
    value: assignment.value,
  }));
}

function toResourceCommandEnvAssignments(
  commands: ResourceCommandState[],
): Array<{ env: string; value: string }> {
  return commands.flatMap((command) =>
    command.outputs.map((assignment) => ({
      env: assignment.env,
      value: assignment.value,
    })),
  );
}

function toResourceCommandEnvNames(commands: ResourceCommandState[]): string[] {
  return [...new Set(commands.flatMap((command) => command.outputs.map((output) => output.env)))];
}

function buildSessionRepoState(options: {
  sourceRoot: string;
  worktreePath: string;
  assignedPorts: AssignedPort[];
  cleanupCommand?: string;
  resourceValues: ResourceValueState[];
  resourceCommandOutputs: ResourceCommandState[];
  isComplete: boolean;
}): SessionRepoState {
  const state: SessionRepoState = {
    sourceRoot: options.sourceRoot,
    worktreePath: options.worktreePath,
    assignedPorts: options.assignedPorts,
  };

  if (options.cleanupCommand) {
    state.cleanupCommand = options.cleanupCommand;
  }

  if (options.resourceValues.length > 0) {
    state.resourceValues = options.resourceValues;
  }

  if (options.resourceCommandOutputs.length > 0) {
    state.resourceCommandOutputs = options.resourceCommandOutputs;
  }

  if (!options.isComplete) {
    state.materializationComplete = false;
  }

  return state;
}

function preserveStaleResourceValues(
  existingValues: ResourceValueState[],
  currentValues: ResourceValueState[],
): ResourceValueState[] {
  const currentEnvNames = new Set(currentValues.map((resource) => resource.env));
  return [
    ...currentValues,
    ...existingValues.filter((resource) => !currentEnvNames.has(resource.env)),
  ];
}

function runCleanupCommands(
  runtime: Runtime,
  reposByRoot: Map<string, RepoConfig>,
  state: SessionState,
): void {
  for (const repoState of state.repos) {
    const repoConfig = reposByRoot.get(repoState.sourceRoot);
    const cleanupCommand = repoState.cleanupCommand ?? repoConfig?.cleanupCommand;
    if (!cleanupCommand) {
      continue;
    }
    const sourceRoot = repoConfig?.sourceRoot ?? repoState.sourceRoot;

    const resourceEnv = Object.fromEntries(
      (repoState.resourceValues ?? []).map((resource) => [resource.env, resource.value]),
    );
    const resourceCommandEnv = Object.fromEntries(
      (repoState.resourceCommandOutputs ?? []).flatMap((command) =>
        command.outputs.map((resource) => [resource.env, resource.value]),
      ),
    );

    try {
      runtime.exec("sh", ["-c", cleanupCommand], {
        cwd: sourceRoot,
        timeoutSeconds: CLEANUP_COMMAND_TIMEOUT_SECONDS,
        env: {
          ...resourceEnv,
          ...resourceCommandEnv,
          MONKE_SESSION: state.session,
          MONKE_SOURCE_ROOT: sourceRoot,
          MONKE_WORKTREE_PATH: repoState.worktreePath,
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new MonkeError(
        `Cleanup command failed for session ${state.session} repo ${sourceRoot}: ${cleanupCommand}\n${detail}`,
      );
    }
  }
}

function runBootstrapCommand(
  runtime: Runtime,
  repoConfig: RepoConfig,
  worktreePath: string,
  externalPathAssignments: Array<{ env: string; value: string }>,
): void {
  if (!repoConfig.bootstrapCommand) {
    return;
  }

  try {
    runtime.exec("sh", ["-c", repoConfig.bootstrapCommand], {
      cwd: worktreePath,
      env: Object.fromEntries(
        externalPathAssignments.map((assignment) => [assignment.env, assignment.value]),
      ),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MonkeError(
      `Bootstrap command failed for ${repoConfig.sourceRoot}: ${repoConfig.bootstrapCommand}\n${detail}`,
    );
  }
}

function assertUniqueExpectedWorktreePaths(
  home: string,
  session: string,
  reposInOrder: RepoConfig[],
): void {
  const ownerByPath = new Map<string, string>();
  for (const repoConfig of reposInOrder) {
    const expectedPath = getExpectedWorktreePath(home, repoConfig.sourceRoot, session);
    const normalizedPath = path.normalize(expectedPath);
    const existingOwner = ownerByPath.get(normalizedPath);
    if (existingOwner) {
      throw new MonkeError(
        `Session worktree path collision at ${expectedPath}: ${existingOwner} and ${repoConfig.sourceRoot} both resolve to ${path.basename(repoConfig.sourceRoot)}/${session}`,
      );
    }
    ownerByPath.set(normalizedPath, repoConfig.sourceRoot);
  }
}

function readGitPathAtRef(
  runtime: Runtime,
  sourceRoot: string,
  ref: string,
  relativePath: string,
): string {
  return runtime.exec("git", ["show", `${ref}:${relativePath}`], { cwd: sourceRoot }).stdout;
}

function runGit(runtime: Runtime, cwd: string, args: string[]): string {
  return runtime.exec("git", args, { cwd }).stdout;
}

function gitPathExistsAtRef(
  runtime: Runtime,
  sourceRoot: string,
  ref: string,
  relativePath: string,
): boolean {
  const result = runtime.exec("git", ["cat-file", "-e", `${ref}:${relativePath}`], {
    cwd: sourceRoot,
    allowFailure: true,
  });
  return result.exitCode === 0;
}

function findFirstIndexNeedingWork(
  runtime: Runtime,
  home: string,
  reposInOrder: RepoConfig[],
  state: SessionState,
  session: string,
  currentRepoIndex: number,
): number {
  for (let index = 0; index < currentRepoIndex; index += 1) {
    const repoConfig = reposInOrder[index]!;
    const existing = state.repos.find((repo) => repo.sourceRoot === repoConfig.sourceRoot);
    if (!existing) {
      return index;
    }

    if (existing.materializationComplete === false) {
      return index;
    }

    if (!existsSync(existing.worktreePath)) {
      return index;
    }

    const expectedPath = getExpectedWorktreePath(home, repoConfig.sourceRoot, session);
    if (path.normalize(existing.worktreePath) !== path.normalize(expectedPath)) {
      throw new MonkeError(
        `Session ${session} recorded ${existing.worktreePath} for ${repoConfig.sourceRoot}, expected ${expectedPath}`,
      );
    }

    validateWorktreeForSession(
      runtime,
      home,
      repoConfig.sourceRoot,
      existing.worktreePath,
      session,
    );
  }

  return currentRepoIndex;
}
