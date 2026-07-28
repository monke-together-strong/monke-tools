import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { errorMessage, MonkeError } from "./errors.ts";
import { listWorktrees, resolveRepoContext } from "./git.ts";
import type { WorktreeEntry } from "./git.ts";
import type { Runtime } from "./types.ts";

/** Shared result of a worktree removal preflight. */
export interface WorktreeRemovalPreflight {
  forceGitRemoval: boolean;
  worktree: WorktreeEntry;
}

/** Reject a locked Git worktree registration. */
export function assertWorktreeUnlocked(entry: WorktreeEntry): void {
  if (entry.locked === null) {
    return;
  }
  const reason = entry.locked === "" ? "" : `: ${entry.locked}`;
  throw new MonkeError(`Cannot Chop locked worktree ${entry.path}${reason}`);
}

/** Validate that a recorded absolute path is the canonical Source checkout for its repository. */
export function assertCanonicalSourceCheckout(runtime: Runtime, sourceRoot: string): void {
  if (!path.isAbsolute(sourceRoot) || !existsSync(sourceRoot)) {
    throw new MonkeError(`Recorded Source checkout does not exist at canonical path ${sourceRoot}`);
  }
  if (path.normalize(realpathSync.native(sourceRoot)) !== path.normalize(sourceRoot)) {
    throw new MonkeError(`Recorded Source checkout path is not canonical: ${sourceRoot}`);
  }

  let context: ReturnType<typeof resolveRepoContext>;
  try {
    context = resolveRepoContext(runtime, sourceRoot, null, {
      inferSessionName: false
    });
  } catch (error) {
    throw new MonkeError(`Cannot verify Source checkout ${sourceRoot}: ${errorMessage(error)}`);
  }
  if (
    !context.isSourceCheckout ||
    path.normalize(context.sourceRoot) !== path.normalize(sourceRoot) ||
    path.normalize(context.worktreeRoot) !== path.normalize(sourceRoot)
  ) {
    throw new MonkeError(`Recorded Source checkout is not that repository's Source checkout`);
  }
}

/** Run shared structural and lock checks, plus cleanliness unless force was requested. */
export function preflightWorktreeRemoval(
  runtime: Runtime,
  sourceRoot: string,
  targetPath: string,
  options: { force: boolean }
): WorktreeRemovalPreflight {
  const worktree = validateRegisteredWorktreeForRemoval(runtime, sourceRoot, targetPath);
  if (options.force) {
    return { forceGitRemoval: true, worktree };
  }
  assertCleanWorktree(runtime, worktree.path);
  const forceGitRemoval = hasInitializedSubmodules(runtime, worktree.path);
  if (forceGitRemoval) {
    // Git needs an internal force flag for initialized submodules. Revalidate
    // cleanliness immediately before authorizing that structural workaround.
    assertCleanWorktree(runtime, worktree.path);
  }
  return { forceGitRemoval, worktree };
}

/** Validate one registered linked worktree before a foreground removal. */
export function validateRegisteredWorktreeForRemoval(
  runtime: Runtime,
  sourceRoot: string,
  targetPath: string
): WorktreeEntry {
  const target = path.normalize(targetPath);
  const entry = listWorktrees(runtime, sourceRoot).find(
    (worktree) => path.normalize(worktree.path) === target
  );
  if (entry === undefined || entry.prunable || !existsSync(entry.path)) {
    throw new MonkeError(`No removable registered worktree exists at ${targetPath}`);
  }
  assertWorktreeUnlocked(entry);
  if (path.normalize(entry.path) === path.normalize(sourceRoot)) {
    throw new MonkeError(`Cannot Chop the Source checkout at ${sourceRoot}`);
  }
  assertWorktreeIdentity(runtime, sourceRoot, entry.path);
  return entry;
}

/** Reject staged, modified, or untracked files in a worktree. */
export function assertCleanWorktree(runtime: Runtime, worktreePath: string): void {
  const status = runtime.exec(
    "git",
    ["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"],
    {
      cwd: worktreePath
    }
  ).stdout;
  if (status.trim() !== "") {
    throw new MonkeError(
      `Cannot Chop dirty worktree ${worktreePath}. Commit or stash staged, modified, and untracked files first.`
    );
  }
}

function hasInitializedSubmodules(runtime: Runtime, worktreePath: string): boolean {
  const status = runtime.exec("git", ["submodule", "status", "--recursive"], {
    cwd: worktreePath
  }).stdout;
  return status.split("\n").some((line) => line !== "" && !line.startsWith("-"));
}

function assertWorktreeIdentity(runtime: Runtime, sourceRoot: string, worktreePath: string): void {
  let context: ReturnType<typeof resolveRepoContext>;
  try {
    context = resolveRepoContext(runtime, worktreePath, null, {
      inferSessionName: false
    });
  } catch (error) {
    throw new MonkeError(
      `Cannot verify registered worktree ${worktreePath}: ${errorMessage(error)}`
    );
  }

  if (path.normalize(context.sourceRoot) !== path.normalize(sourceRoot)) {
    throw new MonkeError(
      `Worktree ${worktreePath} belongs to ${context.sourceRoot}; expected ${sourceRoot}`
    );
  }
  if (
    context.isSourceCheckout ||
    path.normalize(context.worktreeRoot) !== path.normalize(worktreePath)
  ) {
    throw new MonkeError(`Registered path ${worktreePath} is not that linked worktree's root`);
  }
}
