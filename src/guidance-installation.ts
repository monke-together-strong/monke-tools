import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { MonkeError } from "./errors.ts";
import { loadGlobalMonkeConfig, saveGlobalMonkeConfig } from "./global-config.ts";
import type { GlobalMonkeConfig } from "./global-config.ts";
import {
  loadActiveToolInstall,
  loadToolInstall,
  resolveActiveInstallRoot
} from "./install-manifest.ts";
import { withInstallMutationLockAsync } from "./install-recovery.ts";
import { createLogger } from "./logger.ts";
import { resolveManagedDirectory } from "./path-boundary.ts";
import { getHomeDirectory, getMonkeHome } from "./runtime.ts";
import {
  explicitSkillInstallPreference,
  promptForSkillInstallPreference,
  reconcileSkillNamespaces,
  resolveSkillSourceTree
} from "./skills.ts";
import type { ExplicitSkillTargetSelection } from "./skills.ts";
import type { Runtime } from "./types.ts";

/** Prompt for a Skill install preference, save it, and reconcile selected Agent skill roots. */
export function runSkillsConfigure(runtime: Runtime) {
  const monkeHome = getMonkeHome(runtime);
  return withInstallMutationLockAsync(monkeHome, () => runSkillsConfigureLocked(runtime));
}

async function runSkillsConfigureLocked(runtime: Runtime, guidanceSourceRootOverride?: string) {
  const monkeHome = getMonkeHome(runtime);
  const homeDirectory = getHomeDirectory(runtime);
  const config = loadGlobalMonkeConfig(monkeHome);
  const activeInstall = loadFixedToolInstall(runtime, monkeHome);
  const guidanceSourceRoot =
    guidanceSourceRootOverride ??
    (activeInstall?.manifest.installKind === "local"
      ? activeInstall.manifest.sourceCheckout
      : activeInstall?.installRoot);
  if (!guidanceSourceRoot) {
    throw new MonkeError("Active tool install is not configured; install monke-tools first");
  }
  resolveSkillSourceTree(guidanceSourceRoot);

  const previousPreference = config.skillInstallPreference ?? null;
  const nextPreference = await promptForSkillInstallPreference(
    runtime,
    previousPreference,
    homeDirectory
  );
  reconcileSkillNamespaces({
    cwd: runtime.cwd,
    environment: runtime.env,
    guidanceSourceRoot,
    homeDirectory,
    nextPreference,
    previousPreference,
    writeMessage(message) {
      runtime.writeStderr(message);
    }
  });
  saveGlobalMonkeConfig(monkeHome, {
    skillInstallPreference: nextPreference,
    version: 1
  });
  createLogger(runtime).success("Configured monke-tools skills");
}

function loadFixedToolInstall(runtime: Runtime, monkeHome: string) {
  const requestedFixedRoot = path.resolve(runtime.toolInstallRoot);
  const fixedRoot = existsSync(requestedFixedRoot)
    ? realpathSync.native(requestedFixedRoot)
    : requestedFixedRoot;
  const configuredInstallsRoot = path.join(path.resolve(monkeHome), "installs");
  const installsRoot = existsSync(configuredInstallsRoot)
    ? resolveManagedDirectory(configuredInstallsRoot, "Managed installs root")
    : configuredInstallsRoot;
  if (path.dirname(fixedRoot) !== installsRoot) {
    return loadActiveToolInstall(monkeHome);
  }
  if (resolveActiveInstallRoot(monkeHome) !== fixedRoot) {
    throw new MonkeError(
      "The Active tool install changed while Skills Configure was waiting; rerun mt skills configure"
    );
  }
  return loadToolInstall(fixedRoot);
}

/** Reconcile source-backed guidance from a Local checkout under the installation lock. */
export function runLocalInstallSkills(
  runtime: Runtime,
  sourceCheckout: string,
  explicitTargets?: ExplicitSkillTargetSelection
) {
  const monkeHome = getMonkeHome(runtime);
  return withInstallMutationLockAsync(monkeHome, async () => {
    const activeInstall = loadFixedToolInstall(runtime, monkeHome);
    if (activeInstall?.manifest.installKind !== "local") {
      throw new MonkeError(
        "Skills Local Install requires an Active Local tool install; run vp run install:local from the source checkout"
      );
    }
    const requestedCheckout = path.resolve(sourceCheckout);
    if (activeInstall.manifest.sourceCheckout !== requestedCheckout) {
      throw new MonkeError(
        `Skills Local Install checkout does not match the Active Local install: ${activeInstall.manifest.sourceCheckout}`
      );
    }
    await runInstallSkillsLocked(runtime, requestedCheckout, explicitTargets);
  });
}

/** Reconcile guidance from a Local source checkout or Release install while the lock is held. */
export async function runInstallSkillsLocked(
  runtime: Runtime,
  guidanceSourceRoot: string,
  explicitTargets?: ExplicitSkillTargetSelection
) {
  const monkeHome = getMonkeHome(runtime);
  const homeDirectory = getHomeDirectory(runtime);
  const config = loadGlobalMonkeConfig(monkeHome);
  const resolvedGuidanceSourceRoot = path.resolve(guidanceSourceRoot);
  const explicitPreference = explicitSkillInstallPreference(homeDirectory, explicitTargets);
  const nextPreference = explicitPreference ?? config.skillInstallPreference;
  const nextConfig: GlobalMonkeConfig = { version: 1 };
  if (nextPreference) {
    nextConfig.skillInstallPreference = nextPreference;
  }

  if (!nextPreference) {
    await runSkillsConfigureLocked(runtime, resolvedGuidanceSourceRoot);
    return;
  }

  reconcileSkillNamespaces({
    cwd: runtime.cwd,
    environment: runtime.env,
    guidanceSourceRoot: resolvedGuidanceSourceRoot,
    homeDirectory,
    nextPreference,
    previousPreference: config.skillInstallPreference ?? null,
    writeMessage(message) {
      runtime.writeStderr(message);
    }
  });
  saveGlobalMonkeConfig(monkeHome, nextConfig);
  createLogger(runtime).success(
    explicitPreference ? "Configured monke-tools skills" : "Refreshed monke-tools skills"
  );
}

/** Reconcile Release-mode guidance after core activation. */
export async function runReleaseInstallSkillsLocked(
  runtime: Runtime,
  releaseInstallRoot: string,
  options: {
    explicitTargets?: ExplicitSkillTargetSelection;
    interactive: boolean;
  }
) {
  const config = loadGlobalMonkeConfig(getMonkeHome(runtime));
  if (options.explicitTargets !== undefined || config.skillInstallPreference) {
    await runInstallSkillsLocked(runtime, releaseInstallRoot, options.explicitTargets);
    return;
  }
  if (options.interactive) {
    await runSkillsConfigureLocked(runtime, releaseInstallRoot);
    return;
  }
  createLogger(runtime).hint(
    "No Skill install targets were selected. Configure them later with: mt skills configure"
  );
}
