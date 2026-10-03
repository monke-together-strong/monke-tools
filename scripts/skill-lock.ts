import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync
} from "node:fs";
import path from "node:path";

import { MonkeError } from "../src/errors.ts";
import { containsPath } from "../src/path-identity.ts";
import { createRuntime, getMonkeHome, withScopedLockAsync } from "../src/runtime.ts";
import {
  copyStagedGuidanceToManagedRoots,
  importedGuidancePath,
  IMPORTED_REFERENCES_ROOT,
  IMPORTED_SKILLS_ROOT
} from "./import-guidance.ts";
import {
  compareSkillLockStrings,
  readImportRecipeStore,
  SKILL_LOCK_PATH
} from "./skill-import-recipes.ts";
import type { SkillImportRecipe, SkillImportRecipeSkill } from "./skill-import-recipes.ts";
import {
  buildSkillsInstallArgs,
  listStagedSkillSlugs,
  runSkillsCaptured,
  SKILLS_CLI_VERSION
} from "./skills-cli.ts";

export const MATERIALIZER_VERSION = 1;

function resolveExplicitSkillCommit(repository: string, revision: string, repoRoot: string) {
  if (path.isAbsolute(repository)) {
    return createRuntime({ cwd: repository })
      .exec("git", ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`])
      .stdout.trim();
  }
  const stagingDirectory = path.join(repoRoot, "tmp", `skill-pin-${crypto.randomUUID()}`);
  mkdirSync(stagingDirectory, { recursive: true });
  const runtime = createRuntime({ cwd: stagingDirectory });
  try {
    runtime.exec("git", ["init", "--quiet"]);
    runtime.exec("git", ["fetch", "--quiet", "--depth", "1", "--", repository, revision]);
    return runtime.exec("git", ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]).stdout.trim();
  } finally {
    rmSync(stagingDirectory, { force: true, recursive: true });
  }
}

/** Separates deliberate update discovery from the immutable accepted source revision. */
export function describeSkillSource(source: string, repoRoot: string) {
  const github =
    /^(?:https?:\/\/github\.com\/)?(?<owner>[^/\s:]+)\/(?<repo>[^/#\s]+)(?:\/tree\/(?<ref>[^/#]+)(?:\/(?<subpath>[^#]*))?|\/(?<shorthandSubpath>[^#]*))?(?:#(?<fragment>[^#]+))?$/u.exec(
      source
    );
  if (github?.groups && !source.startsWith(".") && !path.isAbsolute(source)) {
    const { fragment, owner, ref, repo, shorthandSubpath, subpath } = github.groups;
    return {
      repository: `https://github.com/${owner}/${repo?.replace(/\.git$/u, "")}.git`,
      subpath: subpath ?? shorthandSubpath ?? "",
      treePath: ref && !fragment ? `${ref}${subpath ? `/${subpath}` : ""}` : undefined,
      updateRef: fragment ?? ref ?? "HEAD"
    };
  }
  const fragment = source.lastIndexOf("#");
  const repository = fragment === -1 ? source : source.slice(0, fragment);
  const updateRef = fragment === -1 ? "HEAD" : source.slice(fragment + 1);
  if (/^(?:https?:|ssh:|git:|git@)/u.test(repository)) {
    return { repository, subpath: "", updateRef };
  }
  const directory = realpathSync.native(path.resolve(repoRoot, repository));
  const topLevel = createRuntime({ cwd: directory }).exec("git", ["rev-parse", "--show-toplevel"], {
    allowFailure: true
  });
  const root = topLevel.exitCode === 0 ? topLevel.stdout.trim() : directory;
  return {
    repository: root,
    subpath: path.relative(root, directory),
    updateRef
  };
}

export function resolveSkillRevision(recipe: SkillImportRecipe, repoRoot: string) {
  const source = recipe.lock ?? describeSkillSource(recipe.source, repoRoot);
  const treePath = "treePath" in source ? source.treePath : undefined;
  const requestedRefs = treePath
    ? treePath
        .split("/")
        .map((_, index, segments) => segments.slice(0, index + 1).join("/"))
        .toReversed()
    : [source.updateRef];
  const revisions = /^[a-f\d]{40}$/u.test(source.updateRef)
    ? []
    : createRuntime({ cwd: repoRoot })
        .exec("git", [
          "ls-remote",
          "--",
          source.repository,
          ...requestedRefs.flatMap((ref) => [ref, `${ref}^{}`])
        ])
        .stdout.trim()
        .split("\n")
        .map((row) => row.split(/\s+/u));
  const updateRef =
    requestedRefs.find((requestedRef) =>
      revisions.some(
        ([, ref]) =>
          ref === requestedRef ||
          ref === `refs/heads/${requestedRef}` ||
          ref === `refs/tags/${requestedRef}`
      )
    ) ?? source.updateRef;
  const selected =
    revisions.find(([, ref]) => ref === updateRef) ??
    revisions.find(([, ref]) => ref === `refs/heads/${updateRef}`) ??
    revisions.find(([, ref]) => ref === `refs/tags/${updateRef}`);
  const commit = /^[a-f\d]{40}$/u.test(source.updateRef)
    ? resolveExplicitSkillCommit(source.repository, source.updateRef, repoRoot)
    : (revisions.find(([, ref]) => ref === `${selected?.[1]}^{}`) ?? selected)?.[0];
  if (!commit || !/^[a-f\d]{40}$/u.test(commit)) {
    throw new MonkeError(
      `Cannot resolve ${recipe.source} at ${source.updateRef} to a full Git commit`
    );
  }
  return {
    commit,
    importerVersion: SKILLS_CLI_VERSION,
    materializerVersion: MATERIALIZER_VERSION,
    repository: source.repository,
    subpath: treePath ? treePath.slice(updateRef.length).replace(/^\//u, "") : source.subpath,
    updateRef
  };
}

/** Remote imports use skills.sh's SHA URL; local Git fixtures receive an immutable checkout. */
export function pinnedSkillSource(
  lock: NonNullable<SkillImportRecipe["lock"]>,
  stagingDirectory: string
) {
  if (lock.materializerVersion !== MATERIALIZER_VERSION) {
    throw new MonkeError(
      `Unsupported skill materializer version ${lock.materializerVersion}; use the tooling from the selected source revision`
    );
  }
  if (path.isAbsolute(lock.repository)) {
    const checkout = path.join(stagingDirectory, "upstream");
    const runtime = createRuntime({ cwd: stagingDirectory });
    runtime.exec("git", ["clone", "--quiet", "--no-checkout", "--", lock.repository, checkout]);
    runtime.exec("git", ["checkout", "--quiet", "--detach", lock.commit], { cwd: checkout });
    validateUpstreamLinks(checkout);
    return path.join(checkout, lock.subpath);
  }
  // Copy mode dereferences upstream links, so validate the exact tree before the importer.
  // Keep remote source URLs intact for upstream discovery and security assessments.
  const checkout = path.join(stagingDirectory, "upstream-validation");
  mkdirSync(checkout, { recursive: true });
  const runtime = createRuntime({ cwd: checkout });
  runtime.exec("git", ["init", "--quiet"]);
  runtime.exec("git", ["fetch", "--quiet", "--depth", "1", "--", lock.repository, lock.commit]);
  runtime.exec("git", ["checkout", "--quiet", "--detach", lock.commit]);
  validateUpstreamLinks(checkout);
  const github = /^https:\/\/github\.com\/(?<repository>.+)\.git$/u.exec(lock.repository);
  if (github?.groups?.repository) {
    return `https://github.com/${github.groups.repository}/tree/${lock.commit}${lock.subpath ? `/${lock.subpath}` : ""}`;
  }
  return `${lock.repository}#${lock.commit}`;
}

function validateUpstreamLinks(checkout: string) {
  const root = realpathSync.native(checkout);
  const gitDirectory = path.join(root, ".git");
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") {
        continue;
      }
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else if (entry.isSymbolicLink()) {
        const target = path.resolve(directory, readlinkSync(file));
        const resolved = existsSync(target) ? realpathSync.native(target) : target;
        if (
          !containsPath(root, target) ||
          !containsPath(root, resolved) ||
          containsPath(gitDirectory, resolved)
        ) {
          throw new MonkeError(`Upstream symlink escapes versioned source: ${file}`);
        }
      }
    }
  };
  visit(root);
}

export function stageLockedRecipe(recipe: SkillImportRecipe, stagingDirectory: string) {
  if (!recipe.lock) {
    throw new MonkeError(`Unpinned Skill import recipe: ${recipe.source}`);
  }
  const source = pinnedSkillSource(recipe.lock, stagingDirectory);
  const output = runSkillsCaptured(
    buildSkillsInstallArgs({
      importerVersion: recipe.lock.importerVersion,
      selectors: recipe.skills.map((skill) => skill.selector),
      source
    }),
    stagingDirectory
  );
  const slugs = listStagedSkillSlugs(stagingDirectory);
  if (
    slugs.join("\0") !==
    recipe.skills
      .map((skill) => skill.slug)
      .toSorted()
      .join("\0")
  ) {
    throw new MonkeError(`Locked Skill slugs changed for ${recipe.source}`);
  }
  return output;
}

/** Hashes delivered paths, bytes, executable bits and confined symlink targets. */
export function guidanceDigest(
  repoRoot: string,
  guidance: readonly SkillImportRecipeSkill[],
  prepared = false
) {
  const hash = new Bun.CryptoHasher("sha256");
  for (const item of guidance.toSorted((a, b) =>
    compareSkillLockStrings(`${a.kind}/${a.slug}`, `${b.kind}/${b.slug}`)
  )) {
    const root = prepared
      ? path.join(repoRoot, item.kind, item.slug)
      : importedGuidancePath(repoRoot, item);
    if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      throw new MonkeError(`Imported ${item.kind} root must be a regular directory: ${root}`);
    }
    const entry = path.join(root, item.kind === "reference" ? "MAIN.md" : "SKILL.md");
    if (!lstatSync(entry, { throwIfNoEntry: false })?.isFile()) {
      throw new MonkeError(`Missing or invalid Imported ${item.kind} entry at ${entry}`);
    }
    hashDirectory(root, root, `${item.kind}/${item.slug}`, hash);
  }
  return hash.digest("hex");
}

function hashDirectory(root: string, directory: string, prefix: string, hash: Bun.CryptoHasher) {
  for (const name of readdirSync(directory).toSorted()) {
    const entry = path.join(directory, name);
    const deliveredPath = `${prefix}/${path.relative(root, entry).split(path.sep).join("/")}`;
    const metadata = lstatSync(entry);
    if (metadata.isDirectory()) {
      hashDirectory(root, entry, prefix, hash);
    } else if (metadata.isFile()) {
      const bytes = readFileSync(entry);
      hash.update(
        // oxlint-disable-next-line no-bitwise -- Executable permission bits belong to the delivered-file contract.
        JSON.stringify([deliveredPath, "file", Boolean(metadata.mode & 0o111), bytes.length])
      );
      hash.update(bytes);
    } else if (metadata.isSymbolicLink()) {
      const target = readlinkSync(entry);
      if (path.isAbsolute(target) || !containsPath(root, path.resolve(directory, target))) {
        throw new MonkeError(
          `Imported symlink escapes its guidance directory: ${entry} -> ${target}`
        );
      }
      hash.update(JSON.stringify([deliveredPath, "symlink", target]));
    } else {
      throw new MonkeError(`Unsupported imported file at ${entry}`);
    }
  }
}

/** Restores exact accepted guidance without discovery or lock rewriting. */
export async function withSkillImportMutation<T>(repoRoot: string, callback: () => T | Promise<T>) {
  const runtime = createRuntime({ cwd: repoRoot });
  return await withScopedLockAsync(getMonkeHome(runtime), `skill-import:${repoRoot}`, callback);
}

export async function restoreSkillImports(repoRoot: string) {
  await withSkillImportMutation(repoRoot, () => {
    restoreLockedImports(repoRoot);
  });
}

export function restoreLockedImports(repoRoot: string) {
  if (!existsSync(path.join(repoRoot, SKILL_LOCK_PATH))) {
    return;
  }
  const store = readImportRecipeStore(repoRoot);
  if (store.recipes.some((recipe) => !recipe.lock)) {
    throw new MonkeError(
      "Skill lock is incomplete; run skills:update to pin every recipe before source installation"
    );
  }
  const managedRoots = [
    { kind: "skill", root: path.join(repoRoot, IMPORTED_SKILLS_ROOT) },
    { kind: "reference", root: path.join(repoRoot, IMPORTED_REFERENCES_ROOT) }
  ];
  for (const { root } of managedRoots) {
    const metadata = lstatSync(root, { throwIfNoEntry: false });
    if (metadata && !metadata.isDirectory()) {
      throw new MonkeError(`Imported guidance root must be a regular directory: ${root}`);
    }
  }
  for (const recipe of store.recipes) {
    try {
      if (guidanceDigest(repoRoot, recipe.skills) === recipe.lock?.digest) {
        continue;
      }
    } catch {
      // Missing/stale local materialization is restored from the accepted pin.
    }
    const stagingDirectory = path.join(repoRoot, "tmp", `skill-restore-${crypto.randomUUID()}`);
    mkdirSync(stagingDirectory, { recursive: true });
    try {
      stageLockedRecipe(recipe, stagingDirectory);
      copyStagedGuidanceToManagedRoots({
        guidance: recipe.skills,
        repoRoot,
        stagingDirectory,
        validatePrepared(preparedRoot) {
          if (guidanceDigest(preparedRoot, recipe.skills, true) !== recipe.lock?.digest) {
            throw new MonkeError(
              `Skill lock digest mismatch for ${recipe.source}; accepted lock was not changed`
            );
          }
        }
      });
    } finally {
      rmSync(stagingDirectory, { force: true, recursive: true });
    }
  }
  for (const recipe of store.recipes) {
    if (guidanceDigest(repoRoot, recipe.skills) !== recipe.lock?.digest) {
      throw new MonkeError(`Invalid locked guidance for ${recipe.source}`);
    }
  }
  // Generated roots belong to the selected lock, including after a Git revert.
  // Wait until every recipe validates before removing entries from a newer lock.
  const guidance = store.recipes.flatMap((recipe) => recipe.skills);
  for (const { kind, root } of managedRoots) {
    const owned = new Set(guidance.filter((item) => item.kind === kind).map((item) => item.slug));
    for (const name of existsSync(root) ? readdirSync(root) : []) {
      if (!owned.has(name)) {
        rmSync(path.join(root, name), { force: true, recursive: true });
      }
    }
  }
}
