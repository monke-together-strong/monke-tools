import { accessSync, constants as fsConstants, existsSync, statSync } from "node:fs";
import path from "node:path";

import { MonkeError } from "./errors.ts";

const POSIX_EXECUTE_PERMISSION_MASK = 0o111;
const POSIX_WRITE_PERMISSION_MASK = 0o222;

/** Require a path to be an immediate child of a managed directory boundary. */
export function assertDirectChildPath(candidate: string, parent: string, label: string) {
  const resolvedParent = path.resolve(parent);
  if (path.dirname(candidate) !== resolvedParent) {
    throw new MonkeError(`${label} must be a direct child of ${resolvedParent}`);
  }
}

/** Require the nearest existing destination directory to allow entry creation and lookup. */
export function assertDirectoryMutationAccess(directory: string, label: string) {
  let candidate = path.resolve(directory);
  while (!existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      throw new MonkeError(`${label} has no existing parent: ${directory}`);
    }
    candidate = parent;
  }
  const stat = statSync(candidate);
  if (!stat.isDirectory()) {
    throw new MonkeError(`${label} is not a directory: ${candidate}`);
  }
  // oxlint-disable-next-line eslint/no-bitwise -- POSIX permission masks make preflight deterministic, including as root.
  const hasWritePermission = (stat.mode & POSIX_WRITE_PERMISSION_MASK) !== 0;
  // oxlint-disable-next-line eslint/no-bitwise -- POSIX permission masks make preflight deterministic, including as root.
  const hasSearchPermission = (stat.mode & POSIX_EXECUTE_PERMISSION_MASK) !== 0;
  if (!hasWritePermission || !hasSearchPermission) {
    throw new MonkeError(`${label} is not writable and searchable: ${candidate}`);
  }
  try {
    accessSync(candidate, fsConstants.W_OK + fsConstants.X_OK);
  } catch {
    throw new MonkeError(`${label} is not writable and searchable: ${candidate}`);
  }
}
