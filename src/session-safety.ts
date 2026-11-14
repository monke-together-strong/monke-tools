import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { MonkeError } from "./errors.ts";
import { getExpectedWorktreePath, listWorktrees } from "./git.ts";
import { containsPath, samePath, worktreePathsOverlap } from "./path-identity.ts";
import type { Runtime, SessionRepoState, SessionState } from "./types.ts";
import { assertCanonicalSourceCheckout, assertWorktreeUnlocked } from "./worktree-safety.ts";

/** Shared registration checks. Live checkout identity/cleanliness is checked by each caller. */
export function inspectSessionRepoRegistration(
  runtime: Runtime,
  home: string,
  state: SessionState,
  repo: SessionRepoState
) {
  assertCanonicalSourceCheckout(runtime, repo.sourceRoot);
  assertRecordedWorktreePath(home, state, repo);

  const worktrees = listWorktrees(runtime, repo.sourceRoot);
  const exact = worktrees.find((entry) => samePath(entry.path, repo.worktreePath));

  const conflicts = worktrees.filter(
    (entry) => entry.branch === state.session && !samePath(entry.path, repo.worktreePath)
  );

  if (conflicts.length > 0) {
    throw new MonkeError(
      `Session branch ${state.session} is registered at unexpected path${conflicts.length === 1 ? "" : "s"} ${conflicts
        .map((entry) => entry.path)
        .join(", ")}`
    );
  }

  if (!existsSync(repo.worktreePath)) {
    if (exact !== undefined) {
      assertWorktreeUnlocked(exact);
    }

    return {
      forceGitRemoval: false,
      mode: exact === undefined ? ("gone" as const) : ("stale" as const),
      registeredBranch: exact?.branch,
      repo
    };
  }

  if (exact === undefined) {
    throw new MonkeError(
      `Session worktree exists but is not registered; delete the directory by hand, then rerun Cleanup`
    );
  }

  return {
    forceGitRemoval: false,
    mode: "live" as const,
    registeredBranch: exact.branch,
    repo
  };
}

/**
 * A recorded Session worktree sits at its canonical path, or, once adopted, outside Monke home and
 * clear of every participating Source checkout, so removing it never reaches shared state or
 * source.
 */
export function assertRecordedWorktreePath(
  home: string,
  state: SessionState,
  repo: SessionRepoState
) {
  const expectedPath = getExpectedWorktreePath(home, repo.sourceRoot, state.session);
  const sessionParent = path.join(home, "worktrees", path.basename(repo.sourceRoot));

  // Compare physical paths so a symlinked home or checkout cannot hide an overlap.
  const adoptedPathOverlaps =
    !samePath(repo.worktreePath, expectedPath) &&
    [home, ...state.repos.map((member) => member.sourceRoot)].some((protectedPath) =>
      worktreePathsOverlap(physicalPath(repo.worktreePath), physicalPath(protectedPath))
    );

  if (
    !path.relative(sessionParent, expectedPath) ||
    !containsPath(sessionParent, expectedPath) ||
    !path.isAbsolute(repo.worktreePath) ||
    adoptedPathOverlaps
  ) {
    throw new MonkeError(
      `Recorded Session worktree path ${repo.worktreePath} is not a valid Session worktree for ${repo.sourceRoot}; expected ${expectedPath}, or an adopted worktree outside Monke home and every Source checkout`
    );
  }
}

/** Resolve symlinks in an existing path; a missing path keeps its lexical form. */
function physicalPath(target: string) {
  try {
    return realpathSync.native(target);
  } catch {
    return target;
  }
}

export function assertNoOtherStateOwnsSessionRepos(state: SessionState, allStates: SessionState[]) {
  if (
    allStates.filter(
      (other) =>
        samePath(other.rootSourceRoot, state.rootSourceRoot) && other.session === state.session
    ).length > 1
  ) {
    throw new MonkeError(
      `Multiple records claim Session ${state.session} at ${state.rootSourceRoot}`
    );
  }

  const paths = state.repos.map((repo) => repo.worktreePath);

  for (const other of allStates) {
    if (
      other === state ||
      (samePath(other.rootSourceRoot, state.rootSourceRoot) && other.session === state.session)
    ) {
      continue;
    }

    const collision = other.repos.find((repo) =>
      paths.some((candidate) => worktreePathsOverlap(candidate, repo.worktreePath))
    );

    if (collision !== undefined) {
      throw new MonkeError(
        paths.some((candidate) => samePath(candidate, collision.worktreePath))
          ? `Session worktree ${collision.worktreePath} is also recorded by Session ${other.session} at ${other.rootSourceRoot}`
          : `Session ${state.session} overlaps worktree ${collision.worktreePath} recorded by Session ${other.session} at ${other.rootSourceRoot}`
      );
    }
  }
}
