import { ok } from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { openCodexWorkspace } from "./codex.ts";
import { reconcileCodiff } from "./codiff.ts";
import { loadResolvedGraph } from "./config.ts";
import { MonkeError } from "./errors.ts";
import {
  branchExists,
  getExpectedWorktreePath,
  getSessionWorktreePath,
  resolveDefaultBranchRef,
  resolveStartRef,
  resolveRepoContext,
  runGit,
  validateWorktreeForSession
} from "./git.ts";
import type { PinnedStartRef } from "./git.ts";
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
import { formatFailureReceipt, runSessionMaterialization } from "./session-materialization.ts";
import type { SessionMaterializationNode } from "./session-materialization.ts";
import {
  assertNoOtherStateOwnsSessionRepos,
  assertRecordedWorktreePath
} from "./session-safety.ts";
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
import {
  assertFreshSessionWorktreeAvailable,
  planWorktreePreparation,
  prepareWorktree
} from "./worktree-preparation.ts";
import type { PreparedWorktree, WorktreePlan } from "./worktree-preparation.ts";

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

interface RepoLifecycleNodeContext {
  home: string;
  retryCommand: string;
  rootSourceRoot: string;
  runtime: Runtime;
  session: string;
  store: SessionStateStore;
}

type PrepareRepoLifecycleNode = SessionMaterializationNode<
  PreparedWorktree,
  RepoMaterializationResult
>["prepare"];

interface ConfiguredSpawn {
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
  worktreePlans: Map<string, WorktreePlan>;
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
  const rootWorktreePath = getSessionWorktreePath(home, rootSourceRoot, session, retainedState);

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
    !repo.cleanupObligated &&
    repo.cleanupCommand === undefined &&
    repo.assignedPorts.length === 0 &&
    repo.resourceCommandOutputs === undefined &&
    repo.resourceValues === undefined
  );
}

function createSpawnMaterializationNodes(execution: ConfiguredSpawn) {
  const { sourcePlan } = execution;

  return execution.reposInOrder.map((repoConfig) => {
    const plan = execution.worktreePlans.get(repoConfig.sourceRoot);
    ok(plan, `Missing Worktree preparation plan for ${repoConfig.sourceRoot}`);

    const recordedState = execution.sessionState.repos.find(
      (repo) => repo.sourceRoot === repoConfig.sourceRoot
    );

    const initialState = {
      ...createInitialRepoLifecycleState(
        repoConfig,
        getExpectedWorktreePath(execution.home, repoConfig.sourceRoot, execution.session),
        recordedState
      ),
      ...plan.pendingDirtyCarry
    };

    if (plan.freshDiffBaseRef !== undefined) {
      initialState.diffBaseRef = plan.freshDiffBaseRef;
    }

    if (sourcePlan.mode === "default-branch" && sourcePlan.attempt === "fresh") {
      const startRef = execution.getStartRef(repoConfig.sourceRoot);
      initialState.diffBaseRef = startRef.ref;
      initialState.pinnedRef = startRef.pinnedRef;
    }

    return createRepoLifecycleNode({
      context: {
        home: execution.home,
        retryCommand: formatSpawnRetryCommand(execution.session, sourcePlan),
        rootSourceRoot: execution.rootSourceRoot,
        runtime: execution.runtime,
        session: execution.session,
        store: execution.store
      },
      initialState,
      prepare: async (lifecycleState, checkpoint) =>
        await prepareWorktree(execution.runtime, {
          existingState: lifecycleState,
          home: execution.home,
          onWorktreeReady: checkpoint,
          plan,
          seedPaths: repoConfig.seedPaths,
          session: execution.session
        }),
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
        dependencyResults,
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
          repoConfig.sourceRoot,
          existingState.worktreePath,
          context.session
        );
      }

      return await options.prepare(existingState, checkpoint);
    },
    reuse: toRepoMaterializationResult,
    sourceRoot: repoConfig.sourceRoot
  } satisfies SessionMaterializationNode<PreparedWorktree, RepoMaterializationResult>;
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

/**
 * Run Worktree preparation for the Root repo only, skip Repo materialization, and fail with the
 * generation-0 receipt.
 */
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
  const priorSessionState = store.get(rootSourceRoot, session);

  assertSessionWorktreePathsAvailable(
    store,
    session,
    [{ sourceRoot: rootSourceRoot }],
    priorSessionState
  );

  if (sourcePlan.mode === "default-branch" && sourcePlan.attempt === "fresh") {
    assertFreshSessionWorktreeAvailable(runtime, home, rootSourceRoot, session);
  }

  const existingRepoState = priorSessionState?.repos.find(
    (repo) => repo.sourceRoot === rootSourceRoot
  );

  const plan = planWorktreePreparation(runtime, {
    home,
    repos: [{ checkoutRoot: rootCheckoutRoot, sourceRoot: rootSourceRoot }],
    retainedState: priorSessionState,
    session,
    source: sourcePlan
  }).get(rootSourceRoot);

  ok(plan, `Missing Worktree preparation plan for ${rootSourceRoot}`);
  const worktreePath = getSessionWorktreePath(home, rootSourceRoot, session, priorSessionState);

  // Record the Diff base before creating the worktree, so a retry keeps it after the Session branch exists.
  const pendingRepoState = createInitialRepoLifecycleState(
    { cleanupCommand: undefined, sourceRoot: rootSourceRoot },
    worktreePath,
    {
      ...existingRepoState,
      ...plan.pendingDirtyCarry,
      assignedPorts: [],
      cleanupObligated: false,
      diffBaseRef: rootStartRef?.ref ?? plan.freshDiffBaseRef ?? existingRepoState?.diffBaseRef,
      materializationStatus: "pending",
      pinnedRef:
        sourcePlan.mode === "default-branch"
          ? (rootStartRef?.pinnedRef ?? existingRepoState?.pinnedRef)
          : undefined,
      preparationStatus: "pending",
      sourceRoot: rootSourceRoot,
      worktreePath
    }
  );

  const pendingState: SessionState = {
    ...priorSessionState,
    ...spawnSourceState(sourcePlan),
    generation: { number: 0, status: "not-started" },
    repos: [pendingRepoState],
    rootSourceRoot,
    session,
    version: 3
  };

  store.checkpoint(pendingState);

  const prepared = await prepareWorktree(runtime, {
    existingState: pendingRepoState,
    home,
    plan,
    seedPaths: [],
    session
  });

  const preparedState: SessionState = {
    ...pendingState,
    repos: [{ ...prepared.state, preparationStatus: "prepared" }]
  };

  store.checkpoint(preparedState);
  runtime.writeStderr(
    `Warning: no monke.yml found for ${rootSourceRoot}; prepared the Session worktree without materializing it.\n`
  );
  throw new MonkeError(
    formatFailureReceipt(preparedState, {
      retryCommand: formatSpawnRetryCommand(session, sourcePlan),
      rootSourceRoot
    })
  );
}

/** The Spawn source policy that Session state records and `retainedSpawnOptions` reads back. */
function spawnSourceState(sourcePlan: SpawnSourcePlan) {
  return {
    copyDirty: sourcePlan.mode === "current-head" ? sourcePlan.copyDirty : undefined,
    graphSource: sourcePlan.mode === "current-head" ? undefined : ("session-branch" as const),
    spawnFrom: sourcePlan.mode === "default-branch" ? sourcePlan.from : undefined,
    spawnSource: sourcePlan.mode === "current-head" ? undefined : sourcePlan.mode
  };
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
  const pinnedRef = state.repos.find((repo) => repo.sourceRoot === sourceRoot)?.pinnedRef;

  if (!pinnedRef) {
    throw new MonkeError(`Missing pinned start commit for ${sourceRoot}`);
  }

  return pinnedRef;
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
  const retainedState = store.get(rootSourceRoot, session);

  const worktreePlans = planWorktreePreparation(runtime, {
    home,
    repos: reposInOrder.map(({ sourceRoot }) => ({
      checkoutRoot: sourceRoot === rootSourceRoot ? rootCheckoutRoot : sourceRoot,
      sourceRoot
    })),
    retainedState,
    session,
    source: sourcePlan
  });

  const sessionState = {
    ...(retainedState ?? createNewSessionState(home, rootSourceRoot, session, reposInOrder)),
    ...spawnSourceState(sourcePlan)
  };

  ensureSessionPrefix(
    sessionState,
    reposInOrder.map((repo) => repo.sourceRoot)
  );
  assertSessionWorktreePathsAvailable(store, session, reposInOrder, sessionState);

  if (sourcePlan.mode === "default-branch" && sourcePlan.attempt === "fresh") {
    for (const repoConfig of reposInOrder) {
      assertFreshSessionWorktreeAvailable(runtime, home, repoConfig.sourceRoot, session);
    }
  }

  return { sessionState, worktreePlans };
}

function createNewSessionState(
  home: string,
  rootSourceRoot: string,
  session: string,
  reposInOrder: RepoConfig[],
  options: { rootWorktreePath?: string } = {}
): SessionState {
  return {
    generation: { number: 0, status: "not-started" },
    repos: reposInOrder.map((repo) =>
      createInitialRepoLifecycleState(
        repo,
        samePath(repo.sourceRoot, rootSourceRoot) && options.rootWorktreePath !== undefined
          ? options.rootWorktreePath
          : getExpectedWorktreePath(home, repo.sourceRoot, session)
      )
    ),
    rootSourceRoot,
    session,
    version: 3
  };
}

function assertSessionWorktreePathsAvailable(
  store: SessionStateStore,
  session: string,
  repoConfigs: { sourceRoot: string }[],
  state: SessionState | undefined
) {
  const otherRepos = store.list().flatMap((retained) => retained.repos);
  const ownerByPath = new Map<string, string>();

  for (const { sourceRoot } of repoConfigs) {
    const worktreePath = getSessionWorktreePath(store.home, sourceRoot, session, state);
    const normalizedPath = path.normalize(worktreePath);
    const sessionOwner = ownerByPath.get(normalizedPath);

    if (sessionOwner !== undefined) {
      throw new MonkeError(
        `Session worktree path collision at ${worktreePath}: ${sessionOwner} and ${sourceRoot} both resolve to ${path.basename(sourceRoot)}/${session}`
      );
    }

    ownerByPath.set(normalizedPath, sourceRoot);

    const collision = otherRepos.find(
      (repo) => samePath(repo.worktreePath, worktreePath) && !samePath(repo.sourceRoot, sourceRoot)
    );

    if (collision) {
      throw new MonkeError(
        `Session worktree path collision at ${worktreePath}; already recorded for ${collision.sourceRoot}. Repo-name/session worktree paths must be unique within MONKE_HOME.`
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

export interface MaterializeOptions {
  /** Adopt the invoking Ordinary worktree as the Root repo's Session worktree. */
  adopt?: boolean;
}

export const ADOPTION_CONSEQUENCES =
  "mt chop now removes this worktree with its Session, and default mt cleanup removes it once its work is preserved. Cleanup also stops process trees attached to it that are more than a day old.";

/** Materialize through the dependency-gated Session lifecycle scheduler. */
export async function runMaterialize(runtime: Runtime, options: MaterializeOptions = {}) {
  const request = resolveMaterializeRequest(runtime, options);
  await withGlobalLockAsync(request.home, async () => {
    const store = new SessionStateStore(request.home);
    const execution = initializeMaterialization(runtime, request, store);

    // Warn before materialization records ownership. Later failure does not undo adoption.
    if (options.adopt === true) {
      createLogger(runtime).warning(
        `Adopting ${request.context.worktreeRoot}: ${ADOPTION_CONSEQUENCES}`
      );
    }

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

function resolveMaterializeRequest(runtime: Runtime, options: MaterializeOptions) {
  const home = getMonkeHome(runtime);

  const context = resolveRepoContext(runtime, runtime.cwd, home, {
    inferSessionName: options.adopt !== true
  });

  if (context.isSourceCheckout) {
    throw new MonkeError(
      options.adopt === true
        ? "mt materialize --adopt must run inside an Ordinary worktree, not the Source checkout"
        : "mt materialize must run inside a session worktree"
    );
  }

  if (options.adopt === true) {
    if (context.currentBranch === "HEAD") {
      throw new MonkeError(
        `Cannot adopt detached worktree ${context.worktreeRoot}; check out a branch first, then rerun mt materialize --adopt`
      );
    }

    return { context, home, session: context.currentBranch };
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
  const { context, home, session } = request;
  const retainedState = store.get(context.sourceRoot, session);

  const recordedRootPath =
    retainedState && getSessionWorktreePath(home, context.sourceRoot, session, retainedState);

  if (recordedRootPath !== undefined && !samePath(recordedRootPath, context.worktreeRoot)) {
    throw new MonkeError(
      `Session ${session} is already bound to ${recordedRootPath}; run mt materialize there, or mt chop ${session} to remove the Session`
    );
  }

  const graph = loadResolvedGraphForSession(runtime, context.sourceRoot, retainedState);

  const sessionState =
    retainedState ??
    createNewSessionState(home, context.sourceRoot, session, graph.reposInMaterializationOrder, {
      rootWorktreePath: context.worktreeRoot
    });

  if (retainedState === undefined) {
    assertNewSessionClaim(home, store, sessionState);
    assertSessionWorktreePathsAvailable(
      store,
      session,
      graph.reposInMaterializationOrder,
      sessionState
    );
  }

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

/** Apply removal's placement and ownership checks before a new Session records its worktrees. */
function assertNewSessionClaim(home: string, store: SessionStateStore, state: SessionState) {
  assertNoOtherStateOwnsSessionRepos(state, store.list());

  for (const repo of state.repos) {
    assertRecordedWorktreePath(home, state, repo);
  }
}

function createMaterializeNodes(execution: ReturnType<typeof initializeMaterialization>) {
  const worktreePlans = planWorktreePreparation(execution.runtime, {
    home: execution.home,
    repos: execution.reposInOrder.map(({ sourceRoot }) => ({
      checkoutRoot: sourceRoot,
      sourceRoot
    })),
    session: execution.session,
    source: { mode: "session-branch" }
  });

  return execution.reposInOrder.map((repoConfig) => {
    const plan = worktreePlans.get(repoConfig.sourceRoot);
    ok(plan, `Missing Worktree preparation plan for ${repoConfig.sourceRoot}`);

    const recordedState = execution.sessionState.repos.find(
      (repo) => repo.sourceRoot === repoConfig.sourceRoot
    );

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
        getExpectedWorktreePath(execution.home, repoConfig.sourceRoot, execution.session),
        recordedState
      ),
      prepare: async (lifecycleState, checkpoint) => {
        if (repoConfig.sourceRoot === execution.context.sourceRoot) {
          validateWorktreeForSession(
            execution.runtime,
            repoConfig.sourceRoot,
            execution.context.worktreeRoot,
            execution.session
          );
        }

        return await prepareWorktree(execution.runtime, {
          existingState: lifecycleState,
          home: execution.home,
          onWorktreeReady: checkpoint,
          plan,
          seedPaths: repoConfig.seedPaths,
          session: execution.session
        });
      },
      repoConfig
    });
  });
}

export async function runSetup(runtime: Runtime) {
  const checkoutRoot = runGit(runtime, runtime.cwd, ["rev-parse", "--show-toplevel"]).trim();

  if (existsSync(path.join(checkoutRoot, "monke.yml"))) {
    runCheckoutSetup(runtime);
  }

  await reconcileProjectSkills(runtime);
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
