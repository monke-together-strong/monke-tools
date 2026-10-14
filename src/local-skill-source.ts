import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  copyStagedGuidanceToManagedRoots,
  importedGuidancePath
} from "../scripts/import-guidance.ts";
import {
  normalizeImportRecipeStore,
  readRepoImportRecipeStore,
  writeImportRecipeStore
} from "../scripts/skill-import-recipes.ts";
import type {
  SkillImportRecipe,
  SkillImportRecipeSkill,
  SkillImportRecipeStore
} from "../scripts/skill-import-recipes.ts";
import { restoreSkillImports } from "../scripts/skill-lock.ts";
import { errorMessage, MonkeError, ThrownValueSchema } from "./errors.ts";
import { containsPath } from "./path-identity.ts";
import { getMonkeHome } from "./runtime.ts";
import {
  discoverSourceSkills,
  resolveSkillSourceFolder,
  scanSkillSource,
  SKILL_SOURCE_CANDIDATES
} from "./skill-source-discovery.ts";
import type { Runtime } from "./types.ts";

/** Back up Skill folders without treating an existing project as disposable installer output. */
function backupSourceFolders(
  previousPath: string,
  workingDirectory: string,
  staging: string,
  recoveryCopies: Map<string, string | null>,
  disposableWorkingDirectory: boolean
) {
  const scanRoots = [
    ...new Set([
      previousPath,
      workingDirectory,
      ...SKILL_SOURCE_CANDIDATES.map((candidate) => path.join(workingDirectory, candidate))
    ])
  ];
  const directories = new Set<string>();
  const links = new Map<string, string>();
  const skills = new Set<string>();
  const parents = new Map<string, string>();
  const sourceSkills = new Set<string>();
  for (const root of scanRoots) {
    rememberSourceAncestors(root, directories, links);
    if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      continue;
    }
    const scanned = scanSkillSource(root);
    for (const directory of scanned.directories) {
      rememberSourceAncestors(directory, directories, links);
    }
    for (const skill of scanned.skills) {
      skills.add(skill);
      if (root === previousPath) {
        sourceSkills.add(skill);
      }
    }
  }
  for (const skill of sourceSkills) {
    const backup = path.join(staging, "originals", String(recoveryCopies.size));
    parents.set(skill, projectedRecoveryParent(skill));
    cpSync(skill, backup, { recursive: true, verbatimSymlinks: true });
    recoveryCopies.set(skill, backup);
  }
  if (disposableWorkingDirectory && !existsSync(workingDirectory)) {
    parents.set(workingDirectory, projectedRecoveryParent(workingDirectory));
    recoveryCopies.set(workingDirectory, null);
  }
  return {
    directories,
    links,
    parents,
    scanRoots,
    skills,
    sourceFolder: previousPath,
    sourceSkills,
    workingDirectory
  };
}

/** Remember existing collection ancestors so cleanup only prunes new, empty directories. */
function rememberSourceAncestors(
  root: string,
  directories: Set<string>,
  links: Map<string, string>
) {
  let directory = root;
  while (!directories.has(directory)) {
    const entry = lstatSync(directory, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) {
      links.set(directory, readlinkSync(directory));
    }
    if (statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
      directories.add(directory);
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return;
    }
    directory = parent;
  }
}

/** Resolve a parent even when the installer removed part of its directory hierarchy. */
function projectedRecoveryParent(source: string) {
  const parent = path.dirname(source);
  let ancestor = parent;
  while (!existsSync(ancestor)) {
    ancestor = path.dirname(ancestor);
  }
  return path.resolve(realpathSync.native(ancestor), path.relative(ancestor, parent));
}

/** Restore source namespace links without following newly introduced directory aliases. */
function prepareRecoveryParents(
  snapshot: ReturnType<typeof backupSourceFolders>,
  directory: string
) {
  const boundary = containsPath(snapshot.workingDirectory, snapshot.sourceFolder)
    ? snapshot.workingDirectory
    : snapshot.sourceFolder;
  if (!containsPath(boundary, directory)) {
    return;
  }
  const parents: string[] = [];
  for (let parent = directory; containsPath(boundary, parent); parent = path.dirname(parent)) {
    parents.push(parent);
    if (parent === boundary) {
      break;
    }
  }
  for (const parent of parents.toReversed()) {
    if (!snapshot.directories.has(parent)) {
      continue;
    }
    const current = lstatSync(parent, { throwIfNoEntry: false });
    const originalLink = snapshot.links.get(parent);
    if (originalLink !== undefined) {
      if (current?.isSymbolicLink() && readlinkSync(parent) === originalLink) {
        continue;
      }
      if (current && !current.isSymbolicLink()) {
        throw new MonkeError(`Source recovery directory replaced an original link: ${parent}`);
      }
      rmSync(parent, { force: true });
      symlinkSync(originalLink, parent, "dir");
    } else {
      if (current?.isSymbolicLink()) {
        rmSync(parent, { force: true });
      }
      mkdirSync(parent, { recursive: true });
    }
  }
}

/** Record failed installer additions without removing preexisting project directories. */
function recordNewSourceSkills(
  snapshot: ReturnType<typeof backupSourceFolders> | undefined,
  recoveryCopies: Map<string, string | null>
) {
  if (!snapshot) {
    return;
  }
  const discovered = snapshot.scanRoots
    .filter((root) => statSync(root, { throwIfNoEntry: false })?.isDirectory())
    .flatMap((root) => scanSkillSource(root, true).skills);
  for (const skillFolder of new Set(discovered)) {
    if (
      [...snapshot.skills].some((root) => containsPath(root, skillFolder)) ||
      [...recoveryCopies.keys()].some((root) => containsPath(root, skillFolder))
    ) {
      continue;
    }
    const target = newSkillRecoveryPath(skillFolder, snapshot);
    if (target) {
      snapshot.parents.set(target, projectedRecoveryParent(target));
      recoveryCopies.set(target, null);
    }
  }
}

/** Remove a new alias rather than deleting the existing directory it exposes. */
function newSkillRecoveryPath(
  skillFolder: string,
  snapshot: ReturnType<typeof backupSourceFolders>
) {
  let newAlias: string | undefined;
  for (let directory = skillFolder; ; directory = path.dirname(directory)) {
    if (lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()) {
      const original = snapshot.links.get(directory);
      if (original === undefined) {
        newAlias = directory;
      } else if (readlinkSync(directory) !== original) {
        return;
      }
    }
    if (path.dirname(directory) === directory) {
      break;
    }
  }
  return (
    newAlias ??
    (snapshot.directories.has(skillFolder) ? path.join(skillFolder, "SKILL.md") : skillFolder)
  );
}

function pruneNewSourceParents(source: string, directories: Set<string>) {
  let parent = path.dirname(source);
  while (!directories.has(parent)) {
    if (lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) {
      return;
    }
    if (existsSync(parent)) {
      if (readdirSync(parent).length > 0) {
        return;
      }
      rmdirSync(parent);
    }
    parent = path.dirname(parent);
  }
}

/** Delete rejected additions first, then restore the original Skill bytes. */
function restoreSourceFolders(
  snapshot: ReturnType<typeof backupSourceFolders> | undefined,
  recoveryCopies: Map<string, string | null>
) {
  const failures: string[] = [];
  if (!snapshot) {
    return failures;
  }
  try {
    prepareRecoveryParents(snapshot, snapshot.sourceFolder);
    recordNewSourceSkills(snapshot, recoveryCopies);
  } catch (error) {
    failures.push(errorMessage(ThrownValueSchema.parse(error)));
  }
  for (const [source, copy] of [...recoveryCopies].toReversed()) {
    try {
      if (copy !== null) {
        prepareRecoveryParents(snapshot, path.dirname(source));
      }
      if (projectedRecoveryParent(source) !== snapshot.parents.get(source)) {
        throw new MonkeError(`Source recovery parent changed: ${source}`);
      }
      rmSync(source, { force: true, recursive: true });
      if (copy === null) {
        pruneNewSourceParents(source, snapshot.directories);
      } else {
        cpSync(copy, source, { recursive: true, verbatimSymlinks: true });
      }
    } catch (error) {
      failures.push(`${source}: ${errorMessage(ThrownValueSchema.parse(error))}`);
    }
  }
  return failures;
}

function resolveLocalSourceRoot(
  localSource: NonNullable<SkillImportRecipe["localSource"]>,
  workingDirectory: string
) {
  return localSource.skillSourceFolder === workingDirectory
    ? resolveSkillSourceFolder(
        localSource.workingDirectory,
        false,
        existsSync(path.join(localSource.workingDirectory, "monke.yml"))
      )
    : localSource.skillSourceFolder;
}

/** Reject ambiguous published slugs before restoring imports into the linked checkout. */
function validateDeclaredSlugs(
  discovered: Map<string, string>,
  declared: SkillImportRecipeSkill[],
  publisher: string,
  source: string
) {
  const declaredSlugs = new Set<string>();
  for (const item of declared) {
    const ownPath = discovered.get(item.slug);
    const isOwnSkill =
      ownPath !== undefined && !containsPath(path.join(publisher, "skills/imported"), ownPath);
    if (isOwnSkill || declaredSlugs.has(item.slug)) {
      throw new MonkeError(
        `Imported ${item.kind} slug ${item.slug} collides with publishing source ${source}`
      );
    }
    declaredSlugs.add(item.slug);
  }
}

/** Include the publisher's reference imports without treating them as linked Skills. */
async function discoverLocalGuidance(
  recipe: SkillImportRecipe & { localSource: NonNullable<SkillImportRecipe["localSource"]> },
  workingDirectory: string,
  runtime: Runtime
) {
  const repository = runtime.exec("git", ["rev-parse", "--show-toplevel"], {
    allowFailure: true,
    cwd: workingDirectory
  });
  const publisher = repository.exitCode === 0 ? repository.stdout.trim() : undefined;
  const declared =
    publisher && existsSync(path.join(publisher, "monke.yml"))
      ? readRepoImportRecipeStore(publisher).recipes.flatMap((item) => item.skills)
      : [];
  if (publisher && existsSync(path.join(publisher, "monke.yml"))) {
    validateDeclaredSlugs(
      discoverSourceSkills(
        resolveLocalSourceRoot(recipe.localSource, workingDirectory),
        path.join(publisher, "skills/imported")
      ),
      declared,
      publisher,
      recipe.source
    );
    await restoreSkillImports(publisher, false, runtime);
  }
  const root = resolveLocalSourceRoot(recipe.localSource, workingDirectory);
  const discovered = new Map<string, { kind: SkillImportRecipeSkill["kind"]; sourcePath: string }>(
    [...discoverSourceSkills(root)].map(([slug, sourcePath]) => [
      slug,
      { kind: "skill", sourcePath }
    ])
  );
  if (publisher) {
    for (const item of declared) {
      discovered.set(item.slug, {
        kind: item.kind,
        sourcePath: importedGuidancePath(publisher, item)
      });
    }
  }
  return { discovered, root };
}

/** Refresh a command or linked source and publish it through the existing import materializer. */
export async function updateLocalSkillSource(options: {
  executeCommand?: boolean;
  recipe: SkillImportRecipe;
  repoRoot: string;
  runtime: Runtime;
  store: SkillImportRecipeStore;
  validatePrepared?: (prepared: string, recipe: SkillImportRecipe) => void;
}) {
  const { recipe, repoRoot, runtime, store } = options;
  const { localSource } = recipe;
  if (!localSource) {
    throw new MonkeError(`Missing local skill source for ${recipe.source}`);
  }
  const staging = mkdtempSync(path.join(tmpdir(), "monke-skill-source-"));
  const previous = store.recipes.find((item) => item.source === recipe.source);
  const workingDirectory = existsSync(localSource.workingDirectory)
    ? realpathSync.native(localSource.workingDirectory)
    : localSource.workingDirectory;
  const recoveryCopies = new Map<string, string | null>();
  let snapshot: ReturnType<typeof backupSourceFolders> | undefined;
  let retainRecovery = false;
  function backupLinkedSkillTarget(sourcePath: string) {
    const physicalSource = realpathSync.native(sourcePath);
    if (![...recoveryCopies.keys()].some((root) => containsPath(root, physicalSource))) {
      const physicalBackup = path.join(staging, "linked-originals", String(recoveryCopies.size));
      cpSync(physicalSource, physicalBackup, { recursive: true, verbatimSymlinks: true });
      recoveryCopies.set(physicalSource, physicalBackup);
      snapshot?.parents.set(physicalSource, projectedRecoveryParent(physicalSource));
    }
  }
  try {
    snapshot = backupSourceFolders(
      localSource.skillSourceFolder,
      workingDirectory,
      staging,
      recoveryCopies,
      containsPath(path.join(getMonkeHome(runtime), "skill-sources"), workingDirectory)
    );
    for (const sourcePath of snapshot.sourceSkills) {
      backupLinkedSkillTarget(sourcePath);
    }
    if (localSource.command && options.executeCommand !== false) {
      mkdirSync(localSource.workingDirectory, { recursive: true });
      const shell = runtime.platform === "win32" ? "cmd.exe" : "sh";
      const args =
        runtime.platform === "win32"
          ? ["/d", "/s", "/c", localSource.command]
          : ["-c", localSource.command];
      const result = await runtime.execAsync(shell, args, {
        cwd: localSource.workingDirectory,
        inheritStdio: true
      });
      if (result.exitCode !== 0) {
        throw new MonkeError(
          `Skill installer for ${recipe.source} exited with code ${result.exitCode}`
        );
      }
    }
    const { discovered, root } = await discoverLocalGuidance(
      { ...recipe, localSource },
      workingDirectory,
      runtime
    );
    if (discovered.size === 0) {
      throw new MonkeError(`No skills found in ${root}`);
    }
    const selected = recipe.selection ?? [...discovered.keys()];
    const skills = selected.map((slug) => {
      const source = discovered.get(slug);
      if (!source) {
        throw new MonkeError(`Selected Skill ${slug} is missing from ${root}`);
      }
      const target = path.join(staging, ".agents", "skills", slug);
      cpSync(source.sourcePath, target, {
        dereference: true,
        recursive: true
      });
      if (source.kind === "reference") {
        renameSync(path.join(target, "MAIN.md"), path.join(target, "SKILL.md"));
      }
      return {
        ...recipe.skills.find((item) => item.slug === slug),
        kind: source.kind,
        selector: slug,
        slug
      };
    });
    const nextRecipe = {
      ...recipe,
      localSource: { ...localSource, skillSourceFolder: root },
      skills
    };
    const next = normalizeImportRecipeStore({
      ...store,
      recipes: [...store.recipes.filter((item) => item.source !== recipe.source), nextRecipe]
    });
    copyStagedGuidanceToManagedRoots({
      commitState() {
        writeImportRecipeStore(repoRoot, next);
      },
      defaultDisableModelInvocation: recipe.disableModelInvocation,
      guidance: nextRecipe.skills,
      linkedSkills: new Map(
        [...discovered]
          .filter(([, item]) => item.kind === "skill")
          .map(([slug, item]) => [slug, item.sourcePath])
      ),
      obsoleteGuidance: previous?.skills.filter(
        (item) =>
          !skills.some((candidate) => candidate.slug === item.slug && candidate.kind === item.kind)
      ),
      repoRoot,
      stagingDirectory: staging,
      validatePrepared(prepared) {
        options.validatePrepared?.(prepared, nextRecipe);
      }
    });
    return next;
  } catch (error) {
    const failures = restoreSourceFolders(snapshot, recoveryCopies);
    if (failures.length > 0) {
      retainRecovery = true;
      throw new MonkeError(
        `${errorMessage(ThrownValueSchema.parse(error))}\nSource restoration failed:\n${failures.join("\n")}\nRecovery copies retained at ${staging}`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    if (!retainRecovery) {
      rmSync(staging, { force: true, recursive: true });
    }
  }
}
