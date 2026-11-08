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
    /** Source roots mapped to their locations in the proposed collection. */
    consumerRoots?: ReadonlyMap<string, string>;
    defaultDisableModelInvocation?: boolean;
    guidance: readonly SkillImportRecipeSkill[];
    ignoredConsumerRoots?: readonly string[];
    linkedSkills?: ReadonlyMap<string, string>;
    obsoleteGuidance?: readonly Pick<SkillImportRecipeSkill, "kind" | "slug">[];
    repoRoot: string;
    /** Original collection for aliases when validating a copied proposal. */
    retainedRoot?: string;
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

  const obsoletePaths = new Set(
    obsoleteGuidance.map((item) => importedGuidancePath(options.repoRoot, item))
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
      (destination) => !obsoletePaths.has(destination.targetPath)
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
    assertObsoleteReferencesAreUnconsumed(
      options.repoRoot,
      obsoleteGuidance,
      [
        backupRoot,
        ...(options.ignoredConsumerRoots ?? []),
        ...(samePath(options.stagingDirectory, options.repoRoot) ? [] : [options.stagingDirectory]),
        ...obsoleteGuidance.map((item) => importedGuidancePath(options.repoRoot, item))
      ],
      options.consumerRoots,
      options.retainedRoot
    );

    const published = guidance.map((item) =>
      lstatSync(importedGuidancePath(options.repoRoot, item))
    );

    const retired = destinations.filter(({ targetPath }) => {
      if (!obsoletePaths.has(targetPath)) {
        return false;
      }

      const entry = lstatSync(targetPath, { throwIfNoEntry: false });

      // A case-only rename can make the obsolete spelling resolve to a published destination.
      return (
        !entry ||
        !published.some((current) => current.dev === entry.dev && current.ino === entry.ino)
      );
    });

    // Retain conversion sources until their replacements exist, including after an interruption.
    for (const { item, targetPath } of retired) {
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

export function transformPreparedReference(referencePath: string) {
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
  redirectEntryLinks(referencePath, skillEntryPath, referenceEntryPath);
}

/** Supporting documents that link to the renamed entry follow it to MAIN.md. */
function redirectEntryLinks(referencePath: string, oldEntry: string, newEntry: string) {
  for (const file of new Bun.Glob("**/*.md").scanSync({ cwd: referencePath, dot: true })) {
    const filePath = path.join(referencePath, file);

    if (!lstatSync(filePath).isFile()) {
      continue;
    }

    const source = readFileSync(filePath, "utf-8");
    let rewritten = source;

    for (const link of relativeMarkdownLinks(source).toReversed()) {
      if (path.resolve(path.dirname(filePath), link.destination) !== oldEntry) {
        continue;
      }

      // The destination follows `](` in an inline link or `]:` in a definition.
      const escaped = link.raw.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);

      const match = new RegExp(String.raw`\](?:\(|:)\s*<?${escaped}`, "u").exec(
        rewritten.slice(link.start, link.end)
      );

      if (!match) {
        throw new MonkeError(
          `Cannot redirect ${file}:${String(link.line)} to MAIN.md; write the link as plain ${link.raw}`
        );
      }

      const start = link.start + match.index + match[0].length - link.raw.length;
      const fragment = link.raw.slice((link.raw.split("#")[0] ?? "").length);
      const target = path.relative(path.dirname(filePath), newEntry).split(path.sep).join("/");
      rewritten = `${rewritten.slice(0, start)}${target}${fragment}${rewritten.slice(start + link.raw.length)}`;
    }

    if (rewritten !== source) {
      writeFileSync(filePath, rewritten, "utf-8");
    }
  }
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

/** Explicit consumer roots replace discovery and allow traversal within each resolved source. */
export function assertObsoleteReferencesAreUnconsumed(
  repoRoot: string,
  obsoleteGuidance: readonly Pick<SkillImportRecipeSkill, "kind" | "slug">[],
  ignoredConsumerRoots: readonly string[] = [],
  consumerRoots?: ReadonlyMap<string, string>,
  retainedRoot = repoRoot
) {
  const physicalRepoRoot = realpathSync.native(repoRoot);

  const physicalPath = (root: string) =>
    containsPath(repoRoot, root)
      ? path.resolve(physicalRepoRoot, path.relative(repoRoot, root))
      : path.resolve(root);

  for (const guidance of obsoleteGuidance) {
    if (guidance.kind !== "reference") {
      continue;
    }

    const obsoleteReferenceRoots = [
      importedGuidancePath(physicalRepoRoot, guidance),
      importedGuidancePath(realpathSync.native(retainedRoot), guidance)
    ];

    const referencePathPrefix = `${path.posix.join("references", "imported", guidance.slug)}/`;

    const ignored = [
      path.join(physicalRepoRoot, "monke.yml"),
      path.join(physicalRepoRoot, "skills/.monke-restored.json"),
      ...ignoredConsumerRoots.map(physicalPath)
    ];

    const roots = consumerRoots
      ? [...consumerRoots].map(([source, projected]) => ({
          projected: physicalPath(projected),
          source: physicalPath(source)
        }))
      : (existsSync(path.join(physicalRepoRoot, "SKILL.md")) ? ["."] : SKILL_SOURCE_CANDIDATES).map(
          (root) => ({ projected: undefined, source: path.join(physicalRepoRoot, root) })
        );

    const consumers = [
      ...new Set(
        roots
          .flatMap(({ projected, source }) =>
            listReferenceConsumers(
              physicalRepoRoot,
              source,
              obsoleteReferenceRoots,
              referencePathPrefix,
              ignored,
              projected
            )
          )
          .map((entryPath) => path.relative(physicalRepoRoot, entryPath))
      )
    ].toSorted();

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
  obsoleteReferenceRoots: readonly string[],
  referencePathPrefix: string,
  ignoredConsumerRoots: readonly string[],
  projectedRoot?: string
): string[] {
  const ancestors = new Set<string>();

  const physicalConsumerRoot =
    projectedRoot && existsSync(root) ? realpathSync.native(root) : undefined;

  const isExcluded = (entryPath: string) =>
    obsoleteReferenceRoots.some((reference) => containsPath(reference, entryPath)) ||
    ignoredConsumerRoots.some((ignored) => containsPath(ignored, entryPath));

  function visit(consumerPath: string): string[] {
    if (isExcluded(consumerPath)) {
      return [];
    }

    let entry = lstatSync(consumerPath, { throwIfNoEntry: false });

    if (!entry) {
      return [];
    }

    const projectedPath =
      projectedRoot && path.join(projectedRoot, path.relative(root, consumerPath));

    if (entry.isSymbolicLink()) {
      const linkTarget = readlinkSync(consumerPath);

      if (
        linkTarget.includes(referencePathPrefix) ||
        consumerPathPointsIntoReference(
          linkTarget,
          consumerPath,
          obsoleteReferenceRoots,
          projectedPath
        )
      ) {
        return [projectedPath ?? consumerPath];
      }

      entry = statSync(consumerPath, { throwIfNoEntry: false });

      if (!entry) {
        return [];
      }
    }

    const physicalPath = realpathSync.native(consumerPath);

    if (
      (!containsPath(repoRoot, physicalPath) &&
        !(physicalConsumerRoot && containsPath(physicalConsumerRoot, physicalPath))) ||
      isExcluded(physicalPath)
    ) {
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
        contentContainsRelativePathInto(
          content,
          consumerPath,
          obsoleteReferenceRoots,
          projectedPath
        );

      return consumesReference ? [projectedPath ?? consumerPath] : [];
    }

    return [];
  }

  return visit(root);
}

function contentContainsRelativePathInto(
  content: string,
  consumerPath: string,
  targetRoots: readonly string[],
  projectedPath?: string
) {
  const relativePathPattern = /(?:\.\.?\/)+[^\s)"'`>]+/gu;

  const destinations = [
    ...content.matchAll(relativePathPattern).map((match) => match[0] ?? ""),
    ...(consumerPath.endsWith(".md")
      ? relativeMarkdownLinks(content).map((link) => link.destination)
      : [])
  ];

  return destinations.some((destination) => {
    const filePath = destination.replace(/[?#].*$/u, "");

    return (
      consumerPathPointsIntoReference(destination, consumerPath, targetRoots, projectedPath) ||
      (filePath !== destination &&
        consumerPathPointsIntoReference(filePath, consumerPath, targetRoots, projectedPath))
    );
  });
}

function consumerPathPointsIntoReference(
  destination: string,
  consumerPath: string,
  referenceRoots: readonly string[],
  projectedPath?: string
) {
  // Resolve projected links lexically so stale owned aliases cannot affect a candidate's check.
  if (
    projectedPath &&
    referenceRoots.some((root) =>
      containsPath(root, path.resolve(path.dirname(projectedPath), destination))
    )
  ) {
    return true;
  }

  const candidate = path.isAbsolute(destination)
    ? destination
    : `${realpathSync.native(path.dirname(consumerPath))}${path.sep}${destination}`;

  if (referenceRoots.some((root) => containsPath(root, path.resolve(candidate)))) {
    return true;
  }

  return (
    existsSync(candidate) &&
    [...resolveSkillPath(candidate).paths].some((entry) =>
      referenceRoots.some((root) => containsPath(root, entry))
    )
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
