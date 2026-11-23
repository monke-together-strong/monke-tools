#!/usr/bin/env bun

import { readFileSync } from "node:fs";

const USAGE = `Usage: bun doc-blocks.ts <base> [<head>] [--min <words>]

Lists the doc blocks that the diff from <base> adds or changes, with word counts, largest first:
doc and block comments, runs of line comments, GraphQL descriptions, Python docstrings, and
Markdown paragraphs, list items, and tables. Without <head>, it compares the working tree,
including untracked files. --min hides blocks shorter than <words>.`;

interface Block {
  end: number;
  label: string;
  path: string;
  start: number;
  words: number;
}

type Span = Omit<Block, "path" | "words">;

const CODE = new Set([
  ".c",
  ".cc",
  ".cjs",
  ".cpp",
  ".cs",
  ".cts",
  ".dart",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".mjs",
  ".mts",
  ".php",
  ".rs",
  ".scala",
  ".swift",
  ".ts",
  ".tsx"
]);

const HASH = new Set([".bash", ".py", ".rb", ".sh", ".toml", ".yaml", ".yml", ".zsh"]);
const GRAPHQL = new Set([".gql", ".graphql", ".graphqls"]);
const MARKDOWN = new Set([".markdown", ".md", ".mdx"]);

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }

  const root = git(["rev-parse", "--show-toplevel"]).trim();

  const range = args.head
    ? [`${args.base}...${args.head}`]
    : [git(["-C", root, "merge-base", args.base, "HEAD"]).trim()];

  const touched = touchedLines(root, range);

  if (!args.head) {
    const untracked = git(["-C", root, "ls-files", "--others", "--exclude-standard", "-z"]);

    for (const path of untracked.split("\0").filter(Boolean)) {
      touched.set(path, "all");
    }
  }

  const blocks: Block[] = [];

  for (const [path, lines] of touched) {
    const extension = path.slice(path.lastIndexOf(".")).toLowerCase();

    const text = args.head
      ? git(["-C", root, "show", `${args.head}:${path}`])
      : readFileSync(`${root}/${path}`, "utf-8");

    for (const span of extract(extension, text.split("\n"))) {
      if (lines === "all" || overlaps(span, lines)) {
        blocks.push({ ...span, path, words: countWords(text.split("\n"), span) });
      }
    }
  }

  const shown = blocks.filter((block) => block.words >= args.min);
  shown.sort((a, b) => b.words - a.words);

  for (const block of shown) {
    const lines = block.end > block.start ? `${block.start}-${block.end}` : `${block.start}`;
    process.stdout.write(
      `${String(block.words).padStart(5)}  ${block.path}:${lines}  ${block.label}\n`
    );
  }

  const total = shown.reduce((sum, block) => sum + block.words, 0);
  process.stdout.write(`${shown.length} blocks, ${total} words\n`);
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let min = 1;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--min") {
      min = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      return undefined;
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  const [base, head] = positional;

  if (base === undefined || positional.length > 2 || !Number.isFinite(min)) {
    return undefined;
  }

  return { base, head, min };
}

function git(args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { stderr: "pipe", stdout: "pipe" });

  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }

  return result.stdout.toString();
}

/** Maps each added or modified path to the 1-based lines its new version changed. */
function touchedLines(root: string, range: string[]) {
  const touched = new Map<string, Set<number> | "all">();

  const diff = git([
    "-C",
    root,
    "diff",
    "-U0",
    "--no-color",
    "--no-ext-diff",
    "--diff-filter=AMR",
    "--dst-prefix=b/",
    ...range
  ]);

  let lines: Set<number> | undefined;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      lines = new Set();
      touched.set(line.slice("+++ b/".length), lines);
      continue;
    }

    const hunk = /^@@ -\S+ \+(?<start>\d+)(?:,(?<count>\d+))? @@/u.exec(line);

    if (hunk?.groups && lines) {
      const start = Number(hunk.groups.start);
      const count = hunk.groups.count === undefined ? 1 : Number(hunk.groups.count);

      // A pure deletion changes the text on both sides of the gap after `start`.
      const last = count === 0 ? start + 1 : start + count - 1;

      for (let number = start; number <= last; number += 1) {
        lines.add(number);
      }
    }
  }

  return touched;
}

function overlaps(span: Span, lines: Set<number>) {
  for (let number = span.start; number <= span.end; number += 1) {
    if (lines.has(number)) {
      return true;
    }
  }

  return false;
}

function countWords(lines: string[], span: Span) {
  return lines
    .slice(span.start - 1, span.end)
    .map((line) => line.replace(/^\s*\d+[.)]\s+/u, ""))
    .join(" ")
    .split(/\s+/u)
    .filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

function extract(extension: string, lines: string[]): Span[] {
  if (CODE.has(extension)) {
    return comments(lines, "//", true);
  }

  if (GRAPHQL.has(extension)) {
    return [...comments(lines, "#", false), ...descriptions(lines, true)];
  }

  if (HASH.has(extension)) {
    const docstrings = extension === ".py" ? descriptions(lines, false) : [];

    return [...comments(lines, "#", false), ...docstrings];
  }

  return MARKDOWN.has(extension) ? markdown(lines) : [];
}

/** Block comments and runs of whole-line comments, labelled with the code that follows them. */
function comments(lines: string[], marker: string, blockComments: boolean) {
  const spans: Span[] = [];
  let index = 0;

  while (index < lines.length) {
    const trimmed = (lines[index] ?? "").trim();
    let end: number | undefined;

    if (blockComments && trimmed.startsWith("/*")) {
      end = closingLine(lines, index, "/*", "*/");
    } else if (trimmed.startsWith(marker) && !trimmed.startsWith("#!")) {
      end = index;

      while ((lines[end + 1] ?? "").trim().startsWith(marker)) {
        end += 1;
      }
    }

    if (end === undefined) {
      index += 1;
      continue;
    }

    spans.push({ end: end + 1, label: nextLine(lines, end), start: index + 1 });
    index = end + 1;
  }

  return spans;
}

/** GraphQL descriptions or Python docstrings, labelled with the line that follows them. */
function descriptions(lines: string[], singleQuoted: boolean) {
  const spans: Span[] = [];
  let index = 0;

  while (index < lines.length) {
    const trimmed = (lines[index] ?? "").trim();
    const quote = ['"""', "'''"].find((candidate) => trimmed.startsWith(candidate));
    let end: number | undefined;

    if (quote) {
      end = closingLine(lines, index, quote, quote);
    } else if (singleQuoted && /^"(?:[^"\\]|\\.)*"$/u.test(trimmed)) {
      end = index;
    }

    if (end === undefined) {
      index += 1;
      continue;
    }

    spans.push({ end: end + 1, label: nextLine(lines, end), start: index + 1 });
    index = end + 1;
  }

  return spans;
}

/** The 0-based line that closes a delimited block opened on `start`. */
function closingLine(lines: string[], start: number, open: string, close: string) {
  const first = lines[start] ?? "";

  if (first.includes(close, first.indexOf(open) + open.length)) {
    return start;
  }

  for (let index = start + 1; index < lines.length; index += 1) {
    if ((lines[index] ?? "").includes(close)) {
      return index;
    }
  }

  return lines.length - 1;
}

function nextLine(lines: string[], after: number) {
  const next = lines.slice(after + 1).find((line) => line.trim() !== "");

  return (next ?? "").trim().slice(0, 70);
}

/** Paragraphs, list items, and tables outside code fences and front matter. */
function markdown(lines: string[]) {
  const spans: Span[] = [];
  let current: { end: number; start: number; table: boolean } | undefined;
  let fence: string | undefined;

  const flush = () => {
    if (current) {
      const text = (lines[current.start] ?? "").trim().replace(/^(?:[-*+]|\d+[.)]|>)\s+/u, "");
      spans.push({ end: current.end + 1, label: text.slice(0, 70), start: current.start + 1 });
    }

    current = undefined;
  };

  let index = 0;

  if ((lines[0] ?? "").trim() === "---") {
    const close = lines.findIndex((line, number) => number > 0 && line.trim() === "---");
    index = close + 1;
  }

  for (; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? "").trim();

    if (fence) {
      if (trimmed.startsWith(fence)) {
        fence = undefined;
      }

      continue;
    }

    const opening = /^(?<fence>`{3,}|~{3,})/u.exec(trimmed);

    if (opening) {
      flush();
      fence = opening.groups?.fence;
      continue;
    }

    if (
      trimmed === "" ||
      /^#{1,6}\s/u.test(trimmed) ||
      /^(?<rule>[-*_])\k<rule>{2,}$/u.test(trimmed) ||
      trimmed.startsWith("<!--")
    ) {
      flush();
      continue;
    }

    const table = trimmed.startsWith("|");

    if (current && (/^(?:[-*+]|\d+[.)])\s+/u.test(trimmed) || table !== current.table)) {
      flush();
    }

    if (current) {
      current.end = index;
    } else {
      current = { end: index, start: index, table };
    }
  }

  flush();

  return spans;
}

main();
