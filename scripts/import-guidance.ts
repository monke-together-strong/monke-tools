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
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { errorMessage, MonkeError, ThrownValueSchema } from "../src/errors.ts";
import { containsPath } from "../src/path-identity.ts";
import { setSkillModelInvocation } from "../src/skill-invocation.ts";
import type { SkillImportRecipeSkill } from "./skill-import-recipes.ts";

export const IMPORTED_SKILLS_ROOT = path.join("skills", "imported");
export const IMPORTED_REFERENCES_ROOT = path.join("skills", "references", "imported");
const CODEX_SKILLS_ROOT = path.join("skills", "codex");
const INTERNAL_SKILLS_ROOT = path.join("skills", "internal");
const INTERNAL_REFERENCES_ROOT = path.join("skills", "references", "internal");
/** Materializes staged upstream guidance using its recorded local Import kind. */
export function copyStagedGuidanceToManagedRoots(
  options: {
    commitState?: () => void;
    defaultDisableModelInvocation?: boolean;
    guidance: readonly SkillImportRecipeSkill[];
    linkedSkills?: ReadonlyMap<string, string>;
    obsoleteGuidance?: readonly SkillImportRecipeSkill[];
    repoRoot: string;
    stagingDirectory: string;
    validatePrepared?: (preparedRoot: string) => void;
  },
  move: (source: string, destination: string) => void = renameSync
) {
  // Validate every destination before copying staged content or moving any originals.
  const destinations = [...options.guidance, ...(options.obsoleteGuidance ?? [])].map((item) => ({
    item,
    targetPath: importedGuidancePath(options.repoRoot, item)
  }));
  const stagedSkillsRoot = path.join(options.stagingDirectory, ".agents", "skills");
  const backupRoot = mkdtempSync(path.join(options.repoRoot, ".monke-guidance-backup-"));
  const preparedRoot = path.join(backupRoot, "prepared");
  const affectedPaths = new Map<string, string | null>();
  const invocationCopies = new Map<string, string | null>();
  const newAgentsDirectories = new Set<string>();
  let retainRecovery = false;

  try {
    prepareStagedGuidance(
      options.guidance.map((item) => ({
        ...item,
        disableModelInvocation: item.disableModelInvocation ?? options.defaultDisableModelInvocation
      })),
      stagedSkillsRoot,
      preparedRoot
    );

    options.validatePrepared?.(preparedRoot);
    assertObsoleteReferencesAreUnconsumed(options.repoRoot, options.obsoleteGuidance ?? []);
    for (const { item, targetPath } of destinations) {
      if (affectedPaths.has(targetPath)) {
        continue;
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

    for (const item of options.guidance) {
      const targetPath = importedGuidancePath(options.repoRoot, item);
      const linkedSource = options.linkedSkills?.get(item.slug);
      if (
        linkedSource &&
        (item.disableModelInvocation ?? options.defaultDisableModelInvocation) !== undefined
      ) {
        backupLinkedInvocation(linkedSource, backupRoot, invocationCopies, newAgentsDirectories);
      }
      mkdirSync(path.dirname(targetPath), { recursive: true });
      publishPreparedGuidance(
        item,
        targetPath,
        preparedRoot,
        linkedSource,
        options.defaultDisableModelInvocation
      );
    }
    options.commitState?.();
  } catch (error) {
    const failures = restoreLinkedInvocation(invocationCopies, newAgentsDirectories);
    for (const [targetPath, backupPath] of affectedPaths) {
      try {
        rmSync(targetPath, { force: true, recursive: true });
        if (backupPath !== null) {
          mkdirSync(path.dirname(targetPath), { recursive: true });
          move(backupPath, targetPath);
        }
      } catch (recoveryError) {
        failures.push(`${targetPath}: ${errorMessage(ThrownValueSchema.parse(recoveryError))}`);
      }
    }
    if (failures.length > 0) {
      retainRecovery = true;
      throw new MonkeError(
        `${errorMessage(ThrownValueSchema.parse(error))}\nGuidance restoration failed:\n${failures.join("\n")}\nRecovery copies retained at ${backupRoot}`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    if (!retainRecovery) {
      rmSync(backupRoot, { force: true, recursive: true });
    }
  }
}

function restoreLinkedInvocation(
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
    } catch (recoveryError) {
      failures.push(`${metadataPath}: ${errorMessage(ThrownValueSchema.parse(recoveryError))}`);
    }
  }
  for (const directory of newAgentsDirectories) {
    try {
      if (existsSync(directory)) {
        rmdirSync(directory);
      }
    } catch (recoveryError) {
      failures.push(`${directory}: ${errorMessage(ThrownValueSchema.parse(recoveryError))}`);
    }
  }
  return failures;
}

/** Keep publication rollback separate from installer recovery and unrelated Skill assets. */
function backupLinkedInvocation(
  source: string,
  backupRoot: string,
  copies: Map<string, string | null>,
  newAgentsDirectories: Set<string>
) {
  const physicalSource = realpathSync.native(source);
  const metadataPaths = [path.join(physicalSource, "SKILL.md")];
  const agentsPath = path.join(physicalSource, "agents");
  const agents = lstatSync(agentsPath, { throwIfNoEntry: false });
  // The invocation setter rejects directory aliases before changing their contents.
  if (!agents || agents.isDirectory()) {
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
      const copy = path.join(backupRoot, "invocation", String(copies.size));
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
  linkedSource?: string,
  defaultDisableModelInvocation?: boolean
) {
  if (linkedSource) {
    if (item.kind !== "skill") {
      throw new MonkeError("Linked guidance must be a Skill");
    }
    const disable = item.disableModelInvocation ?? defaultDisableModelInvocation;
    if (disable !== undefined) {
      setSkillModelInvocation(linkedSource, disable);
    }
    symlinkSync(linkedSource, targetPath, "dir");
  } else {
    cpSync(path.join(preparedRoot, item.kind, item.slug), targetPath, {
      recursive: true,
      verbatimSymlinks: true
    });
  }
}

function prepareStagedGuidance(
  guidance: readonly SkillImportRecipeSkill[],
  stagedSkillsRoot: string,
  preparedRoot: string
) {
  for (const item of guidance) {
    const sourcePath = path.join(stagedSkillsRoot, item.slug);
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
    } else if (item.disableModelInvocation !== undefined) {
      setSkillModelInvocation(preparedPath, item.disableModelInvocation);
    }
  }
}

function transformPreparedReference(referencePath: string) {
  const skillEntryPath = path.join(referencePath, "SKILL.md");
  const referenceEntryPath = path.join(referencePath, "MAIN.md");
  if (existsSync(referenceEntryPath)) {
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

function assertObsoleteReferencesAreUnconsumed(
  repoRoot: string,
  obsoleteGuidance: readonly SkillImportRecipeSkill[]
) {
  for (const guidance of obsoleteGuidance) {
    if (guidance.kind !== "reference") {
      continue;
    }

    const obsoleteReferenceRoot = importedGuidancePath(repoRoot, guidance);
    const referencePathPrefix = `${path.posix.join("references", "imported", guidance.slug)}/`;
    const consumers = [
      CODEX_SKILLS_ROOT,
      INTERNAL_SKILLS_ROOT,
      IMPORTED_SKILLS_ROOT,
      INTERNAL_REFERENCES_ROOT,
      IMPORTED_REFERENCES_ROOT
    ]
      .flatMap((root) =>
        listReferenceConsumers(
          path.join(repoRoot, root),
          obsoleteReferenceRoot,
          referencePathPrefix
        )
      )
      .map((entryPath) => path.relative(repoRoot, entryPath))
      .toSorted();

    if (consumers.length > 0) {
      throw new MonkeError(
        `Cannot replace Imported reference ${guidance.slug}; it is used by ${consumers.join(", ")}`
      );
    }
  }
}

function listReferenceConsumers(
  root: string,
  obsoleteReferenceRoot: string,
  referencePathPrefix: string
): string[] {
  if (!existsSync(root) || containsPath(obsoleteReferenceRoot, root)) {
    return [];
  }

  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return listReferenceConsumers(entryPath, obsoleteReferenceRoot, referencePathPrefix);
    }
    if (entry.isFile()) {
      const content = readFileSync(entryPath, "utf-8");
      const consumesReference =
        content.includes(referencePathPrefix) ||
        contentContainsRelativePathInto(content, path.dirname(entryPath), obsoleteReferenceRoot);
      return consumesReference ? [entryPath] : [];
    }
    if (entry.isSymbolicLink()) {
      const linkTarget = readlinkSync(entryPath);
      const resolvedTarget = path.resolve(path.dirname(entryPath), linkTarget);
      return linkTarget.includes(referencePathPrefix) ||
        containsPath(obsoleteReferenceRoot, resolvedTarget)
        ? [entryPath]
        : [];
    }
    return [];
  });
}

function contentContainsRelativePathInto(
  content: string,
  consumerDirectory: string,
  targetRoot: string
) {
  const relativePathPattern = /(?:\.\.?\/)+[^\s)"'`>]+/gu;
  return [...content.matchAll(relativePathPattern)].some((match) =>
    containsPath(targetRoot, path.resolve(consumerDirectory, match[0] ?? ""))
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
