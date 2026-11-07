import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { openCodexWorkspace } from "./codex.ts";
import { reconcileCodiff } from "./codiff.ts";
import { loadResolvedGraph } from "./config.ts";
import { seedWorktreeFiles } from "./env.ts";
import { errorMessage, MonkeError, ThrownValueSchema } from "./errors.ts";
import {
  assertFreshSessionWorktreeAvailable,
  branchExists,
  ensureCleanCheckout,
  ensureSessionWorktreeAsync,
  ensureFreshSessionWorktreeFromRefAsync,
  getExpectedWorktreePath,
  resolveDefaultBranchRef,
  resolveCheckoutSource,
  resolveStartRef,
  resolveRepoContext,
  runGit,
  validateWorktreeForSession
} from "./git.ts";
import type { CheckoutSource, PinnedStartRef } from "./git.ts";
import {
  INSTALL_MANIFEST_FILENAME,
  loadActiveToolInstall,
  loadToolInstall
} from "./install-manifest.ts";
import { createLogger } from "./logger.ts";
import { samePath } from "./path-identity.ts";
import { reconcileProjectSkills } from "./project-skills.ts";
import {
  createInitialRepoLifecycleState,
  materializeRepo,
  toRepoMaterializationResult
} from "./repo-materialization.ts";
import { runCheckoutSetup } from "./resource-lifecycle.ts";
import { getMonkeHome, withGlobalLockAsync } from "./runtime.ts";
import {
  applyDirtySnapshot,
  assertDirtyCarryBoundary,
  assertDirtyCarrySource,
  dirtyCarrySource,
  captureDirtySnapshot,
  dirtySnapshotHasContent,
  warnDirtyStateNotCarried
} from "./session-dirty-carry.ts";
import type { DirtySnapshot } from "./session-dirty-carry.ts";
import { formatFailureReceipt, runSessionMaterialization } from "./session-materialization.ts";
import type { SessionMaterializationNode } from "./session-materialization.ts";
import {
  ensureSessionPrefix,
  getSessionStateFilePath,
  loadSessionState,
  SessionStateStore
} from "./session-state-store.ts";
import { shellQuote } from "./shell-quote.ts";
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
      /** Spawn from the invoking checkout's current HEAD. */
      mode: "current-head";
    }
  | {
      /** Spawn from an existing branch named after the Session. */
      mode: "session-branch";
    }
  | {
      /** Root repo start ref; defaults to its default branch. */
      from?: string;
      /** Spawn from pinned start refs: `from` for the Root repo, default branches for the rest. */
      mode: "default-branch";
    };

type SpawnSourcePlan =
  | Extract<SpawnOptions, { mode: "current-head" | "session-branch" }>
  | { attempt: "fresh" | "resume"; from?: string; mode: "default-branch" };

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
  checkoutSources: Map<string, CheckoutSource>;
  dirtySnapshots: Map<string, DirtySnapshot>;
  getStartRef: (sourceRoot: string) => PinnedStartRef;
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
    spawnSessionLocked({
      home,
      rootCheckoutRoot: context.worktreeRoot,
      rootSourceRoot: context.sourceRoot,
      runtime,
      session,
      spawnOptions
    })
  );

  finishSpawn(runtime, session, rootWorktreePath, runOptions);
}

function resolveSpawnContext(runtime: Runtime, session: string) {
  if (!session) {
    throw new MonkeError("mt spawn requires a session name");
  }

  const home = getMonkeHome(runtime);
  const context = resolveRepoContext(runtime, runtime.cwd, home, { inferSessionName: false });

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
export async function spawnSessionLocked(request: {
  home: string;
  rootCheckoutRoot?: string;
  rootSourceRoot: string;
  runtime: Runtime;
  session: string;
  spawnOptions: SpawnOptions;
}) {
  const { home, rootSourceRoot, runtime, session, spawnOptions } = request;
  const store = new SessionStateStore(home);

  const execution = await prepareSpawn(
    runtime,
    store,
    rootSourceRoot,
    session,
    spawnOptions,
    request.rootCheckoutRoot ?? rootSourceRoot
  );

  await runSessionMaterialization({
    nodes: createSpawnMaterializationNodes(execution),
    onCheckpoint: execution.runtime.sessionMaterializationBoundary,
    retryCommand: formatSpawnRetryCommand(execution.session, execution.sourcePlan),
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
  spawnOptions: SpawnOptions,
  rootCheckoutRoot: string
) {
  const { home } = store;
  const retainedState = store.get(rootSourceRoot, session);
  const sourcePlan = resolveSpawnSourcePlan(retainedState, session, spawnOptions);
  assertSpawnRequest(runtime, rootSourceRoot, session, sourcePlan);
  const rootWorktreePath = getExpectedWorktreePath(home, rootSourceRoot, session);

  const getStartRef = createStartRefResolver(runtime, rootSourceRoot, {
    checkoutRoot: rootCheckoutRoot,
    from: sourcePlan.mode === "default-branch" ? sourcePlan.from : undefined
  });

  const rootStartRef =
    sourcePlan.mode === "default-branch" && sourcePlan.attempt === "fresh"
      ? getStartRef(rootSourceRoot)
      : null;

  const resumedState =
    sourcePlan.mode === "default-branch" && sourcePlan.attempt === "resume"
      ? retainedState
      : undefined;

  let rootConfigRef = rootStartRef?.pinnedRef;

  if (rootConfigRef === undefined && resumedState) {
    rootConfigRef = requirePinnedRef(resumedState, rootSourceRoot);
  } else if (rootConfigRef === undefined && sourcePlan.mode === "session-branch") {
    rootConfigRef = session;
  }

  const rootConfigExists = spawnRootConfigExists(runtime, rootSourceRoot, rootConfigRef);

  if (!rootConfigExists) {
    if (retainedState && !isConfiglessPreparedState(retainedState)) {
      throw new MonkeError(
        [
          `monke.yml is missing for retained configured Session ${session} at ${rootSourceRoot}.`,
          "The retained Session state and Cleanup obligations were preserved.",
          `Retry: ${formatSpawnRetryCommand(session, sourcePlan)}`
        ].join("\n")
      );
    }

    return await spawnWithoutConfig(
      runtime,
      store,
      rootSourceRoot,
      session,
      sourcePlan,
      rootStartRef,
      rootCheckoutRoot
    );
  }

  const graph = loadSpawnGraph(
    runtime,
    rootSourceRoot,
    session,
    sourcePlan,
    getStartRef,
    resumedState
  );

  const prepared = prepareSpawnMaterialization(
    runtime,
    store,
    rootSourceRoot,
    session,
    sourcePlan,
    graph.reposInMaterializationOrder,
    rootCheckoutRoot
  );

  return {
    ...prepared,
    getStartRef,
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
      initialState.dirtyCarrySource = dirtyCarrySource(dirtySnapshot);
      initialState.dirtyCarryStatus = "pending";
    }

    if (
      execution.sourcePlan.mode === "default-branch" &&
      execution.sourcePlan.attempt === "fresh"
    ) {
      const startRef = execution.getStartRef(repoConfig.sourceRoot);
      initialState.diffBaseRef = startRef.ref;
      initialState.pinnedRef = startRef.pinnedRef;
    }

    return createRepoLifecycleNode({
      context: {
        home: execution.home,
        retryCommand: formatSpawnRetryCommand(execution.session, execution.sourcePlan),
        rootSourceRoot: execution.rootSourceRoot,
        runtime: execution.runtime,
        session: execution.session,
        store: execution.store
      },
      initialState,
      prepare: async (lifecycleState, checkpoint) => {
        const prepared = await prepareSpawnRepoWorktree({
          checkoutSource: execution.checkoutSources.get(repoConfig.sourceRoot),
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
  checkoutSource?: CheckoutSource;
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
    request.sourcePlan.mode === "default-branch"
      ? (existingState?.pinnedRef ?? runGit(runtime, worktree.path, ["rev-parse", "HEAD"]).trim())
      : undefined;

  request.onWorktreeReady({ diffBaseRef, pinnedRef, worktreePath: worktree.path });
  const preparationWarnings = await prepareRepoWorktree(runtime, repoConfig, worktree.path);

  return {
    baselinePortsRoot: useWorktreeBaseline ? worktree.path : repoConfig.sourceRoot,
    diffBaseRef,
    pinnedRef,
    preparationWarnings,
    worktreePath: worktree.path
  };
}

interface SpawnWorktreeRequest {
  checkoutSource?: CheckoutSource;
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
    (sourcePlan.mode === "default-branch" && sourcePlan.attempt === "resume") ||
    (sourcePlan.mode === "session-branch" && sourceRoot === rootSourceRoot);

  if (
    sourcePlan.mode === "default-branch" &&
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
  const sourceHeadRef = request.checkoutSource?.headRef;

  const worktree = await ensureSessionWorktreeAsync(runtime, home, sourceRoot, session, {
    checkoutSource: request.checkoutSource,
    skipCleanCheck: shouldCopyDirty(sourcePlan)
  });

  if (request.dirtySnapshot && (worktree.created || resumesDirtyCarry)) {
    await applyDirtySnapshot(runtime, home, worktree.path, request.dirtySnapshot);
  } else if (request.dirtySnapshot && dirtySnapshotHasContent(request.dirtySnapshot)) {
    warnDirtyStateNotCarried(
      runtime,
      sourceRoot,
      session,
      request.dirtySnapshot.source.checkoutRoot
    );
  }

  return {
    createdDiffBaseRef: worktree.created
      ? resolveFreshCurrentHeadDiffBase({
          sessionBranchExisted,
          sourceHeadRef,
          spawnOptions: sourcePlan
        })
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
    if (spawnOptions.mode === "default-branch" || spawnOptions.mode !== retainedOptions.mode) {
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
      return { ...retainedOptions, attempt: "resume" };
    }

    return retainedOptions;
  }

  if (spawnOptions.mode !== "default-branch") {
    return spawnOptions;
  }

  if (!state) {
    return { ...spawnOptions, attempt: "fresh" };
  }

  throw new MonkeError(
    `Session state already exists for "${session}"; -m and --from require a fresh Session`
  );
}

/** Validate that a retained Session permits the requested Spawn source policy. */
export function assertSpawnSourcePolicy(
  home: string,
  rootSourceRoot: string,
  session: string,
  spawnOptions: SpawnOptions
) {
  const state = existsSync(getSessionStateFilePath(home, rootSourceRoot, session))
    ? loadSessionState(home, rootSourceRoot, session)
    : undefined;

  resolveSpawnSourcePlan(state, session, spawnOptions);
}

function retainedSpawnOptions(state: SessionState): SpawnOptions {
  if (state.spawnSource === "default-branch") {
    return { from: state.spawnFrom, mode: "default-branch" };
  }

  if (state.spawnSource === "session-branch") {
    return { mode: "session-branch" };
  }

  return { copyDirty: state.copyDirty ?? true, mode: "current-head" };
}

function isImplicitSpawnRequest(options: SpawnOptions) {
  return options.mode === "current-head" && options.copyDirty;
}

function sameSpawnOptions(left: SpawnOptions, right: SpawnOptions) {
  if (left.mode === "current-head") {
    return right.mode === "current-head" && left.copyDirty === right.copyDirty;
  }

  if (left.mode === "default-branch") {
    return right.mode === "default-branch" && left.from === right.from;
  }

  return left.mode === right.mode;
}

function formatSpawnPolicy(options: SpawnOptions) {
  if (options.mode === "default-branch") {
    return options.from === undefined
      ? "the pinned default branch"
      : `the pinned start ref ${options.from}`;
  }

  if (options.mode === "session-branch") {
    return "the retained Session branch";
  }

  return options.copyDirty ? "current HEAD with dirty carry" : "clean current HEAD";
}

function formatSpawnRetryCommand(session: string, options: SpawnOptions) {
  if (options.mode === "default-branch") {
    return options.from === undefined
      ? `mt spawn ${session} -m`
      : `mt spawn ${session} --from ${shellQuote(options.from)}`;
  }

  if (options.mode === "current-head" && !options.copyDirty) {
    return `mt spawn ${session} --no-dirty`;
  }

  return `mt spawn ${session}`;
}

/** Memoize start refs so graph loading and worktree creation use the same pinned commit. */
function createStartRefResolver(
  runtime: Runtime,
  rootSourceRoot: string,
  root: { checkoutRoot: string; from: string | undefined }
): (sourceRoot: string) => PinnedStartRef {
  const startRefs = new Map<string, PinnedStartRef>();

  return (sourceRoot) => {
    const cached = startRefs.get(sourceRoot);

    if (cached !== undefined) {
      return cached;
    }

    // Resolve --from in the invoking checkout so per-worktree refs such as HEAD mean that
    // checkout's; other refs resolve the same in every worktree.
    const resolved =
      root.from !== undefined && sourceRoot === rootSourceRoot
        ? resolveStartRef(runtime, root.checkoutRoot, root.from)
        : resolveDefaultStartRef(runtime, sourceRoot);

    startRefs.set(sourceRoot, resolved);

    return resolved;
  };
}

function resolveDefaultStartRef(runtime: Runtime, sourceRoot: string) {
  const { ref } = resolveDefaultBranchRef(runtime, sourceRoot);

  return { pinnedRef: runGit(runtime, sourceRoot, ["rev-parse", `${ref}^{commit}`]).trim(), ref };
}

function spawnRootConfigExists(
  runtime: Runtime,
  rootSourceRoot: string,
  configRef: string | undefined
) {
  const ref = configRefOrLocal(runtime, rootSourceRoot, configRef);

  if (ref !== undefined) {
    return gitPathExistsAtRef(runtime, rootSourceRoot, ref, "monke.yml");
  }

  return existsSync(path.join(rootSourceRoot, "monke.yml"));
}

/** A gitignored Source checkout monke.yml stands in for a ref that has none. */
function configRefOrLocal(runtime: Runtime, sourceRoot: string, ref: string | undefined) {
  if (ref === undefined || gitPathExistsAtRef(runtime, sourceRoot, ref, "monke.yml")) {
    return ref;
  }

  const ignored = runtime.exec("git", ["check-ignore", "-q", "monke.yml"], {
    allowFailure: true,
    cwd: sourceRoot
  });

  return ignored.exitCode === 0 ? undefined : ref;
}

/** Everything one config-less Spawn needs to prepare and record its Root repo Session worktree. */
interface ConfiglessSpawn {
  checkoutSource?: CheckoutSource;
  existingRepoState?: SessionRepoState;
  home: string;
  rootSourceRoot: string;
  rootStartRef: PinnedStartRef | null;
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
  rootStartRef: PinnedStartRef | null,
  rootCheckoutRoot: string
): Promise<never> {
  const { home } = store;
  assertNoGlobalWorktreePathStateCollisions(store, session, [{ sourceRoot: rootSourceRoot }]);
  const priorSessionState = store.get(rootSourceRoot, session);

  const spawn: ConfiglessSpawn = {
    checkoutSource:
      sourcePlan.mode === "current-head"
        ? resolveCheckoutSource(runtime, rootCheckoutRoot)
        : undefined,
    existingRepoState: priorSessionState?.repos.find((repo) => repo.sourceRoot === rootSourceRoot),
    home,
    rootSourceRoot,
    rootStartRef,
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
    dirtyCarrySource: tracksDirtyCarry
      ? dirtyCarrySource(dirtySnapshot ?? undefined)
      : spawn.existingRepoState?.dirtyCarrySource,
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
    dirtyCarrySource: pendingState.repos[0]?.dirtyCarrySource,
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
    checkoutSource: spawn.checkoutSource,
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
      spawn.rootStartRef?.ref ??
      resolveFreshCurrentHeadDiffBase({
        sessionBranchExisted,
        sourceHeadRef: spawn.checkoutSource?.headRef,
        spawnOptions: spawn.sourcePlan
      }),
    pinnedRef: spawn.rootStartRef?.pinnedRef ?? spawn.existingRepoState?.pinnedRef,
    worktreePath: getExpectedWorktreePath(spawn.home, spawn.rootSourceRoot, spawn.session)
  };
}

function captureConfiglessDirtySnapshot(spawn: ConfiglessSpawn) {
  if (spawn.sourcePlan.mode === "current-head" && !spawn.sourcePlan.copyDirty) {
    const checkoutRoot = spawn.checkoutSource?.checkoutRoot ?? spawn.rootSourceRoot;
    ensureCleanCheckout(
      spawn.runtime,
      checkoutRoot,
      samePath(checkoutRoot, spawn.rootSourceRoot) ? "Source checkout" : "Content checkout"
    );
  }

  if (!shouldCopyDirty(spawn.sourcePlan) || !spawn.checkoutSource) {
    return null;
  }

  assertDirtyCarrySource(spawn.checkoutSource, spawn.existingRepoState);
  const snapshot = captureDirtySnapshot(spawn.runtime, spawn.checkoutSource);
  assertDirtyCarryBoundary(
    spawn.runtime,
    spawn.home,
    spawn.rootSourceRoot,
    spawn.session,
    snapshot,
    spawn.existingRepoState?.dirtyCarryStatus === "pending"
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
    dirtyCarrySource?: SessionRepoState["dirtyCarrySource"];
    dirtyCarryStatus?: "complete" | "pending";
    preparationStatus: "pending" | "prepared";
    prepared: { diffBaseRef?: string; pinnedRef?: string; worktreePath: string };
    priorSessionState: SessionState | undefined;
  }
): SessionState {
  const { prepared } = options;
  const { rootSourceRoot, sourcePlan: spawnOptions } = spawn;

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
          dirtyCarrySource: options.dirtyCarrySource,
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
    spawnFrom: spawnOptions.mode === "default-branch" ? spawnOptions.from : undefined,
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
      retryCommand: formatSpawnRetryCommand(spawn.session, spawn.sourcePlan),
      rootSourceRoot: spawn.rootSourceRoot
    })
  );
}

function loadSpawnGraph(
  runtime: Runtime,
  rootSourceRoot: string,
  session: string,
  sourcePlan: SpawnSourcePlan,
  getStartRef: (sourceRoot: string) => PinnedStartRef,
  resumedState: SessionState | undefined
) {
  if (sourcePlan.mode === "default-branch") {
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
      (sourceRoot) => getStartRef(sourceRoot).pinnedRef
    );
  }

  if (sourcePlan.mode === "session-branch") {
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
      const ref = configRefOrLocal(runtime, sourceRoot, refForRepo(sourceRoot));

      return ref === undefined
        ? existsSync(path.join(sourceRoot, relativePath))
        : gitPathExistsAtRef(runtime, sourceRoot, ref, relativePath);
    },
    readRepoConfig(sourceRoot) {
      const ref = configRefOrLocal(runtime, sourceRoot, refForRepo(sourceRoot));

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
    throw new MonkeError(`Missing pinned start commit for ${sourceRoot}`);
  }

  return repo.pinnedRef;
}

function resolveSpawnCheckoutSources(
  runtime: Runtime,
  reposInOrder: RepoConfig[],
  rootSourceRoot: string,
  rootCheckoutRoot: string,
  sourcePlan: SpawnSourcePlan
) {
  const checkoutSources = new Map<string, CheckoutSource>();

  if (sourcePlan.mode === "current-head") {
    for (const { sourceRoot } of reposInOrder) {
      checkoutSources.set(
        sourceRoot,
        resolveCheckoutSource(
          runtime,
          sourceRoot === rootSourceRoot ? rootCheckoutRoot : sourceRoot
        )
      );
    }
  }

  return checkoutSources;
}

function prepareSpawnMaterialization(
  runtime: Runtime,
  store: SessionStateStore,
  rootSourceRoot: string,
  session: string,
  sourcePlan: SpawnSourcePlan,
  reposInOrder: RepoConfig[],
  rootCheckoutRoot: string
) {
  const { home } = store;
  const spawnOptions = sourcePlan;

  const checkoutSources = resolveSpawnCheckoutSources(
    runtime,
    reposInOrder,
    rootSourceRoot,
    rootCheckoutRoot,
    sourcePlan
  );

  if (spawnOptions.mode === "current-head" && !spawnOptions.copyDirty) {
    for (const [sourceRoot, source] of checkoutSources) {
      ensureCleanCheckout(
        runtime,
        source.checkoutRoot,
        samePath(sourceRoot, source.checkoutRoot) ? "Source checkout" : "Content checkout"
      );
    }
  }

  const retainedState = store.get(rootSourceRoot, session);

  for (const [sourceRoot, source] of checkoutSources) {
    assertDirtyCarrySource(
      source,
      retainedState?.repos.find((repo) => repo.sourceRoot === sourceRoot)
    );
  }

  const dirtySnapshots = shouldCopyDirty(spawnOptions)
    ? new Map(
        [...checkoutSources].map(([sourceRoot, source]) => [
          sourceRoot,
          captureDirtySnapshot(runtime, source)
        ])
      )
    : new Map<string, DirtySnapshot>();

  for (const [sourceRoot, dirtySnapshot] of dirtySnapshots) {
    assertDirtyCarryBoundary(
      runtime,
      home,
      sourceRoot,
      session,
      dirtySnapshot,
      retainedState?.repos.find((repo) => repo.sourceRoot === sourceRoot)?.dirtyCarryStatus ===
        "pending"
    );
  }

  const sessionState =
    store.get(rootSourceRoot, session) ??
    createNewSessionState(home, rootSourceRoot, session, reposInOrder);

  sessionState.copyDirty = sourcePlan.mode === "current-head" ? sourcePlan.copyDirty : undefined;
  sessionState.graphSource = sourcePlan.mode === "current-head" ? undefined : "session-branch";
  sessionState.spawnSource = sourcePlan.mode === "current-head" ? undefined : sourcePlan.mode;
  sessionState.spawnFrom = sourcePlan.mode === "default-branch" ? sourcePlan.from : undefined;
  ensureSessionPrefix(
    sessionState,
    reposInOrder.map((repo) => repo.sourceRoot)
  );
  assertUniqueExpectedWorktreePaths(home, session, reposInOrder);
  assertNoGlobalWorktreePathStateCollisions(store, session, reposInOrder);

  if (sourcePlan.mode === "default-branch" && sourcePlan.attempt === "fresh") {
    for (const repoConfig of reposInOrder) {
      assertFreshSessionWorktreeAvailable(runtime, home, repoConfig.sourceRoot, session);
    }
  }

  return { checkoutSources, dirtySnapshots, sessionState };
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

export function loadResolvedGraphForSession(
  runtime: Runtime,
  rootSourceRoot: string,
  sessionState: SessionState | undefined
) {
  if (sessionState?.graphSource !== "session-branch") {
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

  const preparationWarnings = await prepareRepoWorktree(
    execution.runtime,
    repoConfig,
    worktreePath
  );

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

export async function runSetup(runtime: Runtime) {
  const checkoutRoot = runGit(runtime, runtime.cwd, ["rev-parse", "--show-toplevel"]).trim();

  if (existsSync(path.join(checkoutRoot, "monke.yml"))) {
    runCheckoutSetup(runtime);
  }

  await reconcileProjectSkills(runtime);
}

async function prepareRepoWorktree(runtime: Runtime, repoConfig: RepoConfig, worktreePath: string) {
  const warnings: string[] = [];

  try {
    seedWorktreeFiles(repoConfig, worktreePath, (message) => {
      warnings.push(message);
      runtime.writeStderr(`${message}\n`);
    });
  } catch (cause) {
    throw new MonkeError(
      `Worktree preparation failed for ${repoConfig.sourceRoot} in ${worktreePath}\n${errorMessage(ThrownValueSchema.parse(cause))}`,
      { cause }
    );
  }

  await reconcileProjectSkills(runtime, worktreePath);

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
