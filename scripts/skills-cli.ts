import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { MonkeError } from "../src/errors.ts";
import { createRuntime } from "../src/runtime.ts";

export const SKILLS_CLI_VERSION = "1.7.0";
const NPX_COMMAND = process.platform === "win32" ? "npx.cmd" : "npx";
/** Options for building an upstream staged Skill install command. */
export interface BuildSkillsInstallArgsOptions {
  importerVersion?: string;
  /** Upstream Skill import selectors to install. */
  selectors: readonly string[];
  /** Source string passed through to upstream `skills add`. */
  source: string;
}

/** Builds arguments for listing skills from an upstream source. */
export function buildSkillsListArgs(source: string) {
  return [
    "--yes",
    `skills@${SKILLS_CLI_VERSION}`,
    "add",
    source,

    "-l"
  ];
}

/** Builds arguments for installing selected skills from an upstream source into staging. */
export function buildSkillsInstallArgs(options: BuildSkillsInstallArgsOptions) {
  return [
    "--yes",
    `skills@${options.importerVersion ?? SKILLS_CLI_VERSION}`,
    "add",
    options.source,

    ...options.selectors.flatMap((skill) => ["--skill", skill]),
    "--agent",
    "universal",
    "--copy",
    "--yes"
  ];
}

/** Lists Skill slugs staged by the upstream CLI under `.agents/skills`. */
export function listStagedSkillSlugs(stagingDirectory: string) {
  const stagedSkillsRoot = path.join(stagingDirectory, ".agents", "skills");
  if (!existsSync(stagedSkillsRoot)) {
    throw new MonkeError(`Expected staged skills at ${stagedSkillsRoot}`);
  }

  const stagedSkillNames = readdirSync(stagedSkillsRoot)
    .filter((entry) => {
      const entryPath = path.join(stagedSkillsRoot, entry);
      return statSync(entryPath).isDirectory();
    })
    .toSorted();

  if (stagedSkillNames.length === 0) {
    throw new MonkeError(`No staged skill directories found at ${stagedSkillsRoot}`);
  }

  return stagedSkillNames;
}

/** Runs upstream `skills` CLI arguments and returns captured output or throws on failure. */
export function runSkillsCaptured(args: string[], cwd: string) {
  return createRuntime({ cwd }).exec(NPX_COMMAND, args);
}
