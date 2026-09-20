import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

const configDirectory = mkdtempSync(path.join(tmpdir(), "monke-test-git-"));
const globalConfigPath = path.join(configDirectory, "config");
writeFileSync(
  globalConfigPath,
  `[core]\n  excludesFile = ${JSON.stringify(devNull)}\n  attributesFile = ${JSON.stringify(devNull)}\n`
);
afterAll(() => {
  rmSync(configDirectory, { force: true, recursive: true });
});

/** Give every test and child process a Git baseline independent of the invoking shell. */
export function configureTestGitEnvironment() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_")) {
      delete process.env[key];
    }
  }

  // Unsetting these restores normal lookup, including ~/.gitconfig and XDG config.
  // The owned global config also disables default XDG ignore/attributes files at
  // global priority, so repository-local settings and explicit test overrides win.
  process.env.GIT_CONFIG_GLOBAL = globalConfigPath;
  process.env.GIT_CONFIG_SYSTEM = devNull;
  process.env.GIT_ATTR_NOSYSTEM = "1";
}

configureTestGitEnvironment();
