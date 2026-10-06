import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as z from "zod";

import { MonkeError } from "../src/errors.ts";
import { unwrapBoundaryResult } from "../src/validation.ts";
import { IMPORTED_SKILLS_ROOT } from "./import-guidance.ts";

export const SKILL_LOCK_PATH = "skills.lock.json";
const SKILL_IMPORT_RECIPE_STORE_VERSION = 3;
const LEGACY_IMPORT_RECIPE_STORE_PATH = path.join(IMPORTED_SKILLS_ROOT, ".monke-imports.json");
const SkillImportRecipeSkillSchema = z.strictObject(
  {
    adoptedPaths: z.array(z.string().refine(path.isAbsolute)).optional(),
    disableModelInvocation: z.boolean().optional(),
    kind: z.enum(["skill", "reference"], {
      error: "Import kind must be skill or reference"
    }),
    selector: z.string().refine((value) => value.trim().length > 0, {
      error: "Skill import selector must be a non-empty string"
    }),
    slug: z.string().refine((value) => value.trim().length > 0, {
      error: "Skill slug must be a non-empty string"
    })
  },
  { error: "Skill import recipe skill must be a JSON object" }
);
const SkillImportRecipeSchema = z.strictObject(
  {
    acceptOpenClawRisks: z
      .literal(true, {
        error: "Skill import recipe acceptOpenClawRisks must be true when present"
      })
      .optional(),
    disableModelInvocation: z.boolean().optional(),
    disableModelInvocationOverrides: z.record(z.string().min(1), z.boolean()).optional(),
    localSource: z
      .strictObject({
        command: z.string().min(1).optional(),
        kind: z.enum(["command", "link"]),
        skillSourceFolder: z.string().refine(path.isAbsolute),
        workingDirectory: z.string().refine(path.isAbsolute)
      })
      .superRefine((localSource, context) => {
        if (localSource.kind === "command" && !localSource.command) {
          context.addIssue({
            code: "custom",
            message: "Command skill source requires a command",
            path: ["command"]
          });
        }
      })
      .optional(),
    lock: z
      .strictObject({
        commit: z.string().regex(/^[a-f\d]{40}$/u),
        digest: z.string().regex(/^[a-f\d]{64}$/u),
        importerVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
        materializerVersion: z.number().int().positive(),
        repository: z.string().min(1),
        subpath: z
          .string()
          .refine(
            (value) =>
              !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."),
            { error: "Skill source subpath must stay inside the repository" }
          ),
        updateRef: z.string().min(1)
      })
      .optional(),
    name: z
      .string()
      .regex(/^[a-z\d][a-z\d_-]*$/u)
      .optional(),
    selection: z.array(z.string().min(1)).min(1).optional(),
    skills: z
      .array(SkillImportRecipeSkillSchema, {
        error: "Skill import recipe skills must be a non-empty array"
      })
      .min(1, { error: "Skill import recipe skills must be a non-empty array" }),
    source: z.string().refine((value) => value.trim().length > 0, {
      error: "Skill import recipe source must be a non-empty string"
    })
  },
  { error: "Skill import recipe must be a JSON object" }
);
const SkillImportRecipeStoreSchema = z.strictObject(
  {
    recipes: z.array(SkillImportRecipeSchema, {
      error: "Skill import recipe store recipes must be an array"
    }),
    removedSources: z.array(z.string().min(1)).optional(),
    version: z.literal(SKILL_IMPORT_RECIPE_STORE_VERSION, {
      error: `Skill import recipe store version must be ${String(SKILL_IMPORT_RECIPE_STORE_VERSION)}`
    })
  },
  { error: "Skill import recipe store must be a JSON object" }
);

/** Recipes for one bundled or machine-local imported guidance collection. */
export type SkillImportRecipeStore = z.output<typeof SkillImportRecipeStoreSchema>;

/** Local role assigned to one selected upstream guidance item. */
export type ImportedGuidanceKind = "skill" | "reference";

/** Source-scoped recipe used to rerun a Skill import. */
export type SkillImportRecipe = z.output<typeof SkillImportRecipeSchema>;

/** Mapping between an upstream Skill import selector and local Skill slug. */
export type SkillImportRecipeSkill = z.output<typeof SkillImportRecipeSkillSchema>;

/** Keep invocation choices independently of the currently materialized selection. */
export function replaceRecipeSkills(
  recipe: SkillImportRecipe,
  skills: SkillImportRecipeSkill[]
): SkillImportRecipe {
  const overrides = { ...recipe.disableModelInvocationOverrides };
  for (const item of [...recipe.skills, ...skills]) {
    if (item.disableModelInvocation !== undefined) {
      overrides[item.selector] = item.disableModelInvocation;
    }
  }
  return {
    ...recipe,
    ...(Object.keys(overrides).length > 0 ? { disableModelInvocationOverrides: overrides } : {}),
    skills: skills.map((item) => ({
      ...item,
      ...(Object.hasOwn(overrides, item.selector)
        ? { disableModelInvocation: overrides[item.selector] }
        : {})
    }))
  };
}

/** Selector-to-slug mapping before an Import kind is assigned. */
export type StagedSkillSelection = Omit<SkillImportRecipeSkill, "kind">;

/** Input for recording newly imported skills in the recipe store. */
export interface RecordImportedGuidanceInput {
  /** Whether OpenClaw risk acceptance was recorded for this recipe. */
  acceptOpenClawRisks: boolean;
  /** Import kind applied to every selection in this invocation. */
  kind: ImportedGuidanceKind;
  /** Selector-to-slug ownership entries created by the import. */
  skills: StagedSkillSelection[];
  /** Human-facing source string passed through to upstream `skills add`. */
  source: string;
}

/** Stable code-unit ordering for persisted lock data and guidance digests. */
export function compareSkillLockStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Reads a Skill import recipe store, returning an empty store when absent. */
export function readImportRecipeStore(repoRoot: string): SkillImportRecipeStore {
  const storePath = existsSync(path.join(repoRoot, SKILL_LOCK_PATH))
    ? path.join(repoRoot, SKILL_LOCK_PATH)
    : path.join(repoRoot, LEGACY_IMPORT_RECIPE_STORE_PATH);
  if (!existsSync(storePath)) {
    return {
      recipes: [],
      version: SKILL_IMPORT_RECIPE_STORE_VERSION
    };
  }

  return normalizeImportRecipeStore(
    unwrapBoundaryResult(
      SkillImportRecipeStoreSchema.safeParse(JSON.parse(readFileSync(storePath, "utf-8"))),
      "Skill import recipe store"
    )
  );
}

/** Writes the Skill import recipe store with deterministic recipe and skill ordering. */
export function writeImportRecipeStore(repoRoot: string, store: SkillImportRecipeStore) {
  const normalizedStore = normalizeImportRecipeStore(store);
  const storePath = path.join(repoRoot, SKILL_LOCK_PATH);
  mkdirSync(path.dirname(storePath), { recursive: true });
  const temporaryStorePath = `${storePath}.tmp`;
  writeFileSync(temporaryStorePath, `${JSON.stringify(normalizedStore, null, 2)}\n`, "utf-8");
  renameSync(temporaryStorePath, storePath);
}

export function mergeImportedGuidanceIntoRecipeStore(
  store: SkillImportRecipeStore,
  input: RecordImportedGuidanceInput
) {
  if (input.skills.length === 0) {
    throw new MonkeError("At least one imported skill must be recorded");
  }

  const nextStore = normalizeImportRecipeStore(store);
  assertUniqueImportedSkillOwners(nextStore);
  const importedGuidance = input.skills.map((skill) => ({ ...skill, kind: input.kind }));

  const recipe = nextStore.recipes.find((candidate) => candidate.source === input.source);
  if (recipe) {
    if (Boolean(recipe.acceptOpenClawRisks) !== input.acceptOpenClawRisks) {
      throw new MonkeError(
        `Skill import recipe for ${input.source} already exists with a different OpenClaw risk setting`
      );
    }

    for (const skill of importedGuidance) {
      assertSkillCanBeOwnedByRecipe(nextStore, recipe, skill);
      const existingSkill = recipe.skills.find(
        (candidate) => candidate.selector === skill.selector
      );
      if (existingSkill) {
        if (existingSkill.slug !== skill.slug) {
          throw new MonkeError(
            `Skill import selector ${skill.selector} is already recorded with slug ${existingSkill.slug}`
          );
        }
        if (
          recipe.skills.some(
            (candidate) =>
              candidate !== existingSkill &&
              candidate.kind === skill.kind &&
              candidate.slug === skill.slug
          )
        ) {
          throw new MonkeError(
            `Imported ${skill.kind} slug ${skill.slug} is already owned by ${input.source}`
          );
        }
        existingSkill.kind = skill.kind;
        continue;
      }

      if (
        recipe.skills.some(
          (candidate) => candidate.kind === skill.kind && candidate.slug === skill.slug
        )
      ) {
        throw new MonkeError(
          `Imported ${skill.kind} slug ${skill.slug} is already owned by ${input.source}`
        );
      }

      recipe.skills.push(skill);
    }
  } else {
    const newRecipe: SkillImportRecipe = {
      skills: importedGuidance,
      source: input.source
    };
    if (input.acceptOpenClawRisks) {
      newRecipe.acceptOpenClawRisks = true;
    }

    for (const skill of importedGuidance) {
      assertSkillCanBeOwnedByRecipe(nextStore, newRecipe, skill);
    }

    nextStore.recipes.push(newRecipe);
  }

  return nextStore;
}

export function normalizeImportRecipeStore(input: SkillImportRecipeStore): SkillImportRecipeStore {
  const store = unwrapBoundaryResult(
    SkillImportRecipeStoreSchema.safeParse(input),
    "Skill import recipe store"
  );

  const recipes = store.recipes.map((recipe) => {
    assertUniqueRecipeSkillSelectors(recipe.source, recipe.skills);
    assertUniqueRecipeSkillSlugs(recipe.source, recipe.skills);
    return {
      ...recipe,
      skills: recipe.skills.toSorted((left, right) => {
        const slugOrder = compareSkillLockStrings(left.slug, right.slug);
        return slugOrder === 0 ? compareSkillLockStrings(left.selector, right.selector) : slugOrder;
      })
    };
  });
  assertUniqueRecipeSources(recipes);
  assertUniqueImportedSkillOwners({ recipes, version: SKILL_IMPORT_RECIPE_STORE_VERSION });
  const activeSources = new Set(recipes.map((recipe) => recipe.source));
  const removedSources = [...new Set(store.removedSources)]
    .filter((source) => !activeSources.has(source))
    .toSorted(compareSkillLockStrings);

  return {
    recipes: recipes.toSorted((left, right) => {
      const sourceOrder = compareSkillLockStrings(left.source, right.source);
      if (sourceOrder !== 0) {
        return sourceOrder;
      }

      return Number(Boolean(left.acceptOpenClawRisks)) - Number(Boolean(right.acceptOpenClawRisks));
    }),
    ...(removedSources.length > 0 ? { removedSources } : {}),
    version: SKILL_IMPORT_RECIPE_STORE_VERSION
  };
}

function assertUniqueRecipeSources(recipes: readonly SkillImportRecipe[]) {
  const sources = new Set<string>();
  const aliases = new Map<string, string>();
  for (const recipe of recipes) {
    if (sources.has(recipe.source)) {
      throw new MonkeError(`Duplicate skill import recipe source: ${recipe.source}`);
    }

    sources.add(recipe.source);
    for (const alias of new Set(
      [recipe.source, recipe.name].filter((name) => name !== undefined)
    )) {
      const owner = aliases.get(alias);
      if (owner !== undefined && owner !== recipe.source) {
        throw new MonkeError(`Duplicate Skill source name: ${alias}`);
      }
      aliases.set(alias, recipe.source);
    }
  }
}

function assertUniqueRecipeSkillSelectors(
  source: string,
  skills: readonly SkillImportRecipeSkill[]
) {
  const selectors = new Set<string>();
  for (const skill of skills) {
    if (selectors.has(skill.selector)) {
      throw new MonkeError(`Duplicate skill selector in recipe ${source}: ${skill.selector}`);
    }

    selectors.add(skill.selector);
  }
}

function assertUniqueRecipeSkillSlugs(source: string, skills: readonly SkillImportRecipeSkill[]) {
  const slugs = new Set<string>();
  for (const skill of skills) {
    if (slugs.has(skill.slug)) {
      throw new MonkeError(`Duplicate imported slug in recipe ${source}: ${skill.slug}`);
    }

    slugs.add(skill.slug);
  }
}

function assertUniqueImportedSkillOwners(store: SkillImportRecipeStore) {
  const owners = new Map<string, string>();

  for (const recipe of store.recipes) {
    for (const skill of recipe.skills) {
      const ownershipKey = `${skill.kind}:${skill.slug}`;
      const existingOwner = owners.get(ownershipKey);
      if (existingOwner !== undefined) {
        throw new MonkeError(
          `Imported ${skill.kind} slug ${skill.slug} is owned by both ${existingOwner} and ${recipe.source}`
        );
      }

      owners.set(ownershipKey, recipe.source);
    }
  }
}

function assertSkillCanBeOwnedByRecipe(
  store: SkillImportRecipeStore,
  owningRecipe: SkillImportRecipe,
  skill: SkillImportRecipeSkill
) {
  for (const recipe of store.recipes) {
    if (recipe === owningRecipe) {
      continue;
    }

    if (
      recipe.skills.some(
        (candidate) => candidate.kind === skill.kind && candidate.slug === skill.slug
      )
    ) {
      throw new MonkeError(
        `Imported ${skill.kind} slug ${skill.slug} is already owned by recipe ${recipe.source}`
      );
    }
  }
}
