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

import { parseDocument } from "yaml";
import * as z from "zod";

import { MonkeError } from "./errors.ts";
import { unwrapBoundaryResult } from "./validation.ts";

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

/** Apply an invocation override while preserving the skill body and other metadata. */
export function setSkillModelInvocation(skillPath: string, disableModelInvocation: boolean) {
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
  unwrapBoundaryResult(
    SkillInvocationFrontmatterSchema.safeParse(frontmatter.toJS()),
    frontmatterLabel
  );
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
  unwrapBoundaryResult(
    CodexSkillMetadataSchema.safeParse(openaiMetadata.toJS()),
    openaiMetadataLabel
  );
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
