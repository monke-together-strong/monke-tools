#!/usr/bin/env bun

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as p from "@clack/prompts";
import { Command } from "@commander-js/extra-typings";

import { configureCliParser, reportCliFailure } from "../src/cli-errors.ts";
import { MonkeError } from "../src/errors.ts";
import {
  assertSkillSelectorSlugMappingsMatchStagedSlugs,
  buildSkillsInstallArgs,
  copyStagedGuidanceToManagedRoots,
  listStagedSkillSlugs,
  normalizeImportRecipeStore,
  normalizeSourceForStaging,
  IMPORTED_REFERENCES_ROOT,
  IMPORTED_SKILLS_ROOT,
  readImportRecipeStore,
  reportSecurityRiskAssessment,
  resolveSkillSelectorSlugMappings,
  runInstallCommand,
  runSkillsCaptured,
  writeImportRecipeStore
} from "./import-skills.ts";
import type { SkillImportRecipe, SkillImportRecipeStore } from "./import-skills.ts";

interface UpdateCommandOptions {
  install: boolean;
  interactive: boolean;
}

/** Details for an interactive staged Skill slug replacement. */
export interface SlugReplacementRequest {
  /** Human-facing source string from the owning Skill import recipe. */
  source: string;
  /** Upstream-facing selector that produced the staged slug. */
  selector: string;
  /** Local Skill slug currently recorded in the recipe store. */
  recordedSlug: string;
  /** Newly staged Skill slug produced by the upstream import. */
  stagedSlug: string;
}

/** Dependencies that let tests observe source-maintenance update behavior. */
export interface UpdateSkillsDependencies {
  /** Confirms whether an interactive update should accept a staged slug replacement. */
  confirmSlugReplacement?: (request: SlugReplacementRequest) => boolean | Promise<boolean>;
  /** Runs local install after all recipe updates complete when requested. */
  runInstallCommand?: (repoRoot: string) => void;
  /** Receives user-facing status and security assessment text. */
  writeMessage?: (message: string) => void;
}

/** Reruns all recorded Skill import recipes into their recorded managed roots. */
export async function runUpdateSkills(
  argv: string[] = process.argv.slice(2),
  dependencies: UpdateSkillsDependencies = {}
): Promise<void> {
  const { install, interactive } = parseCommand(argv);
  const repoRoot = process.cwd();
  let store = readImportRecipeStore(repoRoot);
  const writeMessage = dependencies.writeMessage ?? process.stdout.write.bind(process.stdout);
  const failures: string[] = [];

  validateImportedGuidanceDirectoriesAreTracked(repoRoot, store);

  // Every recipe reaches the loop tail; Oxlint currently misclassifies the try/finally body.
  // oxlint-disable-next-line no-unreachable-loop
  for (const recipe of store.recipes) {
    const stagingDirectory = mkdtempSync(path.join(tmpdir(), "monke-skills-update-"));
    try {
      const normalizedSource = normalizeSourceForStaging(recipe.source, repoRoot);
      const installOutput = runSkillsCaptured(
        buildSkillsInstallArgs({
          acceptOpenClawRisks: recipe.acceptOpenClawRisks === true,
          selectors: recipe.skills.map((skill) => skill.selector),
          source: normalizedSource
        }),
        stagingDirectory
      );
      reportSecurityRiskAssessment(
        `${installOutput.stdout}\n${installOutput.stderr}`,
        writeMessage
      );

      // Recipe updates are serial because each accepted replacement updates the store for the next.
      // oxlint-disable-next-line no-await-in-loop
      const slugReplacements = await resolveStagedSkillReplacements({
        acceptOpenClawRisks: recipe.acceptOpenClawRisks === true,
        confirmSlugReplacement: dependencies.confirmSlugReplacement ?? promptForSlugReplacement,
        interactive,
        recipe,
        source: normalizedSource,
        stagingDirectory
      });
      const stagedGuidance = applySlugReplacementsToGuidance(recipe, slugReplacements);
      const nextStore =
        slugReplacements.length > 0
          ? applySlugReplacementsToStore(store, recipe.source, stagedGuidance)
          : store;
      copyStagedGuidanceToManagedRoots({
        commitState() {
          if (slugReplacements.length > 0) {
            writeImportRecipeStore(repoRoot, nextStore);
          }
        },
        guidance: stagedGuidance,
        obsoleteGuidance: guidanceReplacedBySlugChanges(recipe, slugReplacements),
        repoRoot,
        stagingDirectory
      });
      store = nextStore;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${recipe.source}: ${message}`);
    } finally {
      rmSync(stagingDirectory, { force: true, recursive: true });
    }
  }

  if (failures.length > 0) {
    throw new MonkeError(
      `Skill update failed for ${failures.length} recipe(s):\n${failures.join("\n")}`
    );
  }

  if (install) {
    writeMessage("Installing imported skills into configured agent roots...\n");
    (dependencies.runInstallCommand ?? runInstallCommand)(repoRoot);
  }
}

function parseCommand(argv: string[]): UpdateCommandOptions {
  const program = new Command()
    .name("bun run skills:update")
    .description("Update imported agent guidance from recorded recipes")
    .option("-i, --install", "Run the monke-tools skill install command after updating")
    .option("--interactive", "Prompt before accepting staged Skill slug replacements")
    .allowExcessArguments(false);

  configureCliParser(program);
  program.parse(argv, { from: "user" });

  const options = program.opts();
  return {
    install: Boolean(options.install),
    interactive: Boolean(options.interactive)
  };
}

function validateImportedGuidanceDirectoriesAreTracked(
  repoRoot: string,
  store: SkillImportRecipeStore
): void {
  const ownedGuidance = new Set(
    store.recipes.flatMap((recipe) => recipe.skills.map((skill) => `${skill.kind}:${skill.slug}`))
  );

  for (const kind of ["skill", "reference"] as const) {
    const root = kind === "skill" ? IMPORTED_SKILLS_ROOT : IMPORTED_REFERENCES_ROOT;
    const untrackedSlugs = listGuidanceDirectories(path.join(repoRoot, root)).filter(
      (slug) => !ownedGuidance.has(`${kind}:${slug}`)
    );
    if (untrackedSlugs.length > 0) {
      throw new MonkeError(`Untracked imported ${kind} directories: ${untrackedSlugs.join(", ")}`);
    }
  }
}

async function resolveStagedSkillReplacements(options: {
  recipe: SkillImportRecipe;
  source: string;
  acceptOpenClawRisks: boolean;
  stagingDirectory: string;
  interactive: boolean;
  confirmSlugReplacement: (request: SlugReplacementRequest) => boolean | Promise<boolean>;
}): Promise<SlugReplacementRequest[]> {
  const { recipe, stagingDirectory } = options;
  const recordedSlugs = recipe.skills.map((skill) => skill.slug).toSorted();
  const stagedSlugs = listStagedSkillSlugs(stagingDirectory);
  const missingSlugs = recordedSlugs.filter((slug) => !stagedSlugs.includes(slug));
  const unexpectedSlugs = stagedSlugs.filter((slug) => !recordedSlugs.includes(slug));

  if (missingSlugs.length === 0 && unexpectedSlugs.length === 0) {
    return [];
  }

  if (!options.interactive) {
    throw new MonkeError(renderSlugMismatchMessage(recipe.source, missingSlugs, unexpectedSlugs));
  }

  const selectorMappings = resolveSkillSelectorSlugMappings({
    acceptOpenClawRisks: options.acceptOpenClawRisks,
    selectors: recipe.skills.map((skill) => skill.selector),
    source: options.source
  });
  assertSkillSelectorSlugMappingsMatchStagedSlugs(recipe.source, selectorMappings, stagedSlugs);
  const stagedSlugBySelector = new Map(
    selectorMappings.map((mapping) => [mapping.selector, mapping.slug])
  );
  const replacements = recipe.skills.flatMap((skill): SlugReplacementRequest[] => {
    const stagedSlug = stagedSlugBySelector.get(skill.selector);
    if (stagedSlug === undefined || stagedSlug === "" || stagedSlug === skill.slug) {
      return [];
    }

    return [
      {
        recordedSlug: skill.slug,
        selector: skill.selector,
        source: recipe.source,
        stagedSlug
      }
    ];
  });

  if (replacements.length === 0) {
    throw new MonkeError(renderSlugMismatchMessage(recipe.source, missingSlugs, unexpectedSlugs));
  }

  for (const replacement of replacements) {
    // Interactive confirmations must remain ordered rather than prompting concurrently.
    // oxlint-disable-next-line no-await-in-loop
    const accepted = await options.confirmSlugReplacement(replacement);
    if (!accepted) {
      throw new MonkeError(renderSlugMismatchMessage(recipe.source, missingSlugs, unexpectedSlugs));
    }
  }

  return replacements;
}

function applySlugReplacementsToStore(
  store: SkillImportRecipeStore,
  source: string,
  guidance: SkillImportRecipe["skills"]
): SkillImportRecipeStore {
  return normalizeImportRecipeStore({
    ...store,
    recipes: store.recipes.map((recipe) =>
      recipe.source === source ? { ...recipe, skills: guidance } : recipe
    )
  });
}

function applySlugReplacementsToGuidance(
  recipe: SkillImportRecipe,
  replacements: readonly SlugReplacementRequest[]
): SkillImportRecipe["skills"] {
  const stagedSlugBySelector = new Map(
    replacements.map((replacement) => [replacement.selector, replacement.stagedSlug])
  );
  return recipe.skills.map((skill) => ({
    ...skill,
    slug: stagedSlugBySelector.get(skill.selector) ?? skill.slug
  }));
}

function guidanceReplacedBySlugChanges(
  recipe: SkillImportRecipe,
  replacements: readonly SlugReplacementRequest[]
): SkillImportRecipe["skills"] {
  const replacedSelectors = new Set(replacements.map((replacement) => replacement.selector));
  return recipe.skills.filter((skill) => replacedSelectors.has(skill.selector));
}

function renderSlugMismatchMessage(
  source: string,
  missingSlugs: readonly string[],
  unexpectedSlugs: readonly string[]
): string {
  return [
    `Skill slug mismatch for ${source}:`,
    `recorded ${missingSlugs.join(", ") || "(none)"}`,
    `but staged ${unexpectedSlugs.join(", ") || "(none)"}`
  ].join(" ");
}

async function promptForSlugReplacement(request: SlugReplacementRequest): Promise<boolean> {
  const accepted = await p.confirm({
    initialValue: false,
    message: `Staged Skill slug changed for ${request.source}: ${request.recordedSlug} -> ${request.stagedSlug}. Replace the recorded slug and imported directory?`
  });

  if (p.isCancel(accepted)) {
    throw new MonkeError("Skill update cancelled");
  }

  return accepted;
}

function listGuidanceDirectories(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  return readdirSync(root)
    .filter((entry) => {
      const entryPath = path.join(root, entry);
      return statSync(entryPath).isDirectory();
    })
    .toSorted();
}

if (import.meta.main) {
  try {
    await runUpdateSkills();
  } catch (error) {
    reportCliFailure(error);
  }
}
