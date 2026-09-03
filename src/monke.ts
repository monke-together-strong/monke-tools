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
  ensureSessionWorktreeAsync,
  ensureFreshSessionWorktreeFromRefAsync,
  getExpectedWorktreePath,
  resolveDefaultBranchRef,
  resolveRepoContext,
  validateWorktreeForSession
} from "./git.ts";
import type { DefaultBranchRef } from "./git.ts";
import {
  INSTALL_MANIFEST_FILENAME,
  loadActiveToolInstall,
  loadToolInstall
} from "./install-manifest.ts";
import { createLogger } from "./logger.ts";
import { samePath } from "./path-identity.ts";
import { resolveResourceCommands, resolveResourceValues } from "./resources.ts";
import { getMonkeHome, withGlobalLock, withGlobalLockAsync } from "./runtime.ts";
import { finalizeSession } from "./session-finalization.ts";
import { runSessionMaterialization } from "./session-materialization.ts";
import type { SessionMaterializationNode } from "./session-materialization.ts";
import {
  allocateLocalPorts,
  ensureSessionPrefix,
  getOrCreateReservation,
  getSessionStateFilePath,
  listSessionStates,
  loadSessionState,
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

type SpawnSourcePlan =
  | {
      kind: "current-head";
      spawnOptions: Extract<SpawnOptions, { mode: "current-head" }>;
    }
  | {
      kind: "session-branch";
      spawnOptions: Extract<SpawnOptions, { mode: "session-branch" }>;
    }
  | {
      attempt: "fresh" | "resume";
      kind: "default-branch";
      spawnOptions: Extract<SpawnOptions, { mode: "default-branch" }>;
    };

export interface SpawnRunOptions {
  /** Open the Root repo's Session worktree in Codex after it is ready. */
  codex?: boolean;
}

interface DirtySnapshot {
  stagedPatch: string;
  unstagedPatch: string;
  untrackedPaths: string[];
}

interface PreparedRepoWorktree {
  baselinePortsRoot: string;
  diffBaseRef?: string;
  pinnedRef?: string;
  preparationWarnings: string[];
  worktreePath: string;
}

interface ConfiguredSpawn {
  dirtySnapshots: Map<string, DirtySnapshot>;
  getDefaultRef: (sourceRoot: string) => DefaultBranchRef;
  home: string;
  reposInOrder: RepoConfig[];
  rootSourceRoot: string;
  rootWorktreePath: string;
  runtime: Runtime;
  session: string;
  sessionState: SessionState;
  sourcePlan: SpawnSourcePlan;
}

class BootstrapCommandError extends MonkeError {
  override name = "BootstrapCommandError";
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

/** Spawn or refresh a Session through bounded Worktree preparation. */
export async function runSpawn(
  runtime: Runtime,
  session: string,
  spawnOptions: SpawnOptions,
  runOptions: SpawnRunOptions = {}
) {
  const { context, home } = resolveSpawnContext(runtime, session);
  const rootWorktreePath = await withGlobalLockAsync(home, () =>
    spawnSessionFromSourceRootLocked(runtime, home, context.sourceRoot, session, spawnOptions)
  );
  finishSpawn(runtime, session, rootWorktreePath, runOptions);
}

function resolveSpawnContext(runtime: Runtime, session: string) {
  if (!session) {
    throw new MonkeError("mt spawn requires a session name");
  }
  const home = getMonkeHome(runtime);
  const context = resolveRepoContext(runtime, runtime.cwd, home);
  if (!context.isSourceCheckout) {
    throw new MonkeError("mt spawn must run from the source checkout");
  }
  return { context, home };
}

function finishSpawn(
  runtime: Runtime,
  session: string,
  rootWorktreePath: string,
  runOptions: SpawnRunOptions
) {
  createLogger(runtime).success(`Spawned or updated session ${session}`);
  requestShellDirectory(runtime, rootWorktreePath);
  if (runOptions.codex === true) {
    openCodexWorkspace(runtime, rootWorktreePath);
  }
}

/** Create or refresh a Session while the caller holds the Monke global lock. */
export async function spawnSessionFromSourceRootLocked(
  runtime: Runtime,
  home: string,
  rootSourceRoot: string,
  session: string,
  spawnOptions: SpawnOptions
) {
  const initialized = await initializeSpawn(runtime, home, rootSourceRoot, session, spawnOptions);
  if (initialized.kind === "complete") {
    return initialized.rootWorktreePath;
  }
  const { execution } = initialized;
  await runSessionMaterialization({
    home: execution.home,
    nodes: createSpawnMaterializationNodes(execution),
    retryCommand:
      execution.sourcePlan.kind === "default-branch"
        ? `mt spawn ${execution.session} -m`
        : `mt spawn ${execution.session}`,
    rootSourceRoot: execution.rootSourceRoot,
    state: execution.sessionState
  });
  return execution.rootWorktreePath;
}

async function initializeSpawn(
  runtime: Runtime,
  home: string,
  rootSourceRoot: string,
  session: string,
  spawnOptions: SpawnOptions
) {
  const sourcePlan = resolveSpawnSourcePlan(home, rootSourceRoot, session, spawnOptions);
  assertSpawnRequest(runtime, rootSourceRoot, session, spawnOptions);
  const rootWorktreePath = getExpectedWorktreePath(home, rootSourceRoot, session);
  const getDefaultRef = createDefaultRefResolver(runtime);
  const rootDefaultRef =
    sourcePlan.kind === "default-branch" && sourcePlan.attempt === "fresh"
      ? getDefaultRef(rootSourceRoot)
      : null;
  const rootConfigExists = spawnRootConfigExists(
    runtime,
    rootSourceRoot,
    session,
    rootDefaultRef,
    sourcePlan.kind === "session-branch" ||
      (sourcePlan.kind === "default-branch" && sourcePlan.attempt === "resume")
  );
  if (!rootConfigExists) {
    return {
      kind: "complete" as const,
      rootWorktreePath: await spawnWithoutConfig(
        runtime,
        home,
        rootSourceRoot,
        session,
        spawnOptions,
        rootDefaultRef
      )
    };
  }

  const graph = loadSpawnGraph(runtime, rootSourceRoot, session, sourcePlan, getDefaultRef);
  const prepared = prepareSpawnMaterialization(
    runtime,
    home,
    rootSourceRoot,
    session,
    sourcePlan,
    graph.reposInMaterializationOrder
  );
  return {
    execution: {
      ...prepared,
      getDefaultRef,
      home,
      reposInOrder: graph.reposInMaterializationOrder,
      rootSourceRoot,
      rootWorktreePath,
      runtime,
      session,
      sourcePlan
    } satisfies ConfiguredSpawn,
    kind: "configured" as const
  };
}

function createSpawnMaterializationNodes(execution: ConfiguredSpawn) {
  return execution.reposInOrder.map((repoConfig) => {
    const recordedState = execution.sessionState.repos.find(
      (repo) => repo.sourceRoot === repoConfig.sourceRoot
    );
    const initialState = createInitialRepoLifecycleState(
      repoConfig,
      getExpectedWorktreePath(execution.home, repoConfig.sourceRoot, execution.session),
      recordedState
    );
    return {
      dependencyRoots: repoConfig.externalInOrder.map((dependency) => dependency.absoluteRepoRoot),
      initialState,
      async materialize({ checkpoint, dependencyResults, existingState, prepared }) {
        const result = await materializeRepo({
          baselinePortsRoot: prepared.baselinePortsRoot,
          dependencyResults,
          diffBaseRef: prepared.diffBaseRef,
          existingState,
          home: execution.home,
          persistRepoState: checkpoint,
          repoConfig,
          retryCommand:
            execution.sourcePlan.kind === "default-branch"
              ? `mt spawn ${execution.session} -m`
              : `mt spawn ${execution.session}`,
          rootSourceRoot: execution.rootSourceRoot,
          runtime: execution.runtime,
          session: execution.session,
          worktreePath: prepared.worktreePath
        });
        return { state: result.state, value: result };
      },
      async prepare(lifecycleState, checkpoint) {
        const prepared = await prepareSpawnRepoWorktree({
          dirtySnapshot: execution.dirtySnapshots.get(repoConfig.sourceRoot),
          existingState: lifecycleState,
          getDefaultRef: execution.getDefaultRef,
          graphSource: execution.sessionState.graphSource,
          home: execution.home,
          onWorktreeReady(worktree) {
            checkpoint({
              ...lifecycleState,
              diffBaseRef: worktree.diffBaseRef,
              pinnedRef: worktree.pinnedRef,
              worktreePath: worktree.worktreePath
            });
          },
          repoConfig,
          rootSourceRoot: execution.rootSourceRoot,
          runtime: execution.runtime,
          session: execution.session,
          sourcePlan: execution.sourcePlan
        });
        return {
          state: {
            ...lifecycleState,
            diffBaseRef: prepared.diffBaseRef,
            pinnedRef: prepared.pinnedRef,
            worktreePath: prepared.worktreePath
          },
          value: prepared,
          warnings: prepared.preparationWarnings
        };
      },
      reuse: toRepoMaterializationResult,
      sourceRoot: repoConfig.sourceRoot
    } satisfies SessionMaterializationNode<PreparedRepoWorktree, RepoMaterializationResult>;
  });
}

interface SpawnRepoPreparationRequest {
  dirtySnapshot?: DirtySnapshot;
  existingState: SessionRepoState | undefined;
  getDefaultRef: (sourceRoot: string) => DefaultBranchRef;
  graphSource: SessionState["graphSource"];
  home: string;
  onWorktreeReady: (worktree: {
    diffBaseRef?: string;
    pinnedRef?: string;
    worktreePath: string;
  }) => void;
  repoConfig: RepoConfig;
  rootSourceRoot: string;
  runtime: Runtime;
  session: string;
  sourcePlan: SpawnSourcePlan;
}

async function prepareSpawnRepoWorktree(request: SpawnRepoPreparationRequest) {
  const { existingState, repoConfig, runtime } = request;
  const { createdDiffBaseRef, useWorktreeBaseline, worktree } = await ensureSpawnWorktree(request);
  const diffBaseRef = existingState?.diffBaseRef ?? createdDiffBaseRef;
  const pinnedRef =
    request.sourcePlan.kind === "default-branch"
      ? (existingState?.pinnedRef ?? runGit(runtime, worktree.path, ["rev-parse", "HEAD"]).trim())
      : undefined;
  request.onWorktreeReady({ diffBaseRef, pinnedRef, worktreePath: worktree.path });
  const preparationWarnings = prepareRepoWorktree(runtime, repoConfig, worktree.path);
  return {
    baselinePortsRoot: useWorktreeBaseline ? worktree.path : repoConfig.sourceRoot,
    diffBaseRef,
    pinnedRef,
    preparationWarnings,
    worktreePath: worktree.path
  };
}

async function ensureSpawnWorktree(request: SpawnRepoPreparationRequest) {
  const { home, repoConfig, rootSourceRoot, runtime, session, sourcePlan } = request;
  const useWorktreeBaseline =
    (sourcePlan.kind === "default-branch" && sourcePlan.attempt === "resume") ||
    (sourcePlan.kind === "session-branch" && repoConfig.sourceRoot === rootSourceRoot);
  if (sourcePlan.kind === "default-branch" && sourcePlan.attempt === "fresh") {
    const defaultRef = request.getDefaultRef(repoConfig.sourceRoot).ref;
    return {
      createdDiffBaseRef: defaultRef,
      useWorktreeBaseline,
      worktree: await ensureFreshSessionWorktreeFromRefAsync(
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
  const worktree = await ensureSessionWorktreeAsync(runtime, home, repoConfig.sourceRoot, session, {
    skipCleanCheck: shouldCopyDirty(sourcePlan.spawnOptions)
  });
  if (request.dirtySnapshot && worktree.created) {
    await applyDirtySnapshot(runtime, repoConfig.sourceRoot, worktree.path, request.dirtySnapshot);
  } else if (request.dirtySnapshot && dirtySnapshotHasContent(request.dirtySnapshot)) {
    warnDirtyStateNotCarried(runtime, repoConfig.sourceRoot, session);
  }
  return {
    createdDiffBaseRef:
      sourcePlan.kind === "current-head" &&
      worktree.created &&
      !sessionBranchExisted &&
      sourceHeadRef !== undefined
        ? sourceHeadRef
        : undefined,
    useWorktreeBaseline,
    worktree
  };
}

function assertSpawnRequest(
  runtime: Runtime,
  rootSourceRoot: string,
  session: string,
  options: SpawnOptions
) {
  if (session === "") {
    throw new MonkeError("mt spawn requires a session name");
  }
  if (options.mode === "session-branch" && !branchExists(runtime, rootSourceRoot, session)) {
    throw new MonkeError(
      `Session branch "${session}" does not exist for ${rootSourceRoot}; cannot spawn from it`
    );
  }
}

function resolveSpawnSourcePlan(
  home: string,
  rootSourceRoot: string,
  session: string,
  spawnOptions: SpawnOptions
): SpawnSourcePlan {
  if (spawnOptions.mode === "current-head") {
    return { kind: "current-head", spawnOptions };
  }
  if (spawnOptions.mode === "session-branch") {
    return { kind: "session-branch", spawnOptions };
  }
  if (!existsSync(getSessionStateFilePath(home, rootSourceRoot, session))) {
    return { attempt: "fresh", kind: "default-branch", spawnOptions };
  }

  const state = loadSessionState(home, rootSourceRoot, session);
  if (isRetryableDefaultBranchSpawn(state)) {
    return { attempt: "resume", kind: "default-branch", spawnOptions };
  }
  throw new MonkeError(
    `Session state already exists for "${session}"; default branch spawn mode requires a fresh Session`
  );
}

function isRetryableDefaultBranchSpawn(state: SessionState) {
  return state.spawnSource === "default-branch" && state.generation.status === "incomplete";
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

// eslint-disable-next-line complexity -- Config-less Spawn keeps its complete compatibility path localized here.
async function spawnWithoutConfig(
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
      ? await ensureSessionWorktreeAsync(runtime, home, rootSourceRoot, session, {
          skipCleanCheck: shouldCopyDirty(options)
        })
      : await ensureFreshSessionWorktreeFromRefAsync(
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
    await applyDirtySnapshot(runtime, rootSourceRoot, worktree.path, dirtySnapshot);
  } else if (dirtySnapshot !== null && dirtySnapshotHasContent(dirtySnapshot)) {
    warnDirtyStateNotCarried(runtime, rootSourceRoot, session);
  }
  const sessionState = {
    ...priorSessionState,
    generation: { number: 0, status: "not-started" as const },
    graphSource: options.mode === "current-head" ? undefined : ("session-branch" as const),
    repos: [
      createInitialRepoLifecycleState(
        {
          cleanupCommand: undefined,
          sourceRoot: rootSourceRoot
        },
        worktree.path,
        {
          ...existingRepoState,
          assignedPorts: [],
          cleanupEligible: false,
          diffBaseRef,
          materializationStatus: "pending",
          pinnedRef:
            options.mode === "default-branch"
              ? runGit(runtime, worktree.path, ["rev-parse", "HEAD"]).trim()
              : undefined,
          preparationStatus: "prepared",
          sourceRoot: rootSourceRoot,
          worktreePath: worktree.path
        }
      )
    ],
    spawnSource: options.mode === "current-head" ? undefined : options.mode
  };
  saveSessionState(home, sessionState);
  runtime.writeStderr(
    `Warning: no monke.yml found for ${rootSourceRoot}; spawned session worktree without materializing it.\n`
  );
  return getExpectedWorktreePath(home, rootSourceRoot, session);
}

function loadSpawnGraph(
  runtime: Runtime,
  rootSourceRoot: string,
  session: string,
  sourcePlan: SpawnSourcePlan,
  getDefaultRef: (sourceRoot: string) => DefaultBranchRef
) {
  if (sourcePlan.kind === "default-branch" && sourcePlan.attempt === "resume") {
    return loadResolvedGraph(runtime, rootSourceRoot, {
      pathExists(sourceRoot, relativePath) {
        return gitPathExistsAtRef(runtime, sourceRoot, session, relativePath);
      },
      readRepoConfig(sourceRoot) {
        return readGitPathAtRef(runtime, sourceRoot, session, "monke.yml");
      }
    });
  }
  if (sourcePlan.kind === "default-branch") {
    return loadResolvedGraph(runtime, rootSourceRoot, {
      pathExists(sourceRoot, relativePath) {
        return gitPathExistsAtRef(runtime, sourceRoot, getDefaultRef(sourceRoot).ref, relativePath);
      },
      readRepoConfig(sourceRoot) {
        return readGitPathAtRef(runtime, sourceRoot, getDefaultRef(sourceRoot).ref, "monke.yml");
      }
    });
  }
  if (sourcePlan.kind === "session-branch") {
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
  sourcePlan: SpawnSourcePlan,
  reposInOrder: RepoConfig[]
) {
  const { spawnOptions } = sourcePlan;
  if (spawnOptions.mode === "current-head" && !spawnOptions.copyDirty) {
    assertCleanCheckoutsForCurrentHeadSpawn(runtime, reposInOrder, session);
  }
  const dirtySnapshots = shouldCopyDirty(spawnOptions)
    ? captureDirtySnapshots(runtime, reposInOrder)
    : new Map<string, DirtySnapshot>();
  for (const [sourceRoot, dirtySnapshot] of dirtySnapshots) {
    assertDirtyCarryBoundary(runtime, home, sourceRoot, session, dirtySnapshot);
  }

  const sessionState = loadSessionState(home, rootSourceRoot, session);
  sessionState.graphSource = sourcePlan.kind === "current-head" ? undefined : "session-branch";
  sessionState.spawnSource = sourcePlan.kind === "current-head" ? undefined : sourcePlan.kind;
  ensureSessionPrefix(
    sessionState,
    reposInOrder.map((repo) => repo.sourceRoot)
  );
  assertUniqueExpectedWorktreePaths(home, session, reposInOrder);
  assertNoGlobalWorktreePathStateCollisions(home, session, reposInOrder);
  if (sourcePlan.kind === "default-branch" && sourcePlan.attempt === "fresh") {
    for (const repoConfig of reposInOrder) {
      assertFreshSessionWorktreeAvailable(runtime, home, repoConfig.sourceRoot, session);
    }
  }

  return { dirtySnapshots, sessionState };
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

async function applyDirtySnapshot(
  runtime: Runtime,
  sourceRoot: string,
  worktreePath: string,
  snapshot: DirtySnapshot
) {
  await applyPatchAsync(runtime, worktreePath, snapshot.stagedPatch);
  await applyPatchAsync(runtime, worktreePath, snapshot.unstagedPatch);
  copyUntrackedPaths(sourceRoot, worktreePath, snapshot.untrackedPaths);
}

async function applyPatchAsync(runtime: Runtime, worktreePath: string, patch: string) {
  if (!patch) {
    return;
  }
  await runtime.execAsync("git", ["apply", "--3way"], { cwd: worktreePath, stdin: patch });
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
  reconcileCodiff(runtime, minimumCodiffVersionForRuntime(runtime));
  createLogger(runtime).success("Verified monke-tools runtime dependencies");
}

function minimumCodiffVersionForRuntime(runtime: Runtime) {
  const fixedManifest = path.join(runtime.toolInstallRoot, INSTALL_MANIFEST_FILENAME);
  if (existsSync(fixedManifest)) {
    return loadToolInstall(runtime.toolInstallRoot).manifest.minimumCodiffVersion;
  }
  return loadActiveToolInstall(getMonkeHome(runtime))?.manifest.minimumCodiffVersion;
}

/** Materialize through the dependency-gated Session lifecycle scheduler. */
export async function runMaterialize(runtime: Runtime) {
  const request = resolveMaterializeRequest(runtime);
  await withGlobalLockAsync(request.home, async () => {
    const execution = initializeMaterialization(runtime, request);
    await runSessionMaterialization({
      home: execution.home,
      nodes: createMaterializeNodes(execution),
      retryCommand: "mt materialize",
      rootSourceRoot: execution.context.sourceRoot,
      state: execution.sessionState
    });
  });
  createLogger(runtime).success(`Materialized session ${request.session}`);
}

function resolveMaterializeRequest(runtime: Runtime) {
  const home = getMonkeHome(runtime);
  const context = resolveRepoContext(runtime, runtime.cwd, home);
  if (context.isSourceCheckout) {
    throw new MonkeError("mt materialize must run inside a session worktree");
  }
  if (!context.sessionName) {
    throw new MonkeError("Unable to infer the current session");
  }
  return { context, home, session: context.sessionName };
}

function initializeMaterialization(
  runtime: Runtime,
  request: ReturnType<typeof resolveMaterializeRequest>
) {
  const sessionState = loadSessionState(request.home, request.context.sourceRoot, request.session);
  const graph = loadResolvedGraphForSession(runtime, request.context.sourceRoot, sessionState);
  ensureSessionPrefix(
    sessionState,
    graph.reposInMaterializationOrder.map((repo) => repo.sourceRoot)
  );
  return { ...request, reposInOrder: graph.reposInMaterializationOrder, runtime, sessionState };
}

function createMaterializeNodes(execution: ReturnType<typeof initializeMaterialization>) {
  return execution.reposInOrder.map((repoConfig) => {
    const recordedState = execution.sessionState.repos.find(
      (repo) => repo.sourceRoot === repoConfig.sourceRoot
    );
    const recordedWorktreePath =
      recordedState?.worktreePath ??
      getExpectedWorktreePath(execution.home, repoConfig.sourceRoot, execution.session);
    return {
      dependencyRoots: repoConfig.externalInOrder.map((dependency) => dependency.absoluteRepoRoot),
      initialState: createInitialRepoLifecycleState(
        repoConfig,
        recordedWorktreePath,
        recordedState
      ),
      async materialize({ checkpoint, dependencyResults, existingState, prepared }) {
        const result = await materializeRepo({
          baselinePortsRoot: prepared.baselinePortsRoot,
          dependencyResults,
          diffBaseRef: prepared.diffBaseRef,
          existingState,
          home: execution.home,
          persistRepoState: checkpoint,
          repoConfig,
          retryCommand: "mt materialize",
          rootSourceRoot: execution.context.sourceRoot,
          runtime: execution.runtime,
          session: execution.session,
          worktreePath: prepared.worktreePath
        });
        return { state: result.state, value: result };
      },
      async prepare(lifecycleState, checkpoint) {
        const prepared = await prepareMaterializeRepoWorktree(
          execution,
          repoConfig,
          (preparedPath) => {
            checkpoint({ ...lifecycleState, worktreePath: preparedPath });
          }
        );
        return {
          state: {
            ...lifecycleState,
            diffBaseRef: prepared.diffBaseRef,
            pinnedRef: prepared.pinnedRef,
            worktreePath: prepared.worktreePath
          },
          value: prepared,
          warnings: prepared.preparationWarnings
        };
      },
      reuse: toRepoMaterializationResult,
      sourceRoot: repoConfig.sourceRoot
    } satisfies SessionMaterializationNode<PreparedRepoWorktree, RepoMaterializationResult>;
  });
}

async function prepareMaterializeRepoWorktree(
  execution: ReturnType<typeof initializeMaterialization>,
  repoConfig: RepoConfig,
  onWorktreeReady: (worktreePath: string) => void
) {
  const isCurrentRepo = repoConfig.sourceRoot === execution.context.sourceRoot;
  const dependencyWorktree = isCurrentRepo
    ? null
    : await ensureSessionWorktreeAsync(
        execution.runtime,
        execution.home,
        repoConfig.sourceRoot,
        execution.session
      );
  const worktreePath = dependencyWorktree?.path ?? execution.context.worktreeRoot;
  if (isCurrentRepo) {
    validateWorktreeForSession(
      execution.runtime,
      execution.home,
      repoConfig.sourceRoot,
      worktreePath,
      execution.session
    );
  }
  onWorktreeReady(worktreePath);
  const preparationWarnings = prepareRepoWorktree(execution.runtime, repoConfig, worktreePath);
  return toPreparedMaterializeWorktree(execution, repoConfig, worktreePath, preparationWarnings);
}

function toPreparedMaterializeWorktree(
  execution: ReturnType<typeof initializeMaterialization>,
  repoConfig: RepoConfig,
  worktreePath: string,
  preparationWarnings: string[]
) {
  const existingState = execution.sessionState.repos.find(
    (repo) => repo.sourceRoot === repoConfig.sourceRoot
  );
  return {
    baselinePortsRoot:
      execution.sessionState.graphSource === "session-branch"
        ? worktreePath
        : repoConfig.sourceRoot,
    diffBaseRef: existingState?.diffBaseRef,
    pinnedRef: existingState?.pinnedRef,
    preparationWarnings,
    worktreePath
  };
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

  createLogger(runtime).success(
    `Updated Source checkout root .env for ${path.basename(context.sourceRoot)}`
  );
}

// eslint-disable-next-line complexity -- Ordered lifecycle checkpoints and repo commands stay behind this deep interface.
async function materializeRepo(options: {
  baselinePortsRoot: string;
  dependencyResults: Map<string, RepoMaterializationResult>;
  diffBaseRef?: string;
  existingState: SessionRepoState | undefined;
  home: string;
  persistRepoState: (repoState: SessionRepoState) => void;
  repoConfig: RepoConfig;
  retryCommand: string;
  rootSourceRoot: string;
  runtime: Runtime;
  session: string;
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
    worktreePath
  } = options;
  const hasBootstrapCommand = repoHasBootstrapCommand(repoConfig);
  const crossesExternalEffectCheckpoint =
    hasBootstrapCommand || repoConfig.resourceCommandsInOrder.length > 0;
  const diffBaseRef = options.diffBaseRef || existingState?.diffBaseRef;

  options.persistRepoState(
    buildSessionRepoState({
      assignedPorts: existingState?.assignedPorts ?? [],
      cleanupCommand: repoConfig.cleanupCommand,
      cleanupEligible: existingState?.cleanupEligible ?? false,
      diffBaseRef,
      existingState,
      materializationStatus: "pending",
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
        cleanupEligible: true,
        diffBaseRef,
        existingState,
        materializationStatus: "pending",
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
  let resolvedResourceCommands: Awaited<ReturnType<typeof resolveResourceCommands>> | undefined;
  if (!hasBootstrapCommand) {
    if (repoConfig.resourceCommandsInOrder.length > 0) {
      options.persistRepoState(
        buildSessionRepoState({
          assignedPorts: existingState?.assignedPorts ?? [],
          cleanupCommand: repoConfig.cleanupCommand,
          cleanupEligible: true,
          diffBaseRef,
          existingState,
          materializationStatus: "pending",
          resourceCommandOutputs: existingState?.resourceCommandOutputs ?? [],
          resourceValues: preserveStaleResourceValues(
            existingState?.resourceValues ?? [],
            resolvedResourceValues.values
          ),
          sourceRoot: repoConfig.sourceRoot,
          worktreePath
        })
      );
    }
    resolvedResourceCommands = await resolveResourceCommands({
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
        cleanupEligible: true,
        diffBaseRef,
        existingState,
        materializationStatus: "pending",
        resourceCommandOutputs: existingState?.resourceCommandOutputs ?? [],
        resourceValues: preserveStaleResourceValues(
          existingState?.resourceValues ?? [],
          resolvedResourceValues.values
        ),
        sourceRoot: repoConfig.sourceRoot,
        worktreePath
      })
    );
    await runBootstrapCommand(
      options.runtime,
      repoConfig,
      worktreePath,
      externalPathAssignments,
      options.retryCommand,
      existingResourceCommandEnvNames
    );
    resolvedResourceCommands = await resolveResourceCommands({
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
    await runBootstrapCommand(
      options.runtime,
      repoConfig,
      worktreePath,
      externalPathAssignments,
      options.retryCommand,
      []
    );
  }

  return {
    localAssignments,
    state: buildSessionRepoState({
      assignedPorts: localAssignedPorts,
      cleanupCommand: repoConfig.cleanupCommand,
      cleanupEligible: existingState?.cleanupEligible === true || crossesExternalEffectCheckpoint,
      diffBaseRef,
      existingState,
      materializationStatus: "materialized",
      resourceCommandOutputs: resolvedResourceCommands.commands,
      resourceValues: resolvedResourceValues.values,
      sourceRoot: repoConfig.sourceRoot,
      worktreePath
    })
  };
}

function prepareRepoWorktree(runtime: Runtime, repoConfig: RepoConfig, worktreePath: string) {
  const warnings: string[] = [];
  try {
    seedWorktreeFiles(repoConfig, worktreePath, (message) => {
      warnings.push(message);
      runtime.writeStderr(`${message}\n`);
    });
  } catch (error) {
    throw new MonkeError(
      `Worktree preparation failed for ${repoConfig.sourceRoot} in ${worktreePath}\n${errorMessage(error)}`
    );
  }
  return warnings;
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
  cleanupEligible: boolean;
  diffBaseRef?: string;
  existingState?: SessionRepoState;
  materializationStatus: SessionRepoState["materializationStatus"];
  resourceCommandOutputs: ResourceCommandState[];
  resourceValues: ResourceValueState[];
  sourceRoot: string;
  worktreePath: string;
}) {
  const state: SessionRepoState = {
    ...options.existingState,
    assignedPorts: options.assignedPorts,
    cleanupEligible: options.cleanupEligible,
    materializationStatus: options.materializationStatus,
    preparationStatus: options.existingState?.preparationStatus ?? "prepared",
    sourceRoot: options.sourceRoot,
    worktreePath: options.worktreePath
  };

  if (options.cleanupCommand) {
    state.cleanupCommand = options.cleanupCommand;
  } else {
    delete state.cleanupCommand;
  }

  if (options.diffBaseRef) {
    state.diffBaseRef = options.diffBaseRef;
  } else {
    delete state.diffBaseRef;
  }

  if (options.resourceValues.length > 0) {
    state.resourceValues = options.resourceValues;
  } else {
    delete state.resourceValues;
  }

  if (options.resourceCommandOutputs.length > 0) {
    state.resourceCommandOutputs = options.resourceCommandOutputs;
  } else {
    delete state.resourceCommandOutputs;
  }

  return state;
}

function createInitialRepoLifecycleState(
  repoConfig: Pick<RepoConfig, "cleanupCommand" | "sourceRoot">,
  worktreePath: string,
  existingState?: SessionRepoState
): SessionRepoState {
  return {
    ...existingState,
    assignedPorts: existingState?.assignedPorts ?? [],
    cleanupCommand: repoConfig.cleanupCommand,
    cleanupEligible: existingState?.cleanupEligible ?? false,
    materializationStatus: existingState?.materializationStatus ?? "pending",
    preparationStatus: existingState?.preparationStatus ?? "pending",
    sourceRoot: repoConfig.sourceRoot,
    worktreePath
  };
}

function toRepoMaterializationResult(state: SessionRepoState): RepoMaterializationResult {
  return {
    localAssignments: new Map(state.assignedPorts.map((entry) => [entry.key, entry.value])),
    state
  };
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

async function runBootstrapCommand(
  runtime: Runtime,
  repoConfig: RepoConfig,
  worktreePath: string,
  externalPathAssignments: { env: string; value: string }[],
  retryCommand: string,
  unsetEnvNames: string[]
) {
  if (!repoConfig.bootstrapCommand) {
    return;
  }

  createLogger(runtime).info(`Bootstrapping ${repoConfig.sourceRoot} in ${worktreePath}`);
  try {
    await runtime.execAsync("sh", ["-c", repoConfig.bootstrapCommand], {
      cwd: worktreePath,
      env: Object.fromEntries([
        ...externalPathAssignments.map((assignment) => [assignment.env, assignment.value] as const),
        ...unsetEnvNames.map((env) => [env, undefined] as const)
      ])
    });
  } catch (error) {
    const detail = errorMessage(error);
    throw new BootstrapCommandError(
      `Bootstrap command failed for ${repoConfig.sourceRoot}: ${repoConfig.bootstrapCommand}\n${detail}\nPartial Session state was kept; fix the command and re-run ${retryCommand} to resume from this repo.`
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
