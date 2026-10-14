import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { confirm, isCancel } from "@clack/prompts";
import { Command } from "@commander-js/extra-typings";
import pLimit from "p-limit";

import { configureCliParser } from "../src/cli-errors.ts";
import { MonkeError } from "../src/errors.ts";
import { updateLocalSkillSource } from "../src/local-skill-source.ts";
import { createRuntime } from "../src/runtime.ts";
import type { Runtime } from "../src/types.ts";
import {
  assertManagedGuidanceRoots,
  copyStagedGuidanceToManagedRoots,
  importedGuidancePath,
  IMPORTED_REFERENCES_ROOT,
  IMPORTED_SKILLS_ROOT
} from "./import-guidance.ts";
import type {
  SkillImportRecipe,
  SkillImportRecipeSkill,
  SkillImportRecipeStore
} from "./skill-import-recipes.ts";
import {
  normalizeImportRecipeStore,
  readImportRecipeStore,
  readRepoImportRecipeStore,
  writeImportRecipeStore,
  writeRepoImportRecipeStore
} from "./skill-import-recipes.ts";
import {
  assertSkillSelectorSlugMappingsMatchStagedSlugs,
  reportSecurityRiskAssessment,
  resolveSkillSelectorSlugMappings
} from "./skill-import.ts";
import {
  assertSkillRestoreMarker,
  ignoreRepoImports,
  pruneImportedGuidance,
  rememberRestoredRecipe,
  stageGitSkillSource,
  stagedSkillGuidance,
  resolveSkillRevision,
  restoreLockedRecipe,
  withSkillImportMutation
} from "./skill-lock.ts";
import {
  openSkillComparison,
  rememberSkillGuidance,
  saveSkillComparison,
  snapshotSkillGuidance,
  snapshotSkillUpdateBaseline
} from "./skill-review.ts";
import { summarizeSkillChanges } from "./skill-summary.ts";
import { listStagedSkillSlugs } from "./skills-cli.ts";

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
  repo?: boolean;
  repoRoot?: string;
  runtime?: Runtime;
  validatePrepared?: (preparedRoot: string, recipe: SkillImportRecipe) => void;
  /** Receives user-facing status and security assessment text. */
  writeMessage?: (message: string) => void;
}

/** Reruns all recorded Skill import recipes into their recorded managed roots. */
export async function runUpdateSkills(argv: string[], dependencies: UpdateSkillsDependencies) {
  const repoRoot = dependencies.repoRoot ?? process.cwd();
  const { failure } = await withSkillImportMutation(
    repoRoot,
    () => updateSkills(argv, dependencies),
    dependencies.runtime
  );
  if (failure) {
    throw failure;
  }
}

async function updateSkills(argv: string[], dependencies: UpdateSkillsDependencies) {
  const { adapter, interactive } = parseCommand(argv);
  const repoRoot = dependencies.repoRoot ?? process.cwd();
  assertManagedGuidanceRoots(repoRoot);
  const runtime =
    dependencies.runtime ??
    createRuntime({ cwd: repoRoot, writeStdout: dependencies.writeMessage });
  let store = (dependencies.repo ? readRepoImportRecipeStore : readImportRecipeStore)(repoRoot);
  if (store.recipes.some((recipe) => !recipe.localSource)) {
    assertSkillRestoreMarker(repoRoot);
  }
  const writeMessage =
    dependencies.writeMessage ??
    ((message: string) => {
      process.stdout.write(message);
    });
  const failures: string[] = [];
  const acceptedGuidance: SkillImportRecipeSkill[] = [];
  const pendingMarkers: SkillImportRecipe[] = [];
  let reviewFailure: string | undefined;

  if (!dependencies.repo) {
    validateImportedGuidanceDirectoriesAreTracked(repoRoot, store);
  } else {
    ignoreRepoImports(repoRoot, runtime);
  }
  const reviewDirectory = mkdtempSync(path.join(tmpdir(), "monke-skills-review-"));
  const before = path.join(reviewDirectory, "before");
  const migrating = store.recipes.some((recipe) => !recipe.localSource && !recipe.commit);
  snapshotSkillUpdateBaseline(repoRoot, before, migrating, store);

  const { recipes } = store;
  const prepare = createGitSkillPreparer({
    before,
    recipes,
    repo: dependencies.repo,
    repoRoot,
    runtime
  });

  // Every recipe reaches the loop tail; Oxlint currently misclassifies the try/finally body.
  // oxlint-disable-next-line no-unreachable-loop
  for (const [index, recipe] of recipes.entries()) {
    let stagingDirectory: string | undefined;
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
        acceptedGuidance.push(
          ...recipe.skills,
          ...store.recipes
            .filter((item) => item.source === recipe.source)
            .flatMap((item) => item.skills)
        );
        continue;
      }
      // Fetch and import concurrently while publication remains in recipe order.
      // oxlint-disable-next-line no-await-in-loop
      const prepared = await prepare(recipe, index);
      const {
        assessmentOutput,
        installOutput,
        normalizedSource,
        revision,
        stagingDirectory: preparedDirectory
      } = prepared;
      stagingDirectory = preparedDirectory;
      reportSecurityRiskAssessment(assessmentOutput, writeMessage);

      // Accepted slug replacements determine the next recipe before publication.
      // oxlint-disable-next-line no-await-in-loop
      const stagedGuidance = await resolveUpdatedGuidance({
        confirmSlugReplacement: dependencies.confirmSlugReplacement ?? promptForSlugReplacement,
        declaredGuidance: installOutput.declaredGuidance,
        interactive,
        preserveImportKinds: dependencies.repo,
        recipe,
        source: normalizedSource,
        stagingDirectory
      });
      const nextStore = applySlugReplacementsToStore(
        store,
        recipe.source,
        stagedGuidance,
        installOutput.selection
      );
      const nextRecipe = nextStore.recipes.find((item) => item.source === recipe.source);
      if (!nextRecipe) {
        throw new MonkeError(`Missing recipe for ${recipe.source}`);
      }
      assertSkillRestoreMarker(repoRoot);
      copyStagedGuidanceToManagedRoots({
        commitState() {
          (dependencies.repo ? writeRepoImportRecipeStore : writeImportRecipeStore)(
            repoRoot,
            nextStore
          );
        },
        defaultDisableModelInvocation: recipe.disableModelInvocation,
        guidance: stagedGuidance,
        obsoleteGuidance: recipe.skills.filter(
          (item) =>
            !stagedGuidance.some((next) => next.kind === item.kind && next.slug === item.slug)
        ),
        repoRoot,
        stagingDirectory,
        validatePrepared(preparedRoot) {
          dependencies.validatePrepared?.(preparedRoot, nextRecipe);
          nextRecipe.commit = revision.commit;
          nextRecipe.source = revision.source;
        }
      });
      if (isDeepStrictEqual(recipe, nextRecipe)) {
        pendingMarkers.push(nextRecipe);
      } else {
        rememberRestoredRecipe(repoRoot, nextRecipe);
      }
      store = nextStore;
      acceptedGuidance.push(...recipe.skills, ...nextRecipe.skills);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${recipe.source}: ${message}`);
    } finally {
      if (stagingDirectory) {
        rmSync(stagingDirectory, { force: true, recursive: true });
      }
    }
  }

  const finalizationFailure = finalizeUpdatedImports({
    failedRecipes: failures.length > 0,
    pendingMarkers,
    repo: Boolean(dependencies.repo),
    repoRoot,
    store
  });
  for (const failure of failures) {
    writeMessage(`Skill source failed: ${failure}\n`);
  }
  if (finalizationFailure) {
    writeMessage(`${finalizationFailure}\n`);
  }
  try {
    await reviewSkillUpdate(
      repoRoot,
      reviewDirectory,
      before,
      runtime,
      adapter,
      writeMessage,
      acceptedGuidance,
      store
    );
  } catch (error) {
    reviewFailure = error instanceof Error ? error.message : String(error);
  } finally {
    rmSync(reviewDirectory, { force: true, recursive: true });
  }

  return { failure: skillUpdateFailure(failures, finalizationFailure, reviewFailure) };
}

function finalizeUpdatedImports(options: {
  failedRecipes: boolean;
  pendingMarkers: SkillImportRecipe[];
  repo: boolean;
  repoRoot: string;
  store: SkillImportRecipeStore;
}) {
  const { failedRecipes, pendingMarkers, repo, repoRoot, store } = options;
  let failure: string | undefined;
  try {
    if (repo && !failedRecipes) {
      // A rejected hand-edited selection may omit the last accepted files.
      pruneImportedGuidance(
        repoRoot,
        store.recipes.flatMap((recipe) => recipe.skills)
      );
    }
    if (!repo || !failedRecipes) {
      for (const recipe of pendingMarkers) {
        rememberRestoredRecipe(repoRoot, recipe);
      }
    }
    if (
      store.recipes.every(
        (recipe) => recipe.localSource !== undefined || recipe.commit !== undefined
      )
    ) {
      rmSync(path.join(repoRoot, IMPORTED_SKILLS_ROOT, ".monke-imports.json"), { force: true });
    }
  } catch (error) {
    failure = `Skill update finalization failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return failure;
}

function skillUpdateFailure(failures: string[], ...otherFailures: (string | undefined)[]) {
  const messages = [
    ...(failures.length > 0
      ? [`Skill update failed for ${failures.length} recipe(s):\n${failures.join("\n")}`]
      : []),
    ...otherFailures.filter((message) => message !== undefined)
  ];
  return messages.length > 0 ? new MonkeError(messages.join("\n")) : undefined;
}

function createGitSkillPreparer(options: {
  before: string;
  recipes: SkillImportRecipe[];
  repo?: boolean;
  repoRoot: string;
  runtime: Runtime;
}) {
  const { before, recipes, repoRoot, runtime } = options;
  const limit = pLimit(4);
  const prepared = new Map<
    string,
    PromiseSettledResult<Awaited<ReturnType<typeof prepareGitSkillUpdate>>>
  >();
  return async (recipe: SkillImportRecipe, index: number) => {
    if (!prepared.has(recipe.source)) {
      const group: SkillImportRecipe[] = [];
      for (const candidate of recipes.slice(index)) {
        if (candidate.localSource) {
          break;
        }
        group.push(candidate);
      }
      // Installer commands are barriers; wait for every preparation before publication.
      const results = await Promise.allSettled(
        group.map((candidate) =>
          limit(() => prepareGitSkillUpdate(repoRoot, candidate, before, runtime, options.repo))
        )
      );
      for (const [position, candidate] of group.entries()) {
        const result = results[position];
        if (result) {
          prepared.set(candidate.source, result);
        }
      }
    }
    const result = prepared.get(recipe.source);
    prepared.delete(recipe.source);
    if (!result) {
      throw new MonkeError(`Missing prepared source: ${recipe.source}`);
    }
    if (result.status === "rejected") {
      throw result.reason;
    }
    return result.value;
  };
}

async function prepareGitSkillUpdate(
  repoRoot: string,
  recipe: SkillImportRecipe,
  before: string,
  runtime: Runtime,
  repo?: boolean
) {
  const stagingDirectory = mkdtempSync(path.join(tmpdir(), "monke-skills-update-"));
  try {
    // Hand-edited repo selections may not exist at the accepted pin, so preserve
    // the captured review baseline instead of restoring that selection first.
    if (recipe.commit && !repo) {
      await restoreLockedRecipe(repoRoot, recipe, true, runtime);
      for (const item of recipe.skills) {
        const target = importedGuidancePath(before, item);
        rmSync(target, { force: true, recursive: true });
        cpSync(importedGuidancePath(repoRoot, item), target, {
          recursive: true,
          verbatimSymlinks: true
        });
      }
    }
    const revision = await resolveSkillRevision(recipe, repoRoot);
    const installOutput = await stageGitSkillSource({
      includeDeclaredImports: !repo,
      previousRecipe: repo ? undefined : recipe,
      recipe: { ...recipe, commit: revision.commit, source: revision.source },
      rejectAmbiguousSelection: recipe.selection?.includes("*"),
      repoRoot,
      retainSelection: !repo,
      runtime,
      selectFromCollection: repo,
      selectors: recipe.selection ?? recipe.skills.map((skill) => skill.selector),
      stagingDirectory
    });
    const assessmentOutput =
      installOutput.securityAssessments ?? `${installOutput.stdout}\n${installOutput.stderr}`;
    const normalizedSource = installOutput.source;
    return { assessmentOutput, installOutput, normalizedSource, revision, stagingDirectory };
  } catch (error) {
    rmSync(stagingDirectory, { force: true, recursive: true });
    throw error;
  }
}

async function reviewSkillUpdate(
  repoRoot: string,
  reviewDirectory: string,
  before: string,
  runtime: Runtime,
  adapter: string | undefined,
  writeMessage: (message: string) => void,
  acceptedGuidance: readonly SkillImportRecipeSkill[],
  store: SkillImportRecipeStore
) {
  const after = path.join(reviewDirectory, "after");
  snapshotSkillGuidance(repoRoot, after, store);
  await summarizeSkillChanges({ after, before, runtime, writeMessage });
  const comparison = await saveSkillComparison(before, after, runtime);
  if (existsSync(path.join(repoRoot, ".monke-skill-baseline"))) {
    rememberSkillGuidance(repoRoot, acceptedGuidance, store);
  }
  if (comparison) {
    await openSkillComparison(comparison, { adapter, runtime, writeMessage });
  } else {
    writeMessage("No skill changes.\n");
  }
}

function parseCommand(argv: string[]) {
  const program = new Command()
    .name("mt skills update --repo")
    .description("Update imported agent guidance from recorded recipes")
    .option("--interactive", "Prompt before accepting staged Skill slug replacements")
    .option("--adapter <adapter>", "Complete review adapter: codiff or lfv")
    .allowExcessArguments(false);

  configureCliParser(program);
  program.parse(argv, { from: "user" });

  const options = program.opts();
  return {
    adapter: options.adapter,
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

async function resolveUpdatedGuidance(options: {
  confirmSlugReplacement: (request: SlugReplacementRequest) => boolean | Promise<boolean>;
  declaredGuidance: SkillImportRecipeSkill[];
  interactive: boolean;
  preserveImportKinds?: boolean;
  recipe: SkillImportRecipe;
  source: string;
  stagingDirectory: string;
}) {
  const { recipe, stagingDirectory } = options;
  const stagedSlugs = listStagedSkillSlugs(stagingDirectory);
  if (
    recipe.selection?.includes("*") &&
    !recipe.skills.some(
      (skill) => (skill.adoptedPaths?.length ?? 0) > 0 && !stagedSlugs.includes(skill.slug)
    )
  ) {
    return stagedSkillGuidance(stagingDirectory, recipe, options.declaredGuidance, {
      preserveImportKinds: options.preserveImportKinds
    });
  }
  const replacements = await resolveStagedSkillReplacements(options);
  const staged = stagedSkillGuidance(stagingDirectory, recipe, options.declaredGuidance, {
    preserveImportKinds: options.preserveImportKinds
  });
  return applySlugReplacementsToGuidance(recipe, replacements).map((item) => ({
    ...item,
    kind: options.preserveImportKinds
      ? item.kind
      : (options.declaredGuidance.find((declared) => declared.slug === item.slug)?.kind ??
        item.kind),
    selector: staged.find((candidate) => candidate.slug === item.slug)?.selector ?? item.selector
  }));
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

  const projectedSkills = recipe.skills.filter(
    (skill) => missingSlugs.includes(skill.slug) && (skill.adoptedPaths?.length ?? 0) > 0
  );
  if (projectedSkills.length > 0) {
    throw new MonkeError(
      `Cannot replace Skill slug ${projectedSkills.map((skill) => skill.slug).join(", ")} with staged ${unexpectedSlugs.join(", ")} while adopted projections remain: ${projectedSkills.flatMap((skill) => skill.adoptedPaths ?? []).join(", ")}. Preserve this registered source and reconcile the recorded slug and projection paths explicitly before rerunning mt skills update.`
    );
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
  guidance: SkillImportRecipe["skills"],
  selection: SkillImportRecipe["selection"]
) {
  return normalizeImportRecipeStore({
    ...store,
    recipes: store.recipes.map((recipe) =>
      recipe.source === source
        ? { ...recipe, ...(selection ? { selection } : {}), skills: guidance }
        : recipe
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

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .toSorted();
}
