import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";
import { parse } from "yaml";

import { normalizeImportRecipeStore } from "../scripts/import-skills.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

describe("distributed skill metadata", () => {
  test("distributed skill source layout separates shared and Codex-only skills", () => {
    expect(
      existsSync(path.join(projectRoot, "skills", "internal", "monke-tools-core", "SKILL.md"))
    ).toBeTruthy();
    expect(existsSync(path.join(projectRoot, "skills", "imported"))).toBeTruthy();
    expect(
      existsSync(path.join(projectRoot, "skills", "codex", "codex-chrome-use", "SKILL.md"))
    ).toBeTruthy();
    expect(
      existsSync(path.join(projectRoot, "skills", "internal", "codex-chrome-use", "SKILL.md"))
    ).toBeFalsy();
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

  test("enforce-standards is user-invoked only", () => {
    const skillRoot = path.join(projectRoot, "skills", "internal", "enforce-standards");
    const skill = readFileSync(path.join(skillRoot, "SKILL.md"), "utf-8");

    expect(skill).toContain("disable-model-invocation: true");
    expect(
      parse(readFileSync(path.join(skillRoot, "agents", "openai.yaml"), "utf-8"))
    ).toMatchObject({ policy: { allow_implicit_invocation: false } });
  });

  test.each([
    [
      "auto-wayfinder",
      "Only use when explicitly mentioned with /auto-wayfinder or $auto-wayfinder."
    ],
    ["implement", "Only use when explicitly mentioned with /implement or $implement."]
  ])("%s uses its description as the explicit invocation gate", (slug, description) => {
    const skillRoot = path.join(projectRoot, "skills", "internal", slug);
    const skill = readFileSync(path.join(skillRoot, "SKILL.md"), "utf-8");

    expect(skill).toContain(`description: ${description}`);
    expect(skill).not.toContain("disable-model-invocation");
    expect(
      parse(readFileSync(path.join(skillRoot, "agents", "openai.yaml"), "utf-8"))
    ).not.toHaveProperty("policy.allow_implicit_invocation");
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

    expect(store.version).toBe(3);
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
    expect(
      importedGuidance
        .filter((guidance) => guidance.disableModelInvocation !== undefined)
        .map(({ disableModelInvocation, slug }) => ({ disableModelInvocation, slug }))
        .toSorted((left, right) => left.slug.localeCompare(right.slug))
    ).toStrictEqual([
      { disableModelInvocation: true, slug: "improve" },
      { disableModelInvocation: true, slug: "thermo-nuclear-code-quality-review" },
      { disableModelInvocation: false, slug: "writing-for-agents" }
    ]);
  });

  test("tracked model invocation overrides are materialized for Claude and Codex", () => {
    const expectedPolicies = [
      { allowImplicitInvocation: false, disableModelInvocation: true, slug: "improve" },
      {
        allowImplicitInvocation: false,
        disableModelInvocation: true,
        slug: "thermo-nuclear-code-quality-review"
      },
      {
        allowImplicitInvocation: true,
        disableModelInvocation: false,
        slug: "writing-for-agents"
      }
    ];

    for (const expected of expectedPolicies) {
      const skillRoot = path.join(projectRoot, "skills", "imported", expected.slug);
      expect(readFileSync(path.join(skillRoot, "SKILL.md"), "utf-8")).toContain(
        `disable-model-invocation: ${String(expected.disableModelInvocation)}`
      );
      expect(
        parse(readFileSync(path.join(skillRoot, "agents", "openai.yaml"), "utf-8"))
      ).toMatchObject({
        policy: { allow_implicit_invocation: expected.allowImplicitInvocation }
      });
    }
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
