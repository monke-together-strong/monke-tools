import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { sha256 } from "./digest.ts";
import { errorMessage, MonkeError } from "./errors.ts";
import {
  FullCommitSchema,
  loadActiveToolInstall,
  RELEASE_TAG_PREFIX,
  ReleaseTagSchema
} from "./install-manifest.ts";
import type { ReleaseInstallManifest, ToolInstallManifest } from "./install-manifest.ts";
import {
  cleanupStaleStagingDirectories,
  releasePlatform,
  runActivateReleaseInstall
} from "./installation.ts";
import { createLogger } from "./logger.ts";
import {
  releaseArchiveName,
  releaseChecksumsName,
  compareStableSemanticVersions,
  verifyReleaseArchive
} from "./release-bundle.ts";
import { findChangedReleaseGuidancePaths } from "./release-guidance.ts";
import { getMonkeHome, withInstallationLockAsync } from "./runtime.ts";
import type { ReleaseCatalogAsset, ReleaseCatalogEntry, Runtime } from "./types.ts";

const MAX_RELEASE_PAGES = 10_000;

export async function runUpdate(runtime: Runtime, options: { check: boolean }) {
  const monkeHome = getMonkeHome(runtime);
  const active = loadActiveToolInstall(monkeHome);
  if (active === null) {
    throw new MonkeError("No Active tool install was found; install monke-tools before updating");
  }
  assertReleaseInstallNotCustomized(active);
  const platform = releasePlatform(runtime);

  if (options.check) {
    createLogger(runtime).progress("Checking the stable monke-tools Release catalog...");
    const selected = await selectLatestStableRelease(runtime);
    assertSelectedReleaseContract(selected, platform);
    reportAvailability(runtime, active.manifest, selected.version);
    return;
  }

  await withInstallationLockAsync(monkeHome, async () => {
    const lockedActive = loadActiveToolInstall(monkeHome);
    if (lockedActive === null) {
      throw new MonkeError("The Active tool install disappeared while update was starting");
    }
    assertReleaseInstallNotCustomized(lockedActive);
    cleanupStaleStagingDirectories(monkeHome);
    createLogger(runtime).progress("Checking the stable monke-tools Release catalog...");
    const selected = await selectLatestStableRelease(runtime);
    const contract = assertSelectedReleaseContract(selected, platform);
    if (!isUpdateAvailable(lockedActive.manifest, selected.version)) {
      reportAvailability(runtime, lockedActive.manifest, selected.version);
      return;
    }

    try {
      await downloadAndActivate(
        runtime,
        contract,
        selected.version,
        selected.release.target_commitish
      );
    } catch (error) {
      if (
        lockedActive.manifest.installKind === "local" &&
        isSelectedReleaseActive(monkeHome, selected.version)
      ) {
        reportLocalTransition(runtime, lockedActive.manifest.sourceCheckout);
      }
      throw error;
    }
    const logger = createLogger(runtime);
    logger.success(`Updated monke-tools to ${selected.version}`);
    if (lockedActive.manifest.installKind === "local") {
      reportLocalTransition(runtime, lockedActive.manifest.sourceCheckout);
    }
  });
}

function assertReleaseInstallNotCustomized(
  active: NonNullable<ReturnType<typeof loadActiveToolInstall>>
) {
  if (active.manifest.installKind !== "release") {
    return;
  }
  const changedPaths = findChangedReleaseGuidancePaths(
    active.installRoot,
    active.manifest.guidanceHashes
  );
  if (changedPaths.length > 0) {
    throw new MonkeError(
      `Customized release install cannot be updated. Changed guidance paths:\n${changedPaths.map((filePath) => `- ${filePath}`).join("\n")}\nNo files were changed. V1 does not automatically back up, migrate, reset, or discard customized guidance.`
    );
  }
}

async function selectLatestStableRelease(runtime: Runtime) {
  let selected: ReleaseCatalogEntry | null = null;
  let selectedVersion = "";
  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- GitHub pagination stops at the first empty page.
    const releases = await runtime.releaseDistribution.listReleases(page);
    for (const release of releases) {
      if (
        release.draft ||
        release.prerelease ||
        !ReleaseTagSchema.safeParse(release.tag_name).success
      ) {
        continue;
      }
      const version = release.tag_name.slice(RELEASE_TAG_PREFIX.length);
      if (selected === null || compareStableSemanticVersions(version, selectedVersion) > 0) {
        selected = release;
        selectedVersion = version;
      }
    }
    if (releases.length === 0) {
      if (selected === null) {
        throw new MonkeError("No stable monke-tools Release was found");
      }
      return { release: selected, version: selectedVersion };
    }
  }
  throw new MonkeError("GitHub Release lookup exceeded the pagination safety limit");
}

function assertSelectedReleaseContract(
  selected: Awaited<ReturnType<typeof selectLatestStableRelease>>,
  platform: ReleaseInstallManifest["platform"]
) {
  FullCommitSchema.parse(selected.release.target_commitish);
  const archiveName = releaseArchiveName(selected.version, platform);
  const checksumsName = releaseChecksumsName(selected.version);
  const archive = selectAsset(selected.release.assets, archiveName);
  const checksums = selectAsset(selected.release.assets, checksumsName);
  for (const asset of [archive, checksums]) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(asset.digest ?? "")) {
      throw new MonkeError(`Selected Release asset has no valid SHA-256 digest: ${asset.name}`);
    }
    const expectedUrl = `https://github.com/monke-together-strong/monke-tools/releases/download/${selected.release.tag_name}/${asset.name}`;
    if (asset.browser_download_url !== expectedUrl) {
      throw new MonkeError(`Selected Release asset has an unexpected download URL: ${asset.name}`);
    }
  }
  return { archive, archiveName, checksums, checksumsName, platform };
}

async function downloadAndActivate(
  runtime: Runtime,
  contract: ReturnType<typeof assertSelectedReleaseContract>,
  version: string,
  sourceCommit: string
) {
  const monkeHome = getMonkeHome(runtime);
  const stagingRoot = path.join(monkeHome, "install-staging");
  mkdirSync(stagingRoot, { recursive: true });
  const updateRoot = mkdtempSync(path.join(stagingRoot, "update-"));
  try {
    const archivePath = path.join(updateRoot, contract.archiveName);
    const checksumsPath = path.join(updateRoot, contract.checksumsName);
    const logger = createLogger(runtime);
    logger.progress(`Downloading monke-tools ${version} for ${contract.platform}...`);
    const [archive, checksums] = await Promise.all([
      runtime.releaseDistribution.downloadReleaseAsset(contract.archive.browser_download_url),
      runtime.releaseDistribution.downloadReleaseAsset(contract.checksums.browser_download_url)
    ]);
    assertAssetDigest(archive, contract.archive);
    assertAssetDigest(checksums, contract.checksums);
    writeFileSync(archivePath, archive);
    writeFileSync(checksumsPath, checksums);
    logger.progress(`Verifying monke-tools ${version}...`);
    try {
      verifyReleaseArchive({
        archivePath,
        checksumPath: checksumsPath,
        expectedPlatform: contract.platform,
        expectedSourceCommit: sourceCommit,
        expectedVersion: version
      });
    } catch (error) {
      throw new MonkeError(`Release archive verification failed: ${errorMessage(error)}`);
    }

    const bundleRoot = path.join(updateRoot, `bundle-${randomUUID()}`);
    mkdirSync(bundleRoot);
    runtime.exec("tar", ["-xzf", archivePath, "-C", bundleRoot]);
    await runActivateReleaseInstall(runtime, { bundleRoot, installationLockHeld: true });
  } finally {
    rmSync(updateRoot, { force: true, recursive: true });
  }
}

function isSelectedReleaseActive(monkeHome: string, selectedVersion: string) {
  try {
    const active = loadActiveToolInstall(monkeHome);
    return (
      active?.manifest.installKind === "release" &&
      active.manifest.releaseVersion === selectedVersion
    );
  } catch {
    return false;
  }
}

function reportLocalTransition(runtime: Runtime, sourceCheckout: string) {
  const logger = createLogger(runtime);
  logger.info(
    `Activated a Release install in place of the Local tool install. Preserved Installed source checkout: ${sourceCheckout}`
  );
  logger.hint("To return to Skill authoring mode, run `vp run install:local` from that checkout.");
}

function assertAssetDigest(contents: Uint8Array, asset: ReleaseCatalogAsset) {
  const expected = asset.digest?.slice("sha256:".length);
  const actual = sha256(contents);
  if (actual !== expected) {
    throw new MonkeError(
      `Downloaded Release asset digest does not match GitHub metadata: ${asset.name}`
    );
  }
}

function reportAvailability(
  runtime: Runtime,
  manifest: ToolInstallManifest,
  selectedVersion: string
) {
  const activeToolBuildIdentity =
    manifest.installKind === "release" ? manifest.releaseVersion : manifest.toolBuildIdentity;
  const logger = createLogger(runtime);
  if (isUpdateAvailable(manifest, selectedVersion)) {
    logger.info(`Release update available: ${activeToolBuildIdentity} -> ${selectedVersion}`);
  } else {
    logger.success(
      `Active tool install ${activeToolBuildIdentity} already matches the selected stable Release`
    );
  }
}

function isUpdateAvailable(manifest: ToolInstallManifest, selectedVersion: string) {
  return (
    manifest.installKind === "local" ||
    compareStableSemanticVersions(selectedVersion, manifest.releaseVersion) > 0
  );
}

function selectAsset(assets: ReleaseCatalogAsset[], name: string) {
  const matches = assets.filter((asset) => asset.name === name);
  if (matches.length !== 1) {
    throw new MonkeError(
      matches.length === 0
        ? `Selected Release is missing required asset ${name}`
        : `Selected Release asset metadata is ambiguous: ${name}`
    );
  }
  const [asset] = matches;
  if (!asset) {
    throw new MonkeError(`Selected Release is missing required asset ${name}`);
  }
  return asset;
}
