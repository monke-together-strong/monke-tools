#!/usr/bin/env bun

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { confirm, isCancel } from "@clack/prompts";
import { Command } from "@commander-js/extra-typings";

import { configureCliParser, reportCliFailure } from "../src/cli-errors.ts";
import { errorMessage, MonkeError, ThrownValueSchema } from "../src/errors.ts";
import { updateLocalSkillSource } from "../src/local-skill-source.ts";
import { createRuntime } from "../src/runtime.ts";
import type { Runtime } from "../src/types.ts";
import {
  copyStagedGuidanceToManagedRoots,
  IMPORTED_REFERENCES_ROOT,
  IMPORTED_SKILLS_ROOT
} from "./import-guidance.ts";
import {
  assertSkillSelectorSlugMappingsMatchStagedSlugs,
  reportSecurityRiskAssessment,
  resolveSkillSelectorSlugMappings,
  runInstallCommand
} from "./import-skills.ts";
import type { SkillImportRecipe, SkillImportRecipeStore } from "./skill-import-recipes.ts";
import {
  normalizeImportRecipeStore,
  readImportRecipeStore,
  writeImportRecipeStore
} from "./skill-import-recipes.ts";
import {
  guidanceDigest,
  pinnedSkillSource,
  resolveSkillRevision,
  restoreLockedImports,
  withSkillImportMutation
} from "./skill-lock.ts";
import {
  openSkillComparison,
  rememberSkillGuidance,
  saveSkillComparison,
  snapshotSkillGuidance,
  snapshotSkillUpdateBaseline
} from "./skill-review.ts";
import { buildSkillsInstallArgs, listStagedSkillSlugs, runSkillsCaptured } from "./skills-cli.ts";

/** Details for an interactive staged Skill slug replacement. */
export interface SlugReplacementRequest {
  /** Local Skill slug currently recorded in the recipe store. */
  recordedSlug: string;
  /** Upstream-facing selector that produced the staged slug. */
  selector: string;
  /** Human-facing source string from the owning Skill import recipe. */
  source: string;
  /** Newly staged Skill slug produced by the upstream import. */
  stagedSlug: string;
}

/** Execution context for repository maintenance and the installed Skill CLI. */
export interface UpdateSkillsDependencies {
  /** Confirms whether an interactive update should accept a staged slug replacement. */
  confirmSlugReplacement?: (request: SlugReplacementRequest) => boolean | Promise<boolean>;
  repoRoot?: string;
  /** Runs local install after all recipe updates complete when requested. */
  runInstallCommand?: (repoRoot: string) => void;
  runtime?: Runtime;
  validatePrepared?: (preparedRoot: string, recipe: SkillImportRecipe) => void;
  /** Receives user-facing status and security assessment text. */
  writeMessage?: (message: string) => void;
}

/** Reruns all recorded Skill import recipes into their recorded managed roots. */
export async function runUpdateSkills(
  argv: string[] = process.argv.slice(2),
  dependencies: UpdateSkillsDependencies = {}
) {
  const repoRoot = dependencies.repoRoot ?? process.cwd();
  const { failure, install } = await withSkillImportMutation(
    repoRoot,
    () => updateSkills(argv, dependencies),
    dependencies.runtime
  );
  if (install) {
    (dependencies.writeMessage ?? ((message: string) => process.stdout.write(message)))(
      "Installing imported skills into configured agent roots...\n"
    );
    try {
      (dependencies.runInstallCommand ?? runInstallCommand)(repoRoot);
    } catch (error) {
      if (failure) {
        throw new MonkeError(
          `${failure.message}\nSkill installation failed: ${errorMessage(ThrownValueSchema.parse(error))}`,
          { cause: error }
        );
      }
      throw error;
    }
  }
  if (failure) {
    throw failure;
  }
}

async function updateSkills(argv: string[], dependencies: UpdateSkillsDependencies) {
  const { adapter, install, interactive } = parseCommand(argv);
  const repoRoot = dependencies.repoRoot ?? process.cwd();
  const runtime =
    dependencies.runtime ??
    createRuntime({ cwd: repoRoot, writeStdout: dependencies.writeMessage });
  let store = readImportRecipeStore(repoRoot);
  const writeMessage =
    dependencies.writeMessage ??
    ((message: string) => {
      process.stdout.write(message);
    });
  const failures: string[] = [];
  let reviewFailure: string | undefined;

  validateImportedGuidanceDirectoriesAreTracked(repoRoot, store);
  if (store.recipes.every((recipe) => recipe.localSource ?? recipe.lock)) {
    restoreLockedImports(repoRoot);
  }
  const reviewDirectory = mkdtempSync(path.join(tmpdir(), "monke-skills-review-"));
  const before = path.join(reviewDirectory, "before");
  snapshotSkillUpdateBaseline(
    repoRoot,
    before,
    store.recipes.some((recipe) => !recipe.localSource && !recipe.lock)
  );

  // Every recipe reaches the loop tail; Oxlint currently misclassifies the try/finally body.
  // oxlint-disable-next-line no-unreachable-loop
  for (const recipe of store.recipes) {
    const stagingDirectory = mkdtempSync(path.join(tmpdir(), "monke-skills-update-"));
    try {
      if (recipe.localSource) {
        // Source commands and registry writes must complete in recipe order.
        // oxlint-disable-next-line no-await-in-loop
        store = await updateLocalSkillSource({
          recipe,
          repoRoot,
          runtime,
          store,
          validatePrepared: dependencies.validatePrepared
        });
        continue;
      }
      const revision = resolveSkillRevision(recipe, repoRoot);
      const normalizedSource = pinnedSkillSource({ ...revision, digest: "" }, stagingDirectory);
      const installOutput = runSkillsCaptured(
        buildSkillsInstallArgs({
          selectors: recipe.skills.map((skill) => skill.selector),
          source: normalizedSource
        }),
        stagingDirectory,
        runtime
      );
      reportSecurityRiskAssessment(
        `${installOutput.stdout}\n${installOutput.stderr}`,
        writeMessage
      );

      // Recipe updates are serial because each accepted replacement updates the store for the next.
      // oxlint-disable-next-line no-await-in-loop
      const slugReplacements = await resolveStagedSkillReplacements({
        confirmSlugReplacement: dependencies.confirmSlugReplacement ?? promptForSlugReplacement,
        interactive,
        recipe,
        source: normalizedSource,
        stagingDirectory
      });
      const stagedGuidance = applySlugReplacementsToGuidance(recipe, slugReplacements);
      const nextStore = applySlugReplacementsToStore(store, recipe.source, stagedGuidance);
      const nextRecipe = nextStore.recipes.find((item) => item.source === recipe.source);
      if (!nextRecipe) {
        throw new MonkeError(`Missing recipe for ${recipe.source}`);
      }
      copyStagedGuidanceToManagedRoots({
        commitState() {
          writeImportRecipeStore(repoRoot, nextStore);
        },
        defaultDisableModelInvocation: recipe.disableModelInvocation,
        guidance: stagedGuidance,
        obsoleteGuidance: guidanceReplacedBySlugChanges(recipe, slugReplacements),
        repoRoot,
        stagingDirectory,
        validatePrepared(preparedRoot) {
          dependencies.validatePrepared?.(preparedRoot, nextRecipe);
          nextRecipe.lock = {
            ...revision,
            digest: guidanceDigest(preparedRoot, stagedGuidance, true)
          };
        }
      });
      store = nextStore;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${recipe.source}: ${message}`);
    } finally {
      rmSync(stagingDirectory, { force: true, recursive: true });
    }
  }

  if (store.recipes.every((recipe) => recipe.localSource ?? recipe.lock)) {
    rmSync(path.join(repoRoot, IMPORTED_SKILLS_ROOT, ".monke-imports.json"), { force: true });
  }
  for (const failure of failures) {
    writeMessage(`Skill source failed: ${failure}\n`);
  }
  try {
    await reviewSkillUpdate(repoRoot, reviewDirectory, before, runtime, adapter, writeMessage);
  } catch (error) {
    reviewFailure = error instanceof Error ? error.message : String(error);
  } finally {
    rmSync(reviewDirectory, { force: true, recursive: true });
  }

  const failure =
    failures.length > 0 || reviewFailure
      ? new MonkeError(
          [
            ...(failures.length > 0
              ? [`Skill update failed for ${failures.length} recipe(s):\n${failures.join("\n")}`]
              : []),
            ...(reviewFailure ? [reviewFailure] : [])
          ].join("\n")
        )
      : undefined;

  return { failure, install };
}

async function reviewSkillUpdate(
  repoRoot: string,
  reviewDirectory: string,
  before: string,
  runtime: Runtime,
  adapter: string | undefined,
  writeMessage: (message: string) => void
) {
  const after = path.join(reviewDirectory, "after");
  snapshotSkillGuidance(repoRoot, after);
  const comparison = await saveSkillComparison(before, after, runtime);
  if (existsSync(path.join(repoRoot, ".monke-skill-baseline"))) {
    rememberSkillGuidance(repoRoot);
  }
  if (comparison) {
    await openSkillComparison(comparison, { adapter, runtime, writeMessage });
  } else {
    writeMessage("No skill changes.\n");
  }
}

function parseCommand(argv: string[]) {
  const program = new Command()
    .name("bun run skills:update")
    .description("Update imported agent guidance from recorded recipes")
    .option("-i, --install", "Run the monke-tools skill install command after updating")
    .option("--interactive", "Prompt before accepting staged Skill slug replacements")
    .option("--adapter <adapter>", "Complete review adapter: codiff or lfv")
    .allowExcessArguments(false);

  configureCliParser(program);
  program.parse(argv, { from: "user" });

  const options = program.opts();
  return {
    adapter: options.adapter,
    install: Boolean(options.install),
    interactive: Boolean(options.interactive)
  };
}

function validateImportedGuidanceDirectoriesAreTracked(
  repoRoot: string,
  store: SkillImportRecipeStore
) {
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
  confirmSlugReplacement: (request: SlugReplacementRequest) => boolean | Promise<boolean>;
  interactive: boolean;
  recipe: SkillImportRecipe;
  source: string;
  stagingDirectory: string;
}) {
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
    selectors: recipe.skills.map((skill) => skill.selector),
    source: options.source
  });
  assertSkillSelectorSlugMappingsMatchStagedSlugs(recipe.source, selectorMappings, stagedSlugs);
  const stagedSlugBySelector = new Map(
    selectorMappings.map((mapping) => [mapping.selector, mapping.slug])
  );
  const replacements = recipe.skills.flatMap((skill) => {
    const stagedSlug = stagedSlugBySelector.get(skill.selector);
    if (!stagedSlug || stagedSlug === skill.slug) {
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
) {
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
) {
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
) {
  const replacedSelectors = new Set(replacements.map((replacement) => replacement.selector));
  return recipe.skills.filter((skill) => replacedSelectors.has(skill.selector));
}

function renderSlugMismatchMessage(
  source: string,
  missingSlugs: readonly string[],
  unexpectedSlugs: readonly string[]
) {
  return [
    `Skill slug mismatch for ${source}:`,
    `recorded ${missingSlugs.join(", ") || "(none)"}`,
    `but staged ${unexpectedSlugs.join(", ") || "(none)"}`
  ].join(" ");
}

async function promptForSlugReplacement(request: SlugReplacementRequest) {
  const accepted = await confirm({
    initialValue: false,
    message: `Staged Skill slug changed for ${request.source}: ${request.recordedSlug} -> ${request.stagedSlug}. Replace the recorded slug and imported directory?`
  });

  if (isCancel(accepted)) {
    throw new MonkeError("Skill update cancelled");
  }

  return accepted;
}

function listGuidanceDirectories(root: string) {
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

async function main() {
  try {
    await runUpdateSkills();
  } catch (error) {
    reportCliFailure(ThrownValueSchema.parse(error));
  }
}

if (import.meta.main) {
  void main();
}
