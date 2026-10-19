import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { errorMessage, MonkeError, ThrownValueSchema } from "../src/errors.ts";
import { containsPath, samePath } from "../src/path-identity.ts";
import { setSkillMetadata } from "../src/skill-metadata.ts";
import { resolveSkillPath } from "../src/skill-path.ts";
import { SKILL_SOURCE_CANDIDATES } from "../src/skill-source-discovery.ts";
import { relativeMarkdownLinks } from "./check-skill-links.ts";
import type { SkillImportRecipeSkill } from "./skill-import-recipes.ts";

export const IMPORTED_SKILLS_ROOT = path.join("skills", "imported");
export const IMPORTED_REFERENCES_ROOT = path.join("skills", "references", "imported");

/** Reject aliases before any publication or pruning can reach outside managed roots. */
export function assertManagedGuidanceRoots(repoRoot: string) {
  for (const relative of [
    "skills",
    "skills/references",
    IMPORTED_SKILLS_ROOT,
    IMPORTED_REFERENCES_ROOT
  ]) {
    const root = path.join(repoRoot, relative);
    const metadata = lstatSync(root, { throwIfNoEntry: false });

    if (metadata && !metadata.isDirectory()) {
      throw new MonkeError(`Imported guidance root must be a regular directory: ${root}`);
    }
  }
}

/** Materializes staged upstream guidance using its recorded local Import kind. */
export function copyStagedGuidanceToManagedRoots(
  options: {
    commitState?: () => void;
    defaultDisableModelInvocation?: boolean;
    guidance: readonly SkillImportRecipeSkill[];
    ignoredConsumerRoots?: readonly string[];
    linkedSkills?: ReadonlyMap<string, string>;
    obsoleteGuidance?: readonly Pick<SkillImportRecipeSkill, "kind" | "slug">[];
    repoRoot: string;
    stagedGuidancePath?: (guidance: SkillImportRecipeSkill) => string;
    stagingDirectory: string;
    validatePrepared?: (preparedRoot: string) => void;
  },
  move: (source: string, destination: string) => void = renameSync
) {
  assertManagedGuidanceRoots(options.repoRoot);
  const obsoleteGuidance = options.obsoleteGuidance ?? [];

  const guidance = options.guidance.map((item) => ({
    ...item,
    disableModelInvocation: item.disableModelInvocation ?? options.defaultDisableModelInvocation
  }));

  // Validate every destination before copying staged content or moving any originals.
  const destinations = [...options.guidance, ...obsoleteGuidance].map((item) => ({
    item,
    targetPath: importedGuidancePath(options.repoRoot, item)
  }));

  const obsoleteReferences = new Set(
    obsoleteGuidance
      .filter((item) => item.kind === "reference")
      .map((item) => importedGuidancePath(options.repoRoot, item))
  );

  const stagedSkillsRoot = path.join(options.stagingDirectory, ".agents", "skills");
  const backupRoot = mkdtempSync(path.join(options.repoRoot, ".monke-guidance-backup-"));
  const preparedRoot = path.join(backupRoot, "prepared");
  const affectedPaths = new Map<string, string | null>();
  const metadataCopies = new Map<string, string | null>();
  const newAgentsDirectories = new Set<string>();
  let retainRecovery = false;

  function moveToBackup(item: Pick<SkillImportRecipeSkill, "kind" | "slug">, targetPath: string) {
    if (affectedPaths.has(targetPath)) {
      return;
    }

    const backupPath = path.join(backupRoot, "originals", item.kind, item.slug);

    if (lstatSync(targetPath, { throwIfNoEntry: false })) {
      mkdirSync(path.dirname(backupPath), { recursive: true });
      move(targetPath, backupPath);
      affectedPaths.set(targetPath, backupPath);
    } else {
      affectedPaths.set(targetPath, null);
    }
  }

  try {
    prepareStagedGuidance(guidance, stagedSkillsRoot, preparedRoot, options.stagedGuidancePath);

    options.validatePrepared?.(preparedRoot);

    for (const { item, targetPath } of destinations.filter(
      (destination) => !obsoleteReferences.has(destination.targetPath)
    )) {
      moveToBackup(item, targetPath);
    }

    for (const item of guidance) {
      const targetPath = importedGuidancePath(options.repoRoot, item);
      const linkedSource = options.linkedSkills?.get(item.slug);

      if (
        linkedSource &&
        (item.description !== undefined || item.disableModelInvocation !== undefined)
      ) {
        backupLinkedMetadata(
          linkedSource,
          backupRoot,
          metadataCopies,
          newAgentsDirectories,
          item.disableModelInvocation !== undefined
        );
      }

      mkdirSync(path.dirname(targetPath), { recursive: true });
      publishPreparedGuidance(item, targetPath, preparedRoot, linkedSource);
    }

    // Keep reference targets resolvable until retained consumers have been checked.
    assertObsoleteReferencesAreUnconsumed(options.repoRoot, obsoleteGuidance, [
      backupRoot,
      ...(options.ignoredConsumerRoots ?? []),
      ...(samePath(options.stagingDirectory, options.repoRoot) ? [] : [options.stagingDirectory]),
      ...obsoleteGuidance.map((item) => importedGuidancePath(options.repoRoot, item))
    ]);

    for (const { item, targetPath } of destinations.filter((destination) =>
      obsoleteReferences.has(destination.targetPath)
    )) {
      moveToBackup(item, targetPath);
    }

    options.commitState?.();
  } catch (cause) {
    const failures = restoreLinkedMetadata(metadataCopies, newAgentsDirectories);

    for (const [targetPath, backupPath] of affectedPaths) {
      try {
        rmSync(targetPath, { force: true, recursive: true });

        if (backupPath !== null) {
          mkdirSync(path.dirname(targetPath), { recursive: true });
          move(backupPath, targetPath);
        }
      } catch (recoveryCause) {
        failures.push(`${targetPath}: ${errorMessage(ThrownValueSchema.parse(recoveryCause))}`);
      }
    }

    if (failures.length > 0) {
      retainRecovery = true;
      throw new MonkeError(
        `${errorMessage(ThrownValueSchema.parse(cause))}\nGuidance restoration failed:\n${failures.join("\n")}\nRecovery copies retained at ${backupRoot}`,
        { cause }
      );
    }

    throw cause;
  } finally {
    if (!retainRecovery) {
      rmSync(backupRoot, { force: true, recursive: true });
    }
  }
}

function restoreLinkedMetadata(
  copies: Map<string, string | null>,
  newAgentsDirectories: Set<string>
) {
  const failures: string[] = [];

  for (const [metadataPath, copy] of copies) {
    try {
      rmSync(metadataPath, { force: true });

      if (copy !== null) {
        cpSync(copy, metadataPath, { verbatimSymlinks: true });
      }
    } catch (recoveryCause) {
      failures.push(`${metadataPath}: ${errorMessage(ThrownValueSchema.parse(recoveryCause))}`);
    }
  }

  for (const directory of newAgentsDirectories) {
    try {
      if (existsSync(directory)) {
        rmdirSync(directory);
      }
    } catch (recoveryCause) {
      failures.push(`${directory}: ${errorMessage(ThrownValueSchema.parse(recoveryCause))}`);
    }
  }

  return failures;
}

/** Keep publication rollback separate from installer recovery and unrelated Skill assets. */
function backupLinkedMetadata(
  source: string,
  backupRoot: string,
  copies: Map<string, string | null>,
  newAgentsDirectories: Set<string>,
  updateInvocation: boolean
) {
  const physicalSource = realpathSync.native(source);
  const metadataPaths = [path.join(physicalSource, "SKILL.md")];
  const agentsPath = path.join(physicalSource, "agents");
  const agents = lstatSync(agentsPath, { throwIfNoEntry: false });

  // The metadata setter rejects directory aliases before changing their contents.
  if (updateInvocation && (!agents || agents.isDirectory())) {
    metadataPaths.push(path.join(agentsPath, "openai.yaml"), path.join(agentsPath, "openai.yml"));

    if (!agents) {
      newAgentsDirectories.add(agentsPath);
    }
  }

  for (const metadataPath of metadataPaths) {
    if (copies.has(metadataPath)) {
      continue;
    }

    if (lstatSync(metadataPath, { throwIfNoEntry: false })) {
      const copy = path.join(backupRoot, "metadata", String(copies.size));
      mkdirSync(path.dirname(copy), { recursive: true });
      cpSync(metadataPath, copy, { verbatimSymlinks: true });
      copies.set(metadataPath, copy);
    } else {
      copies.set(metadataPath, null);
    }
  }
}

function publishPreparedGuidance(
  item: SkillImportRecipeSkill,
  targetPath: string,
  preparedRoot: string,
  linkedSource?: string
) {
  if (linkedSource) {
    if (item.kind !== "skill") {
      throw new MonkeError("Linked guidance must be a Skill");
    }

    setSkillMetadata(linkedSource, item);
    symlinkSync(linkedSource, targetPath, "dir");
  } else {
    cpSync(path.join(preparedRoot, item.kind, item.slug), targetPath, {
      recursive: true,
      verbatimSymlinks: true
    });
  }
}

/** Convert staged guidance and apply its recorded local metadata before publication. */
export function prepareStagedGuidance(
  guidance: readonly SkillImportRecipeSkill[],
  stagedSkillsRoot: string,
  preparedRoot: string,
  stagedGuidancePath?: (guidance: SkillImportRecipeSkill) => string
) {
  for (const item of guidance) {
    const sourcePath = stagedGuidancePath?.(item) ?? path.join(stagedSkillsRoot, item.slug);

    if (!existsSync(sourcePath)) {
      throw new MonkeError(`Expected staged Skill directory at ${sourcePath}`);
    }

    if (!lstatSync(sourcePath).isDirectory()) {
      throw new MonkeError(
        `Expected staged Skill directory to be a regular directory at ${sourcePath}`
      );
    }

    const preparedPath = path.join(preparedRoot, item.kind, item.slug);
    mkdirSync(path.dirname(preparedPath), { recursive: true });
    cpSync(sourcePath, preparedPath, { recursive: true, verbatimSymlinks: true });

    if (item.kind === "reference") {
      transformPreparedReference(preparedPath);
    } else {
      const entry = path.join(preparedPath, "SKILL.md");

      if (!lstatSync(entry, { throwIfNoEntry: false })?.isFile()) {
        throw new MonkeError(`Expected staged Skill entry document to be a regular file: ${entry}`);
      }

      setSkillMetadata(preparedPath, item);
    }
  }
}

function transformPreparedReference(referencePath: string) {
  const skillEntryPath = path.join(referencePath, "SKILL.md");
  const referenceEntryPath = path.join(referencePath, "MAIN.md");

  if (existsSync(referenceEntryPath)) {
    if (!existsSync(skillEntryPath) && lstatSync(referenceEntryPath).isFile()) {
      // Publisher references have already had their entry transformed.
      return;
    }

    throw new MonkeError(
      `Cannot import reference because upstream guidance already contains MAIN.md at ${referenceEntryPath}`
    );
  }

  if (!existsSync(skillEntryPath)) {
    throw new MonkeError(`Expected staged Skill entry document at ${skillEntryPath}`);
  }

  if (!lstatSync(skillEntryPath).isFile()) {
    throw new MonkeError(`Expected staged Skill entry document to be a regular file`);
  }

  const body = removeLeadingYamlFrontmatter(readFileSync(skillEntryPath, "utf-8"));
  unlinkSync(skillEntryPath);
  writeFileSync(referenceEntryPath, body, { encoding: "utf-8", flag: "wx" });
}

function removeLeadingYamlFrontmatter(markdown: string) {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    return markdown;
  }

  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(markdown);

  if (!match) {
    throw new MonkeError("Imported reference has unterminated leading YAML frontmatter");
  }

  return markdown.slice(match[0].length);
}

/** Ignore consumers removed in the same batch while protecting every retained consumer. */
export function assertObsoleteReferencesAreUnconsumed(
  repoRoot: string,
  obsoleteGuidance: readonly Pick<SkillImportRecipeSkill, "kind" | "slug">[],
  ignoredConsumerRoots: readonly string[] = []
) {
  const physicalRepoRoot = realpathSync.native(repoRoot);

  for (const guidance of obsoleteGuidance) {
    if (guidance.kind !== "reference") {
      continue;
    }

    const obsoleteReferenceRoot = importedGuidancePath(physicalRepoRoot, guidance);
    const referencePathPrefix = `${path.posix.join("references", "imported", guidance.slug)}/`;

    const ignored = [
      path.join(physicalRepoRoot, "monke.yml"),
      path.join(physicalRepoRoot, "skills/.monke-restored.json"),
      ...ignoredConsumerRoots.map((root) =>
        path.resolve(physicalRepoRoot, path.relative(repoRoot, root))
      )
    ];

    const roots = existsSync(path.join(physicalRepoRoot, "SKILL.md"))
      ? ["."]
      : SKILL_SOURCE_CANDIDATES;

    const consumers = roots
      .flatMap((root) =>
        listReferenceConsumers(
          physicalRepoRoot,
          path.join(physicalRepoRoot, root),
          obsoleteReferenceRoot,
          referencePathPrefix,
          ignored
        )
      )
      .map((entryPath) => path.relative(physicalRepoRoot, entryPath))
      .toSorted();

    if (consumers.length > 0) {
      throw new MonkeError(
        `Cannot replace Imported reference ${guidance.slug}; it is used by ${consumers.join(", ")}`
      );
    }
  }
}

function listReferenceConsumers(
  repoRoot: string,
  root: string,
  obsoleteReferenceRoot: string,
  referencePathPrefix: string,
  ignoredConsumerRoots: readonly string[]
): string[] {
  const ancestors = new Set<string>();

  const isExcluded = (entryPath: string) =>
    containsPath(obsoleteReferenceRoot, entryPath) ||
    ignoredConsumerRoots.some((ignored) => containsPath(ignored, entryPath));

  function visit(consumerPath: string): string[] {
    if (isExcluded(consumerPath)) {
      return [];
    }

    let entry = lstatSync(consumerPath, { throwIfNoEntry: false });

    if (!entry) {
      return [];
    }

    if (entry.isSymbolicLink()) {
      const linkTarget = readlinkSync(consumerPath);

      const resolvedTarget = path.isAbsolute(linkTarget)
        ? linkTarget
        : `${realpathSync.native(path.dirname(consumerPath))}${path.sep}${linkTarget}`;

      if (
        linkTarget.includes(referencePathPrefix) ||
        pathPointsIntoReference(resolvedTarget, obsoleteReferenceRoot)
      ) {
        return [consumerPath];
      }

      entry = statSync(consumerPath, { throwIfNoEntry: false });

      if (!entry) {
        return [];
      }
    }

    const physicalPath = realpathSync.native(consumerPath);

    if (!containsPath(repoRoot, physicalPath) || isExcluded(physicalPath)) {
      return [];
    }

    if (entry.isDirectory()) {
      if (ancestors.has(physicalPath)) {
        return [];
      }

      ancestors.add(physicalPath);

      const consumers = readdirSync(consumerPath)
        .filter((name) => name !== ".git" && name !== "node_modules")
        .flatMap((name) => visit(path.join(consumerPath, name)));

      ancestors.delete(physicalPath);

      return consumers;
    }

    if (entry.isFile()) {
      const content = readFileSync(consumerPath, "utf-8");

      const consumesReference =
        content.includes(referencePathPrefix) ||
        contentContainsRelativePathInto(content, consumerPath, obsoleteReferenceRoot);

      return consumesReference ? [consumerPath] : [];
    }

    return [];
  }

  return visit(root);
}

function contentContainsRelativePathInto(
  content: string,
  consumerPath: string,
  targetRoot: string
) {
  const relativePathPattern = /(?:\.\.?\/)+[^\s)"'`>]+/gu;

  const destinations = [
    ...content.matchAll(relativePathPattern).map((match) => match[0] ?? ""),
    ...(consumerPath.endsWith(".md")
      ? relativeMarkdownLinks(content).map((link) => link.destination)
      : [])
  ];

  const consumerDirectory = realpathSync.native(path.dirname(consumerPath));

  return destinations.some((destination) => {
    const filePath = destination.replace(/[?#].*$/u, "");

    return (
      pathPointsIntoReference(`${consumerDirectory}${path.sep}${destination}`, targetRoot) ||
      (filePath !== destination &&
        pathPointsIntoReference(`${consumerDirectory}${path.sep}${filePath}`, targetRoot))
    );
  });
}

function pathPointsIntoReference(candidate: string, referenceRoot: string) {
  if (containsPath(referenceRoot, path.resolve(candidate))) {
    return true;
  }

  return (
    existsSync(candidate) &&
    [...resolveSkillPath(candidate).paths].some((entry) => containsPath(referenceRoot, entry))
  );
}

export function importedGuidancePath(
  repoRoot: string,
  guidance: Pick<SkillImportRecipeSkill, "kind" | "slug">
) {
  const root = guidance.kind === "reference" ? IMPORTED_REFERENCES_ROOT : IMPORTED_SKILLS_ROOT;
  const managedRoot = path.resolve(repoRoot, root);
  const guidancePath = path.resolve(managedRoot, guidance.slug);

  if (
    guidance.slug.trim().length === 0 ||
    /[/\\\0]/u.test(guidance.slug) ||
    path.basename(guidance.slug) !== guidance.slug ||
    guidancePath === managedRoot ||
    !containsPath(managedRoot, guidancePath)
  ) {
    throw new MonkeError(`Imported ${guidance.kind} slug ${guidance.slug} escapes ${root}`);
  }

  return guidancePath;
}
