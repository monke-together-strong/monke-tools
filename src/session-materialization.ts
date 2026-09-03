import { errorMessage, MonkeError } from "./errors.ts";
import { saveSessionState } from "./session-state-store.ts";
import type { SessionRepoState, SessionState } from "./types.ts";

const MAX_CONCURRENT_REPO_MATERIALIZATIONS = 4;

export interface PreparedRepo<T> {
  state: SessionRepoState;
  value: T;
  warnings: string[];
}

export interface MaterializedRepo<T> {
  state: SessionRepoState;
  value: T;
}

export interface SessionMaterializationNode<TPrepared, TResult> {
  dependencyRoots: string[];
  initialState: SessionRepoState;
  materialize: (options: {
    checkpoint: (state: SessionRepoState) => void;
    dependencyResults: Map<string, TResult>;
    existingState: SessionRepoState;
    prepared: TPrepared;
  }) => Promise<MaterializedRepo<TResult>>;
  prepare: (
    existingState: SessionRepoState,
    checkpoint: (state: SessionRepoState) => void
  ) => Promise<PreparedRepo<TPrepared>>;
  reuse: (state: SessionRepoState) => TResult;
  sourceRoot: string;
}

export interface RunSessionMaterializationOptions<TPrepared, TResult> {
  home: string;
  nodes: SessionMaterializationNode<TPrepared, TResult>[];
  retryCommand: string;
  rootSourceRoot: string;
  state: SessionState;
}

/** Schedule and persist one complete dependency-gated Materialization generation. */
export async function runSessionMaterialization<TPrepared, TResult>(
  options: RunSessionMaterializationOptions<TPrepared, TResult>
) {
  const owner = new SessionStateOwner(options.home, beginGeneration(options.state, options.nodes));
  const prepared = new Map<string, TPrepared>();
  const results = new Map<string, TResult>();

  for (const node of options.nodes) {
    const state = owner.repo(node.sourceRoot);
    if (state.materializationStatus === "materialized") {
      results.set(node.sourceRoot, node.reuse(state));
    }
  }

  const runPreparation = createLimiter(MAX_CONCURRENT_REPO_MATERIALIZATIONS);
  const preparationPromises = new Map(
    options.nodes
      .filter((node) => !results.has(node.sourceRoot))
      .map((node) => [
        node.sourceRoot,
        runPreparation(async () => {
          try {
            const completed = await node.prepare(owner.repo(node.sourceRoot), (state) => {
              owner.replaceRepo(state);
            });
            prepared.set(node.sourceRoot, completed.value);
            owner.replaceRepo({
              ...completed.state,
              blockedBy: undefined,
              failure: undefined,
              materializationStatus: "pending",
              preparationStatus: completed.warnings.length > 0 ? "warning" : "prepared",
              preparationWarnings: completed.warnings.length > 0 ? completed.warnings : undefined
            });
            return true;
          } catch (error) {
            owner.patchRepo(node.sourceRoot, {
              blockedBy: undefined,
              failure: { message: errorMessage(error), phase: "worktree-preparation" },
              materializationStatus: "failed",
              preparationStatus: "failed",
              preparationWarnings: undefined
            });
            return false;
          }
        })
      ])
  );

  const runRepoMaterialization = createLimiter(MAX_CONCURRENT_REPO_MATERIALIZATIONS);
  const materializationPromises = new Map<
    string,
    Promise<SessionRepoState["materializationStatus"]>
  >();
  for (const node of options.nodes) {
    if (results.has(node.sourceRoot)) {
      materializationPromises.set(node.sourceRoot, Promise.resolve("materialized"));
      continue;
    }
    const dependencyPromises = node.dependencyRoots.map((dependencyRoot) => {
      const dependency = materializationPromises.get(dependencyRoot);
      if (!dependency) {
        throw new MonkeError(
          `Dependency ${dependencyRoot} must precede ${node.sourceRoot} in materialization order`
        );
      }
      return dependency;
    });
    const preparation = preparationPromises.get(node.sourceRoot);
    if (!preparation) {
      throw new MonkeError(`Missing Worktree preparation task for ${node.sourceRoot}`);
    }
    materializationPromises.set(
      node.sourceRoot,
      materializeAfterPrerequisites({
        dependencyPromises,
        node,
        owner,
        preparation,
        prepared,
        results,
        runRepoMaterialization
      })
    );
  }

  await Promise.all(materializationPromises.values());
  const complete = owner.state.repos.every((repo) => repo.materializationStatus === "materialized");
  owner.replaceState({
    ...owner.state,
    generation: { ...owner.state.generation, status: complete ? "complete" : "incomplete" }
  });
  if (!complete) {
    throw new MonkeError(formatFailureReceipt(owner.state, options));
  }
  return { results, state: owner.state };
}

async function materializeAfterPrerequisites<TPrepared, TResult>(options: {
  dependencyPromises: Promise<SessionRepoState["materializationStatus"]>[];
  node: SessionMaterializationNode<TPrepared, TResult>;
  owner: SessionStateOwner;
  preparation: Promise<boolean>;
  prepared: Map<string, TPrepared>;
  results: Map<string, TResult>;
  runRepoMaterialization: <T>(run: () => Promise<T>) => Promise<T>;
}): Promise<SessionRepoState["materializationStatus"]> {
  const [preparationComplete, dependencyStatuses] = await Promise.all([
    options.preparation,
    Promise.all(options.dependencyPromises)
  ]);
  if (!preparationComplete) {
    return "failed";
  }
  const blockingIndex = dependencyStatuses.findIndex((status) => status !== "materialized");
  if (blockingIndex !== -1) {
    options.owner.patchRepo(options.node.sourceRoot, {
      blockedBy: options.node.dependencyRoots[blockingIndex],
      failure: undefined,
      materializationStatus: "blocked"
    });
    return "blocked";
  }

  return await options.runRepoMaterialization(async () => {
    const preparedValue = options.prepared.get(options.node.sourceRoot);
    if (preparedValue === undefined) {
      throw new MonkeError(`Missing Worktree preparation result for ${options.node.sourceRoot}`);
    }
    try {
      const completed = await options.node.materialize({
        checkpoint: (state) => {
          options.owner.replaceRepo(state);
        },
        dependencyResults: options.results,
        existingState: options.owner.repo(options.node.sourceRoot),
        prepared: preparedValue
      });
      options.results.set(options.node.sourceRoot, completed.value);
      options.owner.replaceRepo({
        ...completed.state,
        blockedBy: undefined,
        failure: undefined,
        materializationStatus: "materialized"
      });
      return "materialized";
    } catch (error) {
      options.owner.patchRepo(options.node.sourceRoot, {
        blockedBy: undefined,
        failure: { message: errorMessage(error), phase: "repo-materialization" },
        materializationStatus: "failed"
      });
      return "failed";
    }
  });
}

function createLimiter(maxConcurrent: number) {
  const queue: (() => Promise<void>)[] = [];
  let active = 0;
  const startNext = () => {
    while (active < maxConcurrent) {
      const start = queue.shift();
      if (!start) {
        return;
      }
      active += 1;
      void start();
    }
  };
  return <T>(run: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(async () => {
        try {
          resolve(await run());
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
          active -= 1;
          startNext();
        }
      });
      startNext();
    });
}

function beginGeneration<TPrepared, TResult>(
  state: SessionState,
  nodes: SessionMaterializationNode<TPrepared, TResult>[]
) {
  const startFresh = state.generation.status === "complete";
  const startFirst = state.generation.status === "not-started";
  const existingByRoot = new Map(state.repos.map((repo) => [repo.sourceRoot, repo]));
  const repos = nodes.map((node) => {
    const existing = existingByRoot.get(node.sourceRoot) ?? node.initialState;
    if (!startFresh && existing.materializationStatus === "materialized") {
      return existing;
    }
    return {
      ...existing,
      blockedBy: undefined,
      failure: undefined,
      materializationStatus: "pending" as const,
      preparationStatus: "pending" as const,
      preparationWarnings: undefined
    };
  });
  return {
    ...state,
    generation: {
      number: startFresh ? state.generation.number + 1 : startFirst ? 1 : state.generation.number,
      status: "incomplete" as const
    },
    repos
  };
}

function formatFailureReceipt<TPrepared, TResult>(
  state: SessionState,
  options: RunSessionMaterializationOptions<TPrepared, TResult>
) {
  const lines = ["Session materialization failed after all runnable work settled.", "Receipt:"];
  for (const repo of state.repos) {
    lines.push(`  ${repo.sourceRoot}: ${formatRepoOutcome(repo)}`);
  }
  const root = state.repos.find((repo) => repo.sourceRoot === options.rootSourceRoot);
  if (root && (root.preparationStatus === "prepared" || root.preparationStatus === "warning")) {
    lines.push(`Prepared Root worktree: ${root.worktreePath}`);
  }
  lines.push(`Retry: ${options.retryCommand}`);
  return lines.join("\n");
}

function formatRepoOutcome(repo: SessionRepoState) {
  if (repo.materializationStatus === "materialized") {
    return `materialized (${formatPreparationOutcome(repo)})`;
  }
  if (repo.materializationStatus === "blocked") {
    return `blocked by ${repo.blockedBy ?? "unknown dependency"} (${formatPreparationOutcome(repo)})`;
  }
  if (repo.failure) {
    const phase =
      repo.failure.phase === "worktree-preparation"
        ? "worktree preparation"
        : "repo materialization";
    const preparation =
      repo.failure.phase === "repo-materialization" ? `; ${formatPreparationOutcome(repo)}` : "";
    return `failed (${phase}${preparation})\n    ${repo.failure.message}`;
  }
  if (repo.preparationStatus === "warning") {
    return `warning (${repo.preparationWarnings?.join("; ") ?? "unknown warning"})`;
  }
  return repo.preparationStatus === "prepared" ? "prepared" : "pending";
}

function formatPreparationOutcome(repo: SessionRepoState) {
  const warning = repo.preparationWarnings?.join("; ");
  return warning ? `warning: ${warning}` : "prepared";
}

/** The sole owner of serialized Session-state mutation during concurrent graph work. */
class SessionStateOwner {
  #state: SessionState;

  constructor(
    private readonly home: string,
    state: SessionState
  ) {
    this.#state = state;
    this.persist();
  }

  get state() {
    return this.#state;
  }

  repo(sourceRoot: string) {
    const repo = this.#state.repos.find((candidate) => candidate.sourceRoot === sourceRoot);
    if (!repo) {
      throw new MonkeError(`Missing Session lifecycle state for ${sourceRoot}`);
    }
    return repo;
  }

  patchRepo(sourceRoot: string, patch: Partial<SessionRepoState>) {
    this.replaceRepo({ ...this.repo(sourceRoot), ...patch });
  }

  replaceRepo(repo: SessionRepoState) {
    const index = this.#state.repos.findIndex(
      (candidate) => candidate.sourceRoot === repo.sourceRoot
    );
    if (index === -1) {
      throw new MonkeError(`Missing Session lifecycle state for ${repo.sourceRoot}`);
    }
    const repos = [...this.#state.repos];
    repos[index] = repo;
    this.replaceState({ ...this.#state, repos });
  }

  replaceState(state: SessionState) {
    this.#state = state;
    this.persist();
  }

  private persist() {
    saveSessionState(this.home, this.#state);
  }
}
