import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import * as z from "zod";

import type { CleanupEvidence } from "./cleanup-eligibility.ts";
import { gitBlobOid, inspectPendingWork } from "./cleanup-pending-work.ts";
import { MonkeError } from "./errors.ts";
import { containsPath } from "./path-identity.ts";
import type { Runtime } from "./types.ts";

/** Preserve the exact untracked bundle in an immutable, private archive before teardown. */
export function archiveCleanupFiles(runtime: Runtime, home: string, evidence: CleanupEvidence) {
  const proof = evidence.pendingWork;
  const { sourceRoot, worktreePath } = evidence.candidate;
  const pending = evidence.head ? inspectPendingWork(runtime, worktreePath, evidence.head) : null;
  if (
    !evidence.head ||
    proof?.kind !== "untracked-archive" ||
    !pending ||
    pending.fingerprint !== proof.fingerprint ||
    pending.paths.some(
      (entry) => entry.head !== null || entry.index !== null || entry.disk === null
    )
  ) {
    throw new MonkeError(`Untracked archive evidence changed at ${worktreePath}`);
  }
  const parent = path.join(home, "archives", "cleanup");
  mkdirSync(parent, { mode: 0o700, recursive: true });
  if (containsPath(worktreePath, realpathSync(parent))) {
    throw new MonkeError("Cleanup archives must be outside the removed worktree");
  }
  const directories = new Set<string>();
  const temporary = mkdtempSync(path.join(parent, ".pending-"));
  chmodSync(temporary, 0o700);
  for (const entry of pending.paths) {
    const source = path.join(worktreePath, entry.path);
    const destination = path.join(temporary, "files", entry.path);
    mkdirSync(path.dirname(destination), { mode: 0o700, recursive: true });
    let directory = path.dirname(destination);
    while (directory !== parent) {
      directories.add(directory);
      directory = path.dirname(directory);
    }
    const link = entry.disk?.mode === "120000";
    const bytes = link ? readlinkSync(source, { encoding: "buffer" }) : readFileSync(source);
    const oid = gitBlobOid(bytes);
    if (oid !== entry.disk?.oid) {
      throw new MonkeError(`Untracked file changed during archival: ${source}`);
    }
    if (link) {
      symlinkSync(bytes, destination);
    } else {
      writeFileSync(destination, bytes, {
        flag: "wx",
        mode: entry.disk.mode === "100755" ? 0o700 : 0o600
      });
      syncFile(destination);
    }
  }
  const manifest = path.join(temporary, "manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify(
      {
        branch: evidence.branch,
        createdAt: new Date().toISOString(),
        files: pending.paths.map((entry) => ({ path: entry.path, ...entry.disk })),
        fingerprint: proof.fingerprint,
        head: evidence.head,
        sourceRoot,
        version: 1,
        worktreePath
      },
      null,
      2
    ),
    { flag: "wx", mode: 0o600 }
  );
  syncFile(manifest);
  if (inspectPendingWork(runtime, worktreePath, evidence.head)?.fingerprint !== proof.fingerprint) {
    throw new MonkeError(`Untracked files changed during archival: ${worktreePath}`);
  }
  for (const directory of [...directories].toSorted((a, b) => b.length - a.length)) {
    syncFile(directory);
  }
  const archivePath = path.join(parent, path.basename(temporary).replace(".pending-", "archive-"));
  renameSync(temporary, archivePath);
  syncFile(parent);
  assertCleanupArchive(runtime, archivePath, evidence);
  return archivePath;
}

const ArchiveSchema = z.object({
  files: z.array(z.object({ mode: z.string(), oid: z.string(), path: z.string() })),
  fingerprint: z.string(),
  head: z.string(),
  sourceRoot: z.string(),
  version: z.literal(1),
  worktreePath: z.string()
});

/** Check the retained copy again after cleanup hooks, immediately before removal. */
export function assertCleanupArchive(
  runtime: Runtime,
  archivePath: string,
  evidence: CleanupEvidence
) {
  const manifest = ArchiveSchema.parse(
    JSON.parse(readFileSync(path.join(archivePath, "manifest.json"), "utf-8"))
  );
  const pending = evidence.head
    ? inspectPendingWork(runtime, evidence.candidate.worktreePath, evidence.head)
    : null;
  if (
    !pending ||
    pending.fingerprint !== evidence.pendingWork?.fingerprint ||
    manifest.fingerprint !== pending.fingerprint ||
    manifest.head !== evidence.head ||
    manifest.sourceRoot !== evidence.candidate.sourceRoot ||
    manifest.worktreePath !== evidence.candidate.worktreePath ||
    manifest.files.length !== pending.paths.length
  ) {
    throw new MonkeError("Cleanup archive manifest changed");
  }
  for (const entry of pending.paths) {
    const saved = manifest.files.find((file) => file.path === entry.path);
    if (saved?.oid !== entry.disk?.oid || saved?.mode !== entry.disk?.mode) {
      throw new MonkeError("Cleanup archive entry changed");
    }
    assertArchivedFile(archivePath, entry.path, entry.disk);
  }
}

function assertArchivedFile(
  archivePath: string,
  relative: string,
  expected: { mode: string; oid: string } | null
) {
  const file = path.join(archivePath, "files", relative);
  let directory = path.dirname(file);
  while (containsPath(archivePath, directory)) {
    if (!lstatSync(directory).isDirectory()) {
      throw new MonkeError("Cleanup archive directory replaced");
    }
    directory = path.dirname(directory);
  }
  const stat = lstatSync(file);
  const link = expected?.mode === "120000";
  if (link ? !stat.isSymbolicLink() : !stat.isFile()) {
    throw new MonkeError("Cleanup archive file replaced");
  }
  // oxlint-disable-next-line eslint/no-bitwise
  if (!link && ((stat.mode & 0o111) !== 0) !== (expected?.mode === "100755")) {
    throw new MonkeError("Cleanup archive executable mode changed");
  }
  const bytes = link ? readlinkSync(file, { encoding: "buffer" }) : readFileSync(file);
  const oid = gitBlobOid(bytes);
  if (oid !== expected?.oid) {
    throw new MonkeError("Cleanup archive content changed");
  }
}

function syncFile(file: string) {
  const fd = openSync(file, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
