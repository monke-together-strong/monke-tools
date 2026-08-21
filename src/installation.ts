import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { reconcileCodiff, MINIMUM_CODIFF_VERSION_TEXT } from "./codiff.ts";
import { MonkeError } from "./errors.ts";
import type { BuiltInSkillInstallTargetKind } from "./global-config.ts";
import {
  INSTALL_MANIFEST_FILENAME,
  LocalInstallManifestSchema,
  resolveActiveInstallRoot
} from "./install-manifest.ts";
import type { LocalInstallManifest } from "./install-manifest.ts";
import { createLogger } from "./logger.ts";
import { getHomeDirectory, getMonkeHome, withInstallationLockAsync } from "./runtime.ts";
import { runShellInstall } from "./shell.ts";
import { runLocalInstallSkillsLocked } from "./skills.ts";
import type { Runtime } from "./types.ts";
import { parseBoundaryValue } from "./validation.ts";

export interface ActivateLocalInstallOptions {
  createdAt: string;
  dirty: boolean;
  installId: string;
  platform: string;
  sourceCheckout: string;
  sourceCommit: string;
  stagedInstall: string;
  targetKinds?: BuiltInSkillInstallTargetKind[];
}

/** Activate a fully built Local tool install and finish its installation-adjacent work. */
export async function runActivateLocalInstall(
  runtime: Runtime,
  options: ActivateLocalInstallOptions
) {
  const monkeHome = getMonkeHome(runtime);
  const homeDirectory = getHomeDirectory(runtime);
  const sourceCheckout = path.resolve(options.sourceCheckout);
  const stagedInstall = path.resolve(options.stagedInstall);
  const expectedStagingRoot = path.join(monkeHome, "install-staging");
  assertDirectChild(stagedInstall, expectedStagingRoot, "staged Local tool install");
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

  await withInstallationLockAsync(monkeHome, async () => {
    const predecessor = resolveActiveInstallRoot(monkeHome);
    const installRoot = activateStagedInstall({
      homeDirectory,
      manifest,
      monkeHome,
      stagedInstall
    });

    cleanupManagedInstalls(
      monkeHome,
      new Set([installRoot, ...(predecessor ? [predecessor] : [])])
    );
    cleanupStaleStagingDirectories(monkeHome, stagedInstall);

    const stableCommand = path.join(homeDirectory, ".local", "bin", "mt");
    runShellInstall(runtime, { binary: stableCommand });
    await runLocalInstallSkillsLocked(runtime, sourceCheckout, options.targetKinds);

    try {
      reconcileCodiff(runtime, manifest.minimumCodiffVersion);
    } catch (error) {
      throw new MonkeError(
        `The Local tool install is active, but Codiff reconciliation failed. Retry with: mt install-dependencies\n${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  createLogger(runtime).success(
    `Activated Local tool install ${manifest.toolBuildIdentity} at ${path.join(monkeHome, "installs", manifest.installId)}`
  );
}

function activateStagedInstall(options: {
  homeDirectory: string;
  manifest: LocalInstallManifest;
  monkeHome: string;
  stagedInstall: string;
}) {
  const installsRoot = path.join(options.monkeHome, "installs");
  const installRoot = path.join(installsRoot, options.manifest.installId);
  mkdirSync(installsRoot, { recursive: true });
  if (lstatSync(installRoot, { throwIfNoEntry: false })) {
    throw new MonkeError(`Managed install identity already exists: ${options.manifest.installId}`);
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
  renameSync(options.stagedInstall, installRoot);

  const currentPointer = path.join(options.monkeHome, "current");
  const temporaryPointer = `${currentPointer}.${randomUUID()}.tmp`;
  symlinkSync(path.relative(options.monkeHome, installRoot), temporaryPointer, "dir");
  try {
    renameSync(temporaryPointer, currentPointer);
  } catch (error) {
    rmSync(temporaryPointer, { force: true });
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

function cleanupManagedInstalls(monkeHome: string, retainedRoots: Set<string>) {
  const installsRoot = path.join(monkeHome, "installs");
  if (!existsSync(installsRoot)) {
    return;
  }
  for (const entry of readdirSync(installsRoot, { withFileTypes: true })) {
    const installRoot = path.join(installsRoot, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink() || retainedRoots.has(installRoot)) {
      continue;
    }
    const manifestPath = path.join(installRoot, INSTALL_MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) {
      continue;
    }
    try {
      const manifest = LocalInstallManifestSchema.parse(
        JSON.parse(readFileSync(manifestPath, "utf-8"))
      );
      if (manifest.installId !== entry.name) {
        continue;
      }
    } catch {
      continue;
    }
    const finalStat = lstatSync(installRoot, { throwIfNoEntry: false });
    if (finalStat?.isDirectory() === true && !finalStat.isSymbolicLink()) {
      rmSync(installRoot, { recursive: true });
    }
  }
}

function cleanupStaleStagingDirectories(monkeHome: string, activeStage: string) {
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
      !/^(?:local|release)-[A-Za-z0-9._-]+$/u.test(entry.name)
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

function assertDirectChild(candidate: string, parent: string, label: string) {
  if (path.dirname(candidate) !== path.resolve(parent)) {
    throw new MonkeError(`${label} must be a direct child of ${path.resolve(parent)}`);
  }
}
