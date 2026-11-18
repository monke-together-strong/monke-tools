import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Readers see either the previous state or the complete replacement. */
export function writeSkillImportState(file: string, content: string) {
  const directory = mkdtempSync(path.join(path.dirname(file), ".monke-skill-import-"));

  try {
    const temporary = path.join(directory, "state");
    writeFileSync(temporary, content, { encoding: "utf-8", flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}
