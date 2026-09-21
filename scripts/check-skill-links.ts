#!/usr/bin/env bun

import path from "node:path";

import { fromMarkdown } from "mdast-util-from-markdown";
import { visit } from "unist-util-visit";

import { hashReleaseGuidance } from "../src/release-guidance.ts";

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;

/** Check relative Markdown file links against the release's guidance inventory. */
export async function checkSkillLinks(root: string) {
  const files = Object.keys(hashReleaseGuidance(root));
  const targets = new Set(files);
  for (const file of files) {
    let directory = path.dirname(file);
    while (directory !== ".") {
      targets.add(directory);
      directory = path.dirname(directory);
    }
  }

  const documents = await Promise.all(
    files
      .filter((file) => file.endsWith(".md"))
      .map(async (file) => ({
        file,
        source: await Bun.file(path.join(root, file)).text()
      }))
  );
  const failures: string[] = [];
  for (const { file, source } of documents) {
    const tree = fromMarkdown(source);
    visit(tree, (node) => {
      if (node.type !== "link" && node.type !== "image" && node.type !== "definition") {
        return;
      }
      const raw = node.url;
      // Absolute paths are consumer-machine examples; remote URLs and headings
      // are outside this check's relative-file contract (as in jungle-os).
      if (raw.startsWith("/") || raw.startsWith("#") || URL_SCHEME.test(raw)) {
        return;
      }
      let destination = raw.split("#")[0] ?? "";
      if (!destination) {
        return;
      }
      try {
        destination = decodeURIComponent(destination);
      } catch {
        // A literal percent sign can occur in a local filename.
      }
      const target = path.relative(root, path.resolve(root, path.dirname(file), destination));
      if (!targets.has(target)) {
        failures.push(
          `${file}:${String(node.position?.start.line ?? 1)}: missing packaged link target: ${raw}`
        );
      }
    });
  }
  return failures;
}

if (import.meta.main) {
  const failures = await checkSkillLinks(path.resolve(import.meta.dirname, ".."));
  if (failures.length > 0) {
    process.stderr.write(`${failures.join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("All relative Markdown file links resolve within packaged guidance.\n");
  }
}
