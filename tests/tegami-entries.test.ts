import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";
import * as z from "zod";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

const PackageManifestSchema = z.object({
  name: z.string(),
  private: z.boolean().optional(),
  version: z.string().optional()
});

/** Tegami's npm provider publishes versioned, non-private workspace packages. */
function tegamiPackages() {
  const root: unknown = JSON.parse(
    readFileSync(path.join(repositoryRoot, "package.json"), "utf-8")
  );

  const { workspaces } = z.object({ workspaces: z.array(z.string()) }).parse(root);
  const manifests = new Set(["package.json"]);

  for (const workspace of workspaces) {
    for (const manifest of new Bun.Glob(`${workspace}/package.json`).scanSync(repositoryRoot)) {
      manifests.add(manifest);
    }
  }

  return new Set(
    [...manifests]
      .map((manifest) =>
        PackageManifestSchema.parse(
          JSON.parse(readFileSync(path.join(repositoryRoot, manifest), "utf-8"))
        )
      )
      .filter((manifest) => manifest.version !== undefined && manifest.private !== true)
      .map((manifest) => manifest.name)
  );
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

  it("has at least one publishable workspace package", () => {
    expect(published.size).toBeGreaterThan(0);
  });

  it.each(entries)("names only packages Tegami publishes in %s", (entry) => {
    const text = readFileSync(path.join(repositoryRoot, ".tegami", entry), "utf-8");
    const frontmatter = /^---\n(?<yaml>[\s\S]*?)\n---(?:\n|$)/u.exec(text)?.groups?.yaml;
    expect(frontmatter, "missing frontmatter").toBeDefined();
    const { packages } = FrontmatterSchema.parse(parse(frontmatter ?? ""));

    for (const name of Object.keys(packages)) {
      expect(published, `${entry} names ${name}, which Tegami does not publish`).toContain(name);
    }
  });
});
