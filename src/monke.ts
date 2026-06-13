import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { loadResolvedGraph } from "./config.ts";
import {
  syncRootEnvFile,
  syncRootEnvFileWithRemovals,
  rewriteManagedEnvFiles,
  seedWorktreeFilesFromRoot,
  collectBaselinePortsFromRoot,
} from "./env.ts";
import {
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
import { resolveResourceCommands, resolveResourceValues } from "./resources.ts";
import { findExecutable, getMonkeHome, withGlobalLock } from "./runtime.ts";
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

/** Options controlling how `mt create` chooses source content. */
export interface CreateOptions {
  /** Selects whether create starts from current HEAD or each repo's default branch. */
  mode: "current-head" | "default-branch";
}

/** Create or refresh a Session from the source checkout. */
export function runCreate(runtime: Runtime, session: string, options: CreateOptions): void {
  if (!session) {
    throw new MonkeError("mt create requires a session name");
  }

  const context = resolveRepoContext(runtime);
  if (!context.isSourceCheckout) {
    throw new MonkeError("mt create must run from the source checkout");
  }

  ensureWorktrunkInstalled(runtime);
  const home = getMonkeHome(runtime);
  const createFromDefaultBranch = options.mode === "default-branch";

  withGlobalLock(home, () => {
    if (
      createFromDefaultBranch &&
      existsSync(getSessionStateFilePath(home, context.sourceRoot, session))
    ) {
      throw new MonkeError(
        `Session state already exists for "${session}"; default branch create mode requires a fresh Session`,
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
    let graph: ReturnType<typeof loadResolvedGraph>;
    if (createFromDefaultBranch) {
      graph = loadResolvedGraph(runtime, context.sourceRoot, {
        readRepoConfig(sourceRoot) {
          return readGitPathAtRef(runtime, sourceRoot, getDefaultRef(sourceRoot).ref, "monke.yml");
        },
        pathExists(sourceRoot, relativePath) {
          return gitPathExistsAtRef(
            runtime,
            sourceRoot,
            getDefaultRef(sourceRoot).ref,
            relativePath,
          );
        },
      });
    } else {
      graph = loadResolvedGraph(runtime, context.sourceRoot);
    }
    let sessionState = loadSessionState(home, context.sourceRoot, session);
    if (createFromDefaultBranch) {
      sessionState = { ...sessionState, graphSource: "session-branch" };
    }
    ensureSessionPrefix(
      sessionState,
      graph.reposInMaterializationOrder.map((repo) => repo.sourceRoot),
    );
    assertUniqueExpectedWorktreePaths(home, session, graph.reposInMaterializationOrder);
    assertNoGlobalWorktreePathStateCollisions(home, session, graph.reposInMaterializationOrder);
    if (createFromDefaultBranch) {
      for (const repoConfig of graph.reposInMaterializationOrder) {
        assertFreshSessionWorktreeAvailable(runtime, home, repoConfig.sourceRoot, session);
      }
    }

    const currentRepoRoot = context.sourceRoot;
    const currentIndex = graph.reposInMaterializationOrder.findIndex(
      (repo) => repo.sourceRoot === currentRepoRoot,
    );
    let firstWorkIndex = 0;
    if (!createFromDefaultBranch) {
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
        if (createFromDefaultBranch) {
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
          worktree = ensureSessionWorktree(runtime, home, repoConfig.sourceRoot, session);
        }

        const materialized = materializeRepo({
          runtime,
          home,
          rootSourceRoot: context.sourceRoot,
          session,
          repoConfig,
          worktreePath: worktree.path,
          sourceContentRoot: createFromDefaultBranch ? worktree.path : repoConfig.sourceRoot,
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
      if (createFromDefaultBranch) {
        rollbackDefaultBranchCreate({
          runtime,
          home,
          rootSourceRoot: context.sourceRoot,
          session,
          createdWorktrees: createdDefaultWorktrees,
        });
      }
      throw error;
    }
  });

  runtime.writeStdout(`Created or updated session ${session}\n`);
}

function rollbackDefaultBranchCreate(options: {
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
    `Default branch create failed and rollback was incomplete for session "${options.session}"; run mt cleanup after removing leftover worktrees manually.\n`,
  );
}

function assertNoGlobalWorktreePathStateCollisions(
  home: string,
  session: string,
  repoConfigs: RepoConfig[],
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
  ensureWorktrunkInstalled(runtime);
  runtime.writeStdout("Verified monke-tools runtime dependencies\n");
}

export function runMaterialize(runtime: Runtime): void {
  const context = resolveRepoContext(runtime);
  if (context.isSourceCheckout) {
    throw new MonkeError("mt materialize must run inside a session worktree");
  }
  if (!context.sessionName) {
    throw new MonkeError("Unable to infer the current session");
  }
  const session = context.sessionName;

  ensureWorktrunkInstalled(runtime);
  const home = getMonkeHome(runtime);

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
      const worktreePath = isCurrentRepo ? context.worktreeRoot : dependencyWorktree.path;

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
        sourceContentRoot: repoConfig.sourceRoot,
        worktreeCreated: isCurrentRepo ? false : dependencyWorktree.created,
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

  runtime.writeStdout(`Materialized session ${session}\n`);
}

export function runCleanup(runtime: Runtime): void {
  const context = resolveRepoContext(runtime);
  const home = getMonkeHome(runtime);

  let removed = 0;
  withGlobalLock(home, () => {
    for (const state of listSessionStates(home)) {
      if (state.rootSourceRoot !== context.sourceRoot) {
        continue;
      }

      const allGone = state.repos.every((repo) => !existsSync(repo.worktreePath));
      if (!allGone) {
        continue;
      }

      runCleanupCommands(
        runtime,
        loadResolvedGraphForSession(runtime, context.sourceRoot, state).reposByRoot,
        state,
      );
      removeSessionState(home, state.rootSourceRoot, state.session);
      removed += 1;
    }
  });

  runtime.writeStdout(`Removed ${removed} dead session${removed === 1 ? "" : "s"}\n`);
}

export function runSetup(runtime: Runtime): void {
  const context = resolveRepoContext(runtime);
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

  runtime.writeStdout(`Updated root .env for ${path.basename(context.sourceRoot)}\n`);
}

function materializeRepo(options: {
  runtime: Runtime;
  home: string;
  rootSourceRoot: string;
  session: string;
  repoConfig: RepoConfig;
  worktreePath: string;
  sourceContentRoot: string;
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
    sourceContentRoot,
    worktreeCreated,
    existingState,
    dependencyResults,
  } = options;

  if (worktreeCreated) {
    seedWorktreeFilesFromRoot({
      config: repoConfig,
      sourceRoot: sourceContentRoot,
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
  const resolvedResourceCommands = resolveResourceCommands({
    runtime: options.runtime,
    home,
    session,
    repoConfig,
    existingRepoState: existingState,
    worktreePath,
    resourceValues: resolvedResourceValues.values,
    onResolvedCommandOutputs(resourceCommandOutputs) {
      options.persistRepoState(
        buildSessionRepoState({
          sourceRoot: repoConfig.sourceRoot,
          worktreePath,
          assignedPorts: existingState?.assignedPorts ?? [],
          cleanupCommand: repoConfig.cleanupCommand,
          resourceValues: preserveStaleResourceValues(
            existingState?.resourceValues ?? [],
            resolvedResourceValues.values,
          ),
          resourceCommandOutputs,
          isComplete: false,
        }),
      );
    },
  });
  const reservation = getOrCreateReservation(
    home,
    repoConfig.sourceRoot,
    repoConfig.localPortOrder.length,
  );
  const baselinePorts = collectBaselinePortsFromRoot({
    config: repoConfig,
    sourceRoot: sourceContentRoot,
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
  syncRootEnvFileWithRemovals(
    worktreePath,
    [
      ...externalPathAssignments,
      ...toRootEnvAssignments(localAssignedPorts),
      ...toRootEnvAssignments(dedupeAssignedPorts(externalAssignments)),
      ...toResourceEnvAssignments(resolvedResourceValues.values),
      ...toResourceCommandEnvAssignments(resolvedResourceCommands.commands),
    ],
    [...resolvedResourceValues.removedEnvNames, ...resolvedResourceCommands.removedEnvNames],
  );
  runBootstrapCommand(options.runtime, repoConfig, worktreePath, externalPathAssignments);

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

function ensureWorktrunkInstalled(runtime: Runtime): void {
  let wt = findExecutable("wt", runtime.env);

  if (!wt) {
    const brew = findExecutable("brew", runtime.env);
    if (!brew) {
      throw new MonkeError("Worktrunk is missing and Homebrew is not available");
    }

    runtime.exec(brew, ["install", "worktrunk"]);
    wt = findExecutable("wt", runtime.env);
    if (!wt) {
      throw new MonkeError("Installed worktrunk with Homebrew but could not find wt on PATH");
    }
  }

  runtime.exec(wt, ["config", "shell", "install", "--yes"]);
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
