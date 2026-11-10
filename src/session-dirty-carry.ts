// Dirty carry for Worktree preparation. Only worktree-preparation.ts imports this file.
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync
} from "node:fs";
import path from "node:path";

import { MonkeError } from "./errors.ts";
import { branchExists, getExpectedWorktreePath, runGit } from "./git.ts";
import type { CheckoutSource } from "./git.ts";
import { copyMissingEntries } from "./non-clobbering-copy.ts";
import type { CopyConflict } from "./non-clobbering-copy.ts";
import { samePath } from "./path-identity.ts";
import type { Runtime, SessionRepoState } from "./types.ts";

/** The permitted content-checkout changes carried into a Session worktree during preparation. */
export interface DirtySnapshot {
  source: CheckoutSource;
  trackedPatch: string;
  untrackedPaths: string[];
}

/** Capture a content checkout's changes; an interrupted carry must resume from the same donor. */
export function captureDirtySnapshot(
  runtime: Runtime,
  source: CheckoutSource,
  retainedRepo: SessionRepoState | undefined
): DirtySnapshot {
  assertDirtyCarrySource(source, retainedRepo);
  const sourceRoot = source.checkoutRoot;

  const untrackedOutput = runGit(runtime, sourceRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z"
  ]);

  return {
    source,
    trackedPatch: runGit(runtime, sourceRoot, [
      "diff",
      source.headCommit,
      "--binary",
      "--no-ext-diff"
    ]),
    untrackedPaths: untrackedOutput.split("\0").filter((entry) => entry.length > 0)
  };
}

function dirtySnapshotHasContent(snapshot: DirtySnapshot) {
  return snapshot.trackedPatch.length > 0 || snapshot.untrackedPaths.length > 0;
}

/** An interrupted carry must not silently switch donor checkout or base commit. */
function assertDirtyCarrySource(source: CheckoutSource, state: SessionRepoState | undefined) {
  if (state?.dirtyCarryStatus !== "pending" || !state.dirtyCarrySource) {
    return;
  }

  const retained = state.dirtyCarrySource;

  if (
    !samePath(source.checkoutRoot, retained.checkoutRoot) ||
    source.headCommit !== retained.headCommit
  ) {
    throw new MonkeError(
      `Cannot resume dirty carry: retry from content checkout ${retained.checkoutRoot} at HEAD ${retained.headCommit}; the checkout or HEAD changed.`
    );
  }
}

/**
 * The dirty-carry fields to record before preparation starts: a carry stays pending until applied
 * when it resumes or when the snapshot has content for a Session worktree that does not exist yet.
 */
export function trackDirtyCarry(
  snapshot: DirtySnapshot,
  retainedRepo: SessionRepoState | undefined,
  worktreePath: string
) {
  const tracks =
    retainedRepo?.dirtyCarryStatus === "pending" ||
    (dirtySnapshotHasContent(snapshot) && !existsSync(worktreePath));

  return tracks
    ? {
        dirtyCarrySource: {
          checkoutRoot: snapshot.source.checkoutRoot,
          headCommit: snapshot.source.headCommit
        },
        dirtyCarryStatus: "pending" as const
      }
    : undefined;
}

/** Refuse dirty carry when it would apply HEAD-relative patches onto a diverged Session branch. */
export function assertDirtyCarryBoundary(
  runtime: Runtime,
  home: string,
  sourceRoot: string,
  session: string,
  snapshot: DirtySnapshot,
  resumesDirtyCarry: boolean
) {
  if (!dirtySnapshotHasContent(snapshot) || !branchExists(runtime, sourceRoot, session)) {
    return;
  }

  if (!resumesDirtyCarry && existsSync(getExpectedWorktreePath(home, sourceRoot, session))) {
    return;
  }

  const branchTip = runGit(runtime, sourceRoot, ["rev-parse", `refs/heads/${session}`]).trim();
  const headTip = snapshot.source.headCommit;

  if (branchTip !== headTip) {
    throw new MonkeError(
      `Session branch "${session}" already exists at ${branchTip.slice(0, 8)} but the content checkout HEAD is ${headTip.slice(0, 8)}; carrying dirty changes onto a diverged branch is unsafe. Re-run with --no-dirty, or align the branch with HEAD first.`
    );
  }
}

/**
 * Apply the snapshot to a newly created Session worktree or one whose carry is resuming; warn
 * instead when an existing worktree would otherwise receive it.
 */
export async function carryDirtySnapshot(
  runtime: Runtime,
  request: {
    home: string;
    resumes: boolean;
    session: string;
    snapshot: DirtySnapshot;
    sourceRoot: string;
    worktree: { created: boolean; path: string };
  }
) {
  const { snapshot, worktree } = request;

  if (worktree.created || request.resumes) {
    await applyPatchAsync(runtime, worktree.path, snapshot.trackedPatch);
    copyUntrackedPaths(
      request.home,
      snapshot.source.checkoutRoot,
      worktree.path,
      snapshot.untrackedPaths
    );
  } else if (dirtySnapshotHasContent(snapshot)) {
    const { checkoutRoot } = snapshot.source;

    runtime.writeStderr(
      `Warning: Session worktree for ${request.session} at ${request.sourceRoot} already exists; dirty ${checkoutRoot === request.sourceRoot ? "Source checkout" : `content checkout (${checkoutRoot})`} changes were not carried into it.\n`
    );
  }
}

async function applyPatchAsync(runtime: Runtime, worktreePath: string, patch: string) {
  if (!patch) {
    return;
  }

  const forward = await runtime.execAsync("git", ["apply", "--3way", "--check"], {
    allowFailure: true,
    cwd: worktreePath,
    stdin: patch
  });

  if (forward.exitCode === 0) {
    await runtime.execAsync("git", ["apply", "--3way"], { cwd: worktreePath, stdin: patch });

    return;
  }

  const reverse = await runtime.execAsync("git", ["apply", "--reverse", "--check"], {
    allowFailure: true,
    cwd: worktreePath,
    stdin: patch
  });

  if (reverse.exitCode !== 0) {
    throw new MonkeError(
      `Cannot resume dirty carry without overwriting Session-local tracked changes at ${worktreePath}`
    );
  }
}

function copyUntrackedPaths(
  home: string,
  sourceRoot: string,
  worktreePath: string,
  untrackedPaths: string[]
) {
  const temporaryParent = path.join(home, "tmp");
  mkdirSync(temporaryParent, { recursive: true });
  const temporaryRoot = mkdtempSync(path.join(temporaryParent, "dirty-carry-"));

  try {
    for (const [index, relativePath] of untrackedPaths.entries()) {
      copyUntrackedPath(
        path.join(sourceRoot, relativePath),
        path.join(worktreePath, relativePath),
        path.join(temporaryRoot, String(index))
      );
    }
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

function copyUntrackedPath(sourcePath: string, targetPath: string, temporaryPath: string) {
  copyMissingEntries(sourcePath, targetPath, {
    onConflict(conflict) {
      if (untrackedPathsMatch(conflict)) {
        return;
      }

      throw new MonkeError(
        `Refusing to overwrite Session-local path during dirty carry: ${conflict.targetPath}`
      );
    },
    onMissingSource(missingPath) {
      throw new MonkeError(`Untracked source path disappeared before copy: ${missingPath}`);
    },
    writeFile(entry) {
      // Hardlink through a scratch copy so the worktree never observes a partially written file.
      const scratchPath = path.join(temporaryPath, entry.relativePath);
      mkdirSync(path.dirname(scratchPath), { recursive: true });
      copyFileSync(entry.sourcePath, scratchPath);
      linkSync(scratchPath, entry.targetPath);
    }
  });
}

function untrackedPathsMatch({ sourcePath, sourceStat, targetPath, targetStat }: CopyConflict) {
  if (sourceStat.isSymbolicLink() && targetStat.isSymbolicLink()) {
    return readlinkSync(sourcePath) === readlinkSync(targetPath);
  }

  return (
    sourceStat.isFile() &&
    targetStat.isFile() &&
    readFileSync(sourcePath).equals(readFileSync(targetPath))
  );
}
