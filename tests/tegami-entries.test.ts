import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import * as z from "zod";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

/** The packages Tegami publishes, read from the same config the release workflow runs. */
function tegamiPackages() {
  const source = readFileSync(path.join(repositoryRoot, "scripts/tegami.mts"), "utf-8");
  const block = /packages:\s*\{(?<body>[\s\S]*?)\n {2}\}/u.exec(source)?.groups?.body ?? "";
  return new Set([...block.matchAll(/"(?<name>[^"]+)":/gu)].map((match) => match.groups?.name));
}

const FrontmatterSchema = z.object({
  packages: z
    .record(z.string(), z.unknown())
    .refine((packages) => Object.keys(packages).length > 0, "an entry must name a package")
});

describe("Tegami release entries", () => {
  const published = tegamiPackages();
  const entries = readdirSync(path.join(repositoryRoot, ".tegami")).filter((name) =>
    name.endsWith(".md")
  );

  test("the release config names at least one package", () => {
    expect(published.size).toBeGreaterThan(0);
  });

  test.each(entries)("%s names only packages Tegami publishes", (entry) => {
    const text = readFileSync(path.join(repositoryRoot, ".tegami", entry), "utf-8");
    const frontmatter = /^---\n(?<yaml>[\s\S]*?)\n---(?:\n|$)/u.exec(text)?.groups?.yaml;
    expect(frontmatter, "missing frontmatter").toBeDefined();
    const { packages } = FrontmatterSchema.parse(parse(frontmatter ?? ""));
    for (const name of Object.keys(packages)) {
      expect(published, `${entry} names ${name}, which Tegami does not publish`).toContain(name);
    }
  });
});
