import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import * as z from "zod";

import { MonkeError } from "./errors.ts";
import { assertDirectChildPath } from "./path-boundary.ts";
import { parseBoundaryValue } from "./validation.ts";

export const INSTALL_MANIFEST_FILENAME = "install-manifest.json";

const InstallIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, "must contain only install identity characters");
const CommitSchema = z.string().regex(/^[0-9a-f]{40}$/u, "must be a full Git commit SHA");
export const LocalInstallManifestSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  createdBy: z.literal("bun run install:local"),
  installId: InstallIdSchema,
  installKind: z.literal("local"),
  minimumCodiffVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/u, "must use major.minor.patch numeric version syntax"),
  platform: z.string().min(1),
  schemaVersion: z.literal(1),
  sourceCheckout: z
    .string()
    .min(1)
    .refine((value) => path.isAbsolute(value)),
  sourceCommit: CommitSchema,
  sourceDirty: z.boolean(),
  toolBuildIdentity: z.string().min(1)
});

export type LocalInstallManifest = z.output<typeof LocalInstallManifestSchema>;

/** Load the self-describing Active tool install when one is selected. */
export function loadActiveLocalInstall(monkeHome: string) {
  const installRoot = resolveActiveInstallRoot(monkeHome);
  if (installRoot === null) {
    return null;
  }

  return loadLocalInstall(installRoot);
}

/** Load a local install manifest from a root already resolved by the running command. */
export function loadLocalInstall(installRoot: string) {
  const manifestPath = path.join(installRoot, INSTALL_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    throw new MonkeError(`Tool Install manifest is missing: ${manifestPath}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    throw new MonkeError(`Invalid Tool Install manifest: ${manifestPath}`);
  }
  return {
    installRoot: path.resolve(installRoot),
    manifest: parseBoundaryValue(LocalInstallManifestSchema, value, "Tool Install manifest")
  };
}

export function resolveActiveInstallRoot(monkeHome: string) {
  const currentPointer = path.join(monkeHome, "current");
  const stat = lstatSync(currentPointer, { throwIfNoEntry: false });
  if (!stat) {
    return null;
  }
  if (!stat.isSymbolicLink()) {
    throw new MonkeError(`Active install pointer is not a symbolic link: ${currentPointer}`);
  }
  try {
    const installRoot = realpathSync.native(currentPointer);
    assertDirectChildPath(installRoot, path.join(monkeHome, "installs"), "Active tool install");
    return installRoot;
  } catch (error) {
    if (error instanceof MonkeError) {
      throw error;
    }
    throw new MonkeError(`Active install pointer is invalid: ${currentPointer}`);
  }
}
