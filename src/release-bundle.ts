#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { hash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { array as arraySchema, string as stringSchema } from "zod";
import type { output } from "zod";

import { MINIMUM_CODIFF_VERSION_TEXT } from "./codiff.ts";
import {
  FullCommitSchema,
  RELEASE_PLATFORM_VALUES,
  RELEASE_TAG_PREFIX,
  ReleaseInstallManifestSchema,
  ReleasePlatformSchema,
  ReleaseTagSchema,
  StableSemanticVersionSchema
} from "./install-manifest.ts";
import type { ReleaseInstallManifest } from "./install-manifest.ts";
import { executableFileProblem } from "./path-boundary.ts";
import {
  assertReleaseGuidanceHashes,
  BUNDLED_GUIDANCE_FOLDERS,
  hashReleaseGuidance
} from "./release-guidance.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const CHECKSUM_PATTERN = /^(?<hash>[0-9a-f]{64}) {2}(?<name>[^/\s]+)$/u;
const LEADING_ARCHIVE_PATH_PATTERN = /^\.\/?/u;
const TRAILING_SLASH_PATTERN = /\/$/u;
const ZERO_COMMIT_PATTERN = /^0{40}$/u;
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
const RELEASE_INPUTS = [
  ".github/actions/setup-mainline/",
  ".github/workflows/publish.yml",
  "install.sh",
  "instructions/GLOBAL.md",
  "package.json",
  "scripts/install-local.sh",
  "scripts/install-release.sh",
  "scripts/release-bundle.ts",
  "src/",
  "skills/codex/",
  "skills/imported/",
  "skills/internal/",
  "skills/references/",
  "tsconfig.json",
  "vite.config.ts"
] as const;

export const SUPPORTED_RELEASE_PLATFORMS = RELEASE_PLATFORM_VALUES;

interface BuildReleaseBundleOptions {
  createdAt?: string;
  outputDirectory: string;
  platform: output<typeof ReleasePlatformSchema>;
  sourceCommit: string;
  version: string;
}

interface VerifyReleaseArchiveOptions {
  archivePath: string;
  checksumPath?: string;
  expectedGuidanceRoot?: string;
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

export function isReleaseOwnedPath(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");
  return RELEASE_INPUTS.some((input) =>
    input.endsWith("/") ? normalized.startsWith(input) : normalized === input
  );
}

export function hasReleaseOwnedChanges(filePaths: string[]) {
  if (filePaths.some(isReleaseOwnedPath)) {
    return true;
  }
  return (
    filePaths.includes("bun.lock") &&
    !filePaths.some((filePath) => filePath.startsWith("packages/"))
  );
}

export function deriveNextReleaseVersion(tags: string[]) {
  const versions = tags
    .filter((tag) => ReleaseTagSchema.safeParse(tag).success)
    .map((tag) => tag.slice(RELEASE_TAG_PREFIX.length))
    .toSorted(compareStableSemanticVersions);
  const current = parseSemanticVersion(versions.at(-1) ?? "0.0.0");
  return `${String(current[0])}.${String(current[1])}.${String(current[2] + 1n)}`;
}

export function buildReleaseBundle(options: BuildReleaseBundleOptions) {
  const version = StableSemanticVersionSchema.parse(options.version);
  const platform = ReleasePlatformSchema.parse(options.platform);
  const sourceCommit = FullCommitSchema.parse(options.sourceCommit);
  const outputDirectory = path.resolve(options.outputDirectory);
  const archiveName = releaseArchiveName(version, platform);
  const archivePath = path.join(outputDirectory, archiveName);
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "monke-tools-release-build-"));
  const bundleRoot = path.join(temporaryRoot, "bundle");

  try {
    mkdirSync(bundleRoot, { recursive: true });
    mkdirSync(outputDirectory, { recursive: true });
    compileExecutable(path.join(bundleRoot, "mt"), platform, version);
    copyBundleInputs(bundleRoot);

    const manifest: ReleaseInstallManifest = ReleaseInstallManifestSchema.parse({
      artifactDigest: hash("sha256", readFileSync(path.join(bundleRoot, "mt")), "hex"),
      artifactName: archiveName,
      createdAt: options.createdAt ?? new Date().toISOString(),
      guidanceHashes: hashReleaseGuidance(bundleRoot),
      installKind: "release",
      minimumCodiffVersion: MINIMUM_CODIFF_VERSION_TEXT,
      platform,
      releaseTag: `${RELEASE_TAG_PREFIX}${version}`,
      releaseVersion: version,
      schemaVersion: 1,
      sourceCommit,
      toolBuildIdentity: version
    });
    writeFileSync(
      path.join(bundleRoot, "install-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8"
    );
    run("tar", ["-czf", archivePath, "-C", bundleRoot, "."]);
    return archivePath;
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

export function writeReleaseChecksums(directory: string, version: string) {
  const outputDirectory = path.resolve(directory);
  const archiveNames = SUPPORTED_RELEASE_PLATFORMS.map((platform) =>
    releaseArchiveName(version, platform)
  );
  for (const archiveName of archiveNames) {
    if (!existsSync(path.join(outputDirectory, archiveName))) {
      throw new Error(`Release archive is missing: ${archiveName}`);
    }
  }
  const checksumPath = path.join(outputDirectory, releaseChecksumsName(version));
  const contents = archiveNames
    .map(
      (archiveName) =>
        `${hash("sha256", readFileSync(path.join(outputDirectory, archiveName)), "hex")}  ${archiveName}`
    )
    .join("\n");
  writeFileSync(checksumPath, `${contents}\n`, "utf-8");
  return checksumPath;
}

export function verifyReleaseArchive(options: VerifyReleaseArchiveOptions): ReleaseInstallManifest {
  const archivePath = path.resolve(options.archivePath);
  const expectedVersion = StableSemanticVersionSchema.parse(options.expectedVersion);
  const expectedPlatform = ReleasePlatformSchema.parse(options.expectedPlatform);
  const expectedSourceCommit = FullCommitSchema.parse(options.expectedSourceCommit);
  const expectedArchiveName = releaseArchiveName(expectedVersion, expectedPlatform);
  if (path.basename(archivePath) !== expectedArchiveName) {
    throw new Error(
      `Release archive name mismatch: expected ${expectedArchiveName}, found ${path.basename(archivePath)}`
    );
  }
  if (options.checksumPath) {
    verifyArchiveChecksum(archivePath, options.checksumPath);
  }

  const entries = listArchiveEntries(archivePath);
  assertArchiveContract(entries);
  const extractedRoot = mkdtempSync(path.join(tmpdir(), "monke-tools-release-verify-"));
  try {
    run("tar", ["-xzf", archivePath, "-C", extractedRoot]);
    assertNoLinks(extractedRoot);
    assertExecutable(path.join(extractedRoot, "mt"), "Release executable");
    assertExecutable(path.join(extractedRoot, "install.sh"), "Release installer");

    const manifestPath = path.join(extractedRoot, "install-manifest.json");
    const manifest = ReleaseInstallManifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, "utf-8"))
    );
    const expectedTag = `${RELEASE_TAG_PREFIX}${expectedVersion}`;
    if (
      manifest.releaseVersion !== expectedVersion ||
      manifest.toolBuildIdentity !== expectedVersion
    ) {
      throw new Error(`Release manifest Tool build identity does not match ${expectedVersion}`);
    }
    if (manifest.releaseTag !== expectedTag) {
      throw new Error(`Release manifest tag does not match ${expectedTag}`);
    }
    if (manifest.sourceCommit !== expectedSourceCommit) {
      throw new Error("Release manifest source commit does not match the selected commit");
    }
    if (manifest.platform !== expectedPlatform) {
      throw new Error(`Release manifest platform does not match ${expectedPlatform}`);
    }
    if (manifest.artifactName !== expectedArchiveName) {
      throw new Error(`Release manifest artifact identity does not match ${expectedArchiveName}`);
    }
    if (
      manifest.artifactDigest !==
      hash("sha256", readFileSync(path.join(extractedRoot, "mt")), "hex")
    ) {
      throw new Error("Release manifest artifact digest does not match its executable");
    }
    assertReleaseGuidanceHashes(manifest.guidanceHashes, hashReleaseGuidance(extractedRoot));
    if (options.expectedGuidanceRoot) {
      assertReleaseGuidanceHashes(
        manifest.guidanceHashes,
        hashReleaseGuidance(path.resolve(options.expectedGuidanceRoot))
      );
    }

    if (options.verifyExecutable !== false) {
      const version = spawnSync(path.join(extractedRoot, "mt"), ["--version"], {
        encoding: "utf-8"
      });
      if (version.status !== 0 || version.stdout.trim() !== expectedVersion) {
        throw new Error(`Release executable Tool build identity does not match ${expectedVersion}`);
      }
      const installer = spawnSync(path.join(extractedRoot, "install.sh"), ["--verify"], {
        encoding: "utf-8"
      });
      if (installer.status !== 0) {
        throw new Error(`Release installer verification failed: ${installer.stderr.trim()}`);
      }
    }
    return manifest;
  } finally {
    rmSync(extractedRoot, { force: true, recursive: true });
  }
}

export function verifyReleaseAssets(options: {
  directory: string;
  expectedGuidanceRoot: string;
  sourceCommit: string;
  version: string;
}) {
  const directory = path.resolve(options.directory);
  const checksumPath = path.join(directory, releaseChecksumsName(options.version));
  const checksums = readChecksums(checksumPath);
  const expectedNames = SUPPORTED_RELEASE_PLATFORMS.map((platform) =>
    releaseArchiveName(options.version, platform)
  );
  const actualArchiveNames = readdirSync(directory)
    .filter((name) => name.endsWith(".tar.gz"))
    .toSorted();
  if (JSON.stringify(actualArchiveNames) !== JSON.stringify(expectedNames.toSorted())) {
    throw new Error("Release assets must contain exactly the supported platform archives");
  }
  if (
    checksums.size !== expectedNames.length ||
    expectedNames.some((archiveName) => !checksums.has(archiveName))
  ) {
    throw new Error("Release checksums must cover every supported platform archive exactly once");
  }
  return SUPPORTED_RELEASE_PLATFORMS.map((platform) =>
    verifyReleaseArchive({
      archivePath: path.join(directory, releaseArchiveName(options.version, platform)),
      checksumPath,
      expectedGuidanceRoot: options.expectedGuidanceRoot,
      expectedPlatform: platform,
      expectedSourceCommit: options.sourceCommit,
      expectedVersion: options.version,
      verifyExecutable: false
    })
  );
}

function compileExecutable(
  outputPath: string,
  platform: output<typeof ReleasePlatformSchema>,
  version: string
) {
  const target = platform === "macos-arm64" ? "bun-darwin-arm64" : "bun-linux-x64";
  run("bun", [
    "build",
    "--compile",
    "--target",
    target,
    "--define",
    `process.env.MONKE_TOOLS_BUILD_IDENTITY=${JSON.stringify(version)}`,
    "--outfile",
    outputPath,
    path.join(repositoryRoot, "src", "index.ts")
  ]);
  chmodSync(outputPath, 0o755);
}

function copyBundleInputs(bundleRoot: string) {
  for (const folder of BUNDLED_GUIDANCE_FOLDERS) {
    cpSync(path.join(repositoryRoot, "skills", folder), path.join(bundleRoot, "skills", folder), {
      recursive: true
    });
  }
  mkdirSync(path.join(bundleRoot, "instructions"), { recursive: true });
  cpSync(
    path.join(repositoryRoot, "instructions", "GLOBAL.md"),
    path.join(bundleRoot, "instructions", "GLOBAL.md")
  );
  cpSync(
    path.join(repositoryRoot, "scripts", "install-release.sh"),
    path.join(bundleRoot, "install.sh")
  );
  chmodSync(path.join(bundleRoot, "install.sh"), 0o755);
}

function verifyArchiveChecksum(archivePath: string, checksumPath: string) {
  const checksums = readChecksums(checksumPath);
  const archiveName = path.basename(archivePath);
  const expected = checksums.get(archiveName);
  if (expected === undefined) {
    throw new Error(`Release checksum is missing for ${archiveName}`);
  }
  if (expected !== hash("sha256", readFileSync(archivePath), "hex")) {
    throw new Error(`Release checksum mismatch for ${archiveName}`);
  }
}

function readChecksums(checksumPath: string) {
  const lines = readFileSync(checksumPath, "utf-8").trim().split("\n");
  const checksums = new Map<string, string>();
  for (const entry of ChecksumEntriesSchema.parse(lines)) {
    checksums.set(entry.name, entry.hash);
  }
  return checksums;
}

function listArchiveEntries(archivePath: string) {
  return run("tar", ["-tzf", archivePath])
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
    throw new Error("Release archive contains duplicate entries");
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
      throw new Error(`Unsafe or unexpected Release archive entry: ${entry}`);
    }
  }
  for (const required of requiredEntries) {
    if (!entries.includes(required)) {
      throw new Error(`Release archive entry is missing: ${required}`);
    }
  }
}

function assertNoLinks(root: string) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Release archive contains a symbolic link: ${entry.name}`);
    }
    if (stat.isDirectory()) {
      assertNoLinks(entryPath);
    }
  }
}

function assertExecutable(filePath: string, label: string) {
  if (executableFileProblem(filePath) !== null) {
    throw new Error(`${label} is missing or not executable: ${filePath}`);
  }
}

function parseSemanticVersion(value: string): [bigint, bigint, bigint] {
  const parts = StableSemanticVersionSchema.parse(value).split(".");
  return [BigInt(parts[0] ?? ""), BigInt(parts[1] ?? ""), BigInt(parts[2] ?? "")];
}

export function compareStableSemanticVersions(left: string, right: string) {
  const leftParts = parseSemanticVersion(left);
  const rightParts = parseSemanticVersion(right);
  for (const index of [0, 1, 2]) {
    const leftPart = leftParts[index] ?? 0n;
    const rightPart = rightParts[index] ?? 0n;
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
}

function run(command: string, arguments_: string[], cwd = repositoryRoot) {
  const result = spawnSync(command, arguments_, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`
    );
  }
  return result.stdout;
}

function requiredOption(arguments_: string[], name: string) {
  const value = optionalOption(arguments_, name);
  if (value === undefined) {
    throw new Error(`Missing required option ${name}`);
  }
  return value;
}

function optionalOption(arguments_: string[], name: string) {
  const index = arguments_.indexOf(name);
  const value = index === -1 ? undefined : arguments_[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function changedPaths(before: string, after: string) {
  FullCommitSchema.parse(after);
  if (ZERO_COMMIT_PATTERN.test(before)) {
    return run("git", ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", after])
      .trim()
      .split("\n")
      .filter(Boolean);
  }
  FullCommitSchema.parse(before);
  return run("git", ["diff", "--name-only", "--no-renames", before, after])
    .trim()
    .split("\n")
    .filter(Boolean);
}

export function runReleaseBundleCli(arguments_: string[]) {
  const [command] = arguments_;
  switch (command) {
    case undefined: {
      throw new Error("Missing Release bundle command");
    }
    case "build": {
      const platform = ReleasePlatformSchema.parse(requiredOption(arguments_, "--platform"));
      const archivePath = buildReleaseBundle({
        outputDirectory: requiredOption(arguments_, "--output"),
        platform,
        sourceCommit: requiredOption(arguments_, "--source-commit"),
        version: requiredOption(arguments_, "--version")
      });
      process.stdout.write(`${archivePath}\n`);
      return;
    }
    case "checksums": {
      const checksumPath = writeReleaseChecksums(
        requiredOption(arguments_, "--directory"),
        requiredOption(arguments_, "--version")
      );
      process.stdout.write(`${checksumPath}\n`);
      return;
    }
    case "next-version": {
      const tags = run("git", ["tag", "--list", `${RELEASE_TAG_PREFIX}*`])
        .trim()
        .split("\n")
        .filter(Boolean);
      process.stdout.write(`${deriveNextReleaseVersion(tags)}\n`);
      return;
    }
    case "relevant": {
      const relevant = hasReleaseOwnedChanges(
        changedPaths(requiredOption(arguments_, "--before"), requiredOption(arguments_, "--after"))
      );
      process.stdout.write(`${String(relevant)}\n`);
      return;
    }
    case "verify": {
      verifyReleaseArchive({
        archivePath: requiredOption(arguments_, "--archive"),
        checksumPath: optionalOption(arguments_, "--checksums"),
        expectedGuidanceRoot: repositoryRoot,
        expectedPlatform: ReleasePlatformSchema.parse(requiredOption(arguments_, "--platform")),
        expectedSourceCommit: requiredOption(arguments_, "--source-commit"),
        expectedVersion: requiredOption(arguments_, "--version")
      });
      return;
    }
    case "verify-assets": {
      verifyReleaseAssets({
        directory: requiredOption(arguments_, "--directory"),
        expectedGuidanceRoot: repositoryRoot,
        sourceCommit: requiredOption(arguments_, "--source-commit"),
        version: requiredOption(arguments_, "--version")
      });
      return;
    }
    default: {
      throw new Error(`Unknown Release bundle command: ${command ?? ""}`);
    }
  }
}
