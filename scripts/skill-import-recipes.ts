import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import is from "@sindresorhus/is";
import { Document, isMap, isNode, isScalar, isSeq, parseDocument } from "yaml";
import type { YAMLMap } from "yaml";
import * as z from "zod";

import { MonkeError } from "../src/errors.ts";
import { unwrapBoundaryResult } from "../src/validation.ts";
import { IMPORTED_SKILLS_ROOT } from "./import-guidance.ts";

export const SKILL_LOCK_PATH = "skills.lock.json";
const SKILL_IMPORT_RECIPE_STORE_VERSION = 4 as const;
const LEGACY_IMPORT_RECIPE_STORE_PATH = path.join(IMPORTED_SKILLS_ROOT, ".monke-imports.json");
const SkillImportRecipeSkillSchema = z.strictObject(
  {
    adoptedPaths: z.array(z.string().refine(path.isAbsolute)).optional(),
    description: z
      .string()
      .refine((value) => value.trim().length > 0)
      .optional(),
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
    commit: z
      .string()
      .regex(/^[a-f\d]{40}$/u)
      .optional(),
    disableModelInvocation: z.boolean().optional(),
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

/** Selector-to-slug mapping before an Import kind is assigned. */
export type StagedSkillSelection = Omit<SkillImportRecipeSkill, "kind">;

/** Stable code-unit ordering for persisted lock data and guidance digests. */
export function compareSkillLockStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const RecipeSelectionSchema = z
  .union([
    z.string().min(1),
    z.strictObject({
      adoptedPaths: z.array(z.string().refine(path.isAbsolute)).optional(),
      description: z.string().trim().min(1).optional(),
      kind: z.enum(["skill", "reference"]).optional(),
      modelInvocation: z.enum(["allow", "deny"]).optional(),
      selector: z.string().min(1).optional(),
      slug: z.string().min(1)
    })
  ])
  .transform((selection) => {
    const item = is.string(selection) ? { slug: selection } : selection;
    const { modelInvocation, ...skill } = item;
    return {
      ...skill,
      kind: skill.kind ?? ("skill" as const),
      selector: skill.selector ?? skill.slug,
      ...(modelInvocation === undefined
        ? {}
        : { disableModelInvocation: modelInvocation === "deny" })
    };
  });
const RecipeFields = {
  acceptOpenClawRisks: z.literal(true).optional(),
  commit: z
    .string()
    .regex(/^[a-f\d]{40}$/u)
    .optional(),
  modelInvocation: z.enum(["allow", "deny"]).optional(),
  skills: z.array(RecipeSelectionSchema).min(1),
  source: z.string().trim().min(1)
};
const CompactRecipeSchema = z
  .strictObject({
    ...RecipeFields,
    localSource: SkillImportRecipeSchema.shape.localSource,
    name: SkillImportRecipeSchema.shape.name,
    selection: SkillImportRecipeSchema.shape.selection
  })
  .transform(({ modelInvocation, ...recipe }) => ({
    ...recipe,
    ...(modelInvocation === undefined ? {} : { disableModelInvocation: modelInvocation === "deny" })
  }));
export const RepoImportRecipesSchema = z.array(
  z.strictObject(RecipeFields).transform(({ modelInvocation, ...recipe }) => ({
    ...recipe,
    ...(modelInvocation === undefined ? {} : { disableModelInvocation: modelInvocation === "deny" })
  }))
);
const CompactStoreSchema = z.strictObject({
  recipes: z.array(CompactRecipeSchema),
  removedSources: z.array(z.string().min(1)).optional(),
  version: z.literal(SKILL_IMPORT_RECIPE_STORE_VERSION)
});
const LegacyStoreSchema = z
  .object({
    recipes: z.array(
      SkillImportRecipeSchema.extend({
        lock: z
          .object({
            commit: z.string().regex(/^[a-f\d]{40}$/u),
            repository: z.string().min(1),
            subpath: z.string(),
            updateRef: z.string().min(1)
          })
          .optional()
      })
    ),
    removedSources: z.array(z.string().min(1)).optional(),
    version: z.literal(3)
  })
  .transform((store) => ({
    ...store,
    recipes: store.recipes.map(({ lock, ...recipe }) => ({
      ...recipe,
      commit: lock?.commit,
      source:
        lock?.updateRef.includes("/") &&
        /^(?:https?:\/\/github\.com\/)?[^/\s:]+\/[^/#\s]+\/tree\//u.test(recipe.source)
          ? `${lock.repository.replace(/\.git$/u, "")}${lock.subpath ? `/${lock.subpath}` : ""}#${lock.updateRef}`
          : recipe.source
    })),
    version: SKILL_IMPORT_RECIPE_STORE_VERSION
  }));

/** Read machine-local recipes, or the publishing repo's declaration. */
export function readImportRecipeStore(repoRoot: string, migrate = true): SkillImportRecipeStore {
  const config = path.join(repoRoot, "monke.yml");
  if (existsSync(config) && parseDocument(readFileSync(config, "utf-8")).has("skills")) {
    return readRepoImportRecipeStore(repoRoot);
  }
  const storePath = existsSync(path.join(repoRoot, SKILL_LOCK_PATH))
    ? path.join(repoRoot, SKILL_LOCK_PATH)
    : path.join(repoRoot, LEGACY_IMPORT_RECIPE_STORE_PATH);
  if (!existsSync(storePath)) {
    return readRepoImportRecipeStore(repoRoot);
  }
  const input: unknown = JSON.parse(readFileSync(storePath, "utf-8"));
  const store = normalizeImportRecipeStore(
    unwrapBoundaryResult(
      z.union([CompactStoreSchema, LegacyStoreSchema]).safeParse(input),
      "Skill import recipe store"
    )
  );
  if (migrate && LegacyStoreSchema.safeParse(input).success) {
    writeImportRecipeStore(repoRoot, store);
  }
  return store;
}

export function readRepoImportRecipeStore(repoRoot: string): SkillImportRecipeStore {
  const file = path.join(repoRoot, "monke.yml");
  if (!existsSync(file)) {
    return { recipes: [], version: SKILL_IMPORT_RECIPE_STORE_VERSION };
  }
  const document = parseDocument(readFileSync(file, "utf-8"));
  if (document.errors.length) {
    throw new MonkeError(`Invalid ${file}: ${document.errors[0]?.message}`);
  }
  const skills = document.get("skills", true);
  const recipes = unwrapBoundaryResult(
    RepoImportRecipesSchema.safeParse(isNode(skills) ? skills.toJSON() : []),
    `Repo import recipes in ${file}`
  );
  return normalizeImportRecipeStore({ recipes, version: SKILL_IMPORT_RECIPE_STORE_VERSION });
}

function compactRecipe(recipe: SkillImportRecipe) {
  const { disableModelInvocation, skills, ...fields } = recipe;
  return {
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    ...(disableModelInvocation === undefined
      ? {}
      : { modelInvocation: disableModelInvocation ? "deny" : "allow" }),
    skills: skills.map(
      ({ disableModelInvocation: disable, kind, selector, slug, ...overrides }) => {
        if (
          kind === "skill" &&
          selector === slug &&
          disable === undefined &&
          Object.keys(overrides).length === 0
        ) {
          return slug;
        }
        return {
          slug,
          ...(selector === slug ? {} : { selector }),
          ...(kind === "skill" ? {} : { kind }),
          ...(disable === undefined ? {} : { modelInvocation: disable ? "deny" : "allow" }),
          ...overrides
        };
      }
    )
  };
}

/** Keep deterministic compact recipes in machine-local JSON. */
export function writeImportRecipeStore(repoRoot: string, store: SkillImportRecipeStore) {
  const normalized = normalizeImportRecipeStore(store);
  const storePath = path.join(repoRoot, SKILL_LOCK_PATH);
  mkdirSync(path.dirname(storePath), { recursive: true });
  const temporaryStorePath = `${storePath}.tmp`;
  writeFileSync(
    temporaryStorePath,
    `${JSON.stringify({ ...normalized, recipes: normalized.recipes.map(compactRecipe) }, null, 2)}\n`,
    "utf-8"
  );
  renameSync(temporaryStorePath, storePath);
}

/** Change only the skills YAML node, preserving the rest of the document. */
export function writeRepoImportRecipeStore(repoRoot: string, store: SkillImportRecipeStore) {
  const file = path.join(repoRoot, "monke.yml");
  const original = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const document = parseDocument(original, { keepSourceTokens: true });
  if (document.errors.length) {
    throw new MonkeError(`Invalid ${file}: ${document.errors[0]?.message}`);
  }
  const { contents } = document;
  const empty =
    isScalar(contents) && contents.value === null && contents.range?.[0] === contents.range?.[1];
  if (contents && !isMap(contents) && !empty) {
    throw new MonkeError(`${file} must be a YAML mapping`);
  }
  const recipes = normalizeImportRecipeStore(store).recipes.map(compactRecipe);
  unwrapBoundaryResult(RepoImportRecipesSchema.safeParse(recipes), "Repo import recipes");
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, editRepoSkillsYaml(original, document, recipes));
  renameSync(temporary, file);
}

function editRepoSkillsYaml(
  original: string,
  document: Document.Parsed,
  recipes: ReturnType<typeof compactRecipe>[]
) {
  const { contents } = document;
  const previous = document.get("skills", true);
  const replacement = new Document(recipes);
  if (isSeq(replacement.contents)) {
    replacement.contents.flow =
      (isSeq(previous) && previous.flow === true) || (isMap(contents) && contents.flow === true);
  }
  const value = replacement.toString({ lineWidth: 0 }).replace(/\n$/u, "");
  if (isNode(previous) && previous.range) {
    const [start, end] = previous.range;
    const indent = original.slice(original.lastIndexOf("\n", start - 1) + 1, start);
    const rendered =
      isSeq(previous) && previous.flow !== true ? value.replaceAll("\n", `\n${indent}`) : value;
    const newline = original.slice(start, end).endsWith("\n") ? "\n" : "";
    return `${original.slice(0, start)}${rendered}${newline}${original.slice(end)}`;
  }
  if (isMap(contents) && contents.flow === true) {
    return appendFlowSkillsYaml(original, contents, value);
  }
  const [, end] = document.range;
  const prefix = original.slice(0, end);
  const newline = prefix.length > 0 && !prefix.endsWith("\n") ? "\n" : "";
  const indent = isMap(contents)
    ? original.slice(original.lastIndexOf("\n", contents.range[0] - 1) + 1, contents.range[0])
    : "";
  const addition = new Document({ skills: recipes })
    .toString({ lineWidth: 0 })
    .replaceAll(/^(?=.)/gmu, indent);
  return `${prefix}${newline}${addition}${original.slice(end)}`;
}

function appendFlowSkillsYaml(original: string, contents: YAMLMap.Parsed, value: string) {
  const end = contents.range[1] - 1;
  const token = contents.srcToken;
  const last = token?.type === "flow-collection" ? token.items.at(-1) : undefined;
  const trailingComma =
    last?.key === undefined &&
    last?.value === undefined &&
    last?.start.some((item) => item.type === "comma") === true;
  const separator = contents.items.length > 0 && !trailingComma ? ", " : "";
  return `${original.slice(0, end)}${separator}skills: ${value}${original.slice(end)}`;
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
