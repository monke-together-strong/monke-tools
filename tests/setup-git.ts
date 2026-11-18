import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";

import { afterAll } from "vite-plus/test";

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

  // Git falls back to user config when these variables are unset. The fixture also disables
  // default XDG ignore and attributes files so repo settings and explicit test overrides win.
  process.env.GIT_CONFIG_GLOBAL = globalConfigPath;
  process.env.GIT_CONFIG_SYSTEM = devNull;
  process.env.GIT_ATTR_NOSYSTEM = "1";
}

configureTestGitEnvironment();
