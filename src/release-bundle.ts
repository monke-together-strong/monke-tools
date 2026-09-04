#!/usr/bin/env bun

import {
  chmodSync,
  cpSync,
  existsSync,
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

import { validate } from "zod";
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
import { runReleaseCommand } from "./release-command.ts";
import {
  compareStableSemanticVersions,
  parseStableSemanticVersion,
  readReleaseChecksums,
  releaseArchiveName,
  releaseChecksumsName,
  verifyReleaseArchive
} from "./release-contract.ts";
import { BUNDLED_GUIDANCE_FOLDERS, hashReleaseGuidance } from "./release-guidance.ts";
import { sha256 } from "./sha256.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const ZERO_COMMIT_PATTERN = /^0{40}$/u;
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

interface BuildReleaseBundleOptions {
  createdAt?: string;
  outputDirectory: string;
  platform: output<typeof ReleasePlatformSchema>;
  sourceCommit: string;
  version: string;
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
    .filter((tag) => validate(ReleaseTagSchema, tag))
    .map((tag) => tag.slice(RELEASE_TAG_PREFIX.length))
    .toSorted(compareStableSemanticVersions);
  const current = parseStableSemanticVersion(versions.at(-1) ?? "0.0.0");
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
      artifactDigest: sha256(readFileSync(path.join(bundleRoot, "mt"))),
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
    runReleaseCommand("tar", ["-czf", archivePath, "-C", bundleRoot, "."], {
      cwd: repositoryRoot,
      env: {
        // oxlint-disable-next-line node/no-process-env -- Preserve the build environment while disabling macOS archive metadata.
        ...process.env,
        COPYFILE_DISABLE: "1"
      }
    });
    return archivePath;
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

export function writeReleaseChecksums(directory: string, version: string) {
  const outputDirectory = path.resolve(directory);
  const archiveNames = RELEASE_PLATFORM_VALUES.map((platform) =>
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
        `${sha256(readFileSync(path.join(outputDirectory, archiveName)))}  ${archiveName}`
    )
    .join("\n");
  writeFileSync(checksumPath, `${contents}\n`, "utf-8");
  return checksumPath;
}

export function writeStableReleaseCatalog(options: {
  directory: string;
  outputPath: string;
  sourceCommit: string;
  version: string;
}) {
  const directory = path.resolve(options.directory);
  const outputPath = path.resolve(options.outputPath);
  const version = StableSemanticVersionSchema.parse(options.version);
  const sourceCommit = FullCommitSchema.parse(options.sourceCommit);
  const archiveDigests = RELEASE_PLATFORM_VALUES.map((platform) =>
    releaseAssetDigest(directory, releaseArchiveName(version, platform))
  );
  const checksumsDigest = releaseAssetDigest(directory, releaseChecksumsName(version));
  const contents = [
    "1",
    version,
    `${RELEASE_TAG_PREFIX}${version}`,
    sourceCommit,
    ...archiveDigests,
    checksumsDigest
  ].join("\t");
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${contents}\n`, "utf-8");
  return outputPath;
}

export function verifyReleaseAssets(options: {
  directory: string;
  expectedGuidanceRoot: string;
  sourceCommit: string;
  version: string;
}) {
  const directory = path.resolve(options.directory);
  const checksumPath = path.join(directory, releaseChecksumsName(options.version));
  const checksums = readReleaseChecksums(checksumPath);
  const expectedNames = RELEASE_PLATFORM_VALUES.map((platform) =>
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
  return RELEASE_PLATFORM_VALUES.map((platform) =>
    verifyReleaseArchive({
      archivePath: path.join(directory, releaseArchiveName(options.version, platform)),
      checksumPath,
      expectedGuidanceRoot: options.expectedGuidanceRoot,
      expectedMinimumCodiffVersion: MINIMUM_CODIFF_VERSION_TEXT,
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
  runReleaseCommand(
    "bun",
    [
      "build",
      "--compile",
      "--bytecode",
      "--bytecode-depth=1",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--target",
      target,
      "--define",
      `process.env.MONKE_TOOLS_BUILD_IDENTITY=${JSON.stringify(version)}`,
      "--outfile",
      outputPath,
      path.join(repositoryRoot, "src", "index.ts")
    ],
    { cwd: repositoryRoot }
  );
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

function releaseAssetDigest(directory: string, assetName: string) {
  const assetPath = path.join(directory, assetName);
  if (!existsSync(assetPath)) {
    throw new Error(`Release asset is missing: ${assetName}`);
  }
  return `sha256:${sha256(readFileSync(assetPath))}`;
}

function changedPaths(before: string, after: string) {
  FullCommitSchema.parse(after);
  if (ZERO_COMMIT_PATTERN.test(before)) {
    return runReleaseCommand(
      "git",
      ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", after],
      { cwd: repositoryRoot }
    )
      .trim()
      .split("\n")
      .filter(Boolean);
  }
  FullCommitSchema.parse(before);
  return runReleaseCommand("git", ["diff", "--name-only", "--no-renames", before, after], {
    cwd: repositoryRoot
  })
    .trim()
    .split("\n")
    .filter(Boolean);
}

export function hasReleaseOwnedChangesBetween(before: string, after: string) {
  return hasReleaseOwnedChanges(changedPaths(before, after));
}

export function listReleaseTags() {
  return runReleaseCommand("git", ["tag", "--list", `${RELEASE_TAG_PREFIX}*`], {
    cwd: repositoryRoot
  })
    .trim()
    .split("\n")
    .filter(Boolean);
}
