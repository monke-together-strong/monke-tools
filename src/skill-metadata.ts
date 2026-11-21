import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { isScalar, parseDocument } from "yaml";
import * as z from "zod";

import { MonkeError } from "./errors.ts";
import { unwrapBoundaryResult } from "./validation.ts";

const YAML_DOCUMENT_OPTIONS = {
  merge: false,
  strict: true,
  uniqueKeys: true
} as const;

const SkillFrontmatterSchema = z.looseObject({
  "disable-model-invocation": z.boolean().optional()
});

const CodexSkillMetadataSchema = z.looseObject({
  policy: z
    .looseObject({
      allow_implicit_invocation: z.boolean().optional()
    })
    .optional()
});

/** Apply recorded overrides while preserving the skill body and other metadata. */
export function setSkillMetadata(
  skillPath: string,
  overrides: { description?: string; disableModelInvocation?: boolean }
) {
  if (overrides.description === undefined && overrides.disableModelInvocation === undefined) {
    return;
  }

  const skillEntryPath = path.join(skillPath, "SKILL.md");

  if (!existsSync(skillEntryPath) || !lstatSync(skillEntryPath).isFile()) {
    throw new MonkeError(`Expected Skill entry document to be a regular file at ${skillEntryPath}`);
  }

  const skillMarkdown = readFileSync(skillEntryPath, "utf-8");

  const frontmatterMatch = /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(
    skillMarkdown
  );

  if (!frontmatterMatch) {
    throw new MonkeError(`Expected leading YAML frontmatter at ${skillEntryPath}`);
  }

  const frontmatterLabel = `Skill frontmatter at ${skillEntryPath}`;

  const frontmatter = parseSkillFrontmatterDocument(
    frontmatterMatch.groups?.frontmatter ?? "",
    frontmatterLabel
  );

  unwrapBoundaryResult(SkillFrontmatterSchema.safeParse(frontmatter.toJS()), frontmatterLabel);

  if (overrides.description !== undefined) {
    const description = frontmatter.get("description", true);

    if (isScalar(description)) {
      description.value = overrides.description;
      // Choose style from the new value while retaining anchors and comments.
      delete description.type;
    } else {
      frontmatter.set("description", frontmatter.createNode(overrides.description));
    }
  }

  if (overrides.disableModelInvocation !== undefined) {
    frontmatter.set("disable-model-invocation", overrides.disableModelInvocation);
  }

  writeFileSync(
    skillEntryPath,
    `---\n${frontmatter.toString()}---\n${skillMarkdown.slice(frontmatterMatch[0].length)}`,
    "utf-8"
  );

  if (overrides.disableModelInvocation === undefined) {
    return;
  }

  const agentsPath = path.join(skillPath, "agents");
  const openaiMetadataPath = path.join(skillPath, "agents", "openai.yaml");
  const legacyOpenaiMetadataPath = path.join(skillPath, "agents", "openai.yml");

  if (existsSync(agentsPath) && !lstatSync(agentsPath).isDirectory()) {
    throw new MonkeError(`Expected Skill agents path to be a regular directory at ${agentsPath}`);
  }

  for (const metadataPath of [openaiMetadataPath, legacyOpenaiMetadataPath]) {
    if (existsSync(metadataPath) && !lstatSync(metadataPath).isFile()) {
      throw new MonkeError(`Expected Codex metadata to be a regular file at ${metadataPath}`);
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

  unwrapBoundaryResult(
    CodexSkillMetadataSchema.safeParse(openaiMetadata.toJS()),
    openaiMetadataLabel
  );
  openaiMetadata.setIn(["policy", "allow_implicit_invocation"], !overrides.disableModelInvocation);
  mkdirSync(agentsPath, { recursive: true });
  writeFileSync(openaiMetadataPath, openaiMetadata.toString(), "utf-8");
}

/**
 * Parse Skill frontmatter strictly, falling back to quoting unquoted single-line scalar values that
 * contain `: ` or end with `:` (common in third-party SKILL.md descriptions).
 */
export function parseSkillFrontmatterDocument(text: string, label: string) {
  const initial = parseDocument(text, YAML_DOCUMENT_OPTIONS);

  if (initial.errors.length === 0) {
    return initial;
  }

  const lines = text.split(/\r?\n/u);
  const repairedLines = new Set<number>();
  let current = initial;

  while (current.errors.length > 0) {
    const candidates = new Map<number, number>();

    for (const error of current.errors) {
      if (error.code !== "BLOCK_AS_IMPLICIT_KEY") {
        continue;
      }

      const position = error.linePos?.[0];

      if (!position) {
        continue;
      }

      const previousCol = candidates.get(position.line);

      if (previousCol === undefined || position.col < previousCol) {
        candidates.set(position.line, position.col);
      }
    }

    let changed = false;

    for (const [lineNumber, column] of candidates) {
      if (repairedLines.has(lineNumber)) {
        continue;
      }

      const lineIndex = lineNumber - 1;
      const line = lines[lineIndex];

      if (line === undefined || column < 1 || column > line.length) {
        continue;
      }

      const valueStart = column - 1;
      const prefix = line.slice(0, valueStart);
      const value = line.slice(valueStart).trimEnd();

      if (!/\S.*:[ \t]+$/u.test(prefix) || !/:(?:\s|$)/u.test(value)) {
        continue;
      }

      lines[lineIndex] = `${prefix}${JSON.stringify(value)}`;
      repairedLines.add(lineNumber);
      changed = true;
    }

    if (!changed) {
      break;
    }

    current = parseDocument(lines.join("\n"), YAML_DOCUMENT_OPTIONS);
  }

  if (current.errors.length > 0) {
    throw new MonkeError(
      `Invalid ${label}:\n${initial.errors.map((error) => error.message).join("\n")}`
    );
  }

  return current;
}

function parseMutableYamlDocument(text: string, label: string) {
  const document = parseDocument(text, YAML_DOCUMENT_OPTIONS);

  if (document.errors.length > 0) {
    throw new MonkeError(
      `Invalid ${label}:\n${document.errors.map((error) => error.message).join("\n")}`
    );
  }

  return document;
}
