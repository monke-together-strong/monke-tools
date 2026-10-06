import { existsSync } from "node:fs";
import path from "node:path";

import type { MonkeError } from "./errors.ts";
import {
  INSTALL_MANIFEST_FILENAME,
  loadActiveToolInstall,
  loadToolInstall
} from "./install-manifest.ts";
import { getMonkeHome } from "./runtime.ts";
import type { Runtime } from "./types.ts";

/** Attach existing installation guidance without replacing the original failure. */
export function addInstallGuidance(runtime: Runtime, error: MonkeError) {
  const roots = [runtime.toolInstallRoot, path.resolve(import.meta.dirname, "..")];
  try {
    const install = existsSync(path.join(runtime.toolInstallRoot, INSTALL_MANIFEST_FILENAME))
      ? loadToolInstall(runtime.toolInstallRoot)
      : loadActiveToolInstall(getMonkeHome(runtime));
    if (install) {
      roots.unshift(
        install.manifest.installKind === "local"
          ? install.manifest.sourceCheckout
          : install.installRoot
      );
    }
  } catch {
    // A broken install must not prevent reporting its original error.
  }

  const guidance = roots
    .map((root) => path.join(root, "skills", "internal", "monke-install", "SKILL.md"))
    .find((candidate) => existsSync(candidate));
  if (guidance) {
    const hint = `Installation guidance: ${guidance}`;
    if (!error.message.includes(hint)) {
      error.message += `\n${hint}`;
    }
  }
  return error;
}
