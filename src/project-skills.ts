import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { readImportRecipeStore, writeImportRecipeStore } from "../scripts/skill-import-recipes.ts";
import { MonkeError } from "./errors.ts";
import { loadGlobalMonkeConfig, saveGlobalMonkeConfig } from "./global-config.ts";
import { assertDirectoryMutationAccess } from "./path-boundary.ts";
import { containsPath } from "./path-identity.ts";
import { getMonkeHome, hashKey, withScopedLockAsync } from "./runtime.ts";
import { withSkillPublicationTransaction } from "./skill-publication-transaction.ts";
import {
  reconcileSkillNamespaces,
  resolveSkillInstallTargets,
  skillPublicationPaths
} from "./skills.ts";
import type { SkillPublicationScope } from "./skills.ts";
import type { Runtime } from "./types.ts";

interface ProjectSkillRegistry {
  checkoutRoot: string;
  gitCommonDir: string;
  root: string;
}

/** Keep project registrations local to the clone and shared by its worktrees. */
export function projectSkillRegistry(runtime: Runtime, cwd = runtime.cwd): ProjectSkillRegistry {
  const checkoutRoot = runtime
    .exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd })
    .stdout.trim();
  const gitCommonDir = runtime
    .exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd })
    .stdout.trim();
  return {
    checkoutRoot,
    gitCommonDir,
    root: path.join(gitCommonDir, "monke-tools", "skill-registry")
  };
}

export function withProjectSkillsLock<T>(
  runtime: Runtime,
  context: ProjectSkillRegistry,
  callback: () => T | Promise<T>
) {
  return withScopedLockAsync(
    getMonkeHome(runtime),
    `project-skills-${hashKey(context.gitCommonDir)}`,
    callback
  );
}

/** Start with the user's built-in targets and an empty imported collection. */
export function initializeProjectSkillRegistry(
  runtime: Runtime,
  context: ProjectSkillRegistry
): SkillPublicationScope {
  const config = loadGlobalMonkeConfig(context.root);
  if (!config.skillInstallPreference) {
    const configured = loadGlobalMonkeConfig(getMonkeHome(runtime)).skillInstallPreference;
    const targets = configured?.targets.filter((target) => target.kind !== "custom") ?? [
      { kind: "codex" as const },
      { kind: "claude" as const },
      { kind: "cursor" as const }
    ];
    if (targets.length === 0) {
      throw new MonkeError(
        "Project skills require a built-in target; select one with mt skills configure"
      );
    }
    config.skillInstallPreference = { targets };
    saveGlobalMonkeConfig(context.root, config);
  }
  if (config.skillInstallPreference.targets.some((target) => target.kind === "custom")) {
    throw new MonkeError("Project skills support built-in targets inside the checkout only");
  }
  const scope = { homeDirectory: context.checkoutRoot, preference: config.skillInstallPreference };
  assertProjectSkillDestinations(scope);
  mkdirSync(path.join(context.root, "skills", "imported"), { recursive: true });
  writeImportRecipeStore(context.root, readImportRecipeStore(context.root));
  return scope;
}

function assertProjectSkillDestinations(scope: SkillPublicationScope) {
  const checkout = realpathSync.native(scope.homeDirectory);
  for (const target of resolveSkillInstallTargets({ ...scope, project: true })) {
    let existing = target.agentSkillRoot;
    while (!lstatSync(existing, { throwIfNoEntry: false })) {
      existing = path.dirname(existing);
    }
    if (!containsPath(checkout, realpathSync.native(existing))) {
      throw new MonkeError(
        `Project skill destination is outside this checkout: ${target.agentSkillRoot}`
      );
    }
  }
}

/** Publish project skills without writing global or repository agent instructions. */
export function reconcileProjectSkillRegistry(
  runtime: Runtime,
  root: string,
  scope: SkillPublicationScope
) {
  reconcileSkillNamespaces({
    cwd: scope.homeDirectory,
    guidanceSourceRoot: root,
    homeDirectory: scope.homeDirectory,
    includeGlobalInstructions: false,
    nextPreference: scope.preference,
    previousPreference: scope.preference,
    project: true,
    writeMessage: runtime.writeStderr
  });
  excludeProjectSkillLinks(runtime, root, scope);
}

/** Recreate the current clone's registered links during checkout setup. */
export async function reconcileProjectSkills(runtime: Runtime, cwd = runtime.cwd) {
  const context = projectSkillRegistry(runtime, cwd);
  if (!existsSync(path.join(context.root, "config.yml"))) {
    return;
  }
  await withProjectSkillsLock(runtime, context, () => {
    const scope = initializeProjectSkillRegistry(runtime, context);
    return withProjectSkillPublicationTransaction(runtime, context, scope, () => {
      reconcileProjectSkillRegistry(runtime, context.root, scope);
    });
  });
}

/** Recover registry, projections, and local Git exclusions as one project publication. */
export function withProjectSkillPublicationTransaction<T>(
  runtime: Runtime,
  context: ProjectSkillRegistry,
  scope: SkillPublicationScope,
  publish: () => T | Promise<T>,
  withSnapshotLocks?: (recover: () => Promise<void>) => Promise<void>
) {
  const exclude = path.join(context.gitCommonDir, "info", "exclude");
  preflightProjectSkillExclusions(exclude);
  const targets = resolveSkillInstallTargets({ ...scope, project: true });
  return withSkillPublicationTransaction(
    runtime,
    [
      context.root,
      exclude,
      ...targets.flatMap((target) => {
        const physical = existsSync(target.agentSkillRoot)
          ? [realpathSync.native(target.agentSkillRoot)]
          : [];
        return [target.agentSkillRoot, ...physical];
      })
    ],
    publish,
    withSnapshotLocks
  );
}

function preflightProjectSkillExclusions(exclude: string) {
  assertDirectoryMutationAccess(path.dirname(exclude), "Project skill exclusions directory");
  const stat = lstatSync(exclude, { throwIfNoEntry: false });
  if (!stat) {
    return;
  }
  if (!stat.isFile()) {
    throw new MonkeError(`Project skill exclusions must be a regular file: ${exclude}`);
  }
  // oxlint-disable-next-line eslint/no-bitwise -- Check write permissions even when running as root.
  if ((stat.mode & 0o222) === 0) {
    throw new MonkeError(`Project skill exclusions are not writable: ${exclude}`);
  }
  accessSync(exclude, fsConstants.R_OK + fsConstants.W_OK);
}

function excludeProjectSkillLinks(runtime: Runtime, root: string, scope: SkillPublicationScope) {
  // This path belongs to the shared Git directory, even when publishing in a worktree.
  const excludePath = path.resolve(root, "..", "..", "info", "exclude");
  preflightProjectSkillExclusions(excludePath);
  const start = "# monke-tools project skills:start";
  const end = "# monke-tools project skills:end";
  const current = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
  const withoutManaged = current.replace(
    /# monke-tools project skills:start\n[\s\S]*?# monke-tools project skills:end\n?/u,
    ""
  );
  const paths = skillPublicationPaths(runtime, root, [], scope).map((target) => {
    const relative = path.relative(scope.homeDirectory, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new MonkeError(`Project skill destination is outside this checkout: ${target}`);
    }
    return `/${relative
      .split(path.sep)
      .join("/")
      .replaceAll(/[\\*?[\]#! ]/gu, "\\$&")}`;
  });
  const block = `${start}\n${[...new Set(paths)].join("\n")}\n${end}\n`;
  mkdirSync(path.dirname(excludePath), { recursive: true });
  writeFileSync(
    excludePath,
    `${withoutManaged}${withoutManaged.endsWith("\n") || !withoutManaged ? "" : "\n"}${block}`
  );
}
