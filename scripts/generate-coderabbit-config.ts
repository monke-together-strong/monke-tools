#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Command } from "@commander-js/extra-typings";
import { fromMarkdown } from "mdast-util-from-markdown";
import { visit } from "unist-util-visit";
import { parse, stringify } from "yaml";
import * as z from "zod";

import { configureCliParser, reportCliFailure } from "../src/cli-errors.ts";
import { MonkeError } from "../src/errors.ts";

const SOURCE_ROOT = path.join("skills", "references");
const ROOT_DOCUMENT = path.join(SOURCE_ROOT, "internal", "CODING_STANDARDS.md");
const TEMPLATE_PATH = path.join("config", "coderabbit", "template.yaml");
const MAX_INSTRUCTION_CHARACTERS = 20_000;
export const CODE_RABBIT_SYNC_INPUTS = new Set([
  ".github/workflows/sync-coderabbit.yaml",
  "bun.lock",
  "config/coderabbit/template.yaml",
  "package.json",
  "scripts/generate-coderabbit-config.ts"
]);

const RenderOptionsSchema = z.object({
  repoRoot: z.string(),
  sourceCommit: z.string()
});

const RelevanceOptionsSchema = z.object({
  changedPaths: z.array(z.string()),
  sources: z.array(z.string())
});

const CodeRabbitTemplateSchema = z.looseObject({
  reviews: z
    .looseObject({
      path_instructions: z
        .array(
          z.looseObject({
            instructions: z.string(),
            path: z.string()
          })
        )
        .optional()
    })
    .optional()
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
  const documents = readLinkedDocuments(options.repoRoot);
  const templatePath = path.join(options.repoRoot, TEMPLATE_PATH);
  const template = CodeRabbitTemplateSchema.parse(parse(readFileSync(templatePath, "utf-8")));
  const instructions = [
    "This is the Team coding baseline and applies as a fallback.",
    "Repository AGENTS.md and CODING_STANDARDS.md rules override conflicting baseline rules.",
    ...documents.map((document, index) =>
      index === 0 ? document.contents : `Source: ${document.source}\n\n${document.contents}`
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
    sources: documents.map((document) => document.source),
    yaml: `# Generated from monke-together-strong/monke-tools@${options.sourceCommit}. Do not edit.\n${generated}`
  };
}

function readLinkedDocuments(repoRoot: string) {
  const sourceRoot = realpathSync.native(path.join(repoRoot, SOURCE_ROOT));
  const documents = new Map<string, ReturnType<typeof createSourceDocument>>();

  const readDocument = (relativePath: string) => {
    const candidatePath = path.resolve(repoRoot, relativePath);
    const normalizedSource = toRepoPath(repoRoot, candidatePath);
    if (!existsSync(candidatePath)) {
      throw new Error(`Linked Markdown file does not exist: ${normalizedSource}`);
    }
    const absolutePath = realpathSync.native(candidatePath);
    if (documents.has(absolutePath)) {
      return;
    }
    if (absolutePath !== sourceRoot && !absolutePath.startsWith(`${sourceRoot}${path.sep}`)) {
      throw new Error(`Linked Markdown file is outside ${SOURCE_ROOT}: ${relativePath}`);
    }

    const contents = readFileSync(absolutePath, "utf-8").trimEnd();
    const source = toRepoPath(repoRoot, absolutePath);
    documents.set(absolutePath, createSourceDocument(contents, source));

    const tree = fromMarkdown(contents);
    const definitions = new Map<string, string>();
    visit(tree, "definition", (node) => {
      definitions.set(node.identifier, node.url);
    });
    visit(tree, (node) => {
      const url =
        node.type === "link"
          ? node.url
          : node.type === "linkReference"
            ? definitions.get(node.identifier)
            : undefined;
      if (url && isTraversableMarkdownLink(url)) {
        const linkedPath = url.split(/[?#]/u, 1)[0] ?? url;
        readDocument(path.join(path.dirname(relativePath), decodeURIComponent(linkedPath)));
      }
    });
  };

  readDocument(ROOT_DOCUMENT);
  return [...documents.values()];
}

function createSourceDocument(contents: string, source: string) {
  return { contents, source };
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
