import { ok, fail } from "node:assert/strict";

import pLimit from "p-limit";
import type { LimitFunction } from "p-limit";

import { errorMessage, MonkeError } from "./errors.ts";
import type { SessionStateStore } from "./session-state-store.ts";
import type { SessionMaterializationCheckpoint, SessionRepoState, SessionState } from "./types.ts";

// One bounded-concurrency policy, applied per lifecycle phase so that Worktree preparation and
// Repo materialization each stay within the same cap rather than sharing one queue.
const MAX_CONCURRENT_WORKTREE_PREPARATIONS = 4;
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
    checkpoint: (state: SessionRepoState, phase: SessionMaterializationCheckpoint) => void;
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
  nodes: SessionMaterializationNode<TPrepared, TResult>[];
  onCheckpoint?: (checkpoint: SessionMaterializationCheckpoint) => void;
  retryCommand: string;
  rootSourceRoot: string;
  state: SessionState;
  store: SessionStateStore;
}

/** Schedule and persist one complete dependency-gated Materialization generation. */
export async function runSessionMaterialization<TPrepared, TResult>(
  options: RunSessionMaterializationOptions<TPrepared, TResult>
) {
  const owner = new SessionStateOwner(
    options.store,
    beginGeneration(options.state, options.nodes),
    options.onCheckpoint
  );
  const prepared = new Map<string, TPrepared>();
  const results = new Map<string, TResult>();
  const reusableRoots = new Set(
    options.nodes
      .filter((node) => owner.repo(node.sourceRoot).materializationStatus === "materialized")
      .map((node) => node.sourceRoot)
  );

  const runPreparation = pLimit(MAX_CONCURRENT_WORKTREE_PREPARATIONS);
  const preparationPromises = new Map(
    options.nodes.map((node) => [
      node.sourceRoot,
      runPreparation(async () => {
        try {
          const completed = await node.prepare(owner.repo(node.sourceRoot), (state) => {
            owner.replaceRepo(state, "worktree-ready");
          });
          prepared.set(node.sourceRoot, completed.value);
          owner.replaceRepo(
            transitionRepo(completed.state, {
              phase: "prepared",
              reused: reusableRoots.has(node.sourceRoot),
              warnings: completed.warnings
            }),
            "preparation"
          );
          return true;
        } catch (error) {
          owner.replaceRepo(
            transitionRepo(owner.repo(node.sourceRoot), {
              message: errorMessage(error),
              phase: "preparation-failed",
              reused: reusableRoots.has(node.sourceRoot)
            }),
            "preparation"
          );
          return false;
        }
      })
    ])
  );

  const runRepoMaterialization = pLimit(MAX_CONCURRENT_REPO_MATERIALIZATIONS);
  const materializationPromises = new Map<
    string,
    Promise<SessionRepoState["materializationStatus"]>
  >();
  for (const node of options.nodes) {
    const dependencyPromises = node.dependencyRoots.map((dependencyRoot) => {
      const dependency = materializationPromises.get(dependencyRoot);
      ok(
        dependency,
        `Dependency ${dependencyRoot} must precede ${node.sourceRoot} in materialization order`
      );
      return dependency;
    });
    const preparation = preparationPromises.get(node.sourceRoot);
    ok(preparation, `Missing Worktree preparation task for ${node.sourceRoot}`);
    materializationPromises.set(
      node.sourceRoot,
      materializeAfterPrerequisites({
        dependencyPromises,
        node,
        owner,
        preparation,
        prepared,
        results,
        reuse: reusableRoots.has(node.sourceRoot),
        runRepoMaterialization
      })
    );
  }

  await Promise.all(materializationPromises.values());
  const complete = owner.state.repos.every(
    (repo) =>
      repo.materializationStatus === "materialized" &&
      (repo.preparationStatus === "prepared" || repo.preparationStatus === "warning")
  );
  owner.replaceState(
    {
      ...owner.state,
      generation: { ...owner.state.generation, status: complete ? "complete" : "incomplete" }
    },
    "generation-completion"
  );
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
  reuse: boolean;
  runRepoMaterialization: LimitFunction;
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
    if (options.reuse) {
      return "blocked";
    }
    const blockedBy = options.node.dependencyRoots[blockingIndex];
    ok(blockedBy, "A blocked repo must identify its dependency");
    options.owner.replaceRepo(
      transitionRepo(options.owner.repo(options.node.sourceRoot), { blockedBy, phase: "blocked" }),
      "repo-result"
    );
    return "blocked";
  }

  if (options.reuse) {
    const state = options.owner.repo(options.node.sourceRoot);
    options.results.set(options.node.sourceRoot, options.node.reuse(state));
    return "materialized";
  }

  return await options.runRepoMaterialization(async () => {
    const preparedValue = options.prepared.get(options.node.sourceRoot);
    ok(
      preparedValue !== undefined,
      `Missing Worktree preparation result for ${options.node.sourceRoot}`
    );
    try {
      const completed = await options.node.materialize({
        checkpoint: (state, phase) => {
          options.owner.replaceRepo(state, phase);
        },
        dependencyResults: options.results,
        existingState: options.owner.repo(options.node.sourceRoot),
        prepared: preparedValue
      });
      options.results.set(options.node.sourceRoot, completed.value);
      options.owner.replaceRepo(
        transitionRepo(completed.state, { phase: "materialized" }),
        "repo-result"
      );
      return "materialized";
    } catch (error) {
      options.owner.replaceRepo(
        transitionRepo(options.owner.repo(options.node.sourceRoot), {
          message: errorMessage(error),
          phase: "materialization-failed"
        }),
        "repo-result"
      );
      return "failed";
    }
  });
}

type RepoTransition =
  | { phase: "pending" }
  | { phase: "prepared"; reused: boolean; warnings: string[] }
  | { message: string; phase: "preparation-failed"; reused: boolean }
  | { blockedBy: string; phase: "blocked" }
  | { phase: "materialized" }
  | { message: string; phase: "materialization-failed" };

/** Lifecycle fields change together; callers cannot submit an arbitrary patch bag. */
function transitionRepo(state: SessionRepoState, transition: RepoTransition): SessionRepoState {
  const cleared = { ...state, blockedBy: undefined, failure: undefined };
  switch (transition.phase) {
    case "pending": {
      return {
        ...cleared,
        materializationStatus: "pending",
        preparationStatus: "pending",
        preparationWarnings: undefined
      };
    }
    case "prepared": {
      return {
        ...cleared,
        materializationStatus: transition.reused ? "materialized" : "pending",
        preparationStatus: transition.warnings.length > 0 ? "warning" : "prepared",
        preparationWarnings: transition.warnings.length > 0 ? transition.warnings : undefined
      };
    }
    case "preparation-failed": {
      return {
        ...cleared,
        failure: { message: transition.message, phase: "worktree-preparation" },
        materializationStatus: transition.reused ? "materialized" : "failed",
        preparationStatus: "failed",
        preparationWarnings: undefined
      };
    }
    case "blocked": {
      return { ...cleared, blockedBy: transition.blockedBy, materializationStatus: "blocked" };
    }
    case "materialized": {
      return { ...cleared, materializationStatus: "materialized" };
    }
    case "materialization-failed": {
      return {
        ...cleared,
        failure: { message: transition.message, phase: "repo-materialization" },
        materializationStatus: "failed"
      };
    }
    default: {
      return fail(transition satisfies never);
    }
  }
}

function beginGeneration<TPrepared, TResult>(
  state: SessionState,
  nodes: SessionMaterializationNode<TPrepared, TResult>[]
) {
  const startFresh = state.generation.status === "complete";
  const startFirst = state.generation.status === "not-started";
  let generationNumber = state.generation.number;
  if (startFresh) {
    generationNumber += 1;
  } else if (startFirst) {
    generationNumber = 1;
  }
  const repos = nodes.map((node) => {
    const existing = node.initialState;
    if (!startFresh && existing.materializationStatus === "materialized") {
      return existing;
    }
    return transitionRepo(existing, { phase: "pending" });
  });
  return {
    ...state,
    generation: {
      number: generationNumber,
      status: "incomplete" as const
    },
    repos
  };
}

/** Render the quiescent per-repo receipt for one failed Materialization generation. */
export function formatFailureReceipt(
  state: SessionState,
  options: { retryCommand: string; rootSourceRoot: string }
) {
  const lines = ["Session materialization failed after all runnable work settled.", "Receipt:"];
  for (const repo of state.repos) {
    lines.push(`  ${repo.sourceRoot}: ${formatRepoOutcome(repo)}`);
  }
  const root = state.repos.find((repo) => repo.sourceRoot === options.rootSourceRoot);
  if (root && (root.preparationStatus === "prepared" || root.preparationStatus === "warning")) {
    lines.push(`Prepared Root repo Session worktree: ${root.worktreePath}`);
  }
  lines.push(`Retry: ${options.retryCommand}`);
  return lines.join("\n");
}

function formatRepoOutcome(repo: SessionRepoState) {
  if (repo.preparationStatus === "failed" && repo.failure?.phase === "worktree-preparation") {
    return `failed (worktree preparation)\n    ${repo.failure.message}`;
  }
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
    private readonly store: SessionStateStore,
    state: SessionState,
    private readonly onCheckpoint?: (checkpoint: SessionMaterializationCheckpoint) => void
  ) {
    this.#state = state;
    this.persist("generation-start");
  }

  get state() {
    return this.#state;
  }

  repo(sourceRoot: string) {
    const repo = this.#state.repos.find((candidate) => candidate.sourceRoot === sourceRoot);
    ok(repo, `Missing Session lifecycle state for ${sourceRoot}`);
    return repo;
  }

  replaceRepo(repo: SessionRepoState, checkpoint: SessionMaterializationCheckpoint) {
    const index = this.#state.repos.findIndex(
      (candidate) => candidate.sourceRoot === repo.sourceRoot
    );
    ok(index !== -1, `Missing Session lifecycle state for ${repo.sourceRoot}`);
    const repos = [...this.#state.repos];
    repos[index] = repo;
    this.replaceState({ ...this.#state, repos }, checkpoint);
  }

  replaceState(state: SessionState, checkpoint: SessionMaterializationCheckpoint) {
    this.store.checkpoint(state);
    this.#state = state;
    this.onCheckpoint?.(checkpoint);
  }

  private persist(checkpoint: SessionMaterializationCheckpoint) {
    this.store.checkpoint(this.#state);
    this.onCheckpoint?.(checkpoint);
  }
}
