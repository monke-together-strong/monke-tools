import * as fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  copyStagedGuidanceToManagedRoots,
  transformPreparedReference
} from "../scripts/import-guidance.ts";
import { makeTempDir, read, write } from "./helpers.ts";

function guidanceFixture() {
  const repoRoot = makeTempDir("guidance-recovery-");
  const stagingDirectory = path.join(repoRoot, "staging");

  const guidance = ["alpha", "beta", "new"].map((slug) => ({
    kind: "skill" as const,
    selector: slug,
    slug
  }));

  for (const { slug } of guidance) {
    write(stagingDirectory, path.join(".agents/skills", slug, "SKILL.md"), `updated ${slug}`);
  }

  const target = (slug: string) => path.join(repoRoot, "skills/imported", slug);
  write(target("alpha"), "SKILL.md", "original alpha");
  write(target("beta"), "SKILL.md", "original beta");

  return { guidance, repoRoot, stagingDirectory, target };
}

describe("reference conversion", () => {
  it("points supporting links to the renamed entry", () => {
    const reference = makeTempDir("reference-conversion-");
    write(reference, "SKILL.md", "---\nname: alpha\n---\n\nSee [UI](UI.md).\n");
    write(
      reference,
      "UI.md",
      'The [SKILL](SKILL.md "SKILL.md") and [rules](SKILL.md#rules) mention SKILL.md.\n\n[entry]: SKILL.md\n'
    );
    write(reference, "nested/LOGIC.md", "Back to [SKILL](../SKILL.md).\n");

    transformPreparedReference(reference);

    expect(read(reference, "MAIN.md")).toBe("\nSee [UI](UI.md).\n");
    expect(read(reference, "UI.md")).toBe(
      'The [SKILL](MAIN.md "SKILL.md") and [rules](MAIN.md#rules) mention SKILL.md.\n\n[entry]: MAIN.md\n'
    );
    expect(read(reference, "nested/LOGIC.md")).toBe("Back to [SKILL](../MAIN.md).\n");
  });

  it("rejects an entry link it cannot locate in the source", () => {
    const reference = makeTempDir("reference-conversion-");
    write(reference, "SKILL.md", "Entry.\n");
    write(reference, "UI.md", `${String.raw`See [SKILL](SKILL\.md).`}\n`);

    expect(() => {
      transformPreparedReference(reference);
    }).toThrow("UI.md:1");
    expect(read(reference, "UI.md")).toBe(`${String.raw`See [SKILL](SKILL\.md).`}\n`);
  });
});

describe("guidance transaction recovery", () => {
  it("preserves a published skill after a case-only slug rename", () => {
    const repoRoot = makeTempDir("guidance-case-rename-");
    const stagingDirectory = path.join(repoRoot, "staging");
    write(repoRoot, "skills/imported/Foo/SKILL.md", "Accepted skill.");
    write(stagingDirectory, ".agents/skills/foo/SKILL.md", "Updated skill.");
    copyStagedGuidanceToManagedRoots({
      guidance: [{ kind: "skill", selector: "foo", slug: "foo" }],
      obsoleteGuidance: [{ kind: "skill", slug: "Foo" }],
      repoRoot,
      stagingDirectory
    });
    expect(read(repoRoot, "skills/imported/foo/SKILL.md")).toBe("Updated skill.");
    expect(fs.readdirSync(path.join(repoRoot, "skills/imported"))).toStrictEqual(["foo"]);
  });

  it("keeps retained skill bytes available until their converted reference is published", () => {
    const fixture = guidanceFixture();
    const reference = path.join(fixture.repoRoot, "skills/references/imported/alpha/MAIN.md");
    let convertedBytes: string | undefined;
    copyStagedGuidanceToManagedRoots(
      {
        ...fixture,
        guidance: [{ kind: "reference", selector: "alpha", slug: "alpha" }],
        obsoleteGuidance: [{ kind: "skill", slug: "alpha" }],
        stagedGuidancePath: () => fixture.target("alpha")
      },
      (from, to) => {
        if (from === fixture.target("alpha")) {
          // An interruption after retiring the skill must leave its converted bytes available.
          convertedBytes = fs.readFileSync(reference, "utf-8");
        }

        fs.renameSync(from, to);
      }
    );
    expect(convertedBytes).toBe("original alpha");
    expect(fs.readFileSync(reference, "utf-8")).toBe("original alpha");
    expect(fs.existsSync(fixture.target("alpha"))).toBeFalsy();
  });

  it("restores linked source bytes after a failed description publication without touching agent metadata", () => {
    const fixture = guidanceFixture();
    const source = path.join(fixture.repoRoot, "linked-alpha");
    const original = "---\nname: alpha\ndescription: Original description.\n---\n\nInstructions.\n";
    write(source, "SKILL.md", original);
    write(source, "agents/openai.yaml/keep.txt", "Unrelated metadata.\n");
    write(fixture.stagingDirectory, ".agents/skills/alpha/SKILL.md", original);
    fs.rmSync(fixture.target("alpha"), { recursive: true });
    fs.symlinkSync(source, fixture.target("alpha"), "dir");
    expect(() => {
      copyStagedGuidanceToManagedRoots({
        ...fixture,
        commitState() {
          expect(read(source, "SKILL.md")).toContain("description: Local description.");
          throw new Error("recipe commit failed");
        },
        guidance: [
          { description: "Local description.", kind: "skill", selector: "alpha", slug: "alpha" }
        ],
        linkedSkills: new Map([["alpha", source]])
      });
    }).toThrow("recipe commit failed");
    expect(read(source, "SKILL.md")).toBe(original);
    expect(read(source, "agents/openai.yaml/keep.txt")).toBe("Unrelated metadata.\n");
    expect(fs.realpathSync(fixture.target("alpha"))).toBe(fs.realpathSync(source));
  });

  it("rejects traversal that re-enters the managed destination from a different backup depth", () => {
    const fixture = guidanceFixture();
    const slug = `../../../${path.basename(fixture.repoRoot)}/skills/imported/alpha`;
    expect(path.resolve(fixture.repoRoot, "skills/imported", slug)).toBe(fixture.target("alpha"));
    expect(() => {
      copyStagedGuidanceToManagedRoots({
        ...fixture,
        guidance: [],
        obsoleteGuidance: [{ kind: "skill", slug }]
      });
    }).toThrow(/slug .* escapes/u);
    expect(read(fixture.target("alpha"), "SKILL.md")).toBe("original alpha");
  });

  it.each([
    ["guidance", "../unrelated"],
    ["obsoleteGuidance", "../unrelated"],
    ["guidance", "."],
    ["guidance", "/outside"]
  ] as const)("rejects %s slug %s before installing or removing guidance", (field, slug) => {
    const fixture = guidanceFixture();
    write(fixture.repoRoot, "skills/unrelated/keep.txt", "user content");
    expect(() => {
      copyStagedGuidanceToManagedRoots({
        ...fixture,
        [field]: [{ kind: "skill", selector: slug, slug }]
      });
    }).toThrow(/slug .* escapes/u);
    expect(read(fixture.repoRoot, "skills/unrelated/keep.txt")).toBe("user content");
    expect(read(fixture.target("alpha"), "SKILL.md")).toBe("original alpha");
    expect(fs.existsSync(fixture.target("new"))).toBeFalsy();
  });

  it("restores originals and removes newly installed guidance after a recipe commit failure", () => {
    const fixture = guidanceFixture();
    expect(() => {
      copyStagedGuidanceToManagedRoots({
        ...fixture,
        commitState() {
          throw new Error("recipe commit failed");
        }
      });
    }).toThrow("recipe commit failed");
    expect(read(fixture.target("alpha"), "SKILL.md")).toBe("original alpha");
    expect(read(fixture.target("beta"), "SKILL.md")).toBe("original beta");
    expect(fs.existsSync(fixture.target("new"))).toBeFalsy();
    expect(
      fs.readdirSync(fixture.repoRoot).filter((name) => name.startsWith(".monke-guidance-backup-"))
    ).toStrictEqual([]);
  });

  it("keeps the original ineligible for deletion after a failed backup move", () => {
    const fixture = guidanceFixture();

    const move = (from: string, to: string) => {
      if (from === fixture.target("beta")) {
        throw new Error("backup move failed");
      }

      fs.renameSync(from, to);
    };

    expect(() => {
      copyStagedGuidanceToManagedRoots(fixture, move);
    }).toThrow("backup move failed");
    expect(read(fixture.target("alpha"), "SKILL.md")).toBe("original alpha");
    expect(read(fixture.target("beta"), "SKILL.md")).toBe("original beta");
  });

  it("retains a failed restore's recovery copy and still restores other targets", () => {
    const fixture = guidanceFixture();

    const move = (from: string, to: string) => {
      if (to === fixture.target("alpha")) {
        throw new Error("restore move failed");
      }

      fs.renameSync(from, to);
    };

    expect(() => {
      copyStagedGuidanceToManagedRoots(
        {
          ...fixture,
          commitState() {
            throw new Error("recipe commit failed");
          }
        },
        move
      );
    }).toThrow(/recipe commit failed[\s\S]*restore move failed[\s\S]*Recovery copies retained at/u);
    expect(read(fixture.target("beta"), "SKILL.md")).toBe("original beta");
    expect(fs.existsSync(fixture.target("new"))).toBeFalsy();

    const recovery = fs
      .readdirSync(fixture.repoRoot)
      .find((name) => name.startsWith(".monke-guidance-backup-"));

    expect(recovery).toBeDefined();
    expect(
      read(
        fixture.repoRoot,
        path.join(recovery ?? "missing-recovery", "originals/skill/alpha/SKILL.md")
      )
    ).toBe("original alpha");
  });
});
