import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync
} from "node:fs";
import path from "node:path";

import {
  createMergedCleanupLookupCache,
  inspectMergedWorktreeCleanup,
  removeMergeCleanableWorktree
} from "./cleanup-merged.ts";
import type { MergedCleanupDecision } from "./cleanup-merged.ts";
import { openCodexWorkspace } from "./codex.ts";
import { reconcileCodiff } from "./codiff.ts";
import { loadResolvedGraph } from "./config.ts";
import {
  syncRootEnvFile,
  syncRootEnvFileWithRemovals,
  rewriteManagedEnvFiles,
  seedWorktreeFiles,
  collectBaselinePortsFromRoot
} from "./env.ts";
import { errorMessage, MonkeError } from "./errors.ts";
import {
  assertCleanCheckoutForSessionBranchCreation,
  assertFreshSessionWorktreeAvailable,
  branchExists,
  ensureCleanCheckout,
  ensureSessionWorktree,
  ensureFreshSessionWorktreeFromRef,
  getExpectedWorktreePath,
  removeSessionWorktreeAndBranch,
  resolveDefaultBranchRef,
  resolveRepoContext,
  validateWorktreeForSession
} from "./git.ts";
import type { DefaultBranchRef } from "./git.ts";
import { createLogger } from "./logger.ts";
import { samePath } from "./path-identity.ts";
import { resolveResourceCommands, resolveResourceValues } from "./resources.ts";
import { getMonkeHome, withGlobalLock } from "./runtime.ts";
import { finalizeSession } from "./session-finalization.ts";
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
  toAssignedPorts
} from "./session-state-store.ts";
import { requestShellDirectory } from "./shell.ts";
import type {
  AssignedPort,
  RepoConfig,
  RepoMaterializationResult,
  ResourceCommandState,
  ResourceValueState,
  Runtime,
  SessionRepoState,
  SessionState
} from "./types.ts";

/** Options controlling how `mt spawn` chooses source content. */
export type SpawnOptions =
  | {
      /** Whether dirty source state is copied into newly created Session worktrees. */
      copyDirty: boolean;
      /** Spawn from the source checkout's current HEAD. */
      mode: "current-head";
    }
  | {
      /** Spawn from an existing branch named after the Session. */
      mode: "session-branch";
    }
  | {
      /** Spawn from each repo's resolved default branch ref. */
      mode: "default-branch";
    };

export interface SpawnRunOptions {
  /** Open the root Session worktree in Codex after it is ready. */
  codex?: boolean;
}

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
      /** Whether to report merge-cleanable decisions without removing worktrees or state. */
      dryRun: boolean;
      /** Inspect merge-cleanable Session worktrees before dead-state cleanup. */
      mode: "merged";
    };

/** Spawn or refresh a Session from the source checkout. */
export function runSpawn(
  runtime: Runtime,
  session: string,
  options: SpawnOptions,
  runOptions: SpawnRunOptions = {}
) {
  if (!session) {
    throw new MonkeError("mt spawn requires a session name");
  }

  const home = getMonkeHome(runtime);
  const context = resolveRepoContext(runtime, runtime.cwd, home);
  if (!context.isSourceCheckout) {
    throw new MonkeError("mt spawn must run from the source checkout");
  }

  const rootWorktreePath = withGlobalLock(home, () =>
    spawnSessionFromSourceRootLocked(runtime, home, context.sourceRoot, session, options)
  );

  createLogger(runtime).success(`Spawned or updated session ${session}`);
  requestShellDirectory(runtime, rootWorktreePath);
  if (runOptions.codex === true) {
    openCodexWorkspace(runtime, rootWorktreePath);
  }
}

/** Create or refresh a Session while the caller holds the Monke global lock. */
export function spawnSessionFromSourceRootLocked(
  runtime: Runtime,
  home: string,
  rootSourceRoot: string,
  session: string,
  options: SpawnOptions
) {
  assertSpawnRequest(runtime, home, rootSourceRoot, session, options);
  const rootWorktreePath = getExpectedWorktreePath(home, rootSourceRoot, session);
  const spawnFromDefaultBranch = options.mode === "default-branch";
  const spawnFromSessionBranch = options.mode === "session-branch";
  const getDefaultRef = createDefaultRefResolver(runtime);
  const rootDefaultRef = spawnFromDefaultBranch ? getDefaultRef(rootSourceRoot) : null;
  const rootConfigExists = spawnRootConfigExists(
    runtime,
    rootSourceRoot,
    session,
    rootDefaultRef,
    spawnFromSessionBranch
  );
  if (!rootConfigExists) {
    return spawnWithoutConfig(runtime, home, rootSourceRoot, session, options, rootDefaultRef);
  }

  const graph = loadSpawnGraph(runtime, rootSourceRoot, session, options, getDefaultRef);
  const currentRepoRoot = rootSourceRoot;
  const prepared = prepareSpawnMaterialization(
    runtime,
    home,
    rootSourceRoot,
    session,
    options,
    graph.reposInMaterializationOrder
  );
  const { dirtySnapshots, firstWorkIndex } = prepared;
  let { sessionState } = prepared;

  const results = new Map<string, RepoMaterializationResult>();
  const createdDefaultWorktrees: { sourceRoot: string; worktreePath: string }[] = [];
  const persistRepoState = (repoState: SessionRepoState) => {
    sessionState = recordRepoSuccess(sessionState, repoState);
    saveSessionState(home, sessionState);
  };
  try {
    for (const [index, repoConfig] of graph.reposInMaterializationOrder.entries()) {
      const existingState = sessionState.repos.find(
        (repo) => repo.sourceRoot === repoConfig.sourceRoot
      );
      const shouldSkip = index < firstWorkIndex && repoConfig.sourceRoot !== currentRepoRoot;

      if (shouldSkip && existingState) {
        const dirtySnapshot = dirtySnapshots.get(repoConfig.sourceRoot);
        if (dirtySnapshot && dirtySnapshotHasContent(dirtySnapshot)) {
          warnDirtyStateNotCarried(runtime, repoConfig.sourceRoot, session);
        }
        validateWorktreeForSession(
          runtime,
          home,
          repoConfig.sourceRoot,
          existingState.worktreePath,
          session
        );
        results.set(repoConfig.sourceRoot, {
          localAssignments: new Map(
            existingState.assignedPorts.map((entry) => [entry.key, entry.value])
          ),
          state: existingState
        });
        continue;
      }

      const { createdDiffBaseRef, createdFromDefault, isSessionBranchRoot, worktree } =
        ensureSpawnWorktree({
          dirtySnapshot: dirtySnapshots.get(repoConfig.sourceRoot),
          getDefaultRef,
          home,
          options,
          repoConfig,
          rootSourceRoot,
          runtime,
          session
        });
      if (createdFromDefault) {
        createdDefaultWorktrees.push({
          sourceRoot: repoConfig.sourceRoot,
          worktreePath: worktree.path
        });
      }

      const materialized = materializeRepo({
        baselinePortsRoot: isSessionBranchRoot ? worktree.path : repoConfig.sourceRoot,
        dependencyResults: results,
        diffBaseRef: existingState?.diffBaseRef ?? createdDiffBaseRef,
        existingState,
        home,
        persistRepoState,
        repoConfig,
        rootSourceRoot,
        runtime,
        session,
        worktreeCreated: worktree.created,
        worktreePath: worktree.path
      });

      results.set(repoConfig.sourceRoot, materialized);
      sessionState = recordRepoSuccess(sessionState, materialized.state);
      saveSessionState(home, sessionState);
    }
  } catch (error) {
    if (spawnFromDefaultBranch) {
      rollbackDefaultBranchSpawn({
        createdWorktrees: createdDefaultWorktrees,
        home,
        rootSourceRoot,
        runtime,
        session
      });
    }
    throw error;
  }

  return rootWorktreePath;
}

function ensureSpawnWorktree(options: {
  dirtySnapshot?: DirtySnapshot;
  getDefaultRef: (sourceRoot: string) => DefaultBranchRef;
  home: string;
  options: SpawnOptions;
  repoConfig: RepoConfig;
  rootSourceRoot: string;
  runtime: Runtime;
  session: string;
}) {
  const { home, repoConfig, rootSourceRoot, runtime, session } = options;
  const isSessionBranchRoot =
    options.options.mode === "session-branch" && repoConfig.sourceRoot === rootSourceRoot;
  if (options.options.mode === "default-branch") {
    const defaultRef = options.getDefaultRef(repoConfig.sourceRoot).ref;
    return {
      createdDiffBaseRef: defaultRef,
      createdFromDefault: true,
      isSessionBranchRoot,
      worktree: ensureFreshSessionWorktreeFromRef(
        runtime,
        home,
        repoConfig.sourceRoot,
        session,
        defaultRef
      )
    };
  }

  const sessionBranchExisted = branchExists(runtime, repoConfig.sourceRoot, session);
  const sourceHeadRef = resolveAttachedHeadRef(runtime, repoConfig.sourceRoot);
  const worktree = ensureSessionWorktree(runtime, home, repoConfig.sourceRoot, session, {
    skipCleanCheck: shouldCopyDirty(options.options)
  });
  if (options.dirtySnapshot && worktree.created) {
    applyDirtySnapshot(runtime, repoConfig.sourceRoot, worktree.path, options.dirtySnapshot);
  } else if (options.dirtySnapshot && dirtySnapshotHasContent(options.dirtySnapshot)) {
    warnDirtyStateNotCarried(runtime, repoConfig.sourceRoot, session);
  }
  return {
    createdDiffBaseRef:
      options.options.mode === "current-head" &&
      worktree.created &&
      !sessionBranchExisted &&
      sourceHeadRef !== undefined
        ? sourceHeadRef
        : undefined,
    createdFromDefault: false,
    isSessionBranchRoot,
    worktree
  };
}

function assertSpawnRequest(
  runtime: Runtime,
  home: string,
  rootSourceRoot: string,
  session: string,
  options: SpawnOptions
) {
  if (session === "") {
    throw new MonkeError("mt spawn requires a session name");
  }
  if (
    options.mode === "default-branch" &&
    existsSync(getSessionStateFilePath(home, rootSourceRoot, session))
  ) {
    throw new MonkeError(
      `Session state already exists for "${session}"; default branch spawn mode requires a fresh Session`
    );
  }
  if (options.mode === "session-branch" && !branchExists(runtime, rootSourceRoot, session)) {
    throw new MonkeError(
      `Session branch "${session}" does not exist for ${rootSourceRoot}; cannot spawn from it`
    );
  }
}

function createDefaultRefResolver(runtime: Runtime): (sourceRoot: string) => DefaultBranchRef {
  const defaultRefs = new Map<string, DefaultBranchRef>();
  return (sourceRoot) => {
    const cached = defaultRefs.get(sourceRoot);
    if (cached !== undefined) {
      return cached;
    }
    const resolved = resolveDefaultBranchRef(runtime, sourceRoot);
    defaultRefs.set(sourceRoot, resolved);
    return resolved;
  };
}

function spawnRootConfigExists(
  runtime: Runtime,
  rootSourceRoot: string,
  session: string,
  rootDefaultRef: DefaultBranchRef | null,
  spawnFromSessionBranch: boolean
) {
  if (rootDefaultRef !== null) {
    return gitPathExistsAtRef(runtime, rootSourceRoot, rootDefaultRef.ref, "monke.yml");
  }
  if (spawnFromSessionBranch) {
    return gitPathExistsAtRef(runtime, rootSourceRoot, session, "monke.yml");
  }
  return existsSync(path.join(rootSourceRoot, "monke.yml"));
}

function spawnWithoutConfig(
  runtime: Runtime,
  home: string,
  rootSourceRoot: string,
  session: string,
  options: SpawnOptions,
  rootDefaultRef: DefaultBranchRef | null
) {
  assertNoGlobalWorktreePathStateCollisions(home, session, [{ sourceRoot: rootSourceRoot }]);
  const priorSessionState = loadSessionState(home, rootSourceRoot, session);
  const existingRepoState = priorSessionState.repos.find(
    (repo) => repo.sourceRoot === rootSourceRoot
  );
  const sessionBranchExisted = branchExists(runtime, rootSourceRoot, session);
  if (options.mode === "current-head" && !options.copyDirty) {
    ensureCleanCheckout(runtime, rootSourceRoot);
  }
  const dirtySnapshot = shouldCopyDirty(options)
    ? captureDirtySnapshot(runtime, rootSourceRoot)
    : null;
  if (dirtySnapshot !== null) {
    assertDirtyCarryBoundary(runtime, home, rootSourceRoot, session, dirtySnapshot);
  }
  const worktree =
    rootDefaultRef === null
      ? ensureSessionWorktree(runtime, home, rootSourceRoot, session, {
          skipCleanCheck: shouldCopyDirty(options)
        })
      : ensureFreshSessionWorktreeFromRef(
          runtime,
          home,
          rootSourceRoot,
          session,
          rootDefaultRef.ref
        );
  const sourceHeadRef = resolveAttachedHeadRef(runtime, rootSourceRoot);
  const diffBaseRef =
    existingRepoState?.diffBaseRef ??
    rootDefaultRef?.ref ??
    (worktree.created &&
    !sessionBranchExisted &&
    sourceHeadRef !== undefined &&
    options.mode === "current-head"
      ? sourceHeadRef
      : undefined);
  if (dirtySnapshot !== null && worktree.created) {
    applyDirtySnapshot(runtime, rootSourceRoot, worktree.path, dirtySnapshot);
  } else if (dirtySnapshot !== null && dirtySnapshotHasContent(dirtySnapshot)) {
    warnDirtyStateNotCarried(runtime, rootSourceRoot, session);
  }
  const sessionState = {
    ...priorSessionState,
    graphSource: options.mode === "current-head" ? undefined : ("session-branch" as const)
  };
  saveSessionState(
    home,
    recordRepoSuccess(
      sessionState,
      buildSessionRepoState({
        assignedPorts: [],
        diffBaseRef,
        isComplete: false,
        resourceCommandOutputs: [],
        resourceValues: [],
        sourceRoot: rootSourceRoot,
        worktreePath: worktree.path
      })
    )
  );
  runtime.writeStderr(
    `Warning: no monke.yml found for ${rootSourceRoot}; spawned session worktree without materializing it.\n`
  );
  return getExpectedWorktreePath(home, rootSourceRoot, session);
}

function loadSpawnGraph(
  runtime: Runtime,
  rootSourceRoot: string,
  session: string,
  options: SpawnOptions,
  getDefaultRef: (sourceRoot: string) => DefaultBranchRef
) {
  if (options.mode === "default-branch") {
    return loadResolvedGraph(runtime, rootSourceRoot, {
      pathExists(sourceRoot, relativePath) {
        return gitPathExistsAtRef(runtime, sourceRoot, getDefaultRef(sourceRoot).ref, relativePath);
      },
      readRepoConfig(sourceRoot) {
        return readGitPathAtRef(runtime, sourceRoot, getDefaultRef(sourceRoot).ref, "monke.yml");
      }
    });
  }
  if (options.mode === "session-branch") {
    return loadResolvedGraph(runtime, rootSourceRoot, {
      pathExists(sourceRoot, relativePath) {
        return sourceRoot === rootSourceRoot
          ? gitPathExistsAtRef(runtime, sourceRoot, session, relativePath)
          : existsSync(path.join(sourceRoot, relativePath));
      },
      readRepoConfig(sourceRoot) {
        return sourceRoot === rootSourceRoot
          ? readGitPathAtRef(runtime, sourceRoot, session, "monke.yml")
          : readFileSync(path.join(sourceRoot, "monke.yml"), "utf-8");
      }
    });
  }
  return loadResolvedGraph(runtime, rootSourceRoot);
}

function prepareSpawnMaterialization(
  runtime: Runtime,
  home: string,
  rootSourceRoot: string,
  session: string,
  options: SpawnOptions,
  reposInOrder: RepoConfig[]
) {
  if (options.mode === "current-head" && !options.copyDirty) {
    assertCleanCheckoutsForCurrentHeadSpawn(runtime, reposInOrder, session);
  }
  const dirtySnapshots = shouldCopyDirty(options)
    ? captureDirtySnapshots(runtime, reposInOrder)
    : new Map<string, DirtySnapshot>();
  for (const [sourceRoot, dirtySnapshot] of dirtySnapshots) {
    assertDirtyCarryBoundary(runtime, home, sourceRoot, session, dirtySnapshot);
  }

  const sessionState = loadSessionState(home, rootSourceRoot, session);
  sessionState.graphSource = options.mode === "current-head" ? undefined : "session-branch";
  ensureSessionPrefix(
    sessionState,
    reposInOrder.map((repo) => repo.sourceRoot)
  );
  assertUniqueExpectedWorktreePaths(home, session, reposInOrder);
  assertNoGlobalWorktreePathStateCollisions(home, session, reposInOrder);
  if (options.mode === "default-branch") {
    for (const repoConfig of reposInOrder) {
      assertFreshSessionWorktreeAvailable(runtime, home, repoConfig.sourceRoot, session);
    }
  }

  const currentIndex = reposInOrder.findIndex((repo) => repo.sourceRoot === rootSourceRoot);
  const firstWorkIndex =
    options.mode === "default-branch"
      ? 0
      : findFirstIndexNeedingWork(runtime, home, reposInOrder, sessionState, session, currentIndex);
  return { dirtySnapshots, firstWorkIndex, sessionState };
}

function shouldCopyDirty(options: SpawnOptions) {
  return options.mode === "current-head" && options.copyDirty;
}

function assertCleanCheckoutsForCurrentHeadSpawn(
  runtime: Runtime,
  reposInOrder: RepoConfig[],
  session: string
) {
  for (const repoConfig of reposInOrder) {
    assertCleanCheckoutForSessionBranchCreation(runtime, repoConfig.sourceRoot, session);
  }
}

function captureDirtySnapshots(runtime: Runtime, reposInOrder: RepoConfig[]) {
  return new Map(
    reposInOrder.map((repoConfig) => [
      repoConfig.sourceRoot,
      captureDirtySnapshot(runtime, repoConfig.sourceRoot)
    ])
  );
}

function captureDirtySnapshot(runtime: Runtime, sourceRoot: string) {
  const untrackedOutput = runGit(runtime, sourceRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z"
  ]);

  return {
    stagedPatch: runGit(runtime, sourceRoot, ["diff", "--cached", "--binary", "--no-ext-diff"]),
    unstagedPatch: runGit(runtime, sourceRoot, ["diff", "--binary", "--no-ext-diff"]),
    untrackedPaths: untrackedOutput.split("\0").filter((entry) => entry.length > 0)
  };
}

function dirtySnapshotHasContent(snapshot: DirtySnapshot) {
  return (
    snapshot.stagedPatch.length > 0 ||
    snapshot.unstagedPatch.length > 0 ||
    snapshot.untrackedPaths.length > 0
  );
}

/** Refuse dirty carry when it would apply HEAD-relative patches onto a diverged Session branch. */
function assertDirtyCarryBoundary(
  runtime: Runtime,
  home: string,
  sourceRoot: string,
  session: string,
  snapshot: DirtySnapshot
) {
  if (!dirtySnapshotHasContent(snapshot) || !branchExists(runtime, sourceRoot, session)) {
    return;
  }

  if (existsSync(getExpectedWorktreePath(home, sourceRoot, session))) {
    return;
  }

  const branchTip = runGit(runtime, sourceRoot, ["rev-parse", `refs/heads/${session}`]).trim();
  const headTip = runGit(runtime, sourceRoot, ["rev-parse", "HEAD"]).trim();
  if (branchTip !== headTip) {
    throw new MonkeError(
      `Session branch "${session}" already exists at ${branchTip.slice(0, 8)} but the Source checkout HEAD is ${headTip.slice(0, 8)}; carrying dirty changes onto a diverged branch is unsafe. Re-run with --no-dirty, or align the branch with HEAD first.`
    );
  }
}

function warnDirtyStateNotCarried(runtime: Runtime, sourceRoot: string, session: string) {
  runtime.writeStderr(
    `Warning: Session worktree for ${session} at ${sourceRoot} already exists; dirty Source checkout changes were not carried into it.\n`
  );
}

function applyDirtySnapshot(
  runtime: Runtime,
  sourceRoot: string,
  worktreePath: string,
  snapshot: DirtySnapshot
) {
  applyPatch(runtime, worktreePath, snapshot.stagedPatch);
  applyPatch(runtime, worktreePath, snapshot.unstagedPatch);
  copyUntrackedPaths(sourceRoot, worktreePath, snapshot.untrackedPaths);
}

function applyPatch(runtime: Runtime, worktreePath: string, patch: string) {
  if (!patch) {
    return;
  }

  runtime.exec("git", ["apply", "--3way"], { cwd: worktreePath, stdin: patch });
}

function copyUntrackedPaths(sourceRoot: string, worktreePath: string, untrackedPaths: string[]) {
  for (const relativePath of untrackedPaths) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const sourceStat = lstatSync(sourcePath, { throwIfNoEntry: false });
    if (!sourceStat) {
      throw new MonkeError(`Untracked source path disappeared before copy: ${sourcePath}`);
    }

    const targetPath = path.join(worktreePath, relativePath);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    if (lstatSync(targetPath, { throwIfNoEntry: false })) {
      throw new MonkeError(
        `Refusing to overwrite existing path in new Session worktree: ${targetPath} (source untracked file ${relativePath}). The Session branch already contains this path.`
      );
    }

    if (sourceStat.isSymbolicLink()) {
      symlinkSync(readlinkSync(sourcePath), targetPath);
      continue;
    }

    if (sourceStat.isDirectory()) {
      cpSync(sourcePath, targetPath, { dereference: false, recursive: true });
      continue;
    }

    copyFileSync(sourcePath, targetPath);
  }
}

function rollbackDefaultBranchSpawn(options: {
  createdWorktrees: { sourceRoot: string; worktreePath: string }[];
  home: string;
  rootSourceRoot: string;
  runtime: Runtime;
  session: string;
}) {
  let fullyRolledBack = true;
  for (const created of [...options.createdWorktrees].toReversed()) {
    const removed = removeSessionWorktreeAndBranch(
      options.runtime,
      created.sourceRoot,
      created.worktreePath,
      options.session,
      (message) => {
        options.runtime.writeStderr(`${message}\n`);
      }
    );
    fullyRolledBack &&= removed;
  }

  if (fullyRolledBack) {
    removeSessionState(options.home, options.rootSourceRoot, options.session);
    return;
  }

  options.runtime.writeStderr(
    `Default branch spawn failed and rollback was incomplete for session "${options.session}"; run mt cleanup after removing leftover worktrees manually.\n`
  );
}

function assertNoGlobalWorktreePathStateCollisions(
  home: string,
  session: string,
  repoConfigs: { sourceRoot: string }[]
) {
  const states = listSessionStates(home);
  for (const repoConfig of repoConfigs) {
    const expectedPath = getExpectedWorktreePath(home, repoConfig.sourceRoot, session);
    const collision = states
      .flatMap((state) => state.repos)
      .find(
        (repoState) =>
          samePath(repoState.worktreePath, expectedPath) &&
          !samePath(repoState.sourceRoot, repoConfig.sourceRoot)
      );

    if (collision) {
      throw new MonkeError(
        `Session worktree path collision at ${expectedPath}; already recorded for ${collision.sourceRoot}. Repo-name/session worktree paths must be unique within MONKE_HOME.`
      );
    }
  }
}

function loadResolvedGraphForSession(
  runtime: Runtime,
  rootSourceRoot: string,
  sessionState: SessionState
) {
  if (sessionState.graphSource !== "session-branch" || sessionState.repos.length === 0) {
    return loadResolvedGraph(runtime, rootSourceRoot);
  }

  const sessionRepoRoots = new Set(sessionState.repos.map((repo) => repo.sourceRoot));
  return loadResolvedGraph(runtime, rootSourceRoot, {
    pathExists(sourceRoot, relativePath) {
      if (sessionRepoRoots.has(sourceRoot)) {
        return gitPathExistsAtRef(runtime, sourceRoot, sessionState.session, relativePath);
      }
      return existsSync(path.join(sourceRoot, relativePath));
    },
    readRepoConfig(sourceRoot) {
      if (sessionRepoRoots.has(sourceRoot)) {
        return readGitPathAtRef(runtime, sourceRoot, sessionState.session, "monke.yml");
      }
      return readFileSync(path.join(sourceRoot, "monke.yml"), "utf-8");
    }
  });
}

/** Load the session graph for cleanup, tolerating missing repo config. */
export function runInstallDependencies(runtime: Runtime) {
  reconcileCodiff(runtime);
  createLogger(runtime).success("Verified monke-tools runtime dependencies");
}

export function runMaterialize(runtime: Runtime) {
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
      graph.reposInMaterializationOrder.map((repo) => repo.sourceRoot)
    );

    const currentRepoRoot = context.sourceRoot;
    const results = new Map<string, RepoMaterializationResult>();
    const persistRepoState = (repoState: SessionRepoState) => {
      sessionState = recordRepoSuccess(sessionState, repoState);
      saveSessionState(home, sessionState);
    };
    for (const repoConfig of graph.reposInMaterializationOrder) {
      const existingState = sessionState.repos.find(
        (repo) => repo.sourceRoot === repoConfig.sourceRoot
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
        baselinePortsRoot:
          sessionState.graphSource === "session-branch" ? worktreePath : repoConfig.sourceRoot,
        dependencyResults: results,
        existingState,
        home,
        persistRepoState,
        repoConfig,
        rootSourceRoot: context.sourceRoot,
        runtime,
        session,
        worktreeCreated,
        worktreePath
      });

      results.set(repoConfig.sourceRoot, materialized);
      sessionState = recordRepoSuccess(sessionState, materialized.state);
      saveSessionState(home, sessionState);
    }
  });

  createLogger(runtime).success(`Materialized session ${session}`);
}

/** Clean up dead Session state and optionally remove merge-cleanable Session worktrees first. */
export function runCleanup(runtime: Runtime, options: CleanupOptions) {
  const home = getMonkeHome(runtime);
  const context = resolveRepoContext(runtime, runtime.cwd, home);
  const dryRun = options.mode === "merged" && options.dryRun;

  const mergedResults: MergedCleanupResult[] = [];
  let removedDeadSessions = 0;
  withGlobalLock(home, () => {
    if (options.mode === "merged") {
      mergedResults.push(
        ...cleanupMergedWorktrees(runtime, home, context.sourceRoot, options.dryRun)
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
      `Removed ${removedDeadSessions} dead session${removedDeadSessions === 1 ? "" : "s"}`
    );
  }
}

interface MergedCleanupResult {
  decision: MergedCleanupDecision;
  removed: boolean;
  session: string;
  sourceRoot: string;
  worktreePath: string;
}

function cleanupMergedWorktrees(
  runtime: Runtime,
  home: string,
  rootSourceRoot: string,
  dryRun: boolean
) {
  const results: MergedCleanupResult[] = [];
  const cache = createMergedCleanupLookupCache();

  for (const state of listSessionStates(home)) {
    if (state.rootSourceRoot !== rootSourceRoot) {
      continue;
    }

    for (const repoState of state.repos) {
      const candidate = {
        session: state.session,
        sourceRoot: repoState.sourceRoot,
        worktreePath: repoState.worktreePath
      };
      const decision = inspectMergedWorktreeCleanup(runtime, candidate, {
        cache,
        refreshDefaultBranch: !dryRun
      });
      let removed = false;

      if (decision.eligible && !dryRun) {
        removeMergeCleanableWorktree(runtime, candidate);
        removed = true;
      }

      results.push({
        decision,
        removed,
        session: state.session,
        sourceRoot: repoState.sourceRoot,
        worktreePath: repoState.worktreePath
      });
    }
  }

  return results;
}

function removeDeadSessionStates(runtime: Runtime, home: string, rootSourceRoot: string) {
  let removed = 0;
  const failures: { detail: string; session: string; stateFile: string }[] = [];

  for (const state of listSessionStates(home)) {
    if (state.rootSourceRoot !== rootSourceRoot) {
      continue;
    }

    const allGone = state.repos.every((repo) => !existsSync(repo.worktreePath));
    if (!allGone) {
      continue;
    }

    try {
      finalizeSession(runtime, home, state);
      removed += 1;
    } catch (error) {
      failures.push({
        detail: errorMessage(error),
        session: state.session,
        stateFile: getSessionStateFilePath(home, state.rootSourceRoot, state.session)
      });
    }
  }

  if (failures.length > 0) {
    const failureDetails = failures
      .map(
        (failure) =>
          `- ${failure.session}: ${failure.detail}\n  Session state: ${failure.stateFile}`
      )
      .join("\n");
    throw new MonkeError(
      `Removed ${removed} Session state record${removed === 1 ? "" : "s"} for Dead worktrees; ${failures.length} failed:\n${failureDetails}\nFix the failing Cleanup command (or remove the listed Session state file) and re-run mt cleanup; successfully cleaned sessions were already removed.`
    );
  }

  return removed;
}

function writeMergedCleanupSummary(
  runtime: Runtime,
  results: MergedCleanupResult[],
  dryRun: boolean
) {
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
        }: ${result.worktreePath}`
      );
      continue;
    }

    skipped += 1;
    logger.info(
      `Skipped merged worktree ${result.session} ${result.sourceRoot}: ${result.decision.reasons.join(
        "; "
      )}`
    );
  }

  if (dryRun) {
    logger.info(
      `Merged cleanup dry-run: would remove ${formatWorktreeCount(eligible)}, skipped ${formatWorktreeCount(
        skipped
      )}`
    );
    return;
  }

  logger.info(
    `Merged cleanup: removed ${formatWorktreeCount(removed)}, skipped ${formatWorktreeCount(
      skipped
    )}`
  );
}

function formatWorktreeCount(count: number) {
  return `${count} worktree${count === 1 ? "" : "s"}`;
}

export function runSetup(runtime: Runtime) {
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
      value: path.relative(context.sourceRoot, externalRepo.absoluteRepoRoot) || "."
    }))
  );

  createLogger(runtime).success(`Updated root .env for ${path.basename(context.sourceRoot)}`);
}

function materializeRepo(options: {
  baselinePortsRoot: string;
  dependencyResults: Map<string, RepoMaterializationResult>;
  diffBaseRef?: string;
  existingState: SessionRepoState | undefined;
  home: string;
  persistRepoState: (repoState: SessionRepoState) => void;
  repoConfig: RepoConfig;
  rootSourceRoot: string;
  runtime: Runtime;
  session: string;
  worktreeCreated: boolean;
  worktreePath: string;
}) {
  const {
    baselinePortsRoot,
    dependencyResults,
    existingState,
    home,
    repoConfig,
    rootSourceRoot,
    session,
    worktreeCreated,
    worktreePath
  } = options;
  const hasBootstrapCommand = repoHasBootstrapCommand(repoConfig);
  const diffBaseRef = options.diffBaseRef || existingState?.diffBaseRef;

  if (worktreeCreated) {
    seedWorktreeFiles(repoConfig, worktreePath, (message) => {
      options.runtime.writeStderr(`${message}\n`);
    });
  }

  options.persistRepoState(
    buildSessionRepoState({
      assignedPorts: existingState?.assignedPorts ?? [],
      cleanupCommand: repoConfig.cleanupCommand,
      diffBaseRef,
      isComplete: false,
      resourceCommandOutputs: existingState?.resourceCommandOutputs ?? [],
      resourceValues: existingState?.resourceValues ?? [],
      sourceRoot: repoConfig.sourceRoot,
      worktreePath
    })
  );

  const resolvedResourceValues = resolveResourceValues({
    env: options.runtime.env,
    existingRepoState: existingState,
    home,
    repoConfig,
    rootSourceRoot,
    session
  });
  const persistResolvedResourceCommands = (
    resourceCommandOutputs: ResourceCommandState[],
    assignedPorts: AssignedPort[]
  ) => {
    options.persistRepoState(
      buildSessionRepoState({
        assignedPorts,
        cleanupCommand: repoConfig.cleanupCommand,
        diffBaseRef,
        isComplete: false,
        resourceCommandOutputs,
        resourceValues: preserveStaleResourceValues(
          existingState?.resourceValues ?? [],
          resolvedResourceValues.values
        ),
        sourceRoot: repoConfig.sourceRoot,
        worktreePath
      })
    );
  };
  let resolvedResourceCommands: ReturnType<typeof resolveResourceCommands> | undefined;
  if (!hasBootstrapCommand) {
    resolvedResourceCommands = resolveResourceCommands({
      existingRepoState: existingState,
      home,
      onResolvedCommandOutputs(resourceCommandOutputs) {
        persistResolvedResourceCommands(resourceCommandOutputs, existingState?.assignedPorts ?? []);
      },
      repoConfig,
      resourceValues: resolvedResourceValues.values,
      runtime: options.runtime,
      session,
      worktreePath
    });
  }
  const reservation = getOrCreateReservation(
    home,
    repoConfig.sourceRoot,
    repoConfig.localPortOrder.length
  );
  const baselinePorts = collectBaselinePortsFromRoot({
    config: repoConfig,
    sourceRoot: baselinePortsRoot
  });
  const localAssignments = allocateLocalPorts({
    baselinePorts,
    existingRepoState: existingState,
    home,
    repoConfig,
    reservation,
    rootSourceRoot,
    session
  });

  const externalAssignments = resolveExternalAssignments(repoConfig, dependencyResults);
  const externalPathAssignments = resolveExternalPathAssignments(
    repoConfig,
    worktreePath,
    dependencyResults
  );
  rewriteManagedEnvFiles(repoConfig, worktreePath, localAssignments, externalAssignments);
  const localAssignedPorts = toAssignedPorts(repoConfig, localAssignments);
  const rootEnvAssignmentsBeforeCommands = [
    ...externalPathAssignments,
    ...toRootEnvAssignments(localAssignedPorts),
    ...toRootEnvAssignments(dedupeAssignedPorts(externalAssignments)),
    ...toResourceEnvAssignments(resolvedResourceValues.values)
  ];
  const existingResourceCommandEnvNames = toResourceCommandEnvNames(
    existingState?.resourceCommandOutputs ?? []
  );

  if (hasBootstrapCommand) {
    syncRootEnvFileWithRemovals(worktreePath, rootEnvAssignmentsBeforeCommands, [
      ...resolvedResourceValues.removedEnvNames,
      ...existingResourceCommandEnvNames
    ]);
    options.persistRepoState(
      buildSessionRepoState({
        assignedPorts: localAssignedPorts,
        cleanupCommand: repoConfig.cleanupCommand,
        diffBaseRef,
        isComplete: false,
        resourceCommandOutputs: existingState?.resourceCommandOutputs ?? [],
        resourceValues: preserveStaleResourceValues(
          existingState?.resourceValues ?? [],
          resolvedResourceValues.values
        ),
        sourceRoot: repoConfig.sourceRoot,
        worktreePath
      })
    );
    runBootstrapCommand(
      options.runtime,
      repoConfig,
      worktreePath,
      externalPathAssignments,
      session
    );
    resolvedResourceCommands = resolveResourceCommands({
      existingRepoState: existingState,
      home,
      onResolvedCommandOutputs(resourceCommandOutputs) {
        persistResolvedResourceCommands(resourceCommandOutputs, localAssignedPorts);
      },
      repoConfig,
      resourceValues: resolvedResourceValues.values,
      runtime: options.runtime,
      session,
      worktreePath
    });
  }

  if (!resolvedResourceCommands) {
    throw new MonkeError(`Resource commands were not resolved for ${repoConfig.sourceRoot}`);
  }

  syncRootEnvFileWithRemovals(
    worktreePath,
    [
      ...rootEnvAssignmentsBeforeCommands,
      ...toResourceCommandEnvAssignments(resolvedResourceCommands.commands)
    ],
    [...resolvedResourceValues.removedEnvNames, ...resolvedResourceCommands.removedEnvNames]
  );
  if (!hasBootstrapCommand) {
    runBootstrapCommand(
      options.runtime,
      repoConfig,
      worktreePath,
      externalPathAssignments,
      session
    );
  }

  return {
    localAssignments,
    state: buildSessionRepoState({
      assignedPorts: localAssignedPorts,
      cleanupCommand: repoConfig.cleanupCommand,
      diffBaseRef,
      isComplete: true,
      resourceCommandOutputs: resolvedResourceCommands.commands,
      resourceValues: resolvedResourceValues.values,
      sourceRoot: repoConfig.sourceRoot,
      worktreePath
    })
  };
}

function repoHasBootstrapCommand(repoConfig: RepoConfig) {
  return Boolean(repoConfig.bootstrapCommand);
}

function resolveExternalAssignments(
  repoConfig: RepoConfig,
  dependencyResults: Map<string, RepoMaterializationResult>
) {
  const assignments: AssignedPort[] = [];
  for (const externalRepo of repoConfig.externalInOrder) {
    const dependency = dependencyResults.get(externalRepo.absoluteRepoRoot);
    if (!dependency) {
      throw new MonkeError(
        `Missing dependency materialization result for ${externalRepo.absoluteRepoRoot}`
      );
    }

    for (const mapping of externalRepo.mappings) {
      const value = dependency.localAssignments.get(mapping.portKey);
      if (value === undefined) {
        throw new MonkeError(
          `Dependency ${externalRepo.absoluteRepoRoot} did not materialize local port ${mapping.portKey}`
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
  dependencyResults: Map<string, RepoMaterializationResult>
) {
  return repoConfig.externalInOrder.map((externalRepo) => {
    const dependency = dependencyResults.get(externalRepo.absoluteRepoRoot);
    if (!dependency) {
      throw new MonkeError(
        `Missing dependency materialization result for ${externalRepo.absoluteRepoRoot}`
      );
    }

    const relativePath = path.relative(worktreePath, dependency.state.worktreePath) || ".";
    return {
      env: externalRepo.pathEnv,
      value: relativePath
    };
  });
}

function toRootEnvAssignments(assignments: AssignedPort[]) {
  return assignments.map((assignment) => ({
    env: assignment.key,
    value: String(assignment.value)
  }));
}

function dedupeAssignedPorts(assignments: AssignedPort[]) {
  const deduped = new Map<string, AssignedPort>();
  for (const assignment of assignments) {
    deduped.set(assignment.key, assignment);
  }
  return [...deduped.values()];
}

function toResourceEnvAssignments(assignments: ResourceValueState[]) {
  return assignments.map((assignment) => ({
    env: assignment.env,
    value: assignment.value
  }));
}

function toResourceCommandEnvAssignments(commands: ResourceCommandState[]) {
  return commands.flatMap((command) =>
    command.outputs.map((assignment) => ({
      env: assignment.env,
      value: assignment.value
    }))
  );
}

function toResourceCommandEnvNames(commands: ResourceCommandState[]) {
  return [...new Set(commands.flatMap((command) => command.outputs.map((output) => output.env)))];
}

function buildSessionRepoState(options: {
  assignedPorts: AssignedPort[];
  cleanupCommand?: string;
  diffBaseRef?: string;
  isComplete: boolean;
  resourceCommandOutputs: ResourceCommandState[];
  resourceValues: ResourceValueState[];
  sourceRoot: string;
  worktreePath: string;
}) {
  const state: SessionRepoState = {
    assignedPorts: options.assignedPorts,
    sourceRoot: options.sourceRoot,
    worktreePath: options.worktreePath
  };

  if (options.cleanupCommand) {
    state.cleanupCommand = options.cleanupCommand;
  }

  if (options.diffBaseRef) {
    state.diffBaseRef = options.diffBaseRef;
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
  currentValues: ResourceValueState[]
) {
  const currentEnvNames = new Set(currentValues.map((resource) => resource.env));
  return [
    ...currentValues,
    ...existingValues.filter((resource) => !currentEnvNames.has(resource.env))
  ];
}

function runBootstrapCommand(
  runtime: Runtime,
  repoConfig: RepoConfig,
  worktreePath: string,
  externalPathAssignments: { env: string; value: string }[],
  session: string
) {
  if (!repoConfig.bootstrapCommand) {
    return;
  }

  createLogger(runtime).info(`Bootstrapping ${repoConfig.sourceRoot} in ${worktreePath}`);
  try {
    runtime.exec("sh", ["-c", repoConfig.bootstrapCommand], {
      cwd: worktreePath,
      env: Object.fromEntries(
        externalPathAssignments.map((assignment) => [assignment.env, assignment.value])
      )
    });
  } catch (error) {
    const detail = errorMessage(error);
    throw new MonkeError(
      `Bootstrap command failed for ${repoConfig.sourceRoot}: ${repoConfig.bootstrapCommand}\n${detail}\nPartial Session state was kept; fix the command and re-run mt spawn ${session} to resume from this repo.`
    );
  }
}

function assertUniqueExpectedWorktreePaths(
  home: string,
  session: string,
  reposInOrder: RepoConfig[]
) {
  const ownerByPath = new Map<string, string>();
  for (const repoConfig of reposInOrder) {
    const expectedPath = getExpectedWorktreePath(home, repoConfig.sourceRoot, session);
    const normalizedPath = path.normalize(expectedPath);
    const existingOwner = ownerByPath.get(normalizedPath);
    if (existingOwner !== undefined) {
      throw new MonkeError(
        `Session worktree path collision at ${expectedPath}: ${existingOwner} and ${repoConfig.sourceRoot} both resolve to ${path.basename(repoConfig.sourceRoot)}/${session}`
      );
    }
    ownerByPath.set(normalizedPath, repoConfig.sourceRoot);
  }
}

function readGitPathAtRef(runtime: Runtime, sourceRoot: string, ref: string, relativePath: string) {
  return runtime.exec("git", ["show", `${ref}:${relativePath}`], { cwd: sourceRoot }).stdout;
}

function runGit(runtime: Runtime, cwd: string, args: string[]) {
  return runtime.exec("git", args, { cwd }).stdout;
}

function resolveAttachedHeadRef(runtime: Runtime, sourceRoot: string) {
  const result = runtime.exec("git", ["symbolic-ref", "--quiet", "HEAD"], {
    allowFailure: true,
    cwd: sourceRoot
  });
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

function gitPathExistsAtRef(
  runtime: Runtime,
  sourceRoot: string,
  ref: string,
  relativePath: string
) {
  const result = runtime.exec("git", ["cat-file", "-e", `${ref}:${relativePath}`], {
    allowFailure: true,
    cwd: sourceRoot
  });
  return result.exitCode === 0;
}

function findFirstIndexNeedingWork(
  runtime: Runtime,
  home: string,
  reposInOrder: RepoConfig[],
  state: SessionState,
  session: string,
  currentRepoIndex: number
) {
  for (const [index, repoConfig] of reposInOrder.slice(0, currentRepoIndex).entries()) {
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
    if (!samePath(existing.worktreePath, expectedPath)) {
      throw new MonkeError(
        `Session ${session} recorded ${existing.worktreePath} for ${repoConfig.sourceRoot}, expected ${expectedPath}`
      );
    }

    validateWorktreeForSession(
      runtime,
      home,
      repoConfig.sourceRoot,
      existing.worktreePath,
      session
    );
  }

  return currentRepoIndex;
}
