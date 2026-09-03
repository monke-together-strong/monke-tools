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
import { copyMissingEntries } from "./non-clobbering-copy.ts";
import type { CopyConflict } from "./non-clobbering-copy.ts";
import type { RepoConfig, Runtime } from "./types.ts";

/** The permitted Source-checkout changes carried into a Session worktree during preparation. */
export interface DirtySnapshot {
  trackedPatch: string;
  untrackedPaths: string[];
}

export function captureDirtySnapshots(runtime: Runtime, reposInOrder: RepoConfig[]) {
  return new Map(
    reposInOrder.map((repoConfig) => [
      repoConfig.sourceRoot,
      captureDirtySnapshot(runtime, repoConfig.sourceRoot)
    ])
  );
}

export function captureDirtySnapshot(runtime: Runtime, sourceRoot: string) {
  const untrackedOutput = runGit(runtime, sourceRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z"
  ]);

  return {
    trackedPatch: runGit(runtime, sourceRoot, ["diff", "HEAD", "--binary", "--no-ext-diff"]),
    untrackedPaths: untrackedOutput.split("\0").filter((entry) => entry.length > 0)
  };
}

export function dirtySnapshotHasContent(snapshot: DirtySnapshot) {
  return snapshot.trackedPatch.length > 0 || snapshot.untrackedPaths.length > 0;
}

/** Refuse dirty carry when it would apply HEAD-relative patches onto a diverged Session branch. */
export function assertDirtyCarryBoundary(
  runtime: Runtime,
  home: string,
  sourceRoot: string,
  session: string,
  snapshot: DirtySnapshot
) {
  if (!dirtySnapshotHasContent(snapshot) || !branchExists(runtime, sourceRoot, session)) {
    return;
  }

  if (existsSync(getExpectedWorktreePath(home, sourceRoot, session))) {
    return;
  }

  const branchTip = runGit(runtime, sourceRoot, ["rev-parse", `refs/heads/${session}`]).trim();
  const headTip = runGit(runtime, sourceRoot, ["rev-parse", "HEAD"]).trim();
  if (branchTip !== headTip) {
    throw new MonkeError(
      `Session branch "${session}" already exists at ${branchTip.slice(0, 8)} but the Source checkout HEAD is ${headTip.slice(0, 8)}; carrying dirty changes onto a diverged branch is unsafe. Re-run with --no-dirty, or align the branch with HEAD first.`
    );
  }
}

export function warnDirtyStateNotCarried(runtime: Runtime, sourceRoot: string, session: string) {
  runtime.writeStderr(
    `Warning: Session worktree for ${session} at ${sourceRoot} already exists; dirty Source checkout changes were not carried into it.\n`
  );
}

export async function applyDirtySnapshot(
  runtime: Runtime,
  home: string,
  sourceRoot: string,
  worktreePath: string,
  snapshot: DirtySnapshot
) {
  await applyPatchAsync(runtime, worktreePath, snapshot.trackedPatch);
  copyUntrackedPaths(home, sourceRoot, worktreePath, snapshot.untrackedPaths);
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
