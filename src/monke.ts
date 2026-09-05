import { existsSync, readFileSync } from "node:fs";
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
import { syncRootEnvFileWithRemovals, seedWorktreeFiles } from "./env.ts";
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
  runGit,
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
import {
  createInitialRepoLifecycleState,
  materializeRepo,
  toRepoMaterializationResult
} from "./repo-materialization.ts";
import { getMonkeHome, withGlobalLock, withGlobalLockAsync } from "./runtime.ts";
import {
  applyDirtySnapshot,
  assertDirtyCarryBoundary,
  captureDirtySnapshot,
  captureDirtySnapshots,
  dirtySnapshotHasContent,
  warnDirtyStateNotCarried
} from "./session-dirty-carry.ts";
import type { DirtySnapshot } from "./session-dirty-carry.ts";
import { finalizeSession } from "./session-finalization.ts";
import { formatFailureReceipt, runSessionMaterialization } from "./session-materialization.ts";
import type { SessionMaterializationNode } from "./session-materialization.ts";
import {
  ensureSessionPrefix,
  getSessionStateFilePath,
  SessionStateStore
} from "./session-state-store.ts";
import { requestShellDirectory } from "./shell.ts";
import type {
  RepoConfig,
  RepoMaterializationResult,
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

interface PreparedRepoWorktree {
  baselinePortsRoot: string;
  diffBaseRef?: string;
  pinnedRef?: string;
  preparationWarnings: string[];
  worktreePath: string;
}

interface RepoLifecycleNodeContext {
  home: string;
  retryCommand: string;
  rootSourceRoot: string;
  runtime: Runtime;
  session: string;
  store: SessionStateStore;
}

type PrepareRepoLifecycleNode = SessionMaterializationNode<
  PreparedRepoWorktree,
  RepoMaterializationResult
>["prepare"];

interface ConfiguredSpawn {
  dirtySnapshots: Map<string, DirtySnapshot>;
  getDefaultRef: (sourceRoot: string) => PinnedDefaultBranchRef;
  home: string;
  reposInOrder: RepoConfig[];
  rootSourceRoot: string;
  rootWorktreePath: string;
  runtime: Runtime;
  session: string;
  sessionState: SessionState;
  sourcePlan: SpawnSourcePlan;
  store: SessionStateStore;
}

interface PinnedDefaultBranchRef extends DefaultBranchRef {
  pinnedRef: string;
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

/** Create or update a Session through bounded Worktree preparation. */
export async function runSpawn(
  runtime: Runtime,
  session: string,
  spawnOptions: SpawnOptions,
  runOptions: SpawnRunOptions = {}
) {
  const { context, home } = resolveSpawnContext(runtime, session);
  // The locked spawn throws unless every repo materialized, so reaching here means success.
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

/** Create or update a Session while the caller holds the Monke global lock. */
export async function spawnSessionFromSourceRootLocked(
  runtime: Runtime,
  home: string,
  rootSourceRoot: string,
  session: string,
  spawnOptions: SpawnOptions
) {
  const store = new SessionStateStore(home);
  const execution = await prepareSpawn(runtime, store, rootSourceRoot, session, spawnOptions);
  await runSessionMaterialization({
    nodes: createSpawnMaterializationNodes(execution),
    onCheckpoint: execution.runtime.sessionMaterializationBoundary,
    retryCommand: formatSpawnRetryCommand(execution.session, execution.sourcePlan.spawnOptions),
    rootSourceRoot: execution.rootSourceRoot,
    state: execution.sessionState,
    store
  });
  return execution.rootWorktreePath;
}

async function prepareSpawn(
  runtime: Runtime,
  store: SessionStateStore,
  rootSourceRoot: string,
  session: string,
  spawnOptions: SpawnOptions
) {
  const { home } = store;
  const retainedState = store.get(rootSourceRoot, session);
  const sourcePlan = resolveSpawnSourcePlan(retainedState, session, spawnOptions);
  assertSpawnRequest(runtime, rootSourceRoot, session, sourcePlan.spawnOptions);
  const rootWorktreePath = getExpectedWorktreePath(home, rootSourceRoot, session);
  const getDefaultRef = createDefaultRefResolver(runtime);
  const rootDefaultRef =
    sourcePlan.kind === "default-branch" && sourcePlan.attempt === "fresh"
      ? getDefaultRef(rootSourceRoot)
      : null;
  const resumedState =
    sourcePlan.kind === "default-branch" && sourcePlan.attempt === "resume"
      ? retainedState
      : undefined;
  let rootConfigRef = rootDefaultRef?.pinnedRef;
  if (rootConfigRef === undefined && resumedState) {
    rootConfigRef = requirePinnedRef(resumedState, rootSourceRoot);
  } else if (rootConfigRef === undefined && sourcePlan.kind === "session-branch") {
    rootConfigRef = session;
  }
  const rootConfigExists = spawnRootConfigExists(runtime, rootSourceRoot, rootConfigRef);
  if (!rootConfigExists) {
    if (retainedState && !isConfiglessPreparedState(retainedState)) {
      throw new MonkeError(
        [
          `monke.yml is missing for retained configured Session ${session} at ${rootSourceRoot}.`,
          "The retained Session state and Cleanup obligations were preserved.",
          `Retry: ${formatSpawnRetryCommand(session, sourcePlan.spawnOptions)}`
        ].join("\n")
      );
    }
    return await spawnWithoutConfig(
      runtime,
      store,
      rootSourceRoot,
      session,
      sourcePlan,
      rootDefaultRef
    );
  }

  const graph = loadSpawnGraph(
    runtime,
    rootSourceRoot,
    session,
    sourcePlan,
    getDefaultRef,
    resumedState
  );
  const prepared = prepareSpawnMaterialization(
    runtime,
    store,
    rootSourceRoot,
    session,
    sourcePlan,
    graph.reposInMaterializationOrder
  );
  return {
    ...prepared,
    getDefaultRef,
    home,
    reposInOrder: graph.reposInMaterializationOrder,
    rootSourceRoot,
    rootWorktreePath,
    runtime,
    session,
    sourcePlan,
    store
  } satisfies ConfiguredSpawn;
}

function isConfiglessPreparedState(state: SessionState) {
  const [repo] = state.repos;
  return (
    state.generation.number === 0 &&
    state.generation.status === "not-started" &&
    state.repos.length === 1 &&
    repo?.sourceRoot === state.rootSourceRoot &&
    repo.materializationStatus === "pending" &&
    (repo.preparationStatus === "prepared" ||
      repo.preparationStatus === "warning" ||
      repo.preparationStatus === "pending") &&
    !repo.cleanupEligible &&
    repo.cleanupCommand === undefined &&
    repo.assignedPorts.length === 0 &&
    repo.resourceCommandOutputs === undefined &&
    repo.resourceValues === undefined
  );
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
    const dirtySnapshot = execution.dirtySnapshots.get(repoConfig.sourceRoot);
    const tracksDirtyCarry =
      initialState.dirtyCarryStatus === "pending" ||
      (dirtySnapshot !== undefined &&
        dirtySnapshotHasContent(dirtySnapshot) &&
        !existsSync(initialState.worktreePath));
    if (tracksDirtyCarry) {
      initialState.dirtyCarryStatus = "pending";
    }
    if (
      execution.sourcePlan.kind === "default-branch" &&
      execution.sourcePlan.attempt === "fresh"
    ) {
      const defaultRef = execution.getDefaultRef(repoConfig.sourceRoot);
      initialState.diffBaseRef = defaultRef.ref;
      initialState.pinnedRef = defaultRef.pinnedRef;
    }
    return createRepoLifecycleNode({
      context: {
        home: execution.home,
        retryCommand: formatSpawnRetryCommand(execution.session, execution.sourcePlan.spawnOptions),
        rootSourceRoot: execution.rootSourceRoot,
        runtime: execution.runtime,
        session: execution.session,
        store: execution.store
      },
      initialState,
      prepare: async (lifecycleState, checkpoint) => {
        const prepared = await prepareSpawnRepoWorktree({
          dirtySnapshot,
          existingState: lifecycleState,
          home: execution.home,
          onWorktreeReady(worktree) {
            checkpoint({
              ...lifecycleState,
              diffBaseRef: worktree.diffBaseRef,
              dirtyCarryStatus: tracksDirtyCarry ? "complete" : lifecycleState.dirtyCarryStatus,
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
            dirtyCarryStatus: tracksDirtyCarry ? "complete" : lifecycleState.dirtyCarryStatus,
            pinnedRef: prepared.pinnedRef,
            worktreePath: prepared.worktreePath
          },
          value: prepared,
          warnings: prepared.preparationWarnings
        };
      },
      repoConfig
    });
  });
}

function createRepoLifecycleNode(options: {
  context: RepoLifecycleNodeContext;
  initialState: SessionRepoState;
  prepare: PrepareRepoLifecycleNode;
  repoConfig: RepoConfig;
}) {
  const { context, repoConfig } = options;
  return {
    dependencyRoots: repoConfig.externalInOrder.map((dependency) => dependency.absoluteRepoRoot),
    initialState: options.initialState,
    async materialize({ checkpoint, dependencyResults, existingState, prepared }) {
      const result = await materializeRepo({
        baselinePortsRoot: prepared.baselinePortsRoot,
        dependencyResults,
        diffBaseRef: prepared.diffBaseRef,
        existingState,
        persistRepoState: checkpoint,
        repoConfig,
        retryCommand: context.retryCommand,
        rootSourceRoot: context.rootSourceRoot,
        runtime: context.runtime,
        session: context.session,
        store: context.store,
        worktreePath: prepared.worktreePath
      });
      return { state: result.state, value: result };
    },
    async prepare(existingState, checkpoint) {
      if (existingState.materializationStatus === "materialized") {
        validateWorktreeForSession(
          context.runtime,
          context.home,
          repoConfig.sourceRoot,
          existingState.worktreePath,
          context.session
        );
      }
      return await options.prepare(existingState, checkpoint);
    },
    reuse: toRepoMaterializationResult,
    sourceRoot: repoConfig.sourceRoot
  } satisfies SessionMaterializationNode<PreparedRepoWorktree, RepoMaterializationResult>;
}

interface SpawnRepoPreparationRequest {
  dirtySnapshot?: DirtySnapshot;
  existingState: SessionRepoState | undefined;
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
  const { createdDiffBaseRef, useWorktreeBaseline, worktree } = await ensureSpawnWorktree({
    ...request,
    sourceRoot: repoConfig.sourceRoot
  });
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

interface SpawnWorktreeRequest {
  dirtySnapshot?: DirtySnapshot;
  existingState: SessionRepoState | undefined;
  home: string;
  rootSourceRoot: string;
  runtime: Runtime;
  session: string;
  sourcePlan: SpawnSourcePlan;
  sourceRoot: string;
}

async function ensureSpawnWorktree(request: SpawnWorktreeRequest) {
  const { existingState, home, rootSourceRoot, runtime, session, sourcePlan, sourceRoot } = request;
  const expectedWorktreePath = getExpectedWorktreePath(home, sourceRoot, session);
  const resumesDirtyCarry = existingState?.dirtyCarryStatus === "pending";
  if (resumesDirtyCarry && existsSync(expectedWorktreePath)) {
    validateWorktreeForSession(runtime, home, sourceRoot, expectedWorktreePath, session);
  }
  const useWorktreeBaseline =
    (sourcePlan.kind === "default-branch" && sourcePlan.attempt === "resume") ||
    (sourcePlan.kind === "session-branch" && sourceRoot === rootSourceRoot);
  if (
    sourcePlan.kind === "default-branch" &&
    (sourcePlan.attempt === "fresh" || !branchExists(runtime, sourceRoot, session))
  ) {
    const pinnedRef = requireRepoPinnedRef(existingState, sourceRoot);
    return {
      createdDiffBaseRef: existingState?.diffBaseRef,
      useWorktreeBaseline,
      worktree: await ensureFreshSessionWorktreeFromRefAsync(
        runtime,
        home,
        sourceRoot,
        session,
        pinnedRef
      )
    };
  }

  const sessionBranchExisted = branchExists(runtime, sourceRoot, session);
  const sourceHeadRef = resolveAttachedHeadRef(runtime, sourceRoot);
  const worktree = await ensureSessionWorktreeAsync(runtime, home, sourceRoot, session, {
    skipCleanCheck: shouldCopyDirty(sourcePlan.spawnOptions)
  });
  if (request.dirtySnapshot && (worktree.created || resumesDirtyCarry)) {
    await applyDirtySnapshot(runtime, home, sourceRoot, worktree.path, request.dirtySnapshot);
  } else if (request.dirtySnapshot && dirtySnapshotHasContent(request.dirtySnapshot)) {
    warnDirtyStateNotCarried(runtime, sourceRoot, session);
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
  state: SessionState | undefined,
  session: string,
  spawnOptions: SpawnOptions
): SpawnSourcePlan {
  if (state && state.generation.status === "complete") {
    const retainedOptions = retainedSpawnOptions(state);
    // A completed Session pins its source identity only. Dirty-carry policy is not part of that
    // identity, so changing it alone re-spawns the same Session rather than failing.
    if (
      spawnOptions.mode === "default-branch" ||
      !sameSpawnSourceIdentity(spawnOptions, retainedOptions)
    ) {
      throw new MonkeError(
        `Session ${session} is a completed Session using ${formatSpawnPolicy(retainedOptions)}; use a new Session name to change or refresh its source identity`
      );
    }
  }
  if (state && state.generation.status !== "complete") {
    const retainedOptions = retainedSpawnOptions(state);
    if (!isImplicitSpawnRequest(spawnOptions) && !sameSpawnOptions(spawnOptions, retainedOptions)) {
      throw new MonkeError(
        `Session ${session} has an incomplete Spawn using ${formatSpawnPolicy(retainedOptions)}; retry with ${formatSpawnRetryCommand(session, retainedOptions)}`
      );
    }
    if (retainedOptions.mode === "default-branch") {
      return { attempt: "resume", kind: "default-branch", spawnOptions: retainedOptions };
    }
    if (retainedOptions.mode === "session-branch") {
      return { kind: "session-branch", spawnOptions: retainedOptions };
    }
    return { kind: "current-head", spawnOptions: retainedOptions };
  }
  if (spawnOptions.mode === "current-head") {
    return { kind: "current-head", spawnOptions };
  }
  if (spawnOptions.mode === "session-branch") {
    return { kind: "session-branch", spawnOptions };
  }
  if (!state) {
    return { attempt: "fresh", kind: "default-branch", spawnOptions };
  }

  throw new MonkeError(
    `Session state already exists for "${session}"; default branch spawn mode requires a fresh Session`
  );
}

/** Validate that a retained Session permits the requested Spawn source policy. */
export function assertSpawnSourcePolicy(
  home: string,
  rootSourceRoot: string,
  session: string,
  spawnOptions: SpawnOptions
) {
  const state = new SessionStateStore(home).get(rootSourceRoot, session);
  resolveSpawnSourcePlan(state, session, spawnOptions);
}

function retainedSpawnOptions(state: SessionState): SpawnOptions {
  if (state.spawnSource === "default-branch") {
    return { mode: "default-branch" };
  }
  if (state.spawnSource === "session-branch") {
    return { mode: "session-branch" };
  }
  return { copyDirty: state.copyDirty ?? true, mode: "current-head" };
}

function isImplicitSpawnRequest(options: SpawnOptions) {
  return options.mode === "current-head" && options.copyDirty;
}

/** Whether two Spawn requests resolve their worktrees from the same source. */
function sameSpawnSourceIdentity(left: SpawnOptions, right: SpawnOptions) {
  return left.mode === right.mode;
}

function sameSpawnOptions(left: SpawnOptions, right: SpawnOptions) {
  return (
    left.mode === right.mode &&
    (left.mode !== "current-head" ||
      (right.mode === "current-head" && left.copyDirty === right.copyDirty))
  );
}

function formatSpawnPolicy(options: SpawnOptions) {
  if (options.mode === "default-branch") {
    return "the pinned default branch";
  }
  if (options.mode === "session-branch") {
    return "the retained Session branch";
  }
  return options.copyDirty ? "current HEAD with dirty carry" : "clean current HEAD";
}

function formatSpawnRetryCommand(session: string, options: SpawnOptions) {
  if (options.mode === "default-branch") {
    return `mt spawn ${session} -m`;
  }
  if (options.mode === "current-head" && !options.copyDirty) {
    return `mt spawn ${session} --no-dirty`;
  }
  return `mt spawn ${session}`;
}

function createDefaultRefResolver(
  runtime: Runtime
): (sourceRoot: string) => PinnedDefaultBranchRef {
  const defaultRefs = new Map<string, PinnedDefaultBranchRef>();
  return (sourceRoot) => {
    const cached = defaultRefs.get(sourceRoot);
    if (cached !== undefined) {
      return cached;
    }
    const defaultRef = resolveDefaultBranchRef(runtime, sourceRoot);
    const resolved = {
      ...defaultRef,
      pinnedRef: runGit(runtime, sourceRoot, ["rev-parse", `${defaultRef.ref}^{commit}`]).trim()
    };
    defaultRefs.set(sourceRoot, resolved);
    return resolved;
  };
}

function spawnRootConfigExists(
  runtime: Runtime,
  rootSourceRoot: string,
  configRef: string | undefined
) {
  if (configRef !== undefined) {
    return gitPathExistsAtRef(runtime, rootSourceRoot, configRef, "monke.yml");
  }
  return existsSync(path.join(rootSourceRoot, "monke.yml"));
}

/** Everything one config-less Spawn needs to prepare and record its Root repo Session worktree. */
interface ConfiglessSpawn {
  existingRepoState?: SessionRepoState;
  home: string;
  rootDefaultRef: PinnedDefaultBranchRef | null;
  rootSourceRoot: string;
  runtime: Runtime;
  session: string;
  sourcePlan: SpawnSourcePlan;
}

async function spawnWithoutConfig(
  runtime: Runtime,
  store: SessionStateStore,
  rootSourceRoot: string,
  session: string,
  sourcePlan: SpawnSourcePlan,
  rootDefaultRef: PinnedDefaultBranchRef | null
): Promise<never> {
  const { home } = store;
  assertNoGlobalWorktreePathStateCollisions(store, session, [{ sourceRoot: rootSourceRoot }]);
  const priorSessionState = store.get(rootSourceRoot, session);
  const spawn: ConfiglessSpawn = {
    existingRepoState: priorSessionState?.repos.find((repo) => repo.sourceRoot === rootSourceRoot),
    home,
    rootDefaultRef,
    rootSourceRoot,
    runtime,
    session,
    sourcePlan
  };
  const dirtySnapshot = captureConfiglessDirtySnapshot(spawn);
  const pendingWorktree = prepareConfiglessWorktreeCheckpoint(spawn);
  const tracksDirtyCarry =
    spawn.existingRepoState?.dirtyCarryStatus === "pending" ||
    (dirtySnapshot !== null &&
      dirtySnapshotHasContent(dirtySnapshot) &&
      !existsSync(pendingWorktree.worktreePath));
  const pendingState = createConfiglessSessionState(spawn, {
    dirtyCarryStatus: tracksDirtyCarry ? "pending" : spawn.existingRepoState?.dirtyCarryStatus,
    preparationStatus: "pending",
    prepared: pendingWorktree,
    priorSessionState
  });
  store.checkpoint(pendingState);
  const prepared = {
    ...pendingWorktree,
    ...(await prepareConfiglessWorktree(spawn, dirtySnapshot, pendingState.repos[0]))
  };
  const preparedSessionState = createConfiglessSessionState(spawn, {
    dirtyCarryStatus: tracksDirtyCarry ? "complete" : spawn.existingRepoState?.dirtyCarryStatus,
    preparationStatus: "prepared",
    prepared,
    priorSessionState
  });
  store.checkpoint(preparedSessionState);
  failConfiglessSpawn(spawn, preparedSessionState);
}

async function prepareConfiglessWorktree(
  spawn: ConfiglessSpawn,
  dirtySnapshot: DirtySnapshot | null,
  existingState: SessionRepoState | undefined
) {
  const { worktree } = await ensureSpawnWorktree({
    dirtySnapshot: dirtySnapshot ?? undefined,
    existingState,
    home: spawn.home,
    rootSourceRoot: spawn.rootSourceRoot,
    runtime: spawn.runtime,
    session: spawn.session,
    sourcePlan: spawn.sourcePlan,
    sourceRoot: spawn.rootSourceRoot
  });
  return { worktreePath: worktree.path };
}

function prepareConfiglessWorktreeCheckpoint(spawn: ConfiglessSpawn) {
  const sessionBranchExisted = branchExists(spawn.runtime, spawn.rootSourceRoot, spawn.session);
  return {
    diffBaseRef:
      spawn.existingRepoState?.diffBaseRef ??
      spawn.rootDefaultRef?.ref ??
      resolveFreshCurrentHeadDiffBase({
        sessionBranchExisted,
        sourceHeadRef: resolveAttachedHeadRef(spawn.runtime, spawn.rootSourceRoot),
        spawnOptions: spawn.sourcePlan.spawnOptions
      }),
    pinnedRef: spawn.rootDefaultRef?.pinnedRef ?? spawn.existingRepoState?.pinnedRef,
    worktreePath: getExpectedWorktreePath(spawn.home, spawn.rootSourceRoot, spawn.session)
  };
}

function captureConfiglessDirtySnapshot(spawn: ConfiglessSpawn) {
  if (
    spawn.sourcePlan.spawnOptions.mode === "current-head" &&
    !spawn.sourcePlan.spawnOptions.copyDirty
  ) {
    ensureCleanCheckout(spawn.runtime, spawn.rootSourceRoot);
  }
  if (!shouldCopyDirty(spawn.sourcePlan.spawnOptions)) {
    return null;
  }
  const snapshot = captureDirtySnapshot(spawn.runtime, spawn.rootSourceRoot);
  assertDirtyCarryBoundary(
    spawn.runtime,
    spawn.home,
    spawn.rootSourceRoot,
    spawn.session,
    snapshot
  );
  return snapshot;
}

function resolveFreshCurrentHeadDiffBase(options: {
  sessionBranchExisted: boolean;
  sourceHeadRef?: string;
  spawnOptions: SpawnOptions;
}) {
  return !options.sessionBranchExisted &&
    options.sourceHeadRef !== undefined &&
    options.spawnOptions.mode === "current-head"
    ? options.sourceHeadRef
    : undefined;
}

function createConfiglessSessionState(
  spawn: ConfiglessSpawn,
  options: {
    dirtyCarryStatus?: "complete" | "pending";
    preparationStatus: "pending" | "prepared";
    prepared: { diffBaseRef?: string; pinnedRef?: string; worktreePath: string };
    priorSessionState: SessionState | undefined;
  }
): SessionState {
  const { prepared } = options;
  const {
    rootSourceRoot,
    sourcePlan: { spawnOptions }
  } = spawn;
  return {
    ...options.priorSessionState,
    copyDirty: spawnOptions.mode === "current-head" ? spawnOptions.copyDirty : undefined,
    generation: { number: 0, status: "not-started" },
    graphSource: spawnOptions.mode === "current-head" ? undefined : "session-branch",
    repos: [
      createInitialRepoLifecycleState(
        { cleanupCommand: undefined, sourceRoot: rootSourceRoot },
        prepared.worktreePath,
        {
          ...spawn.existingRepoState,
          assignedPorts: [],
          cleanupEligible: false,
          diffBaseRef: prepared.diffBaseRef,
          dirtyCarryStatus: options.dirtyCarryStatus,
          materializationStatus: "pending",
          pinnedRef: spawnOptions.mode === "default-branch" ? prepared.pinnedRef : undefined,
          preparationStatus: options.preparationStatus,
          sourceRoot: rootSourceRoot,
          worktreePath: prepared.worktreePath
        }
      )
    ],
    rootSourceRoot,
    session: spawn.session,
    spawnSource: spawnOptions.mode === "current-head" ? undefined : spawnOptions.mode,
    version: 2
  };
}

function failConfiglessSpawn(spawn: ConfiglessSpawn, state: SessionState): never {
  spawn.runtime.writeStderr(
    `Warning: no monke.yml found for ${spawn.rootSourceRoot}; prepared session worktree without materializing it.\n`
  );
  throw new MonkeError(
    formatFailureReceipt(state, {
      retryCommand: formatSpawnRetryCommand(spawn.session, spawn.sourcePlan.spawnOptions),
      rootSourceRoot: spawn.rootSourceRoot
    })
  );
}

function loadSpawnGraph(
  runtime: Runtime,
  rootSourceRoot: string,
  session: string,
  sourcePlan: SpawnSourcePlan,
  getDefaultRef: (sourceRoot: string) => PinnedDefaultBranchRef,
  resumedState: SessionState | undefined
) {
  if (sourcePlan.kind === "default-branch") {
    if (sourcePlan.attempt === "resume") {
      if (!resumedState) {
        throw new MonkeError(`Missing retained Session state for ${session}`);
      }
      return loadGraphAtRefs(runtime, rootSourceRoot, (sourceRoot) =>
        requirePinnedRef(resumedState, sourceRoot)
      );
    }
    return loadGraphAtRefs(
      runtime,
      rootSourceRoot,
      (sourceRoot) => getDefaultRef(sourceRoot).pinnedRef
    );
  }
  if (sourcePlan.kind === "session-branch") {
    return loadGraphAtRefs(runtime, rootSourceRoot, (sourceRoot) =>
      sourceRoot === rootSourceRoot ? session : undefined
    );
  }
  return loadResolvedGraph(runtime, rootSourceRoot);
}

/** A missing ref means read that repo's Source checkout; all ref-backed reads share one adapter. */
function loadGraphAtRefs(
  runtime: Runtime,
  rootSourceRoot: string,
  refForRepo: (sourceRoot: string) => string | undefined
) {
  return loadResolvedGraph(runtime, rootSourceRoot, {
    pathExists(sourceRoot, relativePath) {
      const ref = refForRepo(sourceRoot);
      return ref === undefined
        ? existsSync(path.join(sourceRoot, relativePath))
        : gitPathExistsAtRef(runtime, sourceRoot, ref, relativePath);
    },
    readRepoConfig(sourceRoot) {
      const ref = refForRepo(sourceRoot);
      return ref === undefined
        ? readFileSync(path.join(sourceRoot, "monke.yml"), "utf-8")
        : readGitPathAtRef(runtime, sourceRoot, ref, "monke.yml");
    }
  });
}

function requirePinnedRef(state: SessionState, sourceRoot: string) {
  return requireRepoPinnedRef(
    state.repos.find((repo) => repo.sourceRoot === sourceRoot),
    sourceRoot
  );
}

function requireRepoPinnedRef(repo: SessionRepoState | undefined, sourceRoot: string) {
  if (!repo?.pinnedRef) {
    throw new MonkeError(`Missing pinned default-branch ref for ${sourceRoot}`);
  }
  return repo.pinnedRef;
}

function prepareSpawnMaterialization(
  runtime: Runtime,
  store: SessionStateStore,
  rootSourceRoot: string,
  session: string,
  sourcePlan: SpawnSourcePlan,
  reposInOrder: RepoConfig[]
) {
  const { home } = store;
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

  const sessionState =
    store.get(rootSourceRoot, session) ??
    createNewSessionState(home, rootSourceRoot, session, reposInOrder);
  sessionState.copyDirty =
    sourcePlan.kind === "current-head" ? sourcePlan.spawnOptions.copyDirty : undefined;
  sessionState.graphSource = sourcePlan.kind === "current-head" ? undefined : "session-branch";
  sessionState.spawnSource = sourcePlan.kind === "current-head" ? undefined : sourcePlan.kind;
  ensureSessionPrefix(
    sessionState,
    reposInOrder.map((repo) => repo.sourceRoot)
  );
  assertUniqueExpectedWorktreePaths(home, session, reposInOrder);
  assertNoGlobalWorktreePathStateCollisions(store, session, reposInOrder);
  if (sourcePlan.kind === "default-branch" && sourcePlan.attempt === "fresh") {
    for (const repoConfig of reposInOrder) {
      assertFreshSessionWorktreeAvailable(runtime, home, repoConfig.sourceRoot, session);
    }
  }

  return { dirtySnapshots, sessionState };
}

function createNewSessionState(
  home: string,
  rootSourceRoot: string,
  session: string,
  reposInOrder: RepoConfig[]
): SessionState {
  return {
    generation: { number: 0, status: "not-started" },
    repos: reposInOrder.map((repo) =>
      createInitialRepoLifecycleState(repo, getExpectedWorktreePath(home, repo.sourceRoot, session))
    ),
    rootSourceRoot,
    session,
    version: 2
  };
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
    ensureCleanCheckout(runtime, repoConfig.sourceRoot);
  }
}

function assertNoGlobalWorktreePathStateCollisions(
  store: SessionStateStore,
  session: string,
  repoConfigs: { sourceRoot: string }[]
) {
  const { home } = store;
  const states = store.list();
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
  sessionState: SessionState | undefined
) {
  if (sessionState?.graphSource !== "session-branch" || sessionState.repos.length === 0) {
    return loadResolvedGraph(runtime, rootSourceRoot);
  }

  const sessionRepoRoots = new Set(sessionState.repos.map((repo) => repo.sourceRoot));
  return loadGraphAtRefs(runtime, rootSourceRoot, (sourceRoot) =>
    sessionRepoRoots.has(sourceRoot) ? sessionState.session : undefined
  );
}

/** Install or verify runtime dependencies used by mt. */
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
    const store = new SessionStateStore(request.home);
    const execution = initializeMaterialization(runtime, request, store);
    await runSessionMaterialization({
      nodes: createMaterializeNodes(execution),
      onCheckpoint: runtime.sessionMaterializationBoundary,
      retryCommand: "mt materialize",
      rootSourceRoot: execution.context.sourceRoot,
      state: execution.sessionState,
      store
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
  request: ReturnType<typeof resolveMaterializeRequest>,
  store: SessionStateStore
) {
  const retainedState = store.get(request.context.sourceRoot, request.session);
  const graph = loadResolvedGraphForSession(runtime, request.context.sourceRoot, retainedState);
  const sessionState =
    retainedState ??
    createNewSessionState(
      request.home,
      request.context.sourceRoot,
      request.session,
      graph.reposInMaterializationOrder
    );
  ensureSessionPrefix(
    sessionState,
    graph.reposInMaterializationOrder.map((repo) => repo.sourceRoot)
  );
  return {
    ...request,
    reposInOrder: graph.reposInMaterializationOrder,
    runtime,
    sessionState,
    store
  };
}

function createMaterializeNodes(execution: ReturnType<typeof initializeMaterialization>) {
  return execution.reposInOrder.map((repoConfig) => {
    const recordedState = execution.sessionState.repos.find(
      (repo) => repo.sourceRoot === repoConfig.sourceRoot
    );
    const recordedWorktreePath =
      recordedState?.worktreePath ??
      getExpectedWorktreePath(execution.home, repoConfig.sourceRoot, execution.session);
    return createRepoLifecycleNode({
      context: {
        home: execution.home,
        retryCommand: "mt materialize",
        rootSourceRoot: execution.context.sourceRoot,
        runtime: execution.runtime,
        session: execution.session,
        store: execution.store
      },
      initialState: createInitialRepoLifecycleState(
        repoConfig,
        recordedWorktreePath,
        recordedState
      ),
      prepare: async (lifecycleState, checkpoint) => {
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
      repoConfig
    });
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
    const store = new SessionStateStore(home);
    if (options.mode === "merged") {
      mergedResults.push(
        ...cleanupMergedWorktrees(runtime, store, context.sourceRoot, options.dryRun)
      );
    }

    if (!dryRun) {
      removedDeadSessions = removeDeadSessionStates(runtime, store, context.sourceRoot);
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
  store: SessionStateStore,
  rootSourceRoot: string,
  dryRun: boolean
) {
  const results: MergedCleanupResult[] = [];
  const cache = createMergedCleanupLookupCache();

  for (const state of store.list()) {
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

function removeDeadSessionStates(
  runtime: Runtime,
  store: SessionStateStore,
  rootSourceRoot: string
) {
  const { home } = store;
  let removed = 0;
  const failures: { detail: string; session: string; stateFile: string }[] = [];

  for (const state of store.list()) {
    if (state.rootSourceRoot !== rootSourceRoot) {
      continue;
    }

    const allGone = state.repos.every((repo) => !existsSync(repo.worktreePath));
    if (!allGone) {
      continue;
    }

    try {
      finalizeSession(runtime, store, state);
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

  syncRootEnvFileWithRemovals(
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

function prepareRepoWorktree(runtime: Runtime, repoConfig: RepoConfig, worktreePath: string) {
  const warnings: string[] = [];
  try {
    seedWorktreeFiles(repoConfig, worktreePath, (message) => {
      warnings.push(message);
      runtime.writeStderr(`${message}\n`);
    });
  } catch (error) {
    throw new MonkeError(
      `Worktree preparation failed for ${repoConfig.sourceRoot} in ${worktreePath}\n${errorMessage(error)}`,
      { cause: error }
    );
  }
  return warnings;
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
