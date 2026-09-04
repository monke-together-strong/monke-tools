import { spawnSync } from "node:child_process";
import { hash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { array as arraySchema, string as stringSchema } from "zod";
import type { output } from "zod";

import { MonkeError } from "./errors.ts";
import {
  FullCommitSchema,
  RELEASE_TAG_PREFIX,
  ReleaseInstallManifestSchema,
  ReleasePlatformSchema,
  StableSemanticVersionSchema
} from "./install-manifest.ts";
import type { ReleaseInstallManifest } from "./install-manifest.ts";
import { executableFileProblem, resolveManagedDirectory } from "./path-boundary.ts";
import { runReleaseCommand } from "./release-command.ts";
import {
  assertReleaseGuidanceHashes,
  BUNDLED_GUIDANCE_FOLDERS,
  hashReleaseGuidance
} from "./release-guidance.ts";

const CHECKSUM_PATTERN = /^(?<hash>[0-9a-f]{64}) {2}(?<name>[^/\s]+)$/u;
const LEADING_ARCHIVE_PATH_PATTERN = /^\.\/?/u;
const TRAILING_SLASH_PATTERN = /\/$/u;
const ChecksumEntrySchema = stringSchema()
  .regex(CHECKSUM_PATTERN, "must be a SHA-256 hash followed by two spaces and an asset name")
  .transform((line) => {
    const match = CHECKSUM_PATTERN.exec(line);
    if (!match?.groups?.hash || !match.groups.name) {
      throw new Error("Validated Release checksum line could not be parsed");
    }
    return { hash: match.groups.hash, name: match.groups.name };
  });
const ChecksumEntriesSchema = arraySchema(ChecksumEntrySchema).superRefine((entries, context) => {
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.name)) {
      context.addIssue({ code: "custom", message: `duplicate checksum entry: ${entry.name}` });
    }
    names.add(entry.name);
  }
});

export interface ExpectedReleaseIdentity {
  artifactName: string;
  releaseTag: string;
  releaseVersion: string;
  sourceCommit: string;
}

interface ValidateReleaseBundleOptions {
  bundleRoot: string;
  expectedGuidanceRoot?: string;
  expectedIdentity?: ExpectedReleaseIdentity;
  expectedMinimumCodiffVersion?: string;
  expectedPlatform?: output<typeof ReleasePlatformSchema>;
}

interface VerifyReleaseArchiveOptions {
  archivePath: string;
  checksumPath?: string;
  expectedGuidanceRoot?: string;
  expectedMinimumCodiffVersion?: string;
  expectedPlatform: output<typeof ReleasePlatformSchema>;
  expectedSourceCommit: string;
  expectedVersion: string;
  verifyExecutable?: boolean;
}

export function releaseArchiveName(version: string, platform: string) {
  const parsedVersion = StableSemanticVersionSchema.parse(version);
  const parsedPlatform = ReleasePlatformSchema.parse(platform);
  return `${RELEASE_TAG_PREFIX}${parsedVersion}-${parsedPlatform}.tar.gz`;
}

export function releaseChecksumsName(version: string) {
  const parsedVersion = StableSemanticVersionSchema.parse(version);
  return `${RELEASE_TAG_PREFIX}${parsedVersion}-checksums.txt`;
}

export function validateReleaseBundleRoot(options: ValidateReleaseBundleOptions) {
  const bundleRoot = validateReleaseBundleFiles(options.bundleRoot);
  const manifest = readReleaseManifestForActivation(bundleRoot);
  assertCatalogReleaseIdentity(manifest, options.expectedIdentity);
  assertExpectedPlatform(manifest, options.expectedPlatform);
  assertReleaseManifestSelfConsistency(manifest);
  assertReleaseManifestContents({
    bundleRoot,
    digestMismatchMessage: "Release executable digest does not match its Install manifest",
    expectedGuidanceRoot: options.expectedGuidanceRoot,
    expectedMinimumCodiffVersion: options.expectedMinimumCodiffVersion,
    manifest
  });
  return manifest;
}

function validateVerifiedReleaseBundleRoot(options: {
  bundleRoot: string;
  expectedGuidanceRoot?: string;
  expectedIdentity: ExpectedReleaseIdentity;
  expectedMinimumCodiffVersion?: string;
  expectedPlatform: output<typeof ReleasePlatformSchema>;
}) {
  const bundleRoot = validateReleaseBundleFiles(options.bundleRoot);
  const manifest = parseReleaseManifest(bundleRoot);
  assertVerifiedReleaseIdentity(manifest, options.expectedIdentity);
  assertExpectedPlatform(manifest, options.expectedPlatform);
  assertExpectedArtifactName(manifest, options.expectedIdentity.artifactName);
  assertReleaseManifestSelfConsistency(manifest);
  assertReleaseManifestContents({
    bundleRoot,
    digestMismatchMessage: "Release manifest artifact digest does not match its executable",
    expectedGuidanceRoot: options.expectedGuidanceRoot,
    expectedMinimumCodiffVersion: options.expectedMinimumCodiffVersion,
    manifest
  });
  return manifest;
}

function validateReleaseBundleFiles(bundleRoot: string) {
  const resolvedRoot = resolveManagedDirectory(bundleRoot, "Release bundle");
  assertNoLinks(resolvedRoot);
  assertExecutable(path.join(resolvedRoot, "mt"), "Release executable");
  assertExecutable(path.join(resolvedRoot, "install.sh"), "Release installer");
  return resolvedRoot;
}

function assertCatalogReleaseIdentity(
  manifest: ReleaseInstallManifest,
  expected: ExpectedReleaseIdentity | undefined
) {
  if (!expected) {
    return;
  }
  if (
    manifest.artifactName !== expected.artifactName ||
    manifest.releaseTag !== expected.releaseTag ||
    manifest.releaseVersion !== expected.releaseVersion ||
    manifest.sourceCommit !== expected.sourceCommit
  ) {
    throw new MonkeError("Release Install manifest does not match the selected GitHub Release");
  }
}

function assertVerifiedReleaseIdentity(
  manifest: ReleaseInstallManifest,
  expected: ExpectedReleaseIdentity
) {
  if (
    manifest.releaseVersion !== expected.releaseVersion ||
    manifest.toolBuildIdentity !== expected.releaseVersion
  ) {
    throw new MonkeError(
      `Release manifest Tool build identity does not match ${expected.releaseVersion}`
    );
  }
  if (manifest.releaseTag !== expected.releaseTag) {
    throw new MonkeError(`Release manifest tag does not match ${expected.releaseTag}`);
  }
  if (manifest.sourceCommit !== expected.sourceCommit) {
    throw new MonkeError("Release manifest source commit does not match the selected commit");
  }
}

function assertExpectedPlatform(
  manifest: ReleaseInstallManifest,
  expectedPlatform: output<typeof ReleasePlatformSchema> | undefined
) {
  if (expectedPlatform && manifest.platform !== expectedPlatform) {
    throw new MonkeError(`Release manifest platform does not match ${expectedPlatform}`);
  }
}

function assertExpectedArtifactName(
  manifest: ReleaseInstallManifest,
  expectedArtifactName: string
) {
  if (manifest.artifactName !== expectedArtifactName) {
    throw new MonkeError(
      `Release manifest artifact identity does not match ${expectedArtifactName}`
    );
  }
}

function assertReleaseManifestSelfConsistency(manifest: ReleaseInstallManifest) {
  const expectedTag = `${RELEASE_TAG_PREFIX}${manifest.releaseVersion}`;
  const expectedArchiveName = releaseArchiveName(manifest.releaseVersion, manifest.platform);
  if (manifest.toolBuildIdentity !== manifest.releaseVersion) {
    throw new MonkeError("Release manifest Tool build identity does not match its version");
  }
  if (manifest.releaseTag !== expectedTag) {
    throw new MonkeError(`Release manifest tag does not match ${expectedTag}`);
  }
  if (manifest.artifactName !== expectedArchiveName) {
    throw new MonkeError(
      `Release manifest artifact identity does not match ${expectedArchiveName}`
    );
  }
}

function assertReleaseManifestContents(options: {
  bundleRoot: string;
  digestMismatchMessage: string;
  expectedGuidanceRoot?: string;
  expectedMinimumCodiffVersion?: string;
  manifest: ReleaseInstallManifest;
}) {
  if (
    options.expectedMinimumCodiffVersion !== undefined &&
    options.manifest.minimumCodiffVersion !== options.expectedMinimumCodiffVersion
  ) {
    throw new MonkeError(
      `Release manifest Codiff minimum does not match ${options.expectedMinimumCodiffVersion}`
    );
  }
  if (
    options.manifest.artifactDigest !==
    hash("sha256", readFileSync(path.join(options.bundleRoot, "mt")), "hex")
  ) {
    throw new MonkeError(options.digestMismatchMessage);
  }
  assertReleaseGuidanceHashes(
    options.manifest.guidanceHashes,
    hashReleaseGuidance(options.bundleRoot)
  );
  if (options.expectedGuidanceRoot) {
    assertReleaseGuidanceHashes(
      options.manifest.guidanceHashes,
      hashReleaseGuidance(path.resolve(options.expectedGuidanceRoot))
    );
  }
}

function parseReleaseManifest(bundleRoot: string) {
  return ReleaseInstallManifestSchema.parse(
    JSON.parse(readFileSync(path.join(bundleRoot, "install-manifest.json"), "utf-8"))
  );
}

function readReleaseManifestForActivation(bundleRoot: string) {
  const manifestPath = path.join(bundleRoot, "install-manifest.json");
  try {
    return parseReleaseManifest(bundleRoot);
  } catch {
    throw new MonkeError(`Invalid Release Install manifest: ${manifestPath}`);
  }
}

export function verifyReleaseArchive(options: VerifyReleaseArchiveOptions) {
  const archivePath = path.resolve(options.archivePath);
  const expectedVersion = StableSemanticVersionSchema.parse(options.expectedVersion);
  const expectedPlatform = ReleasePlatformSchema.parse(options.expectedPlatform);
  const expectedSourceCommit = FullCommitSchema.parse(options.expectedSourceCommit);
  const expectedArchiveName = releaseArchiveName(expectedVersion, expectedPlatform);
  if (path.basename(archivePath) !== expectedArchiveName) {
    throw new MonkeError(
      `Release archive name mismatch: expected ${expectedArchiveName}, found ${path.basename(archivePath)}`
    );
  }
  if (options.checksumPath) {
    verifyArchiveChecksum(archivePath, options.checksumPath);
  }

  assertArchiveContract(listArchiveEntries(archivePath));
  const extractedRoot = mkdtempSync(path.join(tmpdir(), "monke-tools-release-verify-"));
  try {
    runReleaseCommand("tar", ["-xzf", archivePath, "-C", extractedRoot]);
    const manifest = validateVerifiedReleaseBundleRoot({
      bundleRoot: extractedRoot,
      expectedGuidanceRoot: options.expectedGuidanceRoot,
      expectedIdentity: {
        artifactName: expectedArchiveName,
        releaseTag: `${RELEASE_TAG_PREFIX}${expectedVersion}`,
        releaseVersion: expectedVersion,
        sourceCommit: expectedSourceCommit
      },
      expectedMinimumCodiffVersion: options.expectedMinimumCodiffVersion,
      expectedPlatform
    });

    if (options.verifyExecutable !== false) {
      const version = spawnSync(path.join(extractedRoot, "mt"), ["--version"], {
        encoding: "utf-8"
      });
      if (version.status !== 0 || version.stdout?.trim() !== expectedVersion) {
        throw new MonkeError(
          `Release executable Tool build identity does not match ${expectedVersion}: ${commandFailureDetail(version)}`
        );
      }
      const installer = spawnSync(path.join(extractedRoot, "install.sh"), ["--verify"], {
        encoding: "utf-8"
      });
      if (installer.status !== 0) {
        throw new MonkeError(
          `Release installer verification failed: ${commandFailureDetail(installer)}`
        );
      }
    }
    return manifest;
  } finally {
    rmSync(extractedRoot, { force: true, recursive: true });
  }
}

export function readReleaseChecksums(checksumPath: string) {
  const lines = readFileSync(checksumPath, "utf-8").trim().split("\n");
  const checksums = new Map<string, string>();
  for (const entry of ChecksumEntriesSchema.parse(lines)) {
    checksums.set(entry.name, entry.hash);
  }
  return checksums;
}

export function compareStableSemanticVersions(left: string, right: string) {
  const leftParts = parseStableSemanticVersion(left);
  const rightParts = parseStableSemanticVersion(right);
  for (const index of [0, 1, 2]) {
    const leftPart = leftParts[index] ?? 0n;
    const rightPart = rightParts[index] ?? 0n;
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
}

export function parseStableSemanticVersion(value: string) {
  const parts = StableSemanticVersionSchema.parse(value).split(".");
  return [BigInt(parts[0] ?? ""), BigInt(parts[1] ?? ""), BigInt(parts[2] ?? "")] as const;
}

function verifyArchiveChecksum(archivePath: string, checksumPath: string) {
  const checksums = readReleaseChecksums(checksumPath);
  const archiveName = path.basename(archivePath);
  const expected = checksums.get(archiveName);
  if (expected === undefined) {
    throw new MonkeError(`Release checksum is missing for ${archiveName}`);
  }
  if (expected !== hash("sha256", readFileSync(archivePath), "hex")) {
    throw new MonkeError(`Release checksum mismatch for ${archiveName}`);
  }
}

function listArchiveEntries(archivePath: string) {
  return runReleaseCommand("tar", ["-tzf", archivePath])
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((entry) =>
      entry.replace(LEADING_ARCHIVE_PATH_PATTERN, "").replace(TRAILING_SLASH_PATTERN, "")
    )
    .filter(Boolean);
}

function assertArchiveContract(entries: string[]) {
  const requiredEntries = [
    "install-manifest.json",
    "install.sh",
    "instructions/GLOBAL.md",
    "mt",
    "skills/codex",
    "skills/imported",
    "skills/internal",
    "skills/references"
  ];
  if (new Set(entries).size !== entries.length) {
    throw new MonkeError("Release archive contains duplicate entries");
  }
  for (const entry of entries) {
    const [topLevel, skillFolder] = entry.split("/");
    const allowedEntry =
      ["install-manifest.json", "install.sh", "mt"].includes(entry) ||
      entry === "instructions" ||
      entry === "instructions/GLOBAL.md" ||
      entry === "skills" ||
      (topLevel === "skills" && BUNDLED_GUIDANCE_FOLDERS.some((folder) => folder === skillFolder));
    if (
      entry === "" ||
      path.posix.isAbsolute(entry) ||
      entry.split("/").includes("..") ||
      !allowedEntry
    ) {
      throw new MonkeError(`Unsafe or unexpected Release archive entry: ${entry}`);
    }
  }
  for (const required of requiredEntries) {
    if (!entries.includes(required)) {
      throw new MonkeError(`Release archive entry is missing: ${required}`);
    }
  }
}

function assertNoLinks(root: string) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      throw new MonkeError(`Release bundle contains a symbolic link: ${entryPath}`);
    }
    if (stat.isDirectory()) {
      assertNoLinks(entryPath);
    }
  }
}

function assertExecutable(filePath: string, label: string) {
  if (executableFileProblem(filePath) !== null) {
    throw new MonkeError(`${label} is missing or not executable: ${filePath}`);
  }
}

function commandFailureDetail(result: {
  error?: Error;
  stderr: string | null;
  stdout?: string | null;
}) {
  return (
    result.stderr?.trim() || result.stdout?.trim() || result.error?.message || "unknown failure"
  );
}
