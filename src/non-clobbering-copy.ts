import { lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";

/** One source entry reached while copying, with the stats already resolved. */
export interface CopySourceEntry {
  /** Path of the entry relative to the root of this copy operation. */
  relativePath: string;
  sourcePath: string;
  sourceStat: Stats;
  targetPath: string;
}

/** A source entry whose target path already holds unmergeable Session-local content. */
export interface CopyConflict extends CopySourceEntry {
  targetStat: Stats;
}

/** The caller-supplied decisions that distinguish one non-clobbering copy from another. */
export interface NonClobberingCopyPolicy {
  /** Handle a target path that already exists and is not a directory to merge into. */
  onConflict: (conflict: CopyConflict) => void;
  /** Handle a source path that disappeared between listing and copying. */
  onMissingSource: (sourcePath: string) => void;
  /** Write one regular source file to a target path that does not yet exist. */
  writeFile: (entry: CopySourceEntry) => void;
}

/**
 * Copy `sourcePath` into `targetPath`, filling only what is missing.
 *
 * Directories present on both sides are merged entry by entry. Existing target content is never
 * overwritten or deleted; the policy decides whether a conflict is skipped or fatal.
 */
export function copyMissingEntries(
  sourcePath: string,
  targetPath: string,
  policy: NonClobberingCopyPolicy
) {
  copyEntry(sourcePath, targetPath, "", policy);
}

function copyEntry(
  sourcePath: string,
  targetPath: string,
  relativePath: string,
  policy: NonClobberingCopyPolicy
) {
  const sourceStat = lstatSync(sourcePath, { throwIfNoEntry: false });
  if (!sourceStat) {
    policy.onMissingSource(sourcePath);
    return;
  }
  const targetStat = lstatSync(targetPath, { throwIfNoEntry: false });
  if (targetStat) {
    if (sourceStat.isDirectory() && targetStat.isDirectory()) {
      copyDirectoryEntries(sourcePath, targetPath, relativePath, policy);
      return;
    }
    policy.onConflict({ relativePath, sourcePath, sourceStat, targetPath, targetStat });
    return;
  }

  mkdirSync(path.dirname(targetPath), { recursive: true });
  if (sourceStat.isDirectory()) {
    mkdirSync(targetPath);
    copyDirectoryEntries(sourcePath, targetPath, relativePath, policy);
    return;
  }
  if (sourceStat.isSymbolicLink()) {
    symlinkSync(readlinkSync(sourcePath), targetPath);
    return;
  }
  policy.writeFile({ relativePath, sourcePath, sourceStat, targetPath });
}

function copyDirectoryEntries(
  sourcePath: string,
  targetPath: string,
  relativePath: string,
  policy: NonClobberingCopyPolicy
) {
  for (const entry of readdirSync(sourcePath)) {
    copyEntry(
      path.join(sourcePath, entry),
      path.join(targetPath, entry),
      path.join(relativePath, entry),
      policy
    );
  }
}
