import { hash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { number, strictObject } from "zod";

import { reconcileCodiff, MINIMUM_CODIFF_VERSION_TEXT } from "./codiff.ts";
import { errorMessage, MonkeError } from "./errors.ts";
import {
  INSTALL_MANIFEST_FILENAME,
  LocalInstallManifestSchema,
  ReleaseInstallManifestSchema,
  resolveActiveInstallRoot,
  installIdForManifest
} from "./install-manifest.ts";
import type {
  LocalInstallManifest,
  ReleaseInstallManifest,
  ToolInstallManifest
} from "./install-manifest.ts";
import {
  assertManagedInstallRoot,
  cleanupInactiveToolInstalls,
  COLLISION_RECOVERY_FILENAME,
  reconcilePendingInstallBackups,
  withInstallMutationLockAsync,
  writeCollisionRecovery
} from "./install-recovery.ts";
import { createLogger } from "./logger.ts";
import { assertDirectChildPath } from "./path-boundary.ts";
import { assertReleaseGuidanceHashes, hashReleaseGuidance } from "./release-guidance.ts";
import { getHomeDirectory, getMonkeHome } from "./runtime.ts";
import { runShellInstall } from "./shell.ts";
import {
  preflightInstallGuidance,
  runInstallSkillsLocked,
  runReleaseInstallSkillsLocked
} from "./skills.ts";
import type { ExplicitSkillTargetSelection } from "./skills.ts";
import type { Runtime } from "./types.ts";
import { parseBoundaryValue } from "./validation.ts";

const InstallationLockMetadataSchema = strictObject({
  acquiredAt: number().int().nonnegative(),
  pid: number().int().positive()
});
const MANAGED_STAGING_DIRECTORY_PATTERN = /^(?:local|release|update)-[A-Za-z0-9._-]+$/u;

export interface ActivateLocalInstallOptions {
  createdAt: string;
  dirty: boolean;
  explicitTargets?: ExplicitSkillTargetSelection;
  installationLockHeld?: boolean;
  installId: string;
  platform: string;
  sourceCheckout: string;
  sourceCommit: string;
  stagedInstall: string;
}

export interface ActivateReleaseInstallOptions {
  bundleRoot: string;
  explicitTargets?: ExplicitSkillTargetSelection;
  installationLockHeld?: boolean;
  interactive?: boolean;
}

/** Activate a verified Release bundle and finish its installation-adjacent work. */
export async function runActivateReleaseInstall(
  runtime: Runtime,
  options: ActivateReleaseInstallOptions
) {
  const monkeHome = getMonkeHome(runtime);
  const homeDirectory = getHomeDirectory(runtime);
  const sourceBundle = path.resolve(options.bundleRoot);
  const sourceManifest = validateReleaseBundle(runtime, sourceBundle);
  preflightInstallGuidance(runtime, sourceBundle, options.explicitTargets);
  const activate = async () => {
    preflightInstallGuidance(runtime, sourceBundle, options.explicitTargets);
    const stagingRoot = path.join(monkeHome, "install-staging");
    const stagedInstall = path.join(stagingRoot, `release-${randomUUID()}`);
    const stagingRootExisted = existsSync(stagingRoot);
    mkdirSync(stagingRoot, { recursive: true });
    assertDirectChildPath(stagedInstall, stagingRoot, "staged Release tool install");
    let manifest: ReleaseInstallManifest;
    try {
      cpSync(sourceBundle, stagedInstall, { recursive: true });
      manifest = validateReleaseBundle(runtime, stagedInstall);
      if (JSON.stringify(manifest) !== JSON.stringify(sourceManifest)) {
        throw new MonkeError("Release bundle changed while it was being staged");
      }
      preflightInstallGuidance(runtime, stagedInstall, options.explicitTargets);
    } catch (error) {
      rmSync(stagedInstall, { force: true, recursive: true });
      if (!stagingRootExisted && readdirSync(stagingRoot).length === 0) {
        rmdirSync(stagingRoot);
      }
      throw error;
    }
    const installId = releaseInstallId(manifest);

    const predecessor = resolveActiveInstallRoot(monkeHome);
    const collision = prepareValidatedInactiveInstallCollision(monkeHome, installId, predecessor);
    const candidateRoot = path.join(monkeHome, "installs", installId);
    let installRoot: string;
    try {
      installRoot = activateStagedInstall({
        homeDirectory,
        installId,
        manifest,
        monkeHome,
        runtime,
        stagedInstall
      });
    } catch (error) {
      if (resolveActiveInstallRoot(monkeHome) === candidateRoot) {
        collision?.discard();
      } else {
        collision?.restore();
      }
      throw error;
    }
    collision?.discard();
    cleanupInactiveToolInstalls(
      monkeHome,
      new Set([installRoot, ...(predecessor ? [predecessor] : [])])
    );
    cleanupStaleStagingDirectories(monkeHome, stagedInstall);

    const postActivationFailures: string[] = [];
    try {
      runShellInstall(runtime, { binary: path.join(homeDirectory, ".local", "bin", "mt") });
    } catch (error) {
      postActivationFailures.push(
        `Shell integration is incomplete. Retry with: mt shell install\n${errorMessage(error)}`
      );
    }
    try {
      await runReleaseInstallSkillsLocked(runtime, installRoot, {
        explicitTargets: options.explicitTargets,
        interactive: options.interactive === true
      });
    } catch (error) {
      postActivationFailures.push(
        `Skill or Global agent instruction reconciliation is incomplete. Retry with: mt skills configure\n${errorMessage(error)}`
      );
    }
    try {
      reconcileCodiff(runtime, manifest.minimumCodiffVersion);
    } catch (error) {
      postActivationFailures.push(
        `Codiff reconciliation failed. Retry with: mt install-dependencies\n${errorMessage(error)}`
      );
    }

    if (postActivationFailures.length > 0) {
      throw new MonkeError(
        `The Release install is active, but ${postActivationFailures.length} post-activation step(s) are incomplete:\n${postActivationFailures.join("\n")}`
      );
    }
    return { installId, manifest };
  };
  let activated: Awaited<ReturnType<typeof activate>>;
  if (options.installationLockHeld === true) {
    assertInheritedInstallationLock(monkeHome);
    reconcilePendingInstallBackups(monkeHome);
    activated = await activate();
  } else {
    activated = await withInstallMutationLockAsync(monkeHome, activate);
  }

  createLogger(runtime).success(
    `Activated Release install ${activated.manifest.releaseVersion} at ${path.join(monkeHome, "installs", activated.installId)}`
  );
}

function prepareValidatedInactiveInstallCollision(
  monkeHome: string,
  installId: string,
  activeInstallRoot: string | null
) {
  const installRoot = path.join(monkeHome, "installs", installId);
  const backupsRoot = path.join(monkeHome, "install-backups");
  const backupRoot = path.join(backupsRoot, installId);
  assertDirectChildPath(backupRoot, backupsRoot, "collision backup");

  const stat = lstatSync(installRoot, { throwIfNoEntry: false });
  if (!stat) {
    return null;
  }
  if (installRoot === activeInstallRoot || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new MonkeError(`Tool install identity already exists: ${installId}`);
  }
  assertManagedInstallRoot(installRoot, installId);
  mkdirSync(backupsRoot, { recursive: true });
  assertDirectory(backupsRoot, "Install backup root is invalid");
  try {
    writeCollisionRecovery(installRoot, activeInstallRoot);
    renameSync(installRoot, backupRoot);
  } catch (error) {
    rmSync(path.join(installRoot, COLLISION_RECOVERY_FILENAME), { force: true });
    throw error;
  }
  return {
    discard() {
      rmSync(backupRoot, { force: true, recursive: true });
      removeEmptyDirectory(backupsRoot);
    },
    restore() {
      if (lstatSync(backupRoot, { throwIfNoEntry: false })) {
        rmSync(path.join(backupRoot, COLLISION_RECOVERY_FILENAME));
        renameSync(backupRoot, installRoot);
        removeEmptyDirectory(backupsRoot);
      }
    }
  };
}

function removeEmptyDirectory(directory: string) {
  if (
    lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() &&
    readdirSync(directory).length === 0
  ) {
    rmdirSync(directory);
  }
}

/** Activate a fully built Local tool install and finish its installation-adjacent work. */
export async function runActivateLocalInstall(
  runtime: Runtime,
  options: ActivateLocalInstallOptions
) {
  const monkeHome = getMonkeHome(runtime);
  const homeDirectory = getHomeDirectory(runtime);
  const sourceCheckout = path.resolve(options.sourceCheckout);
  preflightInstallGuidance(runtime, sourceCheckout, options.explicitTargets);
  const activate = async () => {
    const stagedInstall = path.resolve(options.stagedInstall);
    assertDirectChildPath(
      stagedInstall,
      path.join(monkeHome, "install-staging"),
      "staged Local tool install"
    );
    assertDirectory(stagedInstall, "Staged Local tool install is missing");
    assertExecutableFile(path.join(stagedInstall, "mt"));

    const manifest = parseBoundaryValue(
      LocalInstallManifestSchema,
      {
        createdAt: options.createdAt,
        createdBy: "bun run install:local",
        installId: options.installId,
        installKind: "local",
        minimumCodiffVersion: MINIMUM_CODIFF_VERSION_TEXT,
        platform: options.platform,
        schemaVersion: 1,
        sourceCheckout,
        sourceCommit: options.sourceCommit,
        sourceDirty: options.dirty,
        toolBuildIdentity: runtime.toolBuildIdentity
      },
      "Local Install manifest"
    );
    if (path.basename(stagedInstall) !== manifest.installId) {
      throw new MonkeError("Staged Local tool install identity does not match --install-id");
    }
    if (!existsSync(path.join(sourceCheckout, "skills"))) {
      throw new MonkeError(`Skill source tree is missing: ${path.join(sourceCheckout, "skills")}`);
    }
    preflightInstallGuidance(runtime, sourceCheckout, options.explicitTargets);

    const predecessor = resolveActiveInstallRoot(monkeHome);
    const installRoot = activateStagedInstall({
      homeDirectory,
      installId: manifest.installId,
      manifest,
      monkeHome,
      runtime,
      stagedInstall
    });

    cleanupInactiveToolInstalls(
      monkeHome,
      new Set([installRoot, ...(predecessor ? [predecessor] : [])])
    );
    cleanupStaleStagingDirectories(monkeHome, stagedInstall);

    const stableCommand = path.join(homeDirectory, ".local", "bin", "mt");
    runShellInstall(runtime, { binary: stableCommand });
    try {
      await runInstallSkillsLocked(runtime, sourceCheckout, options.explicitTargets);
    } catch (error) {
      throw new MonkeError(
        `The Local tool install is active, but Skill or Global agent instruction reconciliation is incomplete. Retry with: mt skills configure\n${errorMessage(error)}`
      );
    }

    try {
      reconcileCodiff(runtime, manifest.minimumCodiffVersion);
    } catch (error) {
      throw new MonkeError(
        `The Local tool install is active, but Codiff reconciliation failed. Retry with: mt install-dependencies\n${errorMessage(error)}`
      );
    }

    return manifest;
  };

  let manifest: LocalInstallManifest;
  if (options.installationLockHeld === true) {
    assertInheritedInstallationLock(monkeHome);
    reconcilePendingInstallBackups(monkeHome);
    manifest = await activate();
  } else {
    manifest = await withInstallMutationLockAsync(monkeHome, activate);
  }

  createLogger(runtime).success(
    `Activated Local tool install ${manifest.toolBuildIdentity} at ${path.join(monkeHome, "installs", manifest.installId)}`
  );
}

function activateStagedInstall(options: {
  homeDirectory: string;
  installId: string;
  manifest: ToolInstallManifest;
  monkeHome: string;
  runtime: Runtime;
  stagedInstall: string;
}) {
  const installsRoot = path.join(options.monkeHome, "installs");
  const installRoot = path.join(installsRoot, options.installId);
  mkdirSync(installsRoot, { recursive: true });
  if (lstatSync(installRoot, { throwIfNoEntry: false })) {
    throw new MonkeError(`Tool install identity already exists: ${options.installId}`);
  }
  const stableMt = path.join(options.homeDirectory, ".local", "bin", "mt");
  const stableMonke = path.join(options.homeDirectory, ".local", "bin", "monke");
  const obsoleteCommand = path.join(options.homeDirectory, ".local", "bin", "monke-tools");
  assertCommandEntryCanBeReplaced(stableMt);
  assertCommandEntryCanBeReplaced(stableMonke);
  assertCommandEntryCanBeReplaced(obsoleteCommand);

  writeFileSync(
    path.join(options.stagedInstall, INSTALL_MANIFEST_FILENAME),
    `${JSON.stringify(options.manifest, null, 2)}\n`,
    "utf-8"
  );
  try {
    options.runtime.installationActivationBoundary?.("final-rename");
    renameSync(options.stagedInstall, installRoot);
  } catch (error) {
    rmSync(options.stagedInstall, { force: true, recursive: true });
    throw error;
  }

  const currentPointer = path.join(options.monkeHome, "current");
  const temporaryPointer = `${currentPointer}.${randomUUID()}.tmp`;
  symlinkSync(path.relative(options.monkeHome, installRoot), temporaryPointer, "dir");
  try {
    options.runtime.installationActivationBoundary?.("pointer-replacement");
    renameSync(temporaryPointer, currentPointer);
  } catch (error) {
    rmSync(temporaryPointer, { force: true });
    rmSync(installRoot, { recursive: true });
    throw error;
  }

  installStableCommand(stableMt, path.join(currentPointer, "mt"));
  installStableCommand(stableMonke, stableMt);
  rmSync(obsoleteCommand, { force: true });
  return installRoot;
}

function installStableCommand(commandPath: string, targetPath: string) {
  mkdirSync(path.dirname(commandPath), { recursive: true });
  const stat = lstatSync(commandPath, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink() === true && readlinkSync(commandPath) === targetPath) {
    return;
  }
  if (stat) {
    rmSync(commandPath);
  }
  const temporaryLink = `${commandPath}.${randomUUID()}.tmp`;
  symlinkSync(targetPath, temporaryLink, "file");
  renameSync(temporaryLink, commandPath);
}

function assertCommandEntryCanBeReplaced(commandPath: string) {
  const stat = lstatSync(commandPath, { throwIfNoEntry: false });
  if (stat && !stat.isFile() && !stat.isSymbolicLink()) {
    throw new MonkeError(`Refusing to replace non-file command entry at ${commandPath}`);
  }
}

function validateReleaseBundle(runtime: Runtime, bundleRoot: string) {
  const resolvedRoot = path.resolve(bundleRoot);
  assertDirectory(resolvedRoot, "Release bundle is missing");
  assertExecutableFile(path.join(resolvedRoot, "mt"));
  assertExecutableFile(path.join(resolvedRoot, "install.sh"));
  assertRegularFile(path.join(resolvedRoot, "instructions", "GLOBAL.md"));
  const manifestPath = path.join(resolvedRoot, INSTALL_MANIFEST_FILENAME);
  let manifest: ReleaseInstallManifest;
  try {
    manifest = ReleaseInstallManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf-8")));
  } catch {
    throw new MonkeError(`Invalid Release Install manifest: ${manifestPath}`);
  }
  const executableIdentity = runtime.exec(path.join(resolvedRoot, "mt"), ["--version"], {
    allowFailure: true
  });
  if (
    executableIdentity.exitCode !== 0 ||
    executableIdentity.stdout.trim() !== manifest.toolBuildIdentity
  ) {
    throw new MonkeError("Release executable identity does not match its Install manifest");
  }
  if (
    manifest.artifactDigest !== hash("sha256", readFileSync(path.join(resolvedRoot, "mt")), "hex")
  ) {
    throw new MonkeError("Release executable digest does not match its Install manifest");
  }
  if (manifest.platform !== releasePlatform(runtime)) {
    throw new MonkeError(`Release bundle platform does not match ${releasePlatform(runtime)}`);
  }
  assertReleaseGuidanceHashes(manifest.guidanceHashes, hashReleaseGuidance(resolvedRoot));
  return manifest;
}

export function releasePlatform(runtime: Runtime) {
  if (runtime.platform === "darwin" && runtime.architecture === "arm64") {
    return "macos-arm64";
  }
  if (runtime.platform === "linux" && runtime.architecture === "x64") {
    return "linux-x64";
  }
  throw new MonkeError("Unsupported Release platform; supported platforms: macOS arm64, Linux x64");
}

function releaseInstallId(manifest: ReleaseInstallManifest) {
  return installIdForManifest(manifest);
}

export function cleanupStaleStagingDirectories(monkeHome: string, activeStage?: string) {
  const stagingRoot = path.join(monkeHome, "install-staging");
  if (!existsSync(stagingRoot)) {
    return;
  }
  for (const entry of readdirSync(stagingRoot, { withFileTypes: true })) {
    const candidate = path.join(stagingRoot, entry.name);
    if (
      candidate === activeStage ||
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !MANAGED_STAGING_DIRECTORY_PATTERN.test(entry.name)
    ) {
      continue;
    }
    const finalStat = lstatSync(candidate, { throwIfNoEntry: false });
    if (finalStat?.isDirectory() === true && !finalStat.isSymbolicLink()) {
      rmSync(candidate, { recursive: true });
    }
  }
}

function assertDirectory(directory: string, message: string) {
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new MonkeError(`${message}: ${directory}`);
  }
}

function assertExecutableFile(executable: string) {
  const stat = lstatSync(executable, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    throw new MonkeError(`Staged mt executable is missing: ${executable}`);
  }
}

function assertRegularFile(filePath: string) {
  const stat = lstatSync(filePath, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    throw new MonkeError(`Release bundle file is missing: ${filePath}`);
  }
}

function assertInheritedInstallationLock(monkeHome: string) {
  const lockPath = path.join(monkeHome, "locks", "installation.lock");
  const stat = lstatSync(lockPath, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new MonkeError(`Inherited installation lock is missing: ${lockPath}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(lockPath, "utf-8"));
  } catch {
    throw new MonkeError(`Inherited installation lock is invalid: ${lockPath}`);
  }
  const metadata = parseBoundaryValue(
    InstallationLockMetadataSchema,
    value,
    "inherited installation lock"
  );
  if (metadata.pid !== process.pid && metadata.pid !== process.ppid) {
    throw new MonkeError(
      `Inherited installation lock is not owned by this process or its parent: ${lockPath}`
    );
  }
}
