import {
  accessSync,
  constants as fsConstants,
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
import { createRuntime, formatCommand, getMonkeHome, withScopedLockAsync } from "../src/runtime.ts";
import { resolveSkillPath } from "../src/skill-path.ts";
import type { ExecResult, Runtime } from "../src/types.ts";
import { parseOwnedYamlText } from "../src/validation.ts";
import {
  assertManagedGuidanceRoots,
  assertObsoleteReferencesAreUnconsumed,
  copyStagedGuidanceToManagedRoots,
  importedGuidancePath,
  IMPORTED_REFERENCES_ROOT,
  IMPORTED_SKILLS_ROOT,
  prepareStagedGuidance
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
import { readJsonSecurityRiskAssessments, sanitizeSkillMetadata } from "./skill-import.ts";
import type { SecurityRiskAssessment } from "./skill-import.ts";
import { buildSkillsInstallArgs, listStagedSkillSlugs, SKILLS_CLI_VERSION } from "./skills-cli.ts";

export const MATERIALIZER_VERSION = 1;
export const SKILL_RESTORE_MARKER = "skills/.monke-restored.json";

function assertSkillRestoreMarkerEntry(repoRoot: string) {
  const file = path.join(repoRoot, SKILL_RESTORE_MARKER);
  const metadata = lstatSync(file, { throwIfNoEntry: false });

  if (metadata && !metadata.isFile() && !metadata.isSymbolicLink()) {
    throw new MonkeError(`Skill restore marker path is obstructed: ${file}`);
  }

  return file;
}

/** Require a replaceable marker and parent access before publishing accepted guidance. */
export function assertSkillRestoreMarker(repoRoot: string) {
  const file = assertSkillRestoreMarkerEntry(repoRoot);
  let parent = path.dirname(file);

  while (!lstatSync(parent, { throwIfNoEntry: false })) {
    parent = path.dirname(parent);
  }

  try {
    accessSync(parent, fsConstants.W_OK + fsConstants.X_OK);
  } catch (error) {
    throw new MonkeError(`Skill restore marker parent is not writable and searchable: ${parent}`, {
      cause: error
    });
  }

  const entry = lstatSync(file, { throwIfNoEntry: false });
  const directory = lstatSync(parent);
  const uid = process.geteuid?.();

  if (
    entry &&
    uid !== undefined &&
    uid !== 0 &&
    // oxlint-disable-next-line no-bitwise -- Sticky directories restrict replacement by entry ownership.
    (directory.mode & 0o1000) !== 0 &&
    directory.uid !== uid &&
    entry.uid !== uid
  ) {
    throw new MonkeError(`Skill restore marker cannot be replaced in sticky directory: ${file}`);
  }
}

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

/** Matching accepted bytes need no marker write or upstream fetch. */
export function isSkillRecipeRestored(repoRoot: string, recipe: SkillImportRecipe) {
  assertSkillRestoreMarkerEntry(repoRoot);
  const marker = readRestoreMarkers(repoRoot)[recipe.source];

  try {
    return (
      Boolean(recipe.commit) &&
      marker?.recipe === recipeIdentity(recipe) &&
      marker.tooling === `${SKILLS_CLI_VERSION}/${MATERIALIZER_VERSION}` &&
      guidanceDigest(repoRoot, recipe.skills) === marker.digest
    );
  } catch {
    return false;
  }
}

export function rememberRestoredRecipe(repoRoot: string, recipe: SkillImportRecipe) {
  assertSkillRestoreMarker(repoRoot);
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

export function ignoreRepoImports(repoRoot: string, runtime = createRuntime({ cwd: repoRoot })) {
  assertRepoImportIgnoreFile(repoRoot);
  const file = path.join(repoRoot, ".gitignore");
  const original = existsSync(file) ? readFileSync(file, "utf-8") : undefined;
  let text = original ?? "";
  const hasGit = existsSync(path.join(repoRoot, ".git"));

  const isIgnored = (entry: string) => {
    if (!hasGit) {
      return true;
    }

    const result = runtime.exec(
      "git",
      ["check-ignore", "--quiet", "--no-index", "--", entry.slice(1)],
      {
        allowFailure: true,
        cwd: repoRoot
      }
    );

    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new MonkeError(`Cannot check Git ignore rules for ${entry}: ${result.stderr.trim()}`);
    }

    return result.exitCode === 0;
  };

  const entries = ["/skills/imported/", "/skills/references/imported/", `/${SKILL_RESTORE_MARKER}`];

  for (const entry of entries) {
    if (
      !text.split(/\r?\n/u).some((line) => line === entry || line === entry.slice(1)) ||
      !isIgnored(entry)
    ) {
      text += `${text && !text.endsWith("\n") ? "\n" : ""}${entry}\n`;
    }
  }

  if (text !== original) {
    writeFileSync(file, text);
  }

  try {
    for (const entry of entries) {
      if (!isIgnored(entry)) {
        throw new MonkeError(
          `Cannot ignore ${entry}; remove conflicting rules from nested .gitignore files`
        );
      }
    }
  } catch (error) {
    if (text !== original) {
      if (original === undefined) {
        rmSync(file);
      } else {
        writeFileSync(file, original);
      }
    }

    throw error;
  }
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
  rejectAmbiguousSelection?: boolean;
  repoRoot: string;
  retainSelection?: boolean;
  runtime?: Runtime;
  selectFromCollection?: boolean;
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

  const { output, ownNames, ownSkills, securityAssessments, selected, selection } =
    await stageOwnGitSkills({
      imported,
      rejectAmbiguousSelection: options.rejectAmbiguousSelection,
      retainedSkills: options.retainSelection ? options.previousRecipe?.skills : undefined,
      runtime,
      selectFromCollection: options.selectFromCollection,
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
    .map((item) => ({
      kind: "skill" as const,
      selector: ownNames.get(item.slug) ?? item.slug,
      slug: item.slug
    }));

  for (const item of imported) {
    if (ownSkills.has(item.slug)) {
      throw new MonkeError(
        `Imported ${item.kind} slug ${item.slug} collides with publishing source ${recipe.source}`
      );
    }
  }

  if (declared.recipes.length > 0) {
    // Never follow imports declared by an imported source itself.
    await restoreLockedImports(checkout, false, runtime, declared);

    for (const item of imported) {
      if (!publisherGuidanceSelected(item, selected)) {
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

  return {
    ...output,
    declaredGuidance: [...imported, ...ownReplacements],
    declaredSelectors: imported.flatMap((item) => [item.selector, item.slug]),
    securityAssessments,
    selection:
      options.retainSelection &&
      !selectors.includes("*") &&
      selection.some((item, index) => item !== selectors[index])
        ? selection
        : undefined,
    source
  };
}

function publisherGuidanceSelected(
  item: Pick<SkillImportRecipeSkill, "selector" | "slug">,
  selectors: string[]
) {
  return (
    selectors.includes("*") ||
    selectors.some(
      (selector) =>
        selector.toLowerCase() === item.slug.toLowerCase() ||
        selector.toLowerCase() === item.selector.toLowerCase()
    )
  );
}

interface PublisherSkillCatalog {
  entries: Map<string, { assessment?: SecurityRiskAssessment; directory: string; slug: string }>;
  names: Map<string, string>;
  slugs: Set<string>;
}

async function stageOwnGitSkills(options: {
  imported: readonly SkillImportRecipeSkill[];
  rejectAmbiguousSelection?: boolean;
  retainedSkills?: readonly SkillImportRecipeSkill[];
  runtime: Runtime;
  selectFromCollection?: boolean;
  selectors: string[];
  source: string;
  sourceRoot: string;
  stagingDirectory: string;
}) {
  const {
    imported,
    rejectAmbiguousSelection = false,
    retainedSkills,
    runtime,
    selectFromCollection = false,
    selectors,
    source,
    sourceRoot,
    stagingDirectory
  } = options;

  const selectionOptions = publisherSkillSelection({
    imported,
    rejectAmbiguousSelection,
    retainedSkills,
    selectFromCollection,
    selectors,
    sourceRoot
  });

  const { explicit, inspectCollection, ownSelectors, selected } = selectionOptions;

  const collection = await stagePublisherCollection({
    runtime,
    selectFromCollection,
    selection: selectionOptions,
    source,
    stagingDirectory
  });

  const { catalog } = collection;
  let { output } = collection;
  let securityAssessments: SecurityRiskAssessment[] | undefined;

  if (inspectCollection && (explicit || rejectAmbiguousSelection)) {
    await mergeAlternatePublisherCatalog({
      catalog,
      includeInternal:
        selectFromCollection || !["1", "true"].includes(runtime.env.INSTALL_INTERNAL_SKILLS ?? ""),
      rejectAmbiguity: rejectAmbiguousSelection || selectFromCollection,
      runtime,
      selectFromCollection,
      selection: selectionOptions,
      source,
      stagingDirectory
    });
  }

  if (selectFromCollection) {
    securityAssessments = copyPublisherSelection(catalog, ownSelectors, source, stagingDirectory);
  } else if (inspectCollection && explicit && ownSelectors.length > 0) {
    output = await runtime.execAsync(
      runtime.platform === "win32" ? "npx.cmd" : "npx",
      buildSkillsInstallArgs({
        selectors: ownSelectors.map(
          (selector) =>
            retainedPublisherSelector(
              findRetainedSkill(retainedSkills, selector),
              imported,
              catalog
            ) ?? selector
        ),
        source
      }),
      { cwd: stagingDirectory }
    );
  }

  const selection = selectors.map((selector) => {
    const previous = findRetainedSkill(retainedSkills, selector);
    const currentName = retainedPublisherSelector(previous, imported, catalog);

    return previous && currentName && currentName.toLowerCase() !== previous.selector.toLowerCase()
      ? previous.slug
      : selector;
  });

  return {
    output,
    ownNames: catalog.names,
    ownSkills: catalog.slugs,
    securityAssessments,
    selected,
    selection
  };
}

function retainedPublisherSelector(
  previous: SkillImportRecipeSkill | undefined,
  imported: readonly SkillImportRecipeSkill[],
  catalog: PublisherSkillCatalog
) {
  if (!previous) {
    return;
  }

  return (
    imported.find((item) => item.slug === previous.slug)?.selector ??
    (catalog.entries.has(previous.selector.toLowerCase())
      ? previous.selector
      : catalog.names.get(previous.slug))
  );
}

async function stagePublisherCollection(options: {
  runtime: Runtime;
  selectFromCollection: boolean;
  selection: ReturnType<typeof publisherSkillSelection>;
  source: string;
  stagingDirectory: string;
}) {
  const { runtime, selectFromCollection, selection, source, stagingDirectory } = options;
  const { allowEmptyCollection, explicit, inspectCollection, ownSelectors } = selection;

  const directory =
    inspectCollection && explicit
      ? path.join(stagingDirectory, "publisher-collection")
      : stagingDirectory;

  const catalog: PublisherSkillCatalog = { entries: new Map(), names: new Map(), slugs: new Set() };
  let output = { exitCode: 0, stderr: "", stdout: "" };

  if (!inspectCollection && ownSelectors.length === 0) {
    return { catalog, output };
  }

  mkdirSync(directory, { recursive: true });

  const { empty, installed } = await installPublisherSkills({
    allowEmptyCollection: allowEmptyCollection || (inspectCollection && explicit),
    directory,
    includeInternal: selectFromCollection ? false : undefined,
    inspectCollection,
    runtime,
    selectors: inspectCollection ? ["*"] : ownSelectors,
    source
  });

  if (!empty) {
    catalog.slugs = new Set(listStagedSkillSlugs(directory));

    if (inspectCollection) {
      const assessments = readJsonSecurityRiskAssessments(installed.stdout);

      for (const item of stagedSkillGuidance(directory, { skills: [], source })) {
        catalog.names.set(item.slug, item.selector);
        catalog.entries.set(item.selector.toLowerCase(), {
          assessment: assessments.get(item.selector.toLowerCase()),
          directory: path.join(directory, ".agents/skills", item.slug),
          slug: item.slug
        });
      }
    }
  }

  if (!inspectCollection || !explicit) {
    output = installed;
  }

  return { catalog, output };
}

async function mergeAlternatePublisherCatalog(options: {
  catalog: PublisherSkillCatalog;
  includeInternal: boolean;
  rejectAmbiguity: boolean;
  runtime: Runtime;
  selectFromCollection: boolean;
  selection: ReturnType<typeof publisherSkillSelection>;
  source: string;
  stagingDirectory: string;
}) {
  const {
    catalog,
    includeInternal,
    rejectAmbiguity,
    runtime,
    selectFromCollection,
    selection,
    source,
    stagingDirectory
  } = options;

  const { explicit, ownSelectors } = selection;
  const internalDirectory = path.join(stagingDirectory, "publisher-alternate-collection");
  mkdirSync(internalDirectory, { recursive: true });

  const { empty, installed } = await installPublisherSkills({
    allowEmptyCollection: true,
    directory: internalDirectory,
    includeInternal,
    inspectCollection: true,
    runtime,
    selectors: ["*"],
    source
  });

  if (empty) {
    return;
  }

  const assessments = readJsonSecurityRiskAssessments(installed.stdout);

  for (const item of stagedSkillGuidance(internalDirectory, { skills: [], source })) {
    const selectedOwn =
      ownSelectors.includes("*") ||
      ownSelectors.some((selector) => selector.toLowerCase() === item.selector.toLowerCase());

    const directory = path.join(internalDirectory, ".agents/skills", item.slug);
    const previous = catalog.entries.get(item.selector.toLowerCase());

    if (
      rejectAmbiguity &&
      selectedOwn &&
      previous &&
      skillDirectoryDigest(previous.directory) !== skillDirectoryDigest(directory)
    ) {
      throw new MonkeError(
        `Ambiguous Skill selector ${item.selector} in ${source}; default and internal discovery deliver different guidance`
      );
    }

    if (explicit && (!selectFromCollection || selectedOwn)) {
      catalog.slugs.add(item.slug);
    }

    if (!previous) {
      catalog.entries.set(item.selector.toLowerCase(), {
        assessment: assessments.get(item.selector.toLowerCase()),
        directory,
        slug: item.slug
      });
    }

    if (!catalog.names.has(item.slug)) {
      catalog.names.set(item.slug, item.selector);
    }
  }
}

function copyPublisherSelection(
  catalog: PublisherSkillCatalog,
  selectors: string[],
  source: string,
  stagingDirectory: string
) {
  const missing = selectors.filter((selector) => !catalog.entries.has(selector.toLowerCase()));

  if (missing.length > 0) {
    throw new MonkeError(`Selected skills not found in ${source}: ${missing.join(", ")}`);
  }

  const assessments: SecurityRiskAssessment[] = [];

  for (const selector of new Set(selectors.map((item) => item.toLowerCase()))) {
    const skill = catalog.entries.get(selector.toLowerCase());

    if (skill) {
      if (skill.assessment) {
        assessments.push(skill.assessment);
      }

      cpSync(skill.directory, path.join(stagingDirectory, ".agents/skills", skill.slug), {
        recursive: true,
        verbatimSymlinks: true
      });
    }
  }

  return assessments;
}

async function installPublisherSkills(options: {
  allowEmptyCollection: boolean;
  directory: string;
  includeInternal?: boolean;
  inspectCollection: boolean;
  runtime: Runtime;
  selectors: string[];
  source: string;
}) {
  const {
    allowEmptyCollection,
    directory,
    includeInternal,
    inspectCollection,
    runtime,
    selectors,
    source
  } = options;

  const command = runtime.platform === "win32" ? "npx.cmd" : "npx";
  const args = buildSkillsInstallArgs({ selectors, source });

  if (inspectCollection) {
    args.push("--json");
  }

  const installed = await runtime.execAsync(command, args, {
    allowFailure: inspectCollection,
    cwd: directory,
    ...(inspectCollection && includeInternal !== undefined
      ? { env: { INSTALL_INTERNAL_SKILLS: includeInternal ? "1" : "" } }
      : {})
  });

  if (installed.exitCode === 0) {
    return { empty: false, installed };
  }

  if (allowEmptyCollection && isEmptyPublisherCollection(installed)) {
    return { empty: true, installed: { ...installed, exitCode: 0 } };
  }

  const reason =
    installed.stderr.trim() || installed.stdout.trim() || `exit code ${installed.exitCode}`;

  throw new MonkeError(`Command failed: ${formatCommand(command, args)}\n${reason}`);
}

function isEmptyPublisherCollection(output: ExecResult) {
  if (output.exitCode !== 1 || output.timedOut) {
    return false;
  }

  const schema = z.tuple([
    z.strictObject({
      error: z.literal(
        "No valid skills found. Skills require a SKILL.md with name and description."
      ),
      status: z.literal("failed")
    })
  ]);

  try {
    return schema.safeParse(JSON.parse(output.stdout)).success;
  } catch {
    return false;
  }
}

function findRetainedSkill(
  retainedSkills: readonly SkillImportRecipeSkill[] | undefined,
  selector: string
) {
  return (
    retainedSkills?.find((item) => item.slug.toLowerCase() === selector.toLowerCase()) ??
    retainedSkills?.find((item) => item.selector.toLowerCase() === selector.toLowerCase())
  );
}

function publisherSkillSelection(options: {
  imported: readonly SkillImportRecipeSkill[];
  rejectAmbiguousSelection?: boolean;
  retainedSkills?: readonly SkillImportRecipeSkill[];
  selectFromCollection?: boolean;
  selectors: string[];
  sourceRoot: string;
}) {
  const {
    imported,
    rejectAmbiguousSelection = false,
    retainedSkills,
    selectFromCollection = false,
    selectors,
    sourceRoot
  } = options;

  const selected = selectors.map((selector) => {
    const previous = findRetainedSkill(retainedSkills, selector);

    return imported.find((item) => item.slug === previous?.slug)?.slug ?? selector;
  });

  // Only skip the importer for declaration-only publishers. Upstream owns discovery
  // and installed names, including hidden catalogs and names unlike their folders.
  const sourceMayHaveOwnSkills =
    imported.length === 0 ||
    !new Bun.Glob("**/SKILL.md").scanSync({ cwd: sourceRoot, dot: true, onlyFiles: true }).next()
      .done;

  const declaredSelectors = new Set(
    imported.flatMap((item) => [item.slug.toLowerCase(), item.selector.toLowerCase()])
  );

  const ownSelectors = selected.filter(
    (selector) =>
      !declaredSelectors.has(selector.toLowerCase()) && (selector !== "*" || sourceMayHaveOwnSkills)
  );

  const explicit = !selectors.includes("*");

  const inspectCollection =
    sourceMayHaveOwnSkills &&
    (rejectAmbiguousSelection ||
      selectFromCollection ||
      imported.length > 0 ||
      (explicit && (retainedSkills?.length ?? 0) > 0));

  const allowEmptyCollection = imported.length > 0 && (!explicit || ownSelectors.length === 0);

  return { allowEmptyCollection, explicit, inspectCollection, ownSelectors, selected };
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
  options: { preserveImportKinds?: boolean; references?: string[] } = {}
) {
  return listStagedSkillSlugs(stagingDirectory).map((slug) => {
    const entry = path.join(stagingDirectory, ".agents", "skills", slug, "SKILL.md");
    const imported = declared.find((item) => item.slug === slug);
    const existing = previous.skills.find((item) => item.slug === slug);

    const kind = options.preserveImportKinds
      ? (existing?.kind ?? imported?.kind)
      : (imported?.kind ?? existing?.kind);

    const selector = stagedSkillSelector(entry, slug, imported);

    const reference =
      options.references && publisherGuidanceSelected({ selector, slug }, options.references);

    return {
      ...existing,
      kind: reference ? ("reference" as const) : (kind ?? ("skill" as const)),
      selector,
      slug
    };
  });
}

function stagedSkillSelector(entry: string, slug: string, imported?: SkillImportRecipeSkill) {
  if (imported?.kind === "reference") {
    return imported.selector;
  }

  const frontmatter = /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(
    readFileSync(entry, "utf-8")
  );

  if (!frontmatter) {
    throw new MonkeError(`Expected leading YAML frontmatter at ${entry}`);
  }

  const metadata = parseOwnedYamlText(
    frontmatter.groups?.frontmatter ?? "{}",
    entry,
    z.looseObject({ name: z.string().optional() })
  );

  if (metadata.name === undefined) {
    return imported?.selector ?? slug;
  }

  const selector = sanitizeSkillMetadata(metadata.name);

  if (!selector) {
    throw new MonkeError(
      `Skill name normalizes to an empty selector at ${entry}; use a name containing visible characters`
    );
  }

  return selector;
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
    selectFromCollection: !includeDeclaredImports || recipe.selection?.includes("*"),
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

function skillDirectoryDigest(directory: string) {
  const hash = new Bun.CryptoHasher("sha256");
  hashDirectory(directory, directory, "skill", hash);

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

/** Reserve accepted declaration changes through consumer recovery and review saving. */
export async function withSkillImportUpdate<T>(
  repoRoot: string,
  callback: () => T | Promise<T>,
  runtime: Runtime = createRuntime({ cwd: repoRoot })
) {
  return await withScopedLockAsync(
    getMonkeHome(runtime),
    `skill-update:${resolveSkillPath(repoRoot).resolved}`,
    callback
  );
}

/** Serialize materialization, including restores run by saved installers. */
export async function withSkillImportMutation<T>(
  repoRoot: string,
  callback: () => T | Promise<T>,
  runtime: Runtime = createRuntime({ cwd: repoRoot })
) {
  return await withScopedLockAsync(
    getMonkeHome(runtime),
    `skill-import:${resolveSkillPath(repoRoot).resolved}`,
    callback
  );
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
    restoreLockedImports(repoRoot, false, undefined, readRepoImportRecipeStore(repoRoot))
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

  if (isSkillRecipeRestored(repoRoot, recipe)) {
    return;
  }

  assertSkillRestoreMarker(repoRoot);
  const stagingDirectory = path.join(repoRoot, "tmp", `skill-restore-${crypto.randomUUID()}`);
  mkdirSync(stagingDirectory, { recursive: true });

  try {
    await stageLockedRecipe(recipe, stagingDirectory, repoRoot, includeDeclaredImports, runtime);
    assertSkillRestoreMarker(repoRoot);
    copyStagedGuidanceToManagedRoots({
      defaultDisableModelInvocation: recipe.disableModelInvocation,
      guidance: recipe.skills,
      repoRoot,
      stagingDirectory,
      validatePrepared(prepared) {
        guidanceDigest(prepared, recipe.skills, true);
      }
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
  store?: Pick<SkillImportRecipeStore, "recipes">,
  commitState?: () => void
) {
  assertManagedGuidanceRoots(repoRoot);
  const { recipes } = store ?? readImportRecipeStore(repoRoot);

  if (recipes.some((recipe) => !recipe.localSource && !recipe.commit)) {
    throw new MonkeError(
      "Skill lock is incomplete; run mt skills update --repo to pin every recipe before source installation"
    );
  }

  if (existsSync(path.join(repoRoot, "monke.yml"))) {
    ignoreRepoImports(repoRoot, runtime);
  }

  const restore = pLimit(4);
  const stagingDirectories: string[] = [];

  try {
    // Keep the mutation lock until every preparation settles, even when a sibling fails.
    const results = await Promise.allSettled(
      recipes
        .filter((recipe) => !recipe.localSource && !isSkillRecipeRestored(repoRoot, recipe))
        .map((recipe) =>
          restore(async () => {
            assertSkillRestoreMarker(repoRoot);

            const stagingDirectory = path.join(
              repoRoot,
              "tmp",
              `skill-restore-${crypto.randomUUID()}`
            );

            stagingDirectories.push(stagingDirectory);
            mkdirSync(stagingDirectory, { recursive: true });
            await stageLockedRecipe(
              recipe,
              stagingDirectory,
              repoRoot,
              includeDeclaredImports,
              runtime
            );

            const guidance = recipe.skills.map((item) => ({
              ...item,
              disableModelInvocation: item.disableModelInvocation ?? recipe.disableModelInvocation
            }));

            const preparedRoot = path.join(stagingDirectory, "prepared");
            prepareStagedGuidance(
              guidance,
              path.join(stagingDirectory, ".agents", "skills"),
              preparedRoot
            );
            guidanceDigest(preparedRoot, recipe.skills, true);

            return { guidance, preparedRoot, recipe };
          })
        )
    );

    const prepared = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []
    );

    const failed = results.find((result) => result.status === "rejected");

    if (failed && commitState) {
      throw failed.reason;
    }

    const guidance = prepared.flatMap((result) => result.guidance);

    const stagedPaths = new Map(
      prepared.flatMap(({ preparedRoot, recipe }) =>
        recipe.skills.map(
          (item) =>
            [`${item.kind}:${item.slug}`, path.join(preparedRoot, item.kind, item.slug)] as const
        )
      )
    );

    const obsolete = failed
      ? []
      : obsoleteImportedGuidance(
          repoRoot,
          recipes.flatMap((recipe) => recipe.skills)
        );

    if (guidance.length > 0) {
      assertSkillRestoreMarker(repoRoot);
    }

    if (guidance.length > 0 || obsolete.length > 0) {
      copyStagedGuidanceToManagedRoots({
        commitState: failed ? undefined : commitState,
        guidance,
        ignoredConsumerRoots: stagingDirectories,
        obsoleteGuidance: obsolete,
        repoRoot,
        stagedGuidancePath(item) {
          const source = stagedPaths.get(`${item.kind}:${item.slug}`);

          if (!source) {
            throw new MonkeError(`Missing staged ${item.kind} ${item.slug}`);
          }

          return source;
        },
        stagingDirectory: repoRoot
      });
    } else if (!failed) {
      commitState?.();
    }

    for (const { recipe } of prepared) {
      rememberRestoredRecipe(repoRoot, recipe);
    }

    if (failed) {
      throw failed.reason;
    }
  } finally {
    for (const stagingDirectory of stagingDirectories) {
      rmSync(stagingDirectory, { force: true, recursive: true });
    }
  }
}

function obsoleteImportedGuidance(repoRoot: string, guidance: readonly SkillImportRecipeSkill[]) {
  assertManagedGuidanceRoots(repoRoot);

  const managedRoots = [
    { kind: "skill", root: path.join(repoRoot, IMPORTED_SKILLS_ROOT) },
    { kind: "reference", root: path.join(repoRoot, IMPORTED_REFERENCES_ROOT) }
  ] as const;

  return managedRoots.flatMap(({ kind, root }) => {
    const owned = new Set(guidance.filter((item) => item.kind === kind).map((item) => item.slug));

    return (existsSync(root) ? readdirSync(root) : [])
      .filter((slug) => !owned.has(slug))
      .map((slug) => ({ kind, slug }));
  });
}

/** Generated roots belong only to the current selected guidance. */
export function pruneImportedGuidance(repoRoot: string, guidance: SkillImportRecipeSkill[]) {
  const obsolete = obsoleteImportedGuidance(repoRoot, guidance);
  assertObsoleteReferencesAreUnconsumed(
    repoRoot,
    obsolete,
    obsolete.map((item) => importedGuidancePath(repoRoot, item))
  );

  for (const item of obsolete) {
    rmSync(importedGuidancePath(repoRoot, item), { force: true, recursive: true });
  }
}
