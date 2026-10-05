import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, rmdirSync } from "node:fs";
import path from "node:path";

import { errorMessage, MonkeError, ThrownValueSchema } from "./errors.ts";
import { containsPath } from "./path-identity.ts";

/** Retain exact entries (including aliases) until registry and target publication finish. */
export async function withSkillPublicationTransaction<T>(
  recoveryRoot: string,
  paths: string[],
  publish: () => Promise<T>
) {
  mkdirSync(recoveryRoot, { recursive: true });
  const recovery = mkdtempSync(path.join(recoveryRoot, ".monke-adopt-recovery-"));
  const roots = [...new Set(paths)].filter(
    (item, index, all) =>
      !all.some((parent, parentIndex) => parentIndex !== index && containsPath(parent, item))
  );
  const missingParents = new Set<string>();
  const snapshots = [];
  try {
    for (const [index, original] of roots.entries()) {
      let parent = path.dirname(original);
      while (!existsSync(parent)) {
        missingParents.add(parent);
        parent = path.dirname(parent);
      }
      const backup = path.join(recovery, String(index));
      const present = Boolean(lstatSync(original, { throwIfNoEntry: false }));
      if (present) {
        cpSync(original, backup, { recursive: true, verbatimSymlinks: true });
      }
      snapshots.push({ backup, original, present });
    }
    await Bun.write(path.join(recovery, "recovery.json"), JSON.stringify(snapshots, null, 2));
  } catch (error) {
    rmSync(recovery, { recursive: true });
    throw error;
  }
  let result;
  try {
    result = await publish();
  } catch (error) {
    const failures: string[] = [];
    for (const { backup, original, present } of snapshots.toReversed()) {
      try {
        rmSync(original, { force: true, recursive: true });
        if (present) {
          mkdirSync(path.dirname(original), { recursive: true });
          cpSync(backup, original, { recursive: true, verbatimSymlinks: true });
        }
      } catch (restoreError) {
        failures.push(`${original}: ${errorMessage(ThrownValueSchema.parse(restoreError))}`);
      }
    }
    for (const parent of [...missingParents].toSorted((a, b) => b.length - a.length)) {
      try {
        rmdirSync(parent);
      } catch {
        // Keep nonempty parents, including anything created by another writer.
      }
    }
    if (failures.length > 0) {
      throw new MonkeError(
        `${errorMessage(ThrownValueSchema.parse(error))}\nRestoration failed:\n${failures.join("\n")}\nRecovery copies retained at ${recovery} (see recovery.json)`,
        { cause: error }
      );
    }
    rmSync(recovery, { recursive: true });
    throw error;
  }
  rmSync(recovery, { recursive: true });
  return result;
}
