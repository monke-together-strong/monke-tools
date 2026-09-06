import { existsSync } from "node:fs";
import path from "node:path";

import { MonkeError } from "./errors.ts";
import { getExpectedWorktreePath, listWorktrees } from "./git.ts";
import { samePath, worktreePathsOverlap } from "./path-identity.ts";
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
  const expectedPath = getExpectedWorktreePath(home, repo.sourceRoot, state.session);
  const relative = path.relative(
    path.join(home, "worktrees", path.basename(repo.sourceRoot)),
    expectedPath
  );
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !samePath(repo.worktreePath, expectedPath) ||
    !path.isAbsolute(repo.worktreePath)
  ) {
    throw new MonkeError(
      `Recorded Session worktree path is not canonical; expected ${expectedPath}`
    );
  }

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
    throw new MonkeError(`Session worktree exists but is not registered`);
  }
  return {
    forceGitRemoval: false,
    mode: "live" as const,
    registeredBranch: exact.branch,
    repo
  };
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
          ? `Session worktree ${collision.worktreePath} is also recorded by Session ${other.session}`
          : `Session ${state.session} overlaps worktree ${collision.worktreePath} recorded by Session ${other.session}`
      );
    }
  }
}
