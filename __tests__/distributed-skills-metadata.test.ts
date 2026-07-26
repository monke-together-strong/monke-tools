import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("distributed skill source layout uses internal and imported categories", () => {
  expect(
    existsSync(path.join(projectRoot, "skills", "internal", "monke-tools-core", "SKILL.md")),
  ).toBe(true);
  expect(existsSync(path.join(projectRoot, "skills", "imported"))).toBe(true);
  expect(existsSync(path.join(projectRoot, "skills", "core"))).toBe(false);

  const coreSkill = readFileSync(
    path.join(projectRoot, "skills", "internal", "monke-tools-core", "SKILL.md"),
    "utf8",
  );
  expect(coreSkill).toMatch(/^name: monke-tools-core$/m);
});

test("code-review is a Reference-backed skill and its references are not discoverable", () => {
  const wrapper = readFileSync(
    path.join(projectRoot, "skills", "internal", "code-review", "SKILL.md"),
    "utf8",
  );
  const importedReference = readFileSync(
    path.join(projectRoot, "skills", "references", "imported", "code-review", "MAIN.md"),
    "utf8",
  );
  const teamBaseline = readFileSync(
    path.join(projectRoot, "skills", "references", "internal", "CODING_STANDARDS.md"),
    "utf8",
  );

  expect(wrapper).toContain("../../references/imported/code-review/MAIN.md");
  expect(wrapper).toContain("../../references/internal/CODING_STANDARDS.md");
  expect(wrapper).toContain("Repo coding standards");
  expect(wrapper).toContain("Team coding baseline");
  expect(importedReference).toMatch(/^\nTwo-axis review/);
  expect(importedReference).not.toMatch(/^---$/m);
  expect(teamBaseline).toMatch(/^# Team Coding Standards Baseline$/m);
  expect(existsSync(path.join(projectRoot, "skills", "imported", "code-review"))).toBe(false);
  expect(
    existsSync(
      path.join(projectRoot, "skills", "references", "imported", "code-review", "SKILL.md"),
    ),
  ).toBe(false);
});

test("tracked import recipes record one Import kind for every selector", () => {
  const store = JSON.parse(
    readFileSync(path.join(projectRoot, "skills", "imported", ".monke-imports.json"), "utf8"),
  ) as {
    version: number;
    recipes: Array<{
      source: string;
      skills: Array<{ selector: string; kind: string }>;
    }>;
  };
  const importedGuidance = store.recipes.flatMap((recipe) =>
    recipe.skills.map((guidance) => ({ source: recipe.source, ...guidance })),
  );

  expect(store.version).toBe(2);
  expect(importedGuidance.every((guidance) => ["skill", "reference"].includes(guidance.kind))).toBe(
    true,
  );
  expect(
    importedGuidance.find(
      (guidance) =>
        guidance.source === "https://github.com/mattpocock/skills" &&
        guidance.selector === "code-review",
    )?.kind,
  ).toBe("reference");
});

test("metadata and install docs do not reference the retired package discovery path", () => {
  const combined = [
    "README.md",
    "package.json",
    "bun.lock",
    "scripts/install-local.sh",
    "docs/adr/0001-install-distributed-skills-into-agent-roots.md",
  ]
    .map((relativePath) => readFileSync(path.join(projectRoot, relativePath), "utf8"))
    .join("\n");

  expect(combined).not.toMatch(/TanStack Intent|@tanstack\/intent|tanstack-intent/);
  expect(combined).not.toMatch(/npm link|npm root -g|global package roots|intent-skills/);
  expect(combined).toMatch(/Distributed skills/);
  expect(combined).toMatch(/Agent skill roots/);
});
