#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Command } from "@commander-js/extra-typings";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString as markdownToString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";
import { parse, stringify } from "yaml";
import {
  array as arraySchema,
  looseObject,
  number as numberSchema,
  object,
  strictObject,
  string as stringSchema
} from "zod";

import { configureCliParser, reportCliFailure } from "../src/cli-errors.ts";
import { MonkeError } from "../src/errors.ts";

const SOURCE_ROOT = path.join("skills", "references");
const ROOT_DOCUMENT = path.join(SOURCE_ROOT, "internal", "CODING_STANDARDS.md");
const SOURCES_PATH = path.join("config", "coderabbit", "sources.yaml");
const TEMPLATE_PATH = path.join("config", "coderabbit", "template.yaml");
const MAX_INSTRUCTION_CHARACTERS = 20_000;
export const CODE_RABBIT_SYNC_INPUTS = new Set([
  ".github/workflows/sync-coderabbit.yaml",
  "bun.lock",
  "config/coderabbit/sources.yaml",
  "config/coderabbit/template.yaml",
  "package.json",
  "scripts/generate-coderabbit-config.ts"
]);

const RenderOptionsSchema = object({
  repoRoot: stringSchema(),
  sourceCommit: stringSchema()
});

const RelevanceOptionsSchema = object({
  changedPaths: arraySchema(stringSchema()),
  sources: arraySchema(stringSchema())
});

const CodeRabbitTemplateSchema = looseObject({
  reviews: looseObject({
    path_instructions: arraySchema(
      looseObject({
        instructions: stringSchema(),
        path: stringSchema()
      })
    ).optional()
  }).optional()
});

const SourceManifestSchema = strictObject({
  excerpts: arraySchema(
    strictObject({
      anchor: stringSchema().min(1),
      heading: stringSchema().min(1),
      source: stringSchema().min(1),
      stopAtHeadingDepth: numberSchema().int().min(1).max(6)
    })
  )
});

export function isCodeRabbitSyncRelevant(rawOptions: unknown) {
  const options = RelevanceOptionsSchema.parse(rawOptions);
  const sources = new Set(options.sources);
  return options.changedPaths.some(
    (changedPath) => CODE_RABBIT_SYNC_INPUTS.has(changedPath) || sources.has(changedPath)
  );
}

export function listChangedPaths(repoRoot: string, before: string, after: string) {
  const beforeCommit = spawnSync("git", ["cat-file", "-e", `${before}^{commit}`], {
    cwd: repoRoot,
    stdio: "ignore"
  });
  const hasBeforeCommit = !/^0+$/u.test(before) && !beforeCommit.error && beforeCommit.status === 0;
  const args = hasBeforeCommit
    ? ["diff", "--name-only", "--no-renames", "-z", before, after, "--"]
    : ["ls-tree", "-r", "-z", "--name-only", after];
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf-8"
  });
  if (result.error) {
    throw new MonkeError(`Could not inspect changed paths: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new MonkeError(
      `Could not inspect changed paths: ${(result.stderr || result.stdout).trim()}`
    );
  }
  return result.stdout.split("\0").filter(Boolean);
}

export function renderCodeRabbitConfig(rawOptions: unknown) {
  const options = RenderOptionsSchema.parse(rawOptions);
  const documents = [
    ...readLinkedDocuments(options.repoRoot),
    ...readConfiguredExcerpts(options.repoRoot)
  ];
  const templatePath = path.join(options.repoRoot, TEMPLATE_PATH);
  const template = CodeRabbitTemplateSchema.parse(parse(readFileSync(templatePath, "utf-8")));
  const instructions = [
    "This is the Team coding baseline and applies as a fallback.",
    "Repository AGENTS.md and CODING_STANDARDS.md rules override conflicting baseline rules.",
    ...documents.map((document, index) =>
      index === 0 || !document.showSource
        ? document.contents
        : `Source: ${document.source}\n\n${document.contents}`
    )
  ].join("\n\n");
  if (instructions.length > MAX_INSTRUCTION_CHARACTERS) {
    throw new MonkeError(
      "Generated reviews.path_instructions instructions exceed CodeRabbit's 20,000-character limit"
    );
  }

  template.reviews ??= {};
  template.reviews.path_instructions ??= [];
  if (template.reviews.path_instructions.some((instruction) => instruction.path === "**/*")) {
    throw new MonkeError(
      'Template reviews.path_instructions must not contain the generated path "**/*"'
    );
  }
  template.reviews.path_instructions.unshift({
    instructions,
    path: "**/*"
  });

  const generated = stringify(template, { lineWidth: 0 });
  return {
    sources: [...new Set(documents.map((document) => document.source))],
    yaml: `# Generated from monke-together-strong/monke-tools@${options.sourceCommit}. Do not edit.\n${generated}`
  };
}

function readLinkedDocuments(repoRoot: string) {
  const sourceRoot = realpathSync.native(path.join(repoRoot, SOURCE_ROOT));
  const documents = new Map<string, ReturnType<typeof createSourceDocument>>();

  const readDocument = (relativePath: string) => {
    const { absolutePath, contents, source } = readOwnedMarkdown(
      repoRoot,
      sourceRoot,
      relativePath,
      "Linked"
    );
    if (documents.has(absolutePath)) {
      return;
    }

    documents.set(absolutePath, createSourceDocument(contents, source, true));

    const tree = fromMarkdown(contents);
    const definitions = new Map<string, string>();
    visit(tree, "definition", (node) => {
      definitions.set(node.identifier, node.url);
    });
    const readLinkedDocument = (url: string) => {
      if (!isTraversableMarkdownLink(url)) {
        return;
      }
      const linkedPath = url.split(/[?#]/u, 1)[0] ?? url;
      readDocument(path.join(path.dirname(relativePath), decodeURIComponent(linkedPath)));
    };
    visit(tree, (node) => {
      if (node.type === "link") {
        readLinkedDocument(node.url);
        return;
      }
      if (node.type === "linkReference") {
        const url = definitions.get(node.identifier);
        if (url) {
          readLinkedDocument(url);
        }
      }
    });
  };

  readDocument(ROOT_DOCUMENT);
  return [...documents.values()];
}

function readConfiguredExcerpts(repoRoot: string) {
  const sourceRoot = realpathSync.native(path.join(repoRoot, SOURCE_ROOT));
  const manifestPath = path.join(repoRoot, SOURCES_PATH);
  const manifest = SourceManifestSchema.parse(parse(readFileSync(manifestPath, "utf-8")));

  return manifest.excerpts.map((excerpt) => {
    const { contents, source } = readOwnedMarkdown(
      repoRoot,
      sourceRoot,
      excerpt.source,
      "Configured excerpt"
    );
    const tree = fromMarkdown(contents);
    const normalizedAnchor = normalizeSemanticText(excerpt.anchor);
    const matches = tree.children
      .map((node, index) => ({ index, node }))
      .filter(
        ({ node }) =>
          node.type === "paragraph" &&
          normalizeSemanticText(markdownToString(node)).includes(normalizedAnchor)
      );
    if (matches.length !== 1) {
      throw new MonkeError(
        `Configured excerpt anchor must match exactly one paragraph in ${excerpt.source}: ${JSON.stringify(excerpt.anchor)} (matched ${matches.length})`
      );
    }

    const [match] = matches;
    if (!match) {
      throw new MonkeError(`Configured excerpt anchor was not found in ${excerpt.source}`);
    }
    const endIndex = tree.children.findIndex(
      (node, index) =>
        index > match.index && node.type === "heading" && node.depth <= excerpt.stopAtHeadingDepth
    );
    const excerptNodes = tree.children.slice(match.index, endIndex === -1 ? undefined : endIndex);
    const [firstNode] = excerptNodes;
    const lastNode = excerptNodes.at(-1);
    const startOffset = firstNode?.position?.start.offset;
    const endOffset = lastNode?.position?.end.offset;
    if (startOffset === undefined || endOffset === undefined) {
      throw new MonkeError(`Could not locate configured excerpt in ${excerpt.source}`);
    }

    return createSourceDocument(
      `## ${excerpt.heading}\n\n${contents.slice(startOffset, endOffset).trim()}`,
      source,
      false
    );
  });
}

function readOwnedMarkdown(
  repoRoot: string,
  sourceRoot: string,
  relativePath: string,
  description: string
) {
  const candidatePath = path.resolve(repoRoot, relativePath);
  const normalizedSource = toRepoPath(repoRoot, candidatePath);
  if (!existsSync(candidatePath)) {
    throw new MonkeError(`${description} Markdown file does not exist: ${normalizedSource}`);
  }
  const absolutePath = realpathSync.native(candidatePath);
  if (absolutePath !== sourceRoot && !absolutePath.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new MonkeError(`${description} Markdown file is outside ${SOURCE_ROOT}: ${relativePath}`);
  }
  return {
    absolutePath,
    contents: readFileSync(absolutePath, "utf-8").trimEnd(),
    source: toRepoPath(repoRoot, absolutePath)
  };
}

function normalizeSemanticText(value: string) {
  return value.replaceAll(/\s+/gu, " ").trim().toLowerCase();
}

function createSourceDocument(contents: string, source: string, showSource: boolean) {
  return { contents, showSource, source };
}

function toRepoPath(repoRoot: string, absolutePath: string) {
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

function isTraversableMarkdownLink(url: string) {
  if (url.startsWith("#") || url.startsWith("/") || url.startsWith("//")) {
    return false;
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(url)) {
    return false;
  }
  const pathname = url.split(/[?#]/u, 1)[0] ?? "";
  return pathname.toLowerCase().endsWith(".md");
}

export async function runCodeRabbitConfigGenerator(
  argv = process.argv.slice(2),
  writeMessage = (message: string) => {
    process.stdout.write(message);
  }
) {
  const program = new Command()
    .name("generate-coderabbit-config")
    .description("Render and publish-gate the organization CodeRabbit configuration");

  program
    .command("render")
    .requiredOption("--output <path>", "Generated YAML destination")
    .requiredOption("--source-commit <sha>", "monke-tools source commit")
    .option("--repo-root <path>", "monke-tools checkout", process.cwd())
    .action((options) => {
      const rendered = renderCodeRabbitConfig({
        repoRoot: options.repoRoot,
        sourceCommit: options.sourceCommit
      });
      mkdirSync(path.dirname(options.output), { recursive: true });
      writeFileSync(options.output, rendered.yaml, "utf-8");
      writeMessage(`${rendered.sources.join("\n")}\n`);
    });

  program
    .command("relevant")
    .requiredOption("--before <sha>", "commit before the push")
    .requiredOption("--after <sha>", "commit after the push")
    .option("--repo-root <path>", "monke-tools checkout", process.cwd())
    .action((options) => {
      const rendered = renderCodeRabbitConfig({
        repoRoot: options.repoRoot,
        sourceCommit: options.after
      });
      const changedPaths = listChangedPaths(options.repoRoot, options.before, options.after);
      const relevant = isCodeRabbitSyncRelevant({
        changedPaths,
        sources: rendered.sources
      });
      writeMessage(`${String(relevant)}\n`);
    });

  configureCliParser(program);
  await program.parseAsync(argv, { from: "user" });
}

if (import.meta.main) {
  try {
    await runCodeRabbitConfigGenerator();
  } catch (error) {
    reportCliFailure(error);
  }
}
