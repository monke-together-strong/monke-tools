import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { parseDocument } from "yaml";
import * as z from "zod";

import { errorMessage, MonkeError } from "../src/errors.ts";
import { parseBoundaryValue } from "../src/validation.ts";
import type { SkillImportRecipeSkill } from "./import-skills.ts";

export const IMPORTED_SKILLS_ROOT = path.join("skills", "imported");
export const IMPORTED_REFERENCES_ROOT = path.join("skills", "references", "imported");
const CODEX_SKILLS_ROOT = path.join("skills", "codex");
const INTERNAL_SKILLS_ROOT = path.join("skills", "internal");
const INTERNAL_REFERENCES_ROOT = path.join("skills", "references", "internal");
const SkillInvocationFrontmatterSchema = z.looseObject({
  "disable-model-invocation": z.boolean().optional()
});
const CodexSkillMetadataSchema = z.looseObject({
  policy: z
    .looseObject({
      allow_implicit_invocation: z.boolean().optional()
    })
    .optional()
});

/** Materializes staged upstream guidance using its recorded local Import kind. */
export function copyStagedGuidanceToManagedRoots(
  options: {
    commitState?: () => void;
    guidance: readonly SkillImportRecipeSkill[];
    obsoleteGuidance?: readonly SkillImportRecipeSkill[];
    repoRoot: string;
    stagingDirectory: string;
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
  let retainRecovery = false;

  try {
    for (const item of options.guidance) {
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
        transformPreparedSkillInvocationPolicy(preparedPath, item.disableModelInvocation);
      }
    }

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
      mkdirSync(path.dirname(targetPath), { recursive: true });
      cpSync(path.join(preparedRoot, item.kind, item.slug), targetPath, {
        recursive: true,
        verbatimSymlinks: true
      });
    }
    options.commitState?.();
  } catch (error) {
    const failures: string[] = [];
    for (const [targetPath, backupPath] of affectedPaths) {
      try {
        rmSync(targetPath, { force: true, recursive: true });
        if (backupPath !== null) {
          mkdirSync(path.dirname(targetPath), { recursive: true });
          move(backupPath, targetPath);
        }
      } catch (recoveryError) {
        failures.push(`${targetPath}: ${errorMessage(recoveryError)}`);
      }
    }
    if (failures.length > 0) {
      retainRecovery = true;
      throw new MonkeError(
        `${errorMessage(error)}\nGuidance restoration failed:\n${failures.join("\n")}\nRecovery copies retained at ${backupRoot}`,
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

function transformPreparedSkillInvocationPolicy(
  skillPath: string,
  disableModelInvocation: boolean
) {
  const skillEntryPath = path.join(skillPath, "SKILL.md");
  if (!existsSync(skillEntryPath) || !lstatSync(skillEntryPath).isFile()) {
    throw new MonkeError(
      `Expected staged Skill entry document to be a regular file at ${skillEntryPath}`
    );
  }
  const skillMarkdown = readFileSync(skillEntryPath, "utf-8");
  const frontmatterMatch = /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(
    skillMarkdown
  );
  if (!frontmatterMatch) {
    throw new MonkeError(`Expected leading YAML frontmatter at ${skillEntryPath}`);
  }

  const frontmatterLabel = `Skill frontmatter at ${skillEntryPath}`;
  const frontmatter = parseMutableYamlDocument(
    frontmatterMatch.groups?.frontmatter ?? "",
    frontmatterLabel
  );
  parseBoundaryValue(SkillInvocationFrontmatterSchema, frontmatter.toJS(), frontmatterLabel);
  frontmatter.set("disable-model-invocation", disableModelInvocation);
  writeFileSync(
    skillEntryPath,
    `---\n${frontmatter.toString()}---\n${skillMarkdown.slice(frontmatterMatch[0].length)}`,
    "utf-8"
  );

  const agentsPath = path.join(skillPath, "agents");
  const openaiMetadataPath = path.join(skillPath, "agents", "openai.yaml");
  const legacyOpenaiMetadataPath = path.join(skillPath, "agents", "openai.yml");
  if (existsSync(agentsPath) && !lstatSync(agentsPath).isDirectory()) {
    throw new MonkeError(
      `Expected staged Skill agents path to be a regular directory at ${agentsPath}`
    );
  }
  for (const metadataPath of [openaiMetadataPath, legacyOpenaiMetadataPath]) {
    if (existsSync(metadataPath) && !lstatSync(metadataPath).isFile()) {
      throw new MonkeError(
        `Expected staged Codex metadata to be a regular file at ${metadataPath}`
      );
    }
  }
  if (existsSync(legacyOpenaiMetadataPath)) {
    if (existsSync(openaiMetadataPath)) {
      unlinkSync(legacyOpenaiMetadataPath);
    } else {
      renameSync(legacyOpenaiMetadataPath, openaiMetadataPath);
    }
  }
  const openaiMetadataLabel = `Codex metadata at ${openaiMetadataPath}`;
  const openaiMetadata = parseMutableYamlDocument(
    existsSync(openaiMetadataPath)
      ? readFileSync(openaiMetadataPath, "utf-8")
      : "policy:\n  allow_implicit_invocation: false\n",
    openaiMetadataLabel
  );
  parseBoundaryValue(CodexSkillMetadataSchema, openaiMetadata.toJS(), openaiMetadataLabel);
  openaiMetadata.setIn(["policy", "allow_implicit_invocation"], !disableModelInvocation);
  mkdirSync(agentsPath, { recursive: true });
  writeFileSync(openaiMetadataPath, openaiMetadata.toString(), "utf-8");
}

function parseMutableYamlDocument(text: string, label: string) {
  const document = parseDocument(text, {
    merge: false,
    strict: true,
    uniqueKeys: true
  });
  if (document.errors.length > 0) {
    throw new MonkeError(
      `Invalid ${label}:\n${document.errors.map((error) => error.message).join("\n")}`
    );
  }
  return document;
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
  if (!existsSync(root) || isPathWithin(obsoleteReferenceRoot, root)) {
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
        isPathWithin(obsoleteReferenceRoot, resolvedTarget)
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
    isPathWithin(targetRoot, path.resolve(consumerDirectory, match[0] ?? ""))
  );
}

function isPathWithin(parent: string, candidate: string) {
  const relativePath = path.relative(parent, candidate);
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== ".." &&
      !path.isAbsolute(relativePath))
  );
}

function importedGuidancePath(
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
    !isPathWithin(managedRoot, guidancePath)
  ) {
    throw new MonkeError(`Imported ${guidance.kind} slug ${guidance.slug} escapes ${root}`);
  }
  return guidancePath;
}
