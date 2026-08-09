import { symlinkSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { parse } from "yaml";
import { array as arraySchema, looseObject, string as stringSchema } from "zod";

import {
  CODE_RABBIT_SYNC_INPUTS,
  isCodeRabbitSyncRelevant,
  renderCodeRabbitConfig,
  runCodeRabbitConfigGenerator
} from "../scripts/generate-coderabbit-config.ts";
import { createRepo, git, makeTempDir, write } from "./helpers.ts";

const BaselineConfigSchema = looseObject({
  reviews: looseObject({
    path_instructions: arraySchema(
      looseObject({
        instructions: stringSchema(),
        path: stringSchema()
      })
    )
  })
});

const CustomizedConfigSchema = looseObject({
  knowledge_base: looseObject({
    code_guidelines: looseObject({
      filePatterns: arraySchema(
        looseObject({
          applyTo: stringSchema(),
          files: stringSchema()
        })
      )
    })
  }),
  language: stringSchema(),
  reviews: looseObject({
    path_instructions: arraySchema(
      looseObject({
        instructions: stringSchema(),
        path: stringSchema()
      })
    ),
    profile: stringSchema()
  })
});

function makeCodeRabbitRepo(name: string) {
  const repoRoot = makeTempDir(name);
  write(repoRoot, "config/coderabbit/sources.yaml", "excerpts: []\n");
  write(repoRoot, "config/coderabbit/template.yaml", "reviews: {}\n");
  write(repoRoot, "skills/references/internal/CODING_STANDARDS.md", "# Team baseline\n");
  return repoRoot;
}

describe("CodeRabbit central configuration", () => {
  test("renders the complete repository code-smell review baseline", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const [baseline] = BaselineConfigSchema.parse(
      parse(renderCodeRabbitConfig({ repoRoot, sourceCommit: "abc123" }).yaml)
    ).reviews.path_instructions;

    expect(baseline?.instructions).toContain("## Code-smell review baseline");
    expect(baseline?.instructions).toContain("**The repo overrides.**");
    expect(baseline?.instructions).toContain("**Always a judgement call.**");
    for (const smell of [
      "Mysterious Name",
      "Duplicated Code",
      "Feature Envy",
      "Data Clumps",
      "Primitive Obsession",
      "Repeated Switches",
      "Shotgun Surgery",
      "Divergent Change",
      "Speculative Generality",
      "Message Chains",
      "Middle Man",
      "Refused Bequest"
    ]) {
      expect(baseline?.instructions).toContain(`**${smell}**`);
    }
    expect(baseline?.instructions).not.toContain(
      "Anything in the repo that documents how code should be written"
    );
    expect(baseline?.instructions).not.toContain("### 4. Spawn both sub-agents in parallel");
    expect(baseline?.instructions).not.toContain(
      "Source: skills/references/imported/code-review/MAIN.md"
    );
    expect(baseline?.instructions).not.toContain("Excerpt anchor:");
  });

  test("renders configured Markdown excerpts without source metadata", () => {
    const repoRoot = makeCodeRabbitRepo("coderabbit-config-excerpt");
    write(
      repoRoot,
      "config/coderabbit/sources.yaml",
      `excerpts:
  - source: skills/references/imported/code-review/MAIN.md
    anchor: the smell baseline below
    heading: Code-smell review baseline
    stopAtHeadingDepth: 3
`
    );
    write(
      repoRoot,
      "skills/references/imported/code-review/MAIN.md",
      `### 3. Identify the standards sources

Anything in the repo that documents how code should be written.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below — it applies everywhere. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins.
- **Always a judgement call.** Each smell is a labelled heuristic.

- **Mysterious Name** — rename unclear names.
- **Feature Envy** — move behavior to the data it envies.

### 4. Spawn both sub-agents in parallel

Do not include these sub-agent instructions.
`
    );

    const rendered = renderCodeRabbitConfig({ repoRoot, sourceCommit: "abc123" });
    const [baseline] = BaselineConfigSchema.parse(parse(rendered.yaml)).reviews.path_instructions;

    expect(rendered.sources).toContain("skills/references/imported/code-review/MAIN.md");
    expect(baseline?.instructions).toContain("## Code-smell review baseline");
    expect(baseline?.instructions).toContain("**The repo overrides.**");
    expect(baseline?.instructions).toContain("**Always a judgement call.**");
    expect(baseline?.instructions).toContain("**Mysterious Name**");
    expect(baseline?.instructions).toContain("**Feature Envy**");
    expect(baseline?.instructions).not.toContain(
      "Anything in the repo that documents how code should be written"
    );
    expect(baseline?.instructions).not.toContain("Spawn both sub-agents");
    expect(baseline?.instructions).not.toContain("Source:");
    expect(baseline?.instructions).not.toContain("Excerpt anchor:");
  });

  test.each([
    ["missing", "No matching paragraph.\n", "matched 0"],
    [
      "ambiguous",
      "The **smell baseline** below is first.\n\nThe smell baseline below is second.\n",
      "matched 2"
    ]
  ])("fails clearly when a configured excerpt anchor is %s", (_, source, expected) => {
    const repoRoot = makeCodeRabbitRepo("coderabbit-config-excerpt-anchor");
    write(
      repoRoot,
      "config/coderabbit/sources.yaml",
      `excerpts:
  - source: skills/references/imported/code-review/MAIN.md
    anchor: the smell baseline below
    heading: Code-smell review baseline
    stopAtHeadingDepth: 3
`
    );
    write(repoRoot, "skills/references/imported/code-review/MAIN.md", source);

    expect(() => renderCodeRabbitConfig({ repoRoot, sourceCommit: "abc123" })).toThrow(expected);
  });

  test("renders recursively linked Team coding baseline documents with provenance", () => {
    const repoRoot = makeCodeRabbitRepo("coderabbit-config-recursive");
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
    const repoRoot = makeCodeRabbitRepo("coderabbit-config-cycle");
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
    const repoRoot = makeCodeRabbitRepo("coderabbit-config-missing");
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
    const repoRoot = makeCodeRabbitRepo("coderabbit-config-boundary");
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
    const repoRoot = makeCodeRabbitRepo("coderabbit-config-symlink-boundary");
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
    const repoRoot = makeCodeRabbitRepo("coderabbit-config-non-dependencies");
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
    const repoRoot = makeCodeRabbitRepo("coderabbit-config-template-collision");
    write(
      repoRoot,
      "config/coderabbit/template.yaml",
      `reviews:
  path_instructions:
    - path: "**/*"
      instructions: Do something else.
`
    );

    expect(() => renderCodeRabbitConfig({ repoRoot, sourceCommit: "abc123" })).toThrow(
      'Template reviews.path_instructions must not contain the generated path "**/*"'
    );
  });

  test("preserves hand-authored settings and narrower path instructions", () => {
    const repoRoot = makeCodeRabbitRepo("coderabbit-config-customization");
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
    const repoRoot = makeCodeRabbitRepo("coderabbit-config-size-limit");
    write(repoRoot, "skills/references/internal/CODING_STANDARDS.md", "a".repeat(20_000));

    expect(() => renderCodeRabbitConfig({ repoRoot, sourceCommit: "abc123" })).toThrow(
      "Generated reviews.path_instructions instructions exceed CodeRabbit's 20,000-character limit"
    );
  });

  test("accepts a generated instruction at CodeRabbit's 20,000-character limit", () => {
    const repoRoot = makeCodeRabbitRepo("coderabbit-config-exact-size-limit");
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
    const repoRoot = makeCodeRabbitRepo("coderabbit-config-deterministic");
    const options = { repoRoot, sourceCommit: "abc123" };

    expect(renderCodeRabbitConfig(options)).toStrictEqual(renderCodeRabbitConfig(options));
  });

  test("syncs only for renderer inputs or a document in the current dependency graph", () => {
    const sources = [
      "skills/references/internal/CODING_STANDARDS.md",
      "skills/references/imported/code-review/MAIN.md",
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
      "skills/references/imported/code-review/MAIN.md",
      "skills/references/imported/ultracite.md",
      ...CODE_RABBIT_SYNC_INPUTS
    ]) {
      expect(isCodeRabbitSyncRelevant({ changedPaths: [changedPath], sources })).toBeTruthy();
    }
  });

  test("reports push relevance from the current graph and Git commit range", async () => {
    const repoRoot = createRepo(makeTempDir("coderabbit-config-relevance-cli"), {
      "config/coderabbit/sources.yaml": "excerpts: []\n",
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

    const fallbackBeforeCommits = [
      "0".repeat(beforeRelevant.length),
      "f".repeat(beforeRelevant.length)
    ];
    const fallbackOutputs = await Promise.all(
      fallbackBeforeCommits.map(async (before) => {
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
