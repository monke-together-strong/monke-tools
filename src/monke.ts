import { existsSync } from "node:fs";
import path from "node:path";

import { loadResolvedGraph } from "./config.ts";
import {
  rewriteManagedEnvFiles,
  seedEnvFiles,
  writePortsEnv,
  collectBaselinePorts,
} from "./env.ts";
import {
  ensureSessionWorktree,
  getExpectedWorktreePath,
  resolveRepoContext,
  validateWorktreeForSession,
} from "./git.ts";
import { MonkeError } from "./errors.ts";
import { findExecutable, getMonkeHome, withGlobalLock } from "./runtime.ts";
import {
  allocateLocalPorts,
  ensureSessionPrefix,
  getOrCreateReservation,
  listSessionStates,
  loadSessionState,
  recordRepoSuccess,
  removeSessionState,
  saveSessionState,
  toAssignedPorts,
} from "./registry.ts";
import type {
  AssignedPort,
  RepoConfig,
  RepoMaterializationResult,
  Runtime,
  SessionRepoState,
  SessionState,
} from "./types.ts";

export function runCreate(runtime: Runtime, session: string): void {
  if (!session) {
    throw new MonkeError("monke create requires a session name");
  }

  const context = resolveRepoContext(runtime);
  if (!context.isSourceCheckout) {
    throw new MonkeError("monke create must run from the source checkout");
  }

  ensureWorktrunkInstalled(runtime);
  const home = getMonkeHome(runtime);

  withGlobalLock(home, () => {
    const graph = loadResolvedGraph(runtime, context.sourceRoot);
    let sessionState = loadSessionState(home, context.sourceRoot, session);
    ensureSessionPrefix(
      sessionState,
      graph.reposInMaterializationOrder.map((repo) => repo.sourceRoot),
    );

    const currentRepoRoot = context.sourceRoot;
    const currentIndex = graph.reposInMaterializationOrder.findIndex(
      (repo) => repo.sourceRoot === currentRepoRoot,
    );
    const firstWorkIndex = findFirstIndexNeedingWork(
      runtime,
      graph.reposInMaterializationOrder,
      sessionState,
      session,
      currentIndex,
    );

    const results = new Map<string, RepoMaterializationResult>();
    for (const [index, repoConfig] of graph.reposInMaterializationOrder.entries()) {
      const existingState = sessionState.repos.find(
        (repo) => repo.sourceRoot === repoConfig.sourceRoot,
      );
      const shouldSkip = index < firstWorkIndex && repoConfig.sourceRoot !== currentRepoRoot;

      if (shouldSkip && existingState) {
        validateWorktreeForSession(
          runtime,
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

      const worktree = ensureSessionWorktree(runtime, repoConfig.sourceRoot, session);
      const materialized = materializeRepo({
        runtime,
        home,
        rootSourceRoot: context.sourceRoot,
        session,
        repoConfig,
        worktreePath: worktree.path,
        worktreeCreated: worktree.created,
        existingState,
        dependencyResults: results,
      });

      results.set(repoConfig.sourceRoot, materialized);
      sessionState = recordRepoSuccess(sessionState, materialized.state);
      saveSessionState(home, sessionState);
    }
  });

  runtime.writeStdout(`Created or updated session ${session}\n`);
}

export function runMaterialize(runtime: Runtime): void {
  const context = resolveRepoContext(runtime);
  if (context.isSourceCheckout) {
    throw new MonkeError("monke materialize must run inside a session worktree");
  }
  if (!context.sessionName) {
    throw new MonkeError("Unable to infer the current session");
  }
  const session = context.sessionName;

  ensureWorktrunkInstalled(runtime);
  const home = getMonkeHome(runtime);

  withGlobalLock(home, () => {
    const graph = loadResolvedGraph(runtime, context.sourceRoot);
    let sessionState = loadSessionState(home, context.sourceRoot, session);
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
        : ensureSessionWorktree(runtime, repoConfig.sourceRoot, session);
      const worktreePath = isCurrentRepo ? context.worktreeRoot : dependencyWorktree.path;

      if (isCurrentRepo) {
        validateWorktreeForSession(runtime, repoConfig.sourceRoot, worktreePath, session);
      }

      const materialized = materializeRepo({
        runtime,
        home,
        rootSourceRoot: context.sourceRoot,
        session,
        repoConfig,
        worktreePath,
        worktreeCreated: isCurrentRepo ? false : dependencyWorktree.created,
        existingState,
        dependencyResults: results,
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

      removeSessionState(home, state.rootSourceRoot, state.session);
      removed += 1;
    }
  });

  runtime.writeStdout(`Removed ${removed} dead session${removed === 1 ? "" : "s"}\n`);
}

function materializeRepo(options: {
  runtime: Runtime;
  home: string;
  rootSourceRoot: string;
  session: string;
  repoConfig: RepoConfig;
  worktreePath: string;
  worktreeCreated: boolean;
  existingState: SessionRepoState | undefined;
  dependencyResults: Map<string, RepoMaterializationResult>;
}): RepoMaterializationResult {
  const {
    home,
    rootSourceRoot,
    session,
    repoConfig,
    worktreePath,
    worktreeCreated,
    existingState,
    dependencyResults,
  } = options;

  if (worktreeCreated) {
    seedEnvFiles(repoConfig.sourceRoot, worktreePath);
  }

  const reservation = getOrCreateReservation(
    home,
    repoConfig.sourceRoot,
    repoConfig.localPortOrder.length,
  );
  const baselinePorts = collectBaselinePorts(repoConfig);
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
  rewriteManagedEnvFiles(repoConfig, worktreePath, localAssignments, externalAssignments);

  const localAssignedPorts = toAssignedPorts(repoConfig, localAssignments);
  writePortsEnv(worktreePath, localAssignedPorts, externalAssignments);

  return {
    state: {
      sourceRoot: repoConfig.sourceRoot,
      worktreePath,
      assignedPorts: localAssignedPorts,
    },
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

function ensureWorktrunkInstalled(runtime: Runtime): void {
  if (findExecutable("wt", runtime.env)) {
    return;
  }

  const brew = findExecutable("brew", runtime.env);
  if (!brew) {
    throw new MonkeError("Worktrunk is missing and Homebrew is not available");
  }

  runtime.exec(brew, ["install", "worktrunk"]);
  const wt = findExecutable("wt", runtime.env);
  if (!wt) {
    throw new MonkeError("Installed worktrunk with Homebrew but could not find wt on PATH");
  }
  runtime.exec(wt, ["config", "shell", "install"]);
}

function findFirstIndexNeedingWork(
  runtime: Runtime,
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

    if (!existsSync(existing.worktreePath)) {
      return index;
    }

    const expectedPath = getExpectedWorktreePath(repoConfig.sourceRoot, session);
    if (path.normalize(existing.worktreePath) !== path.normalize(expectedPath)) {
      throw new MonkeError(
        `Session ${session} recorded ${existing.worktreePath} for ${repoConfig.sourceRoot}, expected ${expectedPath}`,
      );
    }

    validateWorktreeForSession(runtime, repoConfig.sourceRoot, existing.worktreePath, session);
  }

  return currentRepoIndex;
}
