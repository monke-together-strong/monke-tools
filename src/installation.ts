import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
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
import { runInstallSkillsLocked, runReleaseInstallSkillsLocked } from "./guidance-installation.ts";
import {
  INSTALL_MANIFEST_FILENAME,
  LocalInstallManifestSchema,
  resolveActiveInstallRoot,
  installIdForManifest
} from "./install-manifest.ts";
import type { ReleaseInstallManifest, ToolInstallManifest } from "./install-manifest.ts";
import {
  assertManagedInstallRoot,
  cleanupInactiveToolInstalls,
  COLLISION_RECOVERY_FILENAME,
  reconcilePendingInstallBackups,
  withInstallMutationLockAsync,
  writeCollisionRecovery
} from "./install-recovery.ts";
import { createLogger } from "./logger.ts";
import {
  assertDirectChildPath,
  assertDirectoryMutationAccess,
  executableFileProblem,
  resolveManagedDirectory
} from "./path-boundary.ts";
import { validateReleaseBundleRoot } from "./release-contract.ts";
import type { ExpectedReleaseIdentity } from "./release-contract.ts";
import { getHomeDirectory, getMonkeHome, isProcessRunning } from "./runtime.ts";
import { runShellInstall } from "./shell.ts";
import { preflightInstallGuidance } from "./skills.ts";
import type { ExplicitSkillTargetSelection } from "./skills.ts";
import type { Runtime } from "./types.ts";
import { parseBoundaryValue } from "./validation.ts";

const InstallationLockMetadataSchema = strictObject({
  acquiredAt: number().int().nonnegative(),
  pid: number().int().positive()
});
const MANAGED_STAGING_DIRECTORY_PATTERN = /^(?:local|release|update)-[A-Za-z0-9._-]+$/u;
const PUBLIC_BOOTSTRAP_STAGING_DIRECTORY_PATTERN = /^public-bootstrap-[A-Za-z0-9._-]+$/u;
const PUBLIC_BOOTSTRAP_PID_FILENAME = ".monke-tools-bootstrap-pid";
const PUBLIC_BOOTSTRAP_CREATION_GRACE_MS = 5 * 60 * 1000;

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
  expectedReleaseIdentity?: ExpectedReleaseIdentity;
  explicitTargets?: ExplicitSkillTargetSelection;
  installationLockHeld?: boolean;
  interactive?: boolean;
}

/** Read the catalog identity handed from the public bootstrap to its bundled executable. */
export function expectedReleaseIdentityFromEnvironment(
  environment: NodeJS.ProcessEnv
): ExpectedReleaseIdentity | undefined {
  const identity = {
    artifactName: environment.MONKE_TOOLS_EXPECTED_ARTIFACT_NAME,
    releaseTag: environment.MONKE_TOOLS_EXPECTED_RELEASE_TAG,
    releaseVersion: environment.MONKE_TOOLS_EXPECTED_RELEASE_VERSION,
    sourceCommit: environment.MONKE_TOOLS_EXPECTED_SOURCE_COMMIT
  };
  const values = Object.values(identity);
  if (values.every((value) => value === undefined)) {
    return undefined;
  }
  if (values.some((value) => value === undefined)) {
    throw new MonkeError("Public bootstrap Release identity is incomplete");
  }
  return {
    artifactName: identity.artifactName ?? "",
    releaseTag: identity.releaseTag ?? "",
    releaseVersion: identity.releaseVersion ?? "",
    sourceCommit: identity.sourceCommit ?? ""
  };
}

/** Activate a verified Release bundle and finish its installation-adjacent work. */
export async function runActivateReleaseInstall(
  runtime: Runtime,
  options: ActivateReleaseInstallOptions
) {
  const monkeHome = getMonkeHome(runtime);
  const homeDirectory = getHomeDirectory(runtime);
  const sourceBundle = path.resolve(options.bundleRoot);
  const sourceManifest = validateReleaseBundle(
    runtime,
    sourceBundle,
    options.expectedReleaseIdentity
  );
  preflightInstallGuidance(runtime, sourceBundle, options.explicitTargets);
  const activate = async () => {
    preflightInstallGuidance(runtime, sourceBundle, options.explicitTargets);
    const stagingRoot = path.join(monkeHome, "install-staging");
    const stagedInstall = path.join(stagingRoot, `release-${crypto.randomUUID()}`);
    const stagingRootExisted = existsSync(stagingRoot);
    mkdirSync(stagingRoot, { recursive: true });
    assertDirectChildPath(stagedInstall, stagingRoot, "staged Release tool install");
    let manifest: ReleaseInstallManifest;
    try {
      cpSync(sourceBundle, stagedInstall, { recursive: true });
      manifest = validateReleaseBundle(runtime, stagedInstall, options.expectedReleaseIdentity);
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
    const installId = installIdForManifest(manifest);

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
      const candidateStat = lstatSync(candidateRoot, { throwIfNoEntry: false });
      const activeCandidateRoot =
        candidateStat?.isDirectory() && !candidateStat.isSymbolicLink()
          ? realpathSync.native(candidateRoot)
          : null;
      if (
        activeCandidateRoot !== null &&
        resolveActiveInstallRoot(monkeHome) === activeCandidateRoot
      ) {
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

    await finishInstallActivation(runtime, {
      installKind: "Release",
      minimumCodiffVersion: manifest.minimumCodiffVersion,
      reconcileGuidance: () =>
        runReleaseInstallSkillsLocked(runtime, installRoot, {
          explicitTargets: options.explicitTargets,
          interactive: options.interactive === true
        })
    });
    return { installId, manifest };
  };
  const activated = await runInstallationMutation(
    monkeHome,
    options.installationLockHeld === true,
    activate
  );

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
  resolveManagedDirectory(path.join(monkeHome, "installs"), "Managed installs root");
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new MonkeError(`Tool install identity already exists: ${installId}`);
  }
  if (realpathSync.native(installRoot) === activeInstallRoot) {
    throw new MonkeError(`Tool install identity already exists: ${installId}`);
  }
  assertManagedInstallRoot(installRoot, installId);
  mkdirSync(backupsRoot, { recursive: true });
  resolveManagedDirectory(backupsRoot, "Install backup root");
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
        rmSync(path.join(backupRoot, COLLISION_RECOVERY_FILENAME), { force: true });
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
    resolveManagedDirectory(stagedInstall, "Staged Local tool install");
    assertExecutableFile(path.join(stagedInstall, "mt"), "Staged mt executable");

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

    await finishInstallActivation(runtime, {
      installKind: "Local tool",
      minimumCodiffVersion: manifest.minimumCodiffVersion,
      reconcileGuidance: () =>
        runInstallSkillsLocked(runtime, sourceCheckout, options.explicitTargets)
    });

    return manifest;
  };

  const manifest = await runInstallationMutation(
    monkeHome,
    options.installationLockHeld === true,
    activate
  );

  createLogger(runtime).success(
    `Activated Local tool install ${manifest.toolBuildIdentity} at ${path.join(monkeHome, "installs", manifest.installId)}`
  );
}

async function finishInstallActivation(
  runtime: Runtime,
  options: {
    installKind: "Local tool" | "Release";
    minimumCodiffVersion: string;
    reconcileGuidance: () => Promise<void>;
  }
) {
  const failures: string[] = [];
  try {
    runShellInstall(runtime, {
      binary: path.join(getHomeDirectory(runtime), ".local", "bin", "mt")
    });
  } catch (error) {
    failures.push(
      `Shell integration is incomplete. Retry with: mt shell install\n${errorMessage(error)}`
    );
  }
  try {
    await options.reconcileGuidance();
  } catch (error) {
    failures.push(
      `Skill or Global agent instruction reconciliation is incomplete. Retry with: mt skills configure\n${errorMessage(error)}`
    );
  }
  try {
    reconcileCodiff(runtime, options.minimumCodiffVersion);
  } catch (error) {
    failures.push(
      `Codiff reconciliation failed. Retry with: mt install-dependencies\n${errorMessage(error)}`
    );
  }
  if (failures.length > 0) {
    throw new MonkeError(
      `The ${options.installKind} install is active, but ${failures.length} post-activation step(s) are incomplete:\n${failures.join("\n")}`
    );
  }
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
  resolveManagedDirectory(installsRoot, "Managed installs root");
  if (lstatSync(installRoot, { throwIfNoEntry: false })) {
    throw new MonkeError(`Tool install identity already exists: ${options.installId}`);
  }
  const stableMt = path.join(options.homeDirectory, ".local", "bin", "mt");
  const stableMonke = path.join(options.homeDirectory, ".local", "bin", "monke");
  assertCommandEntryCanBeReplaced(stableMt);
  assertCommandEntryCanBeReplaced(stableMonke);
  assertDirectoryMutationAccess(path.dirname(stableMt), "Stable command destination");

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
  const temporaryPointer = `${currentPointer}.${crypto.randomUUID()}.tmp`;
  try {
    installStableCommand(stableMt, path.join(currentPointer, "mt"));
    installStableCommand(stableMonke, stableMt);
    symlinkSync(path.relative(options.monkeHome, installRoot), temporaryPointer, "dir");
    options.runtime.installationActivationBoundary?.("pointer-replacement");
    renameSync(temporaryPointer, currentPointer);
  } catch (error) {
    rmSync(temporaryPointer, { force: true });
    rmSync(installRoot, { force: true, recursive: true });
    throw error;
  }
  return installRoot;
}

async function runInstallationMutation<T>(
  monkeHome: string,
  installationLockHeld: boolean,
  mutate: () => Promise<T>
) {
  if (!installationLockHeld) {
    return await withInstallMutationLockAsync(monkeHome, mutate);
  }
  assertInheritedInstallationLock(monkeHome);
  reconcilePendingInstallBackups(monkeHome);
  return await mutate();
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
  const temporaryLink = `${commandPath}.${crypto.randomUUID()}.tmp`;
  symlinkSync(targetPath, temporaryLink, "file");
  renameSync(temporaryLink, commandPath);
}

function assertCommandEntryCanBeReplaced(commandPath: string) {
  const stat = lstatSync(commandPath, { throwIfNoEntry: false });
  if (stat && !stat.isFile() && !stat.isSymbolicLink()) {
    throw new MonkeError(`Refusing to replace non-file command entry at ${commandPath}`);
  }
}

function validateReleaseBundle(
  runtime: Runtime,
  bundleRoot: string,
  expectedIdentity?: ExpectedReleaseIdentity
) {
  const resolvedRoot = path.resolve(bundleRoot);
  const manifest = validateReleaseBundleRoot({
    bundleRoot: resolvedRoot,
    expectedIdentity,
    expectedPlatform: releasePlatform(runtime)
  });
  const executableIdentity = runtime.exec(path.join(resolvedRoot, "mt"), ["--version"], {
    allowFailure: true
  });
  if (
    executableIdentity.exitCode !== 0 ||
    executableIdentity.stdout.trim() !== manifest.toolBuildIdentity
  ) {
    throw new MonkeError("Release executable identity does not match its Install manifest");
  }
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

export function cleanupStaleStagingDirectories(monkeHome: string, activeStage?: string) {
  const stagingRoot = path.join(monkeHome, "install-staging");
  if (!existsSync(stagingRoot)) {
    return;
  }
  for (const entry of readdirSync(stagingRoot, { withFileTypes: true })) {
    const candidate = path.join(stagingRoot, entry.name);
    if (candidate === activeStage || !entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const finalStat = lstatSync(candidate, { throwIfNoEntry: false });
    if (!finalStat?.isDirectory() || finalStat.isSymbolicLink()) {
      continue;
    }
    if (
      MANAGED_STAGING_DIRECTORY_PATTERN.test(entry.name) ||
      (PUBLIC_BOOTSTRAP_STAGING_DIRECTORY_PATTERN.test(entry.name) &&
        isAbandonedPublicBootstrap(candidate, finalStat.mtimeMs))
    ) {
      rmSync(candidate, { force: true, recursive: true });
    }
  }
}

function isAbandonedPublicBootstrap(candidate: string, modifiedAt: number) {
  const age = Date.now() - modifiedAt;
  const pidPath = path.join(candidate, PUBLIC_BOOTSTRAP_PID_FILENAME);
  const pidStat = lstatSync(pidPath, { throwIfNoEntry: false });
  if (!pidStat?.isFile() || pidStat.isSymbolicLink()) {
    return age >= PUBLIC_BOOTSTRAP_CREATION_GRACE_MS;
  }
  const pidText = readFileSync(pidPath, "utf-8").trim();
  const pid = /^\d+$/u.test(pidText) ? Number(pidText) : 0;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return age >= PUBLIC_BOOTSTRAP_CREATION_GRACE_MS;
  }
  return !isProcessRunning(pid);
}

function assertExecutableFile(executable: string, label: string) {
  const problem = executableFileProblem(executable);
  if (problem === "missing") {
    throw new MonkeError(`${label} is missing: ${executable}`);
  }
  if (problem === "not-executable") {
    throw new MonkeError(`${label} is not executable: ${executable}`);
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
