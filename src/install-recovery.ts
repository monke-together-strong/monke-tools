import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { nullable, strictObject, string } from "zod";

import { MonkeError } from "./errors.ts";
import {
  INSTALL_MANIFEST_FILENAME,
  ToolInstallManifestSchema,
  installIdForManifest,
  resolveActiveInstallRoot
} from "./install-manifest.ts";
import { assertDirectChildPath } from "./path-boundary.ts";
import { withInstallationLockAsync } from "./runtime.ts";
import { parseBoundaryValue } from "./validation.ts";

export const COLLISION_RECOVERY_FILENAME = ".monke-tools-collision.json";
const CollisionRecoverySchema = strictObject({
  predecessorInstallId: nullable(string().min(1))
});

/** Run a serialized install mutation after reconciling any interrupted collision backup. */
export function withInstallMutationLockAsync<T>(home: string, callback: () => Promise<T>) {
  return withInstallationLockAsync(home, () => {
    reconcilePendingInstallBackups(home);
    return callback();
  });
}

/** Restore or discard managed collision backups according to the current Active pointer. */
export function reconcilePendingInstallBackups(monkeHome: string) {
  const backupsRoot = path.join(monkeHome, "install-backups");
  if (!existsSync(backupsRoot)) {
    return;
  }
  const rootStat = lstatSync(backupsRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new MonkeError(`Install backup root is invalid: ${backupsRoot}`);
  }

  const activeInstallRoot = resolveActiveInstallRoot(monkeHome);
  for (const entry of readdirSync(backupsRoot, { withFileTypes: true })) {
    const backupRoot = path.join(backupsRoot, entry.name);
    assertDirectChildPath(backupRoot, backupsRoot, "collision backup");
    assertManagedInstallRoot(backupRoot, entry.name);
    const recovery = loadCollisionRecovery(backupRoot);

    const installRoot = path.join(monkeHome, "installs", entry.name);
    const installStat = lstatSync(installRoot, { throwIfNoEntry: false });
    if (!installStat) {
      mkdirSync(path.dirname(installRoot), { recursive: true });
      rmSync(path.join(backupRoot, COLLISION_RECOVERY_FILENAME));
      renameSync(backupRoot, installRoot);
      continue;
    }
    assertManagedInstallRoot(installRoot, entry.name);
    if (activeInstallRoot === installRoot) {
      const predecessorRoot = recovery.predecessorInstallId
        ? path.join(monkeHome, "installs", recovery.predecessorInstallId)
        : null;
      if (predecessorRoot) {
        assertDirectChildPath(
          predecessorRoot,
          path.join(monkeHome, "installs"),
          "activation predecessor"
        );
      }
      rmSync(backupRoot, { recursive: true });
      cleanupInactiveToolInstalls(
        monkeHome,
        new Set([installRoot, ...(predecessorRoot ? [predecessorRoot] : [])])
      );
      continue;
    }
    rmSync(installRoot, { recursive: true });
    rmSync(path.join(backupRoot, COLLISION_RECOVERY_FILENAME));
    renameSync(backupRoot, installRoot);
  }
  if (readdirSync(backupsRoot).length === 0) {
    rmdirSync(backupsRoot);
  }
}

export function writeCollisionRecovery(installRoot: string, predecessorInstallRoot: string | null) {
  writeFileSync(
    path.join(installRoot, COLLISION_RECOVERY_FILENAME),
    `${JSON.stringify({
      predecessorInstallId: predecessorInstallRoot ? path.basename(predecessorInstallRoot) : null
    })}\n`,
    "utf-8"
  );
}

function loadCollisionRecovery(backupRoot: string) {
  const recoveryPath = path.join(backupRoot, COLLISION_RECOVERY_FILENAME);
  try {
    return parseBoundaryValue(
      CollisionRecoverySchema,
      JSON.parse(readFileSync(recoveryPath, "utf-8")),
      "collision recovery metadata"
    );
  } catch {
    throw new MonkeError(`Collision recovery metadata is invalid: ${recoveryPath}`);
  }
}

export function assertManagedInstallRoot(installRoot: string, installId: string) {
  const stat = lstatSync(installRoot, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new MonkeError(`Tool install identity already exists: ${installId}`);
  }
  try {
    const manifest = ToolInstallManifestSchema.parse(
      JSON.parse(readFileSync(path.join(installRoot, INSTALL_MANIFEST_FILENAME), "utf-8"))
    );
    if (installIdForManifest(manifest) !== installId) {
      throw new Error("install identity mismatch");
    }
  } catch {
    throw new MonkeError(`Tool install identity already exists: ${installId}`);
  }
}

/** Remove validated inactive installs except the explicitly retained roots. */
export function cleanupInactiveToolInstalls(monkeHome: string, retainedRoots: Set<string>) {
  const installsRoot = path.join(monkeHome, "installs");
  if (!existsSync(installsRoot)) {
    return;
  }
  for (const entry of readdirSync(installsRoot, { withFileTypes: true })) {
    const installRoot = path.join(installsRoot, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink() || retainedRoots.has(installRoot)) {
      continue;
    }
    try {
      assertManagedInstallRoot(installRoot, entry.name);
    } catch {
      continue;
    }
    rmSync(installRoot, { recursive: true });
  }
}
