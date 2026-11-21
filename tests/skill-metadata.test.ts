import path from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

import { stagedSkillGuidance } from "../scripts/skill-lock.ts";
import { parseSkillFrontmatterDocument, setSkillMetadata } from "../src/skill-metadata.ts";
import { makeTempDir, read, write } from "./helpers.ts";

describe("skill frontmatter tolerance", () => {
  it("tolerates unquoted colons in single-line frontmatter values while preserving other fields and comments", () => {
    const skillDirectory = makeTempDir("skill-metadata-colons-");

    const description =
      'Package UI work for X. Includes "quotes" and C:\\path. Triggers on: video, reel, clip.';

    write(
      skillDirectory,
      "SKILL.md",
      [
        "---",
        "name: emil-package-my-work",
        `description: ${description}   `,
        "argument-hint: format: mp4: 60fps",
        "trailing: Triggers on:",
        "license: MIT # Keep this comment",
        "notes: |",
        "  Keep: block scalar",
        "metadata:",
        "  summary: Note: nested value",
        "---",
        "",
        "Body instructions.",
        ""
      ].join("\r\n")
    );

    setSkillMetadata(skillDirectory, { disableModelInvocation: true });

    const written = read(skillDirectory, "SKILL.md");
    const frontmatter = /^---\n(?<yaml>[\s\S]*?)\n---\n/u.exec(written)?.groups?.yaml ?? "";

    expect(parse(frontmatter)).toStrictEqual({
      "argument-hint": "format: mp4: 60fps",
      description,
      "disable-model-invocation": true,
      license: "MIT",
      metadata: { summary: "Note: nested value" },
      name: "emil-package-my-work",
      notes: "Keep: block scalar\n",
      trailing: "Triggers on:"
    });
    expect(written).toContain("# Keep this comment");
    expect(written.endsWith("\r\nBody instructions.\r\n")).toBeTruthy();
    expect(parse(read(skillDirectory, "agents/openai.yaml"))).toStrictEqual({
      policy: { allow_implicit_invocation: false }
    });
  });

  it("applies description overrides on top of frontmatter with unquoted colons", () => {
    const skillDirectory = makeTempDir("skill-metadata-override-");

    write(
      skillDirectory,
      "SKILL.md",
      "---\nname: pkg\ndescription: Old text. Triggers on: video, clip.\n---\n\nKeep body.\n"
    );

    setSkillMetadata(skillDirectory, {
      description: "Custom trigger: explicit only.",
      disableModelInvocation: true
    });

    const written = read(skillDirectory, "SKILL.md");
    const frontmatter = /^---\n(?<yaml>[\s\S]*?)\n---\n/u.exec(written)?.groups?.yaml ?? "";

    expect(parse(frontmatter)).toStrictEqual({
      description: "Custom trigger: explicit only.",
      "disable-model-invocation": true,
      name: "pkg"
    });
    expect(written.endsWith("\nKeep body.\n")).toBeTruthy();
  });

  it("reads staged Git Skill selectors when description contains unquoted colons", () => {
    const staging = makeTempDir("skill-lock-selector-colons-");

    write(
      staging,
      ".agents/skills/package-work/SKILL.md",
      "---\nname: emil-package-my-work\ndescription: Make clips. Triggers on: video, reel.\n---\nBody.\n"
    );

    expect(stagedSkillGuidance(staging, { skills: [], source: "example/repo" })).toStrictEqual([
      {
        kind: "skill",
        selector: "emil-package-my-work",
        slug: "package-work"
      }
    ]);
  });

  it.each([
    {
      label: "duplicate keys alongside an unquoted colon",
      yaml: "name: a\nname: b\ndescription: Triggers on: video\n"
    },
    {
      label: "broken multiline mapping",
      yaml: "metadata: extra\n  author: emil\n"
    },
    {
      label: "broken flow collection",
      yaml: "metadata: { a: b: c }\n"
    },
    {
      label: "unclosed quote",
      yaml: 'description: "unterminated: value\n'
    },
    {
      label: "tab indentation",
      yaml: "metadata:\n\tnote: Foo: bar\n"
    },
    {
      label: "empty key",
      yaml: ": foo: bar\n"
    }
  ])("still rejects genuinely invalid frontmatter ($label)", ({ yaml }) => {
    expect(() => parseSkillFrontmatterDocument(yaml, "fixture")).toThrow(/Invalid fixture:/u);
  });

  it("rejects invalid disable-model-invocation values even after quoting colons", () => {
    const skillDirectory = makeTempDir("skill-metadata-invalid-bool-");

    write(
      skillDirectory,
      "SKILL.md",
      "---\nname: pkg\ndisable-model-invocation: true: false\n---\nBody.\n"
    );

    expect(() => {
      setSkillMetadata(skillDirectory, { disableModelInvocation: true });
    }).toThrow(/disable-model-invocation/u);
  });

  it("keeps Codex agents/openai.yaml parsing strict", () => {
    const skillDirectory = makeTempDir("skill-metadata-strict-openai-");

    write(skillDirectory, "SKILL.md", "---\nname: pkg\ndescription: Valid.\n---\nBody.\n");
    write(skillDirectory, path.join("agents", "openai.yaml"), "policy: allow: false\n");

    expect(() => {
      setSkillMetadata(skillDirectory, { disableModelInvocation: true });
    }).toThrow(/Invalid Codex metadata/u);
  });
});
