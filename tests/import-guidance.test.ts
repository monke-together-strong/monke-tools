import * as fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { copyStagedGuidanceToManagedRoots } from "../scripts/import-guidance.ts";
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

describe("guidance transaction recovery", () => {
  test("rejects traversal that re-enters the managed destination from a different backup depth", () => {
    const fixture = guidanceFixture();
    const slug = `../../../${path.basename(fixture.repoRoot)}/skills/imported/alpha`;
    expect(path.resolve(fixture.repoRoot, "skills/imported", slug)).toBe(fixture.target("alpha"));
    expect(() => {
      copyStagedGuidanceToManagedRoots({
        ...fixture,
        guidance: [],
        obsoleteGuidance: [{ kind: "skill", selector: "alpha", slug }]
      });
    }).toThrow(/slug .* escapes/u);
    expect(read(fixture.target("alpha"), "SKILL.md")).toBe("original alpha");
  });

  test.each([
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

  test("a recipe commit failure restores originals and removes newly installed guidance", () => {
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

  test("a failed backup move does not make the original eligible for deletion", () => {
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

  test("a failed restore retains its recovery copy and still restores other targets", () => {
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
