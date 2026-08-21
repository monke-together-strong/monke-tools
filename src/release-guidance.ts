import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { MonkeError } from "./errors.ts";

export const BUNDLED_GUIDANCE_FOLDERS = ["codex", "imported", "internal", "references"] as const;

/** Hash the ordinary guidance files included in a Release bundle. */
export function hashReleaseGuidance(bundleRoot: string) {
  const hashes: Record<string, string> = {};
  for (const folder of BUNDLED_GUIDANCE_FOLDERS) {
    const root = path.join(bundleRoot, "skills", folder);
    assertGuidanceDirectory(root);
    for (const filePath of listRegularFiles(root)) {
      const relativePath = path.relative(bundleRoot, filePath).replaceAll(path.sep, "/");
      hashes[relativePath] = createHash("sha256").update(readFileSync(filePath)).digest("hex");
    }
  }
  return Object.fromEntries(
    Object.entries(hashes).toSorted(([left], [right]) => left.localeCompare(right))
  );
}

/** Require the same sorted Release guidance paths and hashes on both sides. */
export function assertReleaseGuidanceHashes(
  expected: Record<string, string>,
  actual: Record<string, string>
) {
  const expectedPaths = Object.keys(expected).toSorted();
  const actualPaths = Object.keys(actual).toSorted();
  if (
    JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths) ||
    expectedPaths.some((filePath) => expected[filePath] !== actual[filePath])
  ) {
    throw new MonkeError("Release guidance hashes do not match the original hashes");
  }
}

function listRegularFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRegularFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    } else {
      throw new MonkeError(`Release guidance contains an unsupported entry: ${entryPath}`);
    }
  }
  return files;
}

function assertGuidanceDirectory(directory: string) {
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new MonkeError(`Release guidance folder is missing: ${directory}`);
  }
}
