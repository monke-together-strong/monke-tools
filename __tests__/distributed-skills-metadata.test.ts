import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { normalizeImportRecipeStore } from "../scripts/import-skills.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

describe("distributed skill metadata", () => {
  test("distributed skill source layout uses internal and imported categories", () => {
    expect(
      existsSync(path.join(projectRoot, "skills", "internal", "monke-tools-core", "SKILL.md"))
    ).toBeTruthy();
    expect(existsSync(path.join(projectRoot, "skills", "imported"))).toBeTruthy();
    expect(existsSync(path.join(projectRoot, "skills", "core"))).toBeFalsy();

    const coreSkill = readFileSync(
      path.join(projectRoot, "skills", "internal", "monke-tools-core", "SKILL.md"),
      "utf-8"
    );
    expect(coreSkill).toMatch(/^name: monke-tools-core$/mu);
  });

  test("code-review is a Reference-backed skill and its references are not discoverable", () => {
    const wrapper = readFileSync(
      path.join(projectRoot, "skills", "internal", "code-review", "SKILL.md"),
      "utf-8"
    );
    const importedReference = readFileSync(
      path.join(projectRoot, "skills", "references", "imported", "code-review", "MAIN.md"),
      "utf-8"
    );
    const teamBaseline = readFileSync(
      path.join(projectRoot, "skills", "references", "internal", "CODING_STANDARDS.md"),
      "utf-8"
    );

    expect(wrapper).toContain("../../references/imported/code-review/MAIN.md");
    expect(wrapper).toContain("../../references/internal/CODING_STANDARDS.md");
    expect(wrapper).toContain("Repo coding standards");
    expect(wrapper).toContain("Team coding baseline");
    expect(importedReference).toMatch(/^\nTwo-axis review/u);
    expect(importedReference).not.toMatch(/^---$/mu);
    expect(teamBaseline).toMatch(/^# Team Coding Standards Baseline$/mu);
    expect(existsSync(path.join(projectRoot, "skills", "imported", "code-review"))).toBeFalsy();
    expect(
      existsSync(
        path.join(projectRoot, "skills", "references", "imported", "code-review", "SKILL.md")
      )
    ).toBeFalsy();
  });

  test("tracked import recipes record one Import kind for every selector", () => {
    const store = normalizeImportRecipeStore(
      JSON.parse(
        readFileSync(path.join(projectRoot, "skills", "imported", ".monke-imports.json"), "utf-8")
      )
    );
    const importedGuidance = store.recipes.flatMap((recipe) =>
      recipe.skills.map((guidance) => ({ source: recipe.source, ...guidance }))
    );

    expect(store.version).toBe(2);
    expect(
      importedGuidance.every((guidance) => ["skill", "reference"].includes(guidance.kind))
    ).toBeTruthy();
    expect(
      importedGuidance.find(
        (guidance) =>
          guidance.source === "https://github.com/mattpocock/skills" &&
          guidance.selector === "code-review"
      )?.kind
    ).toBe("reference");
  });

  test("metadata and install docs do not reference the retired package discovery path", () => {
    const combined = [
      "README.md",
      "package.json",
      "bun.lock",
      "scripts/install-local.sh",
      "docs/adr/0001-install-distributed-skills-into-agent-roots.md"
    ]
      .map((relativePath) => readFileSync(path.join(projectRoot, relativePath), "utf-8"))
      .join("\n");

    expect(combined).not.toMatch(/TanStack Intent|@tanstack\/intent|tanstack-intent/u);
    expect(combined).not.toMatch(/npm link|npm root -g|global package roots|intent-skills/u);
    expect(combined).toMatch(/Distributed skills/u);
    expect(combined).toMatch(/Agent skill roots/u);
  });
});
