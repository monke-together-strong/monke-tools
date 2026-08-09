import { symlinkSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { parse } from "yaml";
import * as z from "zod";

import {
  CODE_RABBIT_SYNC_INPUTS,
  isCodeRabbitSyncRelevant,
  renderCodeRabbitConfig,
  runCodeRabbitConfigGenerator
} from "../scripts/generate-coderabbit-config.ts";
import { createRepo, git, makeTempDir, write } from "./helpers.ts";

const BaselineConfigSchema = z.looseObject({
  reviews: z.looseObject({
    path_instructions: z.array(
      z.looseObject({
        instructions: z.string(),
        path: z.string()
      })
    )
  })
});

const CustomizedConfigSchema = z.looseObject({
  knowledge_base: z.looseObject({
    code_guidelines: z.looseObject({
      filePatterns: z.array(
        z.looseObject({
          applyTo: z.string(),
          files: z.string()
        })
      )
    })
  }),
  language: z.string(),
  reviews: z.looseObject({
    path_instructions: z.array(
      z.looseObject({
        instructions: z.string(),
        path: z.string()
      })
    ),
    profile: z.string()
  })
});

describe("CodeRabbit central configuration", () => {
  test("renders recursively linked Team coding baseline documents with provenance", () => {
    const repoRoot = makeTempDir("coderabbit-config-recursive");
    write(
      repoRoot,
      "config/coderabbit/template.yaml",
      `inheritance: true
reviews:
  path_instructions: []
`
    );
    write(
      repoRoot,
      "skills/references/internal/CODING_STANDARDS.md",
      `# Team baseline

Follow the [shared rules](../imported/shared.md).
`
    );
    write(
      repoRoot,
      "skills/references/imported/shared.md",
      `# Shared rules

- Prefer narrow interfaces.
`
    );

    const rendered = renderCodeRabbitConfig({
      repoRoot,
      sourceCommit: "0123456789abcdef0123456789abcdef01234567"
    });

    expect(rendered.sources).toStrictEqual([
      "skills/references/internal/CODING_STANDARDS.md",
      "skills/references/imported/shared.md"
    ]);
    const parsed = BaselineConfigSchema.parse(parse(rendered.yaml));
    const [baseline] = parsed.reviews.path_instructions;
    expect(baseline?.instructions).toContain("# Team baseline");
    expect(baseline?.instructions).toContain(
      "Source: skills/references/imported/shared.md\n\n# Shared rules"
    );
    expect(baseline?.path).toBe("**/*");
    expect(rendered.yaml).toContain(
      "Generated from monke-together-strong/monke-tools@0123456789abcdef0123456789abcdef01234567"
    );
  });

  test("terminates cycles and follows used reference-style Markdown links once", () => {
    const repoRoot = makeTempDir("coderabbit-config-cycle");
    write(repoRoot, "config/coderabbit/template.yaml", "reviews:\n  path_instructions: []\n");
    write(
      repoRoot,
      "skills/references/internal/CODING_STANDARDS.md",
      "Read [shared].\n\n[shared]: ../imported/shared.md\n"
    );
    write(
      repoRoot,
      "skills/references/imported/shared.md",
      "Return to the [baseline][root].\n\n[root]: ../internal/CODING_STANDARDS.md\n"
    );

    const rendered = renderCodeRabbitConfig({ repoRoot, sourceCommit: "abc123" });

    expect(rendered.sources).toStrictEqual([
      "skills/references/internal/CODING_STANDARDS.md",
      "skills/references/imported/shared.md"
    ]);
  });

  test("fails clearly when a linked local Markdown file is missing", () => {
    const repoRoot = makeTempDir("coderabbit-config-missing");
    write(repoRoot, "config/coderabbit/template.yaml", "reviews: {}\n");
    write(
      repoRoot,
      "skills/references/internal/CODING_STANDARDS.md",
      "Read [missing](../imported/missing.md).\n"
    );

    expect(() => renderCodeRabbitConfig({ repoRoot, sourceCommit: "abc123" })).toThrow(
      "Linked Markdown file does not exist: skills/references/imported/missing.md"
    );
  });

  test("rejects Markdown dependencies outside skills/references", () => {
    const repoRoot = makeTempDir("coderabbit-config-boundary");
    write(repoRoot, "config/coderabbit/template.yaml", "reviews: {}\n");
    write(repoRoot, "outside.md", "Not an owned reference.\n");
    write(
      repoRoot,
      "skills/references/internal/CODING_STANDARDS.md",
      "Read [outside](../../../outside.md).\n"
    );

    expect(() => renderCodeRabbitConfig({ repoRoot, sourceCommit: "abc123" })).toThrow(
      "Linked Markdown file is outside skills/references: outside.md"
    );
  });

  test("rejects symlinked Markdown dependencies that escape skills/references", () => {
    const repoRoot = makeTempDir("coderabbit-config-symlink-boundary");
    write(repoRoot, "config/coderabbit/template.yaml", "reviews: {}\n");
    write(repoRoot, "outside.md", "Not an owned reference.\n");
    write(repoRoot, "skills/references/imported/.keep", "");
    write(
      repoRoot,
      "skills/references/internal/CODING_STANDARDS.md",
      "Read [outside](../imported/outside.md).\n"
    );
    symlinkSync(
      path.join(repoRoot, "outside.md"),
      path.join(repoRoot, "skills/references/imported/outside.md")
    );

    expect(() => renderCodeRabbitConfig({ repoRoot, sourceCommit: "abc123" })).toThrow(
      "Linked Markdown file is outside skills/references: skills/references/imported/outside.md"
    );
  });

  test("does not traverse external, image, anchor, or non-Markdown links", () => {
    const repoRoot = makeTempDir("coderabbit-config-non-dependencies");
    write(repoRoot, "config/coderabbit/template.yaml", "reviews: {}\n");
    write(
      repoRoot,
      "skills/references/internal/CODING_STANDARDS.md",
      [
        "[External](https://example.com/rules.md)",
        "![Diagram](../imported/missing.md)",
        "[Section](#section)",
        "[Text](../imported/missing.txt)"
      ].join("\n")
    );

    const rendered = renderCodeRabbitConfig({ repoRoot, sourceCommit: "abc123" });

    expect(rendered.sources).toStrictEqual(["skills/references/internal/CODING_STANDARDS.md"]);
  });

  test("rejects a hand-authored path instruction that collides with the generated path", () => {
    const repoRoot = makeTempDir("coderabbit-config-template-collision");
    write(
      repoRoot,
      "config/coderabbit/template.yaml",
      `reviews:
  path_instructions:
    - path: "**/*"
      instructions: Do something else.
`
    );
    write(repoRoot, "skills/references/internal/CODING_STANDARDS.md", "# Team baseline\n");

    expect(() => renderCodeRabbitConfig({ repoRoot, sourceCommit: "abc123" })).toThrow(
      'Template reviews.path_instructions must not contain the generated path "**/*"'
    );
  });

  test("preserves hand-authored settings and narrower path instructions", () => {
    const repoRoot = makeTempDir("coderabbit-config-customization");
    write(
      repoRoot,
      "config/coderabbit/template.yaml",
      `language: en-US
knowledge_base:
  code_guidelines:
    filePatterns:
      - files: "**/CODING_STANDARDS.md"
        applyTo: "**/*"
reviews:
  profile: chill
  path_instructions:
    - path: "src/api/**"
      instructions: Keep API handlers thin.
`
    );
    write(repoRoot, "skills/references/internal/CODING_STANDARDS.md", "# Team baseline\n");

    const parsed = CustomizedConfigSchema.parse(
      parse(renderCodeRabbitConfig({ repoRoot, sourceCommit: "abc123" }).yaml)
    );

    expect(parsed.language).toBe("en-US");
    expect(parsed.knowledge_base.code_guidelines.filePatterns).toStrictEqual([
      { applyTo: "**/*", files: "**/CODING_STANDARDS.md" }
    ]);
    expect(parsed.reviews.profile).toBe("chill");
    expect(parsed.reviews.path_instructions[1]).toStrictEqual({
      instructions: "Keep API handlers thin.",
      path: "src/api/**"
    });
  });

  test("rejects a generated instruction over CodeRabbit's 20,000-character limit", () => {
    const repoRoot = makeTempDir("coderabbit-config-size-limit");
    write(repoRoot, "config/coderabbit/template.yaml", "reviews: {}\n");
    write(repoRoot, "skills/references/internal/CODING_STANDARDS.md", "a".repeat(20_000));

    expect(() => renderCodeRabbitConfig({ repoRoot, sourceCommit: "abc123" })).toThrow(
      "Generated reviews.path_instructions instructions exceed CodeRabbit's 20,000-character limit"
    );
  });

  test("accepts a generated instruction at CodeRabbit's 20,000-character limit", () => {
    const repoRoot = makeTempDir("coderabbit-config-exact-size-limit");
    write(repoRoot, "config/coderabbit/template.yaml", "reviews: {}\n");
    write(repoRoot, "skills/references/internal/CODING_STANDARDS.md", "");
    const [emptyBaseline] = BaselineConfigSchema.parse(
      parse(renderCodeRabbitConfig({ repoRoot, sourceCommit: "abc123" }).yaml)
    ).reviews.path_instructions;
    expect(emptyBaseline).toBeDefined();
    write(
      repoRoot,
      "skills/references/internal/CODING_STANDARDS.md",
      "a".repeat(20_000 - (emptyBaseline?.instructions.length ?? 0))
    );

    expect(() => renderCodeRabbitConfig({ repoRoot, sourceCommit: "abc123" })).not.toThrow();
  });

  test("renders deterministically for the same source tree and commit", () => {
    const repoRoot = makeTempDir("coderabbit-config-deterministic");
    write(repoRoot, "config/coderabbit/template.yaml", "reviews: {}\n");
    write(repoRoot, "skills/references/internal/CODING_STANDARDS.md", "# Team baseline\n");
    const options = { repoRoot, sourceCommit: "abc123" };

    expect(renderCodeRabbitConfig(options)).toStrictEqual(renderCodeRabbitConfig(options));
  });

  test("syncs only for renderer inputs or a document in the current dependency graph", () => {
    const sources = [
      "skills/references/internal/CODING_STANDARDS.md",
      "skills/references/imported/ultracite.md"
    ];

    expect(
      isCodeRabbitSyncRelevant({
        changedPaths: ["skills/references/imported/unrelated.md"],
        sources
      })
    ).toBeFalsy();
    for (const changedPath of [
      "skills/references/internal/CODING_STANDARDS.md",
      "skills/references/imported/ultracite.md",
      ...CODE_RABBIT_SYNC_INPUTS
    ]) {
      expect(isCodeRabbitSyncRelevant({ changedPaths: [changedPath], sources })).toBeTruthy();
    }
  });

  test("reports push relevance from the current graph and Git commit range", async () => {
    const repoRoot = createRepo(makeTempDir("coderabbit-config-relevance-cli"), {
      "config/coderabbit/template.yaml": "reviews: {}\n",
      "skills/references/imported/shared.md": "# Shared\n",
      "skills/references/imported/unrelated.md": "# Unrelated\n",
      "skills/references/internal/CODING_STANDARDS.md": "Read [shared](../imported/shared.md).\n"
    });
    const beforeRelevant = git(repoRoot, ["rev-parse", "HEAD"]);
    write(repoRoot, "skills/references/imported/shared.md", "# Shared\n\nChanged.\n");
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-m", "change shared rules"]);
    const afterRelevant = git(repoRoot, ["rev-parse", "HEAD"]);
    let output = "";

    await runCodeRabbitConfigGenerator(
      ["relevant", "--repo-root", repoRoot, "--before", beforeRelevant, "--after", afterRelevant],
      (message) => {
        output += message;
      }
    );

    expect(output).toBe("true\n");

    write(repoRoot, "skills/references/imported/unrelated.md", "# Unrelated\n\nChanged.\n");
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-m", "change unrelated rules"]);
    const afterIrrelevant = git(repoRoot, ["rev-parse", "HEAD"]);
    output = "";

    await runCodeRabbitConfigGenerator(
      ["relevant", "--repo-root", repoRoot, "--before", afterRelevant, "--after", afterIrrelevant],
      (message) => {
        output += message;
      }
    );

    expect(output).toBe("false\n");

    const fallbackOutputs = await Promise.all(
      ["0".repeat(40), "f".repeat(40)].map(async (before) => {
        let fallbackOutput = "";
        await runCodeRabbitConfigGenerator(
          ["relevant", "--repo-root", repoRoot, "--before", before, "--after", afterIrrelevant],
          (message) => {
            fallbackOutput += message;
          }
        );
        return fallbackOutput;
      })
    );
    expect(fallbackOutputs).toStrictEqual(["true\n", "true\n"]);
  });
});
