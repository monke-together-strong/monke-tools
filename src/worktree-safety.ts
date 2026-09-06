import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { errorMessage, MonkeError, ThrownValueSchema } from "./errors.ts";
import { listWorktrees, resolveRepoContext } from "./git.ts";
import type { WorktreeEntry } from "./git.ts";
import { samePath } from "./path-identity.ts";
import type { Runtime } from "./types.ts";

/** Reject a locked Git worktree registration. */
export function assertWorktreeUnlocked(entry: WorktreeEntry) {
  if (entry.locked === null) {
    return;
  }
  const reason = entry.locked === "" ? "" : `: ${entry.locked}`;
  throw new MonkeError(`Cannot Chop locked worktree ${entry.path}${reason}`);
}

/** Validate that a recorded absolute path is the canonical Source checkout for its repository. */
export function assertCanonicalSourceCheckout(runtime: Runtime, sourceRoot: string) {
  if (!path.isAbsolute(sourceRoot) || !existsSync(sourceRoot)) {
    throw new MonkeError(`Recorded Source checkout does not exist at canonical path ${sourceRoot}`);
  }
  if (!samePath(realpathSync.native(sourceRoot), sourceRoot)) {
    throw new MonkeError(`Recorded Source checkout path is not canonical: ${sourceRoot}`);
  }

  let context: ReturnType<typeof resolveRepoContext>;
  try {
    context = resolveRepoContext(runtime, sourceRoot, null, {
      inferSessionName: false
    });
  } catch (error) {
    throw new MonkeError(
      `Cannot verify Source checkout ${sourceRoot}: ${errorMessage(ThrownValueSchema.parse(error))}`
    );
  }
  if (
    !context.isSourceCheckout ||
    !samePath(context.sourceRoot, sourceRoot) ||
    !samePath(context.worktreeRoot, sourceRoot)
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
) {
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
) {
  const target = path.normalize(targetPath);
  const entry = listWorktrees(runtime, sourceRoot).find(
    (worktree) => path.normalize(worktree.path) === target
  );
  if (entry === undefined || entry.prunable || !existsSync(entry.path)) {
    throw new MonkeError(`No removable registered worktree exists at ${targetPath}`);
  }
  assertWorktreeUnlocked(entry);
  if (samePath(entry.path, sourceRoot)) {
    throw new MonkeError(`Cannot Chop the Source checkout at ${sourceRoot}`);
  }
  assertWorktreeIdentity(runtime, sourceRoot, entry.path);
  return entry;
}

/** Reject staged, modified, or untracked files in a worktree. */
export function assertCleanWorktree(runtime: Runtime, worktreePath: string) {
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
  if (hasHiddenWorktreeIndexEntries(runtime, worktreePath)) {
    throw new MonkeError(
      `Cannot prove clean worktree ${worktreePath}: hidden index entries may conceal edits, including in submodules.`
    );
  }
}

/** Status cannot prove cleanliness for assume-unchanged or skip-worktree entries. */
export function hasHiddenWorktreeIndexEntries(runtime: Runtime, worktreePath: string) {
  const entries = runtime
    .exec("git", ["ls-files", "-v", "--stage", "-z"], {
      cwd: worktreePath
    })
    .stdout.split("\0");
  if (entries.some((entry) => /^[a-zS] /u.test(entry))) {
    return true;
  }
  if (!entries.some((entry) => /^[A-Z] 160000 /u.test(entry))) {
    return false;
  }
  const submodules = runtime.exec(
    "git",
    ["submodule", "foreach", "--quiet", "--recursive", "git ls-files -v -z"],
    { cwd: worktreePath }
  ).stdout;
  return submodules.split("\0").some((entry) => /^[a-zS] /u.test(entry));
}

function hasInitializedSubmodules(runtime: Runtime, worktreePath: string) {
  const status = runtime.exec("git", ["submodule", "status", "--recursive"], {
    cwd: worktreePath
  }).stdout;
  return status.split("\n").some((line) => line !== "" && !line.startsWith("-"));
}

function assertWorktreeIdentity(runtime: Runtime, sourceRoot: string, worktreePath: string) {
  let context: ReturnType<typeof resolveRepoContext>;
  try {
    context = resolveRepoContext(runtime, worktreePath, null, {
      inferSessionName: false
    });
  } catch (error) {
    throw new MonkeError(
      `Cannot verify registered worktree ${worktreePath}: ${errorMessage(ThrownValueSchema.parse(error))}`
    );
  }

  if (!samePath(context.sourceRoot, sourceRoot)) {
    throw new MonkeError(
      `Worktree ${worktreePath} belongs to ${context.sourceRoot}; expected ${sourceRoot}`
    );
  }
  if (context.isSourceCheckout || !samePath(context.worktreeRoot, worktreePath)) {
    throw new MonkeError(`Registered path ${worktreePath} is not that linked worktree's root`);
  }
}
