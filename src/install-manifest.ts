import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import {
  boolean as booleanSchema,
  enum as enumSchema,
  iso,
  literal,
  record,
  strictObject,
  string as stringSchema
} from "zod";
import type { output } from "zod";

import { MonkeError } from "./errors.ts";
import { assertDirectChildPath } from "./path-boundary.ts";
import { parseBoundaryValue } from "./validation.ts";

export const INSTALL_MANIFEST_FILENAME = "install-manifest.json";

export const StableSemanticVersionSchema = stringSchema().regex(
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u,
  "must use stable major.minor.patch semantic version syntax"
);
const InstallIdSchema = stringSchema()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, "must contain only install identity characters");
export const FullCommitSchema = stringSchema().regex(
  /^[0-9a-f]{40}$/u,
  "must be a full Git commit SHA"
);
export const ReleasePlatformSchema = enumSchema(["linux-x64", "macos-arm64"]);
export const ReleaseTagSchema = stringSchema().regex(
  /^monke-tools-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u
);
export const ReleaseInstallManifestSchema = strictObject({
  artifactName: stringSchema().regex(
    /^monke-tools-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-(?:linux-x64|macos-arm64)\.tar\.gz$/u
  ),
  guidanceHashes: record(
    stringSchema().regex(
      /^skills\/(?:codex|imported|internal|references)\/.+/u,
      "must be a projected guidance path"
    ),
    stringSchema().regex(/^[0-9a-f]{64}$/u, "must be a SHA-256 hash")
  ),
  installKind: literal("release"),
  minimumCodiffVersion: StableSemanticVersionSchema,
  platform: ReleasePlatformSchema,
  releaseTag: ReleaseTagSchema,
  releaseVersion: StableSemanticVersionSchema,
  schemaVersion: literal(1),
  sourceCommit: FullCommitSchema,
  toolBuildIdentity: stringSchema().min(1)
});
export const LocalInstallManifestSchema = strictObject({
  createdAt: iso.datetime(),
  createdBy: literal("bun run install:local"),
  installId: InstallIdSchema,
  installKind: literal("local"),
  minimumCodiffVersion: StableSemanticVersionSchema,
  platform: stringSchema().min(1),
  schemaVersion: literal(1),
  sourceCheckout: stringSchema()
    .min(1)
    .refine((value) => path.isAbsolute(value)),
  sourceCommit: FullCommitSchema,
  sourceDirty: booleanSchema(),
  toolBuildIdentity: stringSchema().min(1)
});

export type LocalInstallManifest = output<typeof LocalInstallManifestSchema>;
export type ReleaseInstallManifest = output<typeof ReleaseInstallManifestSchema>;

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
