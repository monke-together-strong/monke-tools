import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { copyStagedGuidanceToManagedRoots } from "../scripts/import-guidance.ts";
import {
  normalizeImportRecipeStore,
  writeImportRecipeStore
} from "../scripts/skill-import-recipes.ts";
import type { SkillImportRecipe, SkillImportRecipeStore } from "../scripts/skill-import-recipes.ts";
import { errorMessage, MonkeError, ThrownValueSchema } from "./errors.ts";
import { containsPath } from "./path-identity.ts";
import { getMonkeHome } from "./runtime.ts";
import type { Runtime } from "./types.ts";

const SKILL_SOURCE_CANDIDATES = [
  ".agents/skills",
  "skills",
  ".claude/skills",
  ".codex/skills",
  ".cursor/skills"
];

/** Choose one skill source folder from a checkout or installer output. */
export function resolveSkillSourceFolder(directory: string, preserveAlias = false) {
  if (existsSync(path.join(directory, "SKILL.md"))) {
    return preserveAlias ? directory : realpathSync.native(directory);
  }
  const candidates = SKILL_SOURCE_CANDIDATES.map((candidate) => path.join(directory, candidate));
  const root = candidates.find((candidate) => existsSync(candidate)) ?? directory;
  return existsSync(root) && !preserveAlias ? realpathSync.native(root) : root;
}

/** Scan Skill directories and their existing ancestors without following cycles. */
function scanSkillSource(root: string, includeNestedSkills = false) {
  if (!existsSync(root)) {
    throw new MonkeError(`Skill source is missing: ${root}`);
  }
  const skills: string[] = [];
  const directories = new Set<string>();
  const ancestors = new Set<string>();
  function visit(directory: string) {
    const physicalDirectory = realpathSync.native(directory);
    if (ancestors.has(physicalDirectory)) {
      return;
    }
    directories.add(directory);
    if (existsSync(path.join(directory, "SKILL.md"))) {
      skills.push(directory);
      if (!includeNestedSkills) {
        return;
      }
    }
    ancestors.add(physicalDirectory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        (entry.isDirectory() ||
          (entry.isSymbolicLink() &&
            statSync(path.join(directory, entry.name), {
              throwIfNoEntry: false
            })?.isDirectory())) &&
        !entry.name.startsWith(".") &&
        !["node_modules", "references"].includes(entry.name)
      ) {
        visit(path.join(directory, entry.name));
      }
    }
    ancestors.delete(physicalDirectory);
  }
  visit(root);
  return { directories, skills };
}

/** Discover Skills without asking which agent should receive them. */
export function discoverSourceSkills(root: string) {
  const skills = new Map<string, string>();
  for (const directory of scanSkillSource(root).skills) {
    const slug = path.basename(directory);
    if (skills.has(slug)) {
      throw new MonkeError(`Duplicate Skill slug ${slug} in ${root}`);
    }
    skills.set(slug, directory);
  }
  return skills;
}

/** Keep duplicate slugs visible so adoption can compare them before publishing. */
export function discoverSourceSkillCopies(root: string) {
  return scanSkillSource(root).skills;
}

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
    const root =
      localSource.skillSourceFolder === workingDirectory
        ? resolveSkillSourceFolder(localSource.workingDirectory)
        : localSource.skillSourceFolder;
    const discovered = discoverSourceSkills(root);
    if (discovered.size === 0) {
      throw new MonkeError(`No skills found in ${root}`);
    }
    const selected = recipe.selection ?? [...discovered.keys()];
    const skills = selected.map((slug) => {
      const sourcePath = discovered.get(slug);
      if (!sourcePath) {
        throw new MonkeError(`Selected Skill ${slug} is missing from ${root}`);
      }
      cpSync(sourcePath, path.join(staging, ".agents", "skills", slug), {
        dereference: true,
        recursive: true
      });
      return {
        ...recipe.skills.find((item) => item.slug === slug),
        kind: "skill" as const,
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
      linkedSkills: discovered,
      obsoleteGuidance: previous?.skills.filter((item) => !selected.includes(item.slug)),
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
