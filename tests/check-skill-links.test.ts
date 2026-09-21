import { mkdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { checkSkillLinks } from "../scripts/check-skill-links.ts";
import { BUNDLED_GUIDANCE_FOLDERS } from "../src/release-guidance.ts";
import { makeTempDir, write } from "./helpers.ts";

function guidanceFixture() {
  const root = makeTempDir("skill-links");
  for (const folder of BUNDLED_GUIDANCE_FOLDERS) {
    mkdirSync(path.join(root, "skills", folder), { recursive: true });
  }
  write(root, "instructions/GLOBAL.md", "Global instructions.\n");
  return root;
}

describe("Packaged skill links", () => {
  test("Rejects checkout-only links even when their document and heading exist", async () => {
    const root = guidanceFixture();
    write(root, "docs/reference/session-lifecycle.md", "# Ownership and execution\n");
    write(
      root,
      "skills/internal/core/SKILL.md",
      "[Recovery](../../../docs/reference/session-lifecycle.md#ownership-and-execution)\n"
    );

    await expect(checkSkillLinks(root)).resolves.toStrictEqual([
      "skills/internal/core/SKILL.md:1: missing packaged link target: ../../../docs/reference/session-lifecycle.md#ownership-and-execution"
    ]);
  });

  test("Checks support documents, imported guidance, images, and reference-style links", async () => {
    const root = guidanceFixture();
    write(root, "skills/internal/core/references/details.md", "![Diagram](missing.png)\n");
    write(
      root,
      "skills/references/internal/shared.md",
      "[Further reading][next]\n\n[next]: absent.md\n"
    );
    write(root, "skills/imported/example/SKILL.md", "[Support](missing.md)\n");

    await expect(checkSkillLinks(root)).resolves.toStrictEqual([
      "skills/imported/example/SKILL.md:1: missing packaged link target: missing.md",
      "skills/internal/core/references/details.md:1: missing packaged link target: missing.png",
      "skills/references/internal/shared.md:3: missing packaged link target: absent.md"
    ]);
  });

  test("Resolves shared references and encoded paths while ignoring example code and nonrelative links", async () => {
    const root = guidanceFixture();
    write(root, "skills/references/internal/Shared reference.md", "# Recovery\n");
    write(root, "skills/internal/core/100%.md", "Percent filename.\n");
    write(
      root,
      "skills/internal/core/SKILL.md",
      [
        '[Shared](../../references/internal/Shared%20reference.md#recovery "Recovery")',
        "[Directory](../../references/internal/)",
        "[Percent](100%.md)",
        "[Heading](#heading)",
        "[Web](https://example.com/missing) [Mail](mailto:example@example.com)",
        "[Local example](/path/to/file.md)",
        "`[Inline example](missing.md)`",
        "```md\n[Fenced example](missing.md)\n```",
        "    [Indented example](missing.md)",
        "<!-- [Comment](missing.md) -->"
      ].join("\n\n")
    );

    await expect(checkSkillLinks(root)).resolves.toStrictEqual([]);
  });

  test("Distributed guidance links resolve using only release-owned files", async () => {
    await expect(checkSkillLinks(path.resolve(import.meta.dirname, ".."))).resolves.toStrictEqual(
      []
    );
  });
});
