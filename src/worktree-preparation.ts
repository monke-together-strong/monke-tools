import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { seedWorktreeFiles } from "./env.ts";
import { errorMessage, MonkeError, ThrownValueSchema } from "./errors.ts";
import {
  branchExists,
  getExpectedWorktreePath,
  getSessionWorktreePath,
  listWorktrees,
  resolveCheckoutSource,
  resolveRepoContext,
  runGit,
  validateWorktreeForSession
} from "./git.ts";
import type { CheckoutSource } from "./git.ts";
import { samePath } from "./path-identity.ts";
import { reconcileProjectSkills } from "./project-skills.ts";
import {
  assertDirtyCarryBoundary,
  captureDirtySnapshot,
  carryDirtySnapshot,
  trackDirtyCarry
} from "./session-dirty-carry.ts";
import type { DirtySnapshot } from "./session-dirty-carry.ts";
import type { Runtime, SessionRepoState, SessionState } from "./types.ts";

/** Where Worktree preparation takes a missing Session worktree's content from. */
export type WorktreeSource =
  /** A missing Session branch starts at the content checkout's HEAD; `copyDirty` carries its edits. */
  | { copyDirty: boolean; mode: "current-head" }
  /** The existing Session branch, or the clean Source checkout HEAD when the branch is missing. */
  | { mode: "session-branch" }
  /** The repo's pinned start commit; a fresh attempt never reuses an existing Session branch. */
  | { attempt: "fresh" | "resume"; mode: "default-branch" };

/** One repo's Worktree preparation inputs, captured before any Session state is written. */
export interface WorktreePlan {
  /** The content checkout whose HEAD starts a missing Session branch; current-HEAD Spawn only. */
  checkout?: CheckoutSource;
  /**
   * The Diff base for a Session branch this attempt creates from the content checkout's HEAD.
   * Callers record it before preparation, so a retry keeps it once the branch exists.
   */
  freshDiffBaseRef?: string;
  /** Dirty-carry fields to record before the Session worktree is created. */
  pendingDirtyCarry?: Pick<SessionRepoState, "dirtyCarrySource" | "dirtyCarryStatus">;
  snapshot?: DirtySnapshot;
  source: WorktreeSource;
  sourceRoot: string;
}

/** A Prepared worktree, ready for Repo materialization. */
export interface PreparedWorktree {
  worktreePath: string;
}

/**
 * Resolve each repo's content checkout and capture its permitted dirty state. Throws, before any
 * Session state is written, when `--no-dirty` meets a dirty checkout, a pending carry's checkout or
 * HEAD changed, or a carry would land on a diverged Session branch.
 */
export function planWorktreePreparation(
  runtime: Runtime,
  request: {
    home: string;
    /** The checkout each repo takes content from; only current-HEAD sources read it. */
    repos: { checkoutRoot: string; sourceRoot: string }[];
    retainedState?: SessionState;
    session: string;
    source: WorktreeSource;
  }
) {
  const { home, session, source } = request;

  const retainedRepo = (sourceRoot: string) =>
    request.retainedState?.repos.find((repo) => repo.sourceRoot === sourceRoot);

  const worktreePath = (sourceRoot: string) =>
    getSessionWorktreePath(home, sourceRoot, session, request.retainedState);

  const checkouts = new Map(
    source.mode === "current-head"
      ? request.repos.map(({ checkoutRoot, sourceRoot }) => [
          sourceRoot,
          resolveCheckoutSource(runtime, checkoutRoot)
        ])
      : []
  );

  if (source.mode === "current-head" && !source.copyDirty) {
    for (const [sourceRoot, checkout] of checkouts) {
      ensureCleanCheckout(
        runtime,
        checkout.checkoutRoot,
        samePath(sourceRoot, checkout.checkoutRoot) ? "Source checkout" : "Content checkout"
      );
    }
  }

  const snapshots = new Map(
    source.mode === "current-head" && source.copyDirty
      ? [...checkouts].map(([sourceRoot, checkout]) => [
          sourceRoot,
          captureDirtySnapshot(runtime, checkout, retainedRepo(sourceRoot))
        ])
      : []
  );

  for (const [sourceRoot, snapshot] of snapshots) {
    assertDirtyCarryBoundary(
      runtime,
      sourceRoot,
      session,
      worktreePath(sourceRoot),
      snapshot,
      retainedRepo(sourceRoot)?.dirtyCarryStatus === "pending"
    );
  }

  return new Map(
    request.repos.map(({ sourceRoot }): [string, WorktreePlan] => {
      const checkout = checkouts.get(sourceRoot);
      const snapshot = snapshots.get(sourceRoot);

      return [
        sourceRoot,
        {
          checkout,
          freshDiffBaseRef:
            checkout?.headRef !== undefined && !branchExists(runtime, sourceRoot, session)
              ? checkout.headRef
              : undefined,
          pendingDirtyCarry:
            snapshot &&
            trackDirtyCarry(snapshot, retainedRepo(sourceRoot), worktreePath(sourceRoot)),
          snapshot,
          source,
          sourceRoot
        }
      ];
    })
  );
}

/**
 * Create or validate one Session worktree, apply its pending dirty carry, copy missing Seed
 * material, and reconcile project skills. `onWorktreeReady` receives the repo state before seeding
 * starts. Returns that state, the Prepared worktree, and any Preparation warnings.
 */
export async function prepareWorktree(
  runtime: Runtime,
  request: {
    existingState: SessionRepoState;
    home: string;
    onWorktreeReady?: (state: SessionRepoState) => void;
    plan: WorktreePlan;
    /** Configured Seed paths copied in addition to the discovered local files. */
    seedPaths: readonly string[];
    session: string;
  }
) {
  const { existingState, home, plan, session } = request;
  const { snapshot, source, sourceRoot } = plan;
  const carryPending = snapshot !== undefined && existingState.dirtyCarryStatus === "pending";
  const recordedPath = existingState.worktreePath;

  if (
    !samePath(recordedPath, getExpectedWorktreePath(home, sourceRoot, session)) &&
    !existsSync(recordedPath)
  ) {
    throw new MonkeError(
      `Adopted Session worktree ${recordedPath} is missing; run mt chop ${session} from ${sourceRoot} to release the Session`
    );
  }

  if (carryPending && existsSync(recordedPath)) {
    validateWorktreeForSession(runtime, sourceRoot, recordedPath, session);
  }

  const worktree =
    source.mode === "default-branch" &&
    (source.attempt === "fresh" || !branchExists(runtime, sourceRoot, session))
      ? await createFreshSessionWorktree(
          runtime,
          home,
          sourceRoot,
          session,
          requirePinnedRef(existingState)
        )
      : await ensureSessionWorktree(runtime, home, sourceRoot, session, recordedPath, {
          checkoutSource: plan.checkout,
          skipCleanCheck: source.mode === "current-head" && source.copyDirty
        });

  if (snapshot) {
    await carryDirtySnapshot(runtime, {
      home,
      pending: carryPending,
      session,
      snapshot,
      sourceRoot,
      worktree
    });
  }

  const state: SessionRepoState = {
    ...existingState,
    dirtyCarryStatus: carryPending ? "complete" : existingState.dirtyCarryStatus,
    worktreePath: worktree.path
  };

  request.onWorktreeReady?.(state);

  const warnings = await seedWorktree(
    runtime,
    { seedPaths: request.seedPaths, sourceRoot },
    worktree.path
  );

  const value: PreparedWorktree = { worktreePath: worktree.path };

  return { state, value, warnings };
}

function requirePinnedRef(state: SessionRepoState) {
  if (!state.pinnedRef) {
    throw new MonkeError(`Missing pinned start commit for ${state.sourceRoot}`);
  }

  return state.pinnedRef;
}

async function seedWorktree(
  runtime: Runtime,
  seed: Parameters<typeof seedWorktreeFiles>[0],
  worktreePath: string
) {
  const warnings: string[] = [];

  try {
    seedWorktreeFiles(seed, worktreePath, (message) => {
      warnings.push(message);
      runtime.writeStderr(`${message}\n`);
    });
  } catch (cause) {
    throw new MonkeError(
      `Worktree preparation failed for ${seed.sourceRoot} in ${worktreePath}\n${errorMessage(ThrownValueSchema.parse(cause))}`,
      { cause }
    );
  }

  await reconcileProjectSkills(runtime, worktreePath);

  return warnings;
}

function ensureCleanCheckout(runtime: Runtime, sourceRoot: string, label = "Source checkout") {
  const status = runGit(runtime, sourceRoot, [
    "status",
    "--porcelain",
    "--untracked-files=normal"
  ]).trim();

  if (status) {
    throw new MonkeError(
      `${label} is dirty: ${sourceRoot}. Commit or stash the changes, or drop --no-dirty to carry them into the new Session worktree.`
    );
  }
}

/**
 * Reuse the recorded Session worktree, or create it at that path from the Session branch or the
 * checkout's HEAD.
 */
async function ensureSessionWorktree(
  runtime: Runtime,
  home: string,
  sourceRoot: string,
  session: string,
  expectedPath: string,
  options: { checkoutSource?: CheckoutSource; skipCleanCheck: boolean }
) {
  validateSessionBranchName(runtime, sourceRoot, session);
  const worktrees = listWorktreesForSessionPreparation(runtime, sourceRoot, session, expectedPath);

  const branchMatch = worktrees.find(
    (entry) => entry.branch === session && !entry.prunable && existsSync(entry.path)
  );

  const pathMatch = worktrees.find(
    (entry) =>
      path.normalize(entry.path) === path.normalize(expectedPath) &&
      !entry.prunable &&
      existsSync(entry.path)
  );

  if (branchMatch && path.normalize(branchMatch.path) !== path.normalize(expectedPath)) {
    throw new MonkeError(
      `Session "${session}" already exists at unexpected path ${branchMatch.path}; expected ${expectedPath}`
    );
  }

  if (pathMatch && pathMatch.branch !== session) {
    throw new MonkeError(
      `Worktree ${expectedPath} exists but is on branch ${pathMatch.branch ?? "detached"} instead of ${session}`
    );
  }

  if (branchMatch && pathMatch) {
    return { created: false, path: expectedPath };
  }

  if (existsSync(expectedPath) && !pathMatch) {
    throw new MonkeError(
      `Expected worktree path ${expectedPath} already exists and is not registered. Remove or move that directory (a previous spawn may have left it behind), then re-run mt spawn.`
    );
  }

  const sourceContext = resolveRepoContext(runtime, sourceRoot, home);

  if (sourceContext.currentBranch === session && !branchMatch) {
    throw new MonkeError(
      `Cannot create the Session worktree for "${session}" because the Source checkout ${sourceRoot} is already on that branch. Switch the Source checkout to another branch, then retry.`
    );
  }

  if (!branchExists(runtime, sourceRoot, session)) {
    if (!options.skipCleanCheck) {
      ensureCleanCheckout(runtime, options.checkoutSource?.checkoutRoot ?? sourceRoot);
    }

    runGit(runtime, sourceRoot, ["branch", session, options.checkoutSource?.headCommit ?? "HEAD"]);
  }

  mkdirSync(path.dirname(expectedPath), { recursive: true });
  await runtime.execAsync("git", ["worktree", "add", expectedPath, session], { cwd: sourceRoot });

  return { created: true, path: expectedPath };
}

/** Create the Session branch and worktree at a pinned start commit. */
async function createFreshSessionWorktree(
  runtime: Runtime,
  home: string,
  sourceRoot: string,
  session: string,
  startRef: string
) {
  assertFreshSessionWorktreeAvailable(runtime, home, sourceRoot, session);
  const expectedPath = getExpectedWorktreePath(home, sourceRoot, session);
  mkdirSync(path.dirname(expectedPath), { recursive: true });

  // Peel to a commit so a ref named like a commit SHA cannot shadow the pinned start.
  await runtime.execAsync(
    "git",
    ["worktree", "add", "-b", session, expectedPath, `${startRef}^{commit}`],
    { cwd: sourceRoot }
  );

  return { created: true, path: expectedPath };
}

/** Assert that `-m` and `--from` can spawn a fresh Session worktree. */
export function assertFreshSessionWorktreeAvailable(
  runtime: Runtime,
  home: string,
  sourceRoot: string,
  session: string
) {
  validateSessionBranchName(runtime, sourceRoot, session);

  const expectedPath = getExpectedWorktreePath(home, sourceRoot, session);
  const worktrees = listWorktreesForSessionPreparation(runtime, sourceRoot, session, expectedPath);

  if (branchExists(runtime, sourceRoot, session)) {
    throw new MonkeError(
      `Session branch "${session}" already exists for ${sourceRoot}; -m and --from require a fresh Session branch`
    );
  }

  const branchMatch = worktrees.find(
    (entry) => entry.branch === session && !entry.prunable && existsSync(entry.path)
  );

  if (branchMatch) {
    throw new MonkeError(
      `Session "${session}" already has a worktree at ${branchMatch.path}; -m and --from require a fresh Session worktree`
    );
  }

  const pathMatch = worktrees.find(
    (entry) =>
      path.normalize(entry.path) === path.normalize(expectedPath) &&
      !entry.prunable &&
      existsSync(entry.path)
  );

  if (pathMatch || existsSync(expectedPath)) {
    throw new MonkeError(
      `Session worktree path collision at ${expectedPath}; -m and --from require an unused ${path.basename(sourceRoot)}/${session} path`
    );
  }
}

function validateSessionBranchName(runtime: Runtime, sourceRoot: string, session: string) {
  const result = runtime.exec("git", ["check-ref-format", "--branch", session], {
    allowFailure: true,
    cwd: sourceRoot
  });

  if (result.exitCode !== 0) {
    throw new MonkeError(`Invalid session name "${session}": must be a valid git branch name`);
  }
}

function listWorktreesForSessionPreparation(
  runtime: Runtime,
  sourceRoot: string,
  session: string,
  expectedPath: string
) {
  const worktrees = listWorktrees(runtime, sourceRoot);

  const stale = worktrees.find(
    (entry) =>
      (entry.branch === session || path.normalize(entry.path) === path.normalize(expectedPath)) &&
      (entry.prunable || !existsSync(entry.path))
  );

  if (stale) {
    throw new MonkeError(
      `Worktree registration needs recovery: ${stale.path}. Missing worktrees can retain staged changes. Inspect it with mt cleanup --dry-run --include-unowned from the Source checkout before retrying.`
    );
  }

  return worktrees;
}
