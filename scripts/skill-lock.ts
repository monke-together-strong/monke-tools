import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import pLimit from "p-limit";
import * as z from "zod";

import { MonkeError } from "../src/errors.ts";
import { containsPath } from "../src/path-identity.ts";
import { createRuntime, getMonkeHome, withScopedLockAsync } from "../src/runtime.ts";
import type { Runtime } from "../src/types.ts";
import { parseOwnedYamlText } from "../src/validation.ts";
import {
  assertManagedGuidanceRoots,
  copyStagedGuidanceToManagedRoots,
  importedGuidancePath,
  IMPORTED_REFERENCES_ROOT,
  IMPORTED_SKILLS_ROOT
} from "./import-guidance.ts";
import {
  compareSkillLockStrings,
  RepoImportRecipesSchema,
  readImportRecipeStore,
  readRepoImportRecipeStore
} from "./skill-import-recipes.ts";
import type {
  SkillImportRecipe,
  SkillImportRecipeSkill,
  SkillImportRecipeStore
} from "./skill-import-recipes.ts";
import { writeSkillImportState } from "./skill-import-state.ts";
import { buildSkillsInstallArgs, listStagedSkillSlugs, SKILLS_CLI_VERSION } from "./skills-cli.ts";

export const MATERIALIZER_VERSION = 1;
export const SKILL_RESTORE_MARKER = "skills/.monke-restored.json";
const MarkerSchema = z.record(
  z.string(),
  z.strictObject({ digest: z.string(), recipe: z.string(), tooling: z.string() })
);
function recipeIdentity(recipe: SkillImportRecipe) {
  return JSON.stringify({
    commit: recipe.commit,
    disableModelInvocation: recipe.disableModelInvocation,
    skills: recipe.skills.map(({ description, disableModelInvocation, kind, selector, slug }) => ({
      description,
      disableModelInvocation,
      kind,
      selector,
      slug
    })),
    source: recipe.source
  });
}
function readRestoreMarkers(repoRoot: string) {
  const file = path.join(repoRoot, SKILL_RESTORE_MARKER);
  if (!existsSync(file)) {
    return {};
  }
  try {
    const parsed = MarkerSchema.safeParse(JSON.parse(readFileSync(file, "utf-8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
export function rememberRestoredRecipe(repoRoot: string, recipe: SkillImportRecipe) {
  const file = path.join(repoRoot, SKILL_RESTORE_MARKER);
  const markers = readRestoreMarkers(repoRoot);
  markers[recipe.source] = {
    digest: guidanceDigest(repoRoot, recipe.skills),
    recipe: recipeIdentity(recipe),
    tooling: `${SKILLS_CLI_VERSION}/${MATERIALIZER_VERSION}`
  };
  mkdirSync(path.dirname(file), { recursive: true });
  writeSkillImportState(file, `${JSON.stringify(markers)}\n`);
}
/** Ignore updates must not mutate another file through a symlink or hard link. */
export function assertRepoImportIgnoreFile(repoRoot: string) {
  const file = path.join(repoRoot, ".gitignore");
  const metadata = lstatSync(file, { throwIfNoEntry: false });
  if (metadata && (!metadata.isFile() || metadata.nlink > 1)) {
    throw new MonkeError(`.gitignore must be a regular file without aliases: ${file}`);
  }
}

export function ignoreRepoImports(repoRoot: string) {
  assertRepoImportIgnoreFile(repoRoot);
  const file = path.join(repoRoot, ".gitignore");
  let text = existsSync(file) ? readFileSync(file, "utf-8") : "";
  for (const entry of [
    "/skills/imported/",
    "/skills/references/imported/",
    `/${SKILL_RESTORE_MARKER}`
  ]) {
    if (!text.split(/\r?\n/u).some((line) => line === entry || line === entry.slice(1))) {
      text += `${text && !text.endsWith("\n") ? "\n" : ""}${entry}\n`;
    }
  }
  writeFileSync(file, text);
}

async function resolveExplicitSkillCommit(repository: string, revision: string, repoRoot: string) {
  if (path.isAbsolute(repository)) {
    const result = await createRuntime({ cwd: repository }).execAsync("git", [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${revision}^{commit}`
    ]);
    return result.stdout.trim();
  }
  const stagingDirectory = path.join(repoRoot, "tmp", `skill-pin-${crypto.randomUUID()}`);
  mkdirSync(stagingDirectory, { recursive: true });
  const runtime = createRuntime({ cwd: stagingDirectory });
  try {
    runtime.exec("git", ["init", "--quiet"]);
    await runtime.execAsync("git", [
      "fetch",
      "--quiet",
      "--depth",
      "1",
      "--",
      repository,
      revision
    ]);
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

export async function resolveSkillRevision(recipe: SkillImportRecipe, repoRoot: string) {
  const source = describeSkillSource(recipe.source, repoRoot);
  const treePath = "treePath" in source ? source.treePath : undefined;
  const requestedRefs = treePath
    ? treePath
        .split("/")
        .map((_, index, segments) => segments.slice(0, index + 1).join("/"))
        .toReversed()
    : [source.updateRef];
  let revisions: string[][] = [];
  if (!/^[a-f\d]{40}$/u.test(source.updateRef)) {
    const result = await createRuntime({ cwd: repoRoot }).execAsync("git", [
      "ls-remote",
      "--",
      source.repository,
      ...requestedRefs.flatMap((ref) => [ref, `${ref}^{}`])
    ]);
    revisions = result.stdout
      .trim()
      .split("\n")
      .map((row) => row.split(/\s+/u));
  }
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
    ? await resolveExplicitSkillCommit(source.repository, source.updateRef, repoRoot)
    : (revisions.find(([, ref]) => ref === `${selected?.[1]}^{}`) ?? selected)?.[0];
  if (!commit || !/^[a-f\d]{40}$/u.test(commit)) {
    throw new MonkeError(
      `Cannot resolve ${recipe.source} at ${source.updateRef} to a full Git commit`
    );
  }
  return {
    commit,
    repository: source.repository,
    source:
      treePath && updateRef.includes("/")
        ? `https://github.com/${source.repository.slice("https://github.com/".length).replace(/\.git$/u, "")}${treePath.slice(updateRef.length)}#${updateRef}`
        : recipe.source,
    subpath: treePath ? treePath.slice(updateRef.length).replace(/^\//u, "") : source.subpath,
    updateRef
  };
}

/** Remote imports use skills.sh's SHA URL; local Git fixtures receive an immutable checkout. */
export async function pinnedSkillSource(
  lock: { commit: string; repository: string; subpath: string },
  stagingDirectory: string
) {
  if (path.isAbsolute(lock.repository)) {
    const checkout = path.join(stagingDirectory, "upstream");
    const runtime = createRuntime({ cwd: stagingDirectory });
    await runtime.execAsync("git", [
      "clone",
      "--quiet",
      "--no-checkout",
      "--",
      lock.repository,
      checkout
    ]);
    await runtime.execAsync("git", ["checkout", "--quiet", "--detach", lock.commit], {
      cwd: checkout
    });
    validateUpstreamLinks(checkout);
    return path.join(checkout, lock.subpath);
  }
  // Copy mode dereferences upstream links, so validate the exact tree before the importer.
  // Keep remote source URLs intact for upstream discovery and security assessments.
  const checkout = path.join(stagingDirectory, "upstream-validation");
  mkdirSync(checkout, { recursive: true });
  const runtime = createRuntime({ cwd: checkout });
  await runtime.execAsync("git", ["init", "--quiet"]);
  await runtime.execAsync("git", [
    "fetch",
    "--quiet",
    "--depth",
    "1",
    "--",
    lock.repository,
    lock.commit
  ]);
  await runtime.execAsync("git", ["checkout", "--quiet", "--detach", lock.commit]);
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

/** Stage a publishing repo and one level of its declared imports as one collection. */
export async function stageGitSkillSource(options: {
  includeDeclaredImports?: boolean;
  previousRecipe?: SkillImportRecipe;
  recipe: SkillImportRecipe;
  repoRoot: string;
  runtime?: Runtime;
  selectors: string[];
  stagingDirectory: string;
}) {
  const { recipe, repoRoot, selectors, stagingDirectory } = options;
  if (!recipe.commit) {
    throw new MonkeError(
      `Unpinned Skill import recipe: ${recipe.source}; run mt skills update --repo`
    );
  }
  const descriptor = describeSkillSource(recipe.source, repoRoot);
  const source = await pinnedSkillSource(
    { ...descriptor, commit: recipe.commit },
    stagingDirectory
  );
  const checkout = path.join(
    stagingDirectory,
    path.isAbsolute(descriptor.repository) ? "upstream" : "upstream-validation"
  );
  const declared =
    options.includeDeclaredImports === false
      ? { recipes: [] }
      : readRepoImportRecipeStore(checkout);
  const imported = declared.recipes.flatMap((entry) => entry.skills);
  const runtime = options.runtime ?? createRuntime({ cwd: stagingDirectory });
  const { output, ownSkills } = await stageOwnGitSkills({
    imported,
    runtime,
    selectors,
    source,
    sourceRoot: path.join(checkout, descriptor.subpath),
    stagingDirectory
  });
  const retiredReferences =
    options.previousRecipe?.skills.filter(
      (item) =>
        item.kind === "reference" &&
        ownSkills.has(item.slug) &&
        !imported.some((current) => current.slug === item.slug)
    ) ?? [];
  const previousDeclared =
    retiredReferences.length > 0
      ? await previousPublisherGuidance(
          checkout,
          descriptor.repository,
          options.previousRecipe?.commit,
          runtime
        )
      : [];
  const ownReplacements = retiredReferences
    .filter((item) =>
      previousDeclared.some((old) => old.kind === "reference" && old.slug === item.slug)
    )
    .map((item) => ({ kind: "skill" as const, selector: item.slug, slug: item.slug }));
  if (imported.length > 0) {
    for (const item of imported) {
      if (ownSkills.has(item.slug)) {
        throw new MonkeError(
          `Imported ${item.kind} slug ${item.slug} collides with publishing source ${recipe.source}`
        );
      }
    }
  }
  if (declared.recipes.length > 0) {
    // Never follow imports declared by an imported source itself.
    await restoreLockedImports(checkout, false, runtime, declared);
    for (const item of imported) {
      if (
        !selectors.includes("*") &&
        !selectors.some((selector) => selector === item.slug || selector === item.selector)
      ) {
        continue;
      }
      const target = path.join(stagingDirectory, ".agents", "skills", item.slug);
      if (existsSync(target)) {
        throw new MonkeError(
          `Imported ${item.kind} slug ${item.slug} collides with publishing source ${recipe.source}`
        );
      }
      cpSync(importedGuidancePath(checkout, item), target, {
        recursive: true,
        verbatimSymlinks: true
      });
    }
  }
  return { ...output, declaredGuidance: [...imported, ...ownReplacements], source };
}

async function stageOwnGitSkills(options: {
  imported: readonly SkillImportRecipeSkill[];
  runtime: Runtime;
  selectors: string[];
  source: string;
  sourceRoot: string;
  stagingDirectory: string;
}) {
  const { imported, runtime, selectors, source, sourceRoot, stagingDirectory } = options;
  // Only skip the importer for declaration-only publishers. Upstream owns discovery
  // and installed names, including hidden catalogs and names unlike their folders.
  const hasOwnSkills =
    imported.length === 0 ||
    !new Bun.Glob("**/SKILL.md")
      .scanSync({
        cwd: sourceRoot,
        dot: true,
        onlyFiles: true
      })
      .next().done;
  const declaredSelectors = new Set(imported.flatMap((item) => [item.slug, item.selector]));
  const ownSelectors = selectors.filter(
    (selector) => !declaredSelectors.has(selector) && (selector !== "*" || hasOwnSkills)
  );
  const inspectCollection = imported.length > 0 && hasOwnSkills;
  const explicit = !selectors.includes("*");
  const collectionDirectory =
    inspectCollection && explicit
      ? path.join(stagingDirectory, "publisher-collection")
      : stagingDirectory;
  let output = { exitCode: 0, stderr: "", stdout: "" };
  let ownSkills = new Set<string>();
  if (inspectCollection || ownSelectors.length > 0) {
    mkdirSync(collectionDirectory, { recursive: true });
    const installed = await runtime.execAsync(
      runtime.platform === "win32" ? "npx.cmd" : "npx",
      buildSkillsInstallArgs({ selectors: inspectCollection ? ["*"] : ownSelectors, source }),
      {
        cwd: collectionDirectory,
        // Stage the complete collection before applying the consumer's selection.
        ...(inspectCollection ? { env: { INSTALL_INTERNAL_SKILLS: "1" } } : {})
      }
    );
    ownSkills = new Set(listStagedSkillSlugs(collectionDirectory));
    if (!inspectCollection || !explicit) {
      output = installed;
    }
  }
  if (
    inspectCollection &&
    !explicit &&
    !["1", "true"].includes(runtime.env.INSTALL_INTERNAL_SKILLS ?? "")
  ) {
    pruneInternalPublisherSkills(collectionDirectory, ownSkills);
  }
  if (inspectCollection && explicit && ownSelectors.length > 0) {
    output = await runtime.execAsync(
      runtime.platform === "win32" ? "npx.cmd" : "npx",
      buildSkillsInstallArgs({ selectors: ownSelectors, source }),
      { cwd: stagingDirectory }
    );
  }
  return { output, ownSkills };
}

/** Match the pinned importer's default exclusion after staging an entire publisher. */
function pruneInternalPublisherSkills(stagingDirectory: string, ownSkills: Set<string>) {
  for (const slug of ownSkills) {
    const directory = path.join(stagingDirectory, ".agents", "skills", slug);
    const content = readFileSync(path.join(directory, "SKILL.md"), "utf-8");
    const frontmatter = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
    const data = parseOwnedYamlText(
      frontmatter?.groups?.yaml ?? "{}",
      directory,
      z.looseObject({ metadata: z.unknown().optional() })
    );
    if (z.looseObject({ internal: z.literal(true) }).safeParse(data.metadata).success) {
      rmSync(directory, { recursive: true });
      ownSkills.delete(slug);
    }
  }
}

/** Identify inherited reference kinds without overriding legacy consumer choices. */
async function previousPublisherGuidance(
  checkout: string,
  repository: string,
  commit: string | undefined,
  runtime: Runtime
) {
  if (!commit) {
    return [];
  }
  const available = await runtime.execAsync("git", ["cat-file", "-e", `${commit}^{commit}`], {
    allowFailure: true,
    cwd: checkout
  });
  if (available.exitCode !== 0) {
    await runtime.execAsync("git", ["fetch", "--quiet", "--depth", "1", "--", repository, commit], {
      cwd: checkout
    });
  }
  const config = await runtime.execAsync("git", ["show", `${commit}:monke.yml`], {
    allowFailure: true,
    cwd: checkout
  });
  if (config.exitCode !== 0) {
    return [];
  }
  const previous = parseOwnedYamlText(
    config.stdout,
    `monke.yml at ${commit}`,
    z.looseObject({ skills: RepoImportRecipesSchema.default([]) })
  );
  return previous.skills.flatMap((entry) => entry.skills);
}

/** Preserve user overrides while discovering the publishing source's selected collection. */
export function stagedSkillGuidance(
  stagingDirectory: string,
  previous: SkillImportRecipe,
  declared: SkillImportRecipeSkill[] = [],
  options: { preserveImportKinds?: boolean; reference?: boolean } = {}
) {
  return listStagedSkillSlugs(stagingDirectory).map((slug) => {
    const entry = path.join(stagingDirectory, ".agents", "skills", slug, "SKILL.md");
    const imported = declared.find((item) => item.slug === slug);
    const frontmatter =
      imported?.kind === "reference"
        ? null
        : /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(
            readFileSync(entry, "utf-8")
          );
    if (!frontmatter && imported?.kind !== "reference") {
      throw new MonkeError(`Expected leading YAML frontmatter at ${entry}`);
    }
    const metadata = parseOwnedYamlText(
      frontmatter?.groups?.frontmatter ?? "{}",
      entry,
      z.looseObject({ name: z.string().optional() })
    );
    const existing = previous.skills.find((item) => item.slug === slug);
    const kind = options.preserveImportKinds
      ? (existing?.kind ?? imported?.kind)
      : (imported?.kind ?? existing?.kind);
    return {
      ...existing,
      kind: options.reference ? ("reference" as const) : (kind ?? ("skill" as const)),
      selector: metadata.name ?? slug,
      slug
    };
  });
}

export async function stageLockedRecipe(
  recipe: SkillImportRecipe,
  stagingDirectory: string,
  repoRoot: string,
  includeDeclaredImports = true,
  runtime?: Runtime
) {
  const output = await stageGitSkillSource({
    includeDeclaredImports,
    recipe,
    repoRoot,
    runtime,
    selectors: recipe.skills.map((skill) => skill.selector),
    stagingDirectory
  });
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
export async function withSkillImportMutation<T>(
  repoRoot: string,
  callback: () => T | Promise<T>,
  runtime: Runtime = createRuntime({ cwd: repoRoot })
) {
  return await withScopedLockAsync(getMonkeHome(runtime), `skill-import:${repoRoot}`, callback);
}

export async function restoreSkillImports(
  repoRoot: string,
  includeDeclaredImports = true,
  runtime?: Runtime,
  store?: Pick<SkillImportRecipeStore, "recipes">
) {
  await withSkillImportMutation(
    repoRoot,
    () => restoreLockedImports(repoRoot, includeDeclaredImports, runtime, store),
    runtime
  );
}

/** Restore source-checkout declarations, reading YAML while holding the mutation lock. */
export async function restoreRepoSkillImports(repoRoot: string) {
  await withSkillImportMutation(repoRoot, () =>
    restoreLockedImports(repoRoot, true, undefined, readRepoImportRecipeStore(repoRoot))
  );
}

/** Restore one accepted Git source without blocking unrelated source updates. */
export async function restoreLockedRecipe(
  repoRoot: string,
  recipe: SkillImportRecipe,
  includeDeclaredImports = true,
  runtime?: Runtime
) {
  if (!recipe.commit) {
    throw new MonkeError(
      `Unpinned Skill import recipe: ${recipe.source}; run mt skills update --repo`
    );
  }
  const marker = readRestoreMarkers(repoRoot)[recipe.source];
  try {
    if (
      marker?.recipe === recipeIdentity(recipe) &&
      marker.tooling === `${SKILLS_CLI_VERSION}/${MATERIALIZER_VERSION}` &&
      guidanceDigest(repoRoot, recipe.skills) === marker.digest
    ) {
      return;
    }
  } catch {
    // Missing or edited guidance must be restored from the pin.
  }
  const stagingDirectory = path.join(repoRoot, "tmp", `skill-restore-${crypto.randomUUID()}`);
  mkdirSync(stagingDirectory, { recursive: true });
  try {
    await stageLockedRecipe(recipe, stagingDirectory, repoRoot, includeDeclaredImports, runtime);
    copyStagedGuidanceToManagedRoots({
      defaultDisableModelInvocation: recipe.disableModelInvocation,
      guidance: recipe.skills,
      repoRoot,
      stagingDirectory
    });
    rememberRestoredRecipe(repoRoot, recipe);
  } finally {
    rmSync(stagingDirectory, { force: true, recursive: true });
  }
}

export async function restoreLockedImports(
  repoRoot: string,
  includeDeclaredImports = true,
  runtime?: Runtime,
  store?: Pick<SkillImportRecipeStore, "recipes">
) {
  assertManagedGuidanceRoots(repoRoot);
  const { recipes } = store ?? readImportRecipeStore(repoRoot);
  if (recipes.some((recipe) => !recipe.localSource && !recipe.commit)) {
    throw new MonkeError(
      "Skill lock is incomplete; run mt skills update --repo to pin every recipe before source installation"
    );
  }
  if (existsSync(path.join(repoRoot, "monke.yml"))) {
    ignoreRepoImports(repoRoot);
  }
  const restore = pLimit(4);
  // Keep the mutation lock until every restore settles, even when a sibling fails.
  const results = await Promise.allSettled(
    recipes
      .filter((recipe) => !recipe.localSource)
      .map((recipe) =>
        restore(() => restoreLockedRecipe(repoRoot, recipe, includeDeclaredImports, runtime))
      )
  );
  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
  // Wait until every recipe validates before pruning entries from a newer lock.
  pruneImportedGuidance(
    repoRoot,
    recipes.flatMap((recipe) => recipe.skills)
  );
}

/** Generated roots belong only to the current selected guidance. */
export function pruneImportedGuidance(repoRoot: string, guidance: SkillImportRecipeSkill[]) {
  assertManagedGuidanceRoots(repoRoot);
  const managedRoots = [
    { kind: "skill", root: path.join(repoRoot, IMPORTED_SKILLS_ROOT) },
    { kind: "reference", root: path.join(repoRoot, IMPORTED_REFERENCES_ROOT) }
  ];
  for (const { kind, root } of managedRoots) {
    const owned = new Set(guidance.filter((item) => item.kind === kind).map((item) => item.slug));
    for (const name of existsSync(root) ? readdirSync(root) : []) {
      if (!owned.has(name)) {
        rmSync(path.join(root, name), { force: true, recursive: true });
      }
    }
  }
}
