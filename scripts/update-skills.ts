import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { confirm, isCancel } from "@clack/prompts";
import { Command } from "@commander-js/extra-typings";
import pLimit from "p-limit";

import { configureCliParser } from "../src/cli-errors.ts";
import { MonkeError } from "../src/errors.ts";
import { updateLocalSkillSource } from "../src/local-skill-source.ts";
import { createRuntime, getMonkeHome } from "../src/runtime.ts";
import { sha256 } from "../src/sha256.ts";
import { resolveSkillPath } from "../src/skill-path.ts";
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
  describeSkillSource,
  guidanceDigest,
  ignoreRepoImports,
  isSkillRecipeRestored,
  pruneImportedGuidance,
  rememberRestoredRecipe,
  stageGitSkillSource,
  SKILL_RESTORE_MARKER,
  stagedSkillGuidance,
  resolveSkillRevision,
  restoreLockedRecipe,
  withSkillImportMutation,
  withSkillImportUpdate
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
  /** Editable publisher checkouts whose declarations advance before installed copies. */
  connectedRepos?: string[];
  /** Publish the installed collection, completing recovery before final review snapshots. */
  publishCollection?: (
    update: () => Promise<void>,
    withSnapshotLocks: (recover: () => Promise<void>) => Promise<void>
  ) => Promise<void>;
  /** Local publisher checkouts whose files may overlap project recovery snapshots. */
  publisherRepos?: string[];
  /** Apply monke-tools' import declarations after the review baseline, returning changed guidance. */
  reconcile?: () => SkillImportRecipeSkill[];
  repo?: boolean;
  repoRoot?: string;
  runtime?: Runtime;
  validatePrepared?: (preparedRoot: string, recipe: SkillImportRecipe) => void;
  /** Receives user-facing status and security assessment text. */
  writeMessage?: (message: string) => void;
}

/** Reruns all recorded Skill import recipes into their recorded managed roots. */
export async function runUpdateSkills(argv: string[], dependencies: UpdateSkillsDependencies) {
  const options = parseCommand(argv);
  const repoRoot = dependencies.repoRoot ?? process.cwd();
  const runtime = dependencies.runtime ?? createRuntime({ cwd: repoRoot });
  const writeMessage = dependencies.writeMessage ?? runtime.writeStdout;
  const reviewDirectory = mkdtempSync(path.join(tmpdir(), "monke-skills-review-"));
  const before = path.join(reviewDirectory, "before");
  const after = path.join(reviewDirectory, "after");
  const collections: string[] = [];
  const updatedCollections: Awaited<ReturnType<typeof updateSkills>>[] = [];
  const revisions = new Map<string, ReturnType<typeof resolveSkillRevision>>();
  const failures: string[] = [];
  let comparison: Awaited<ReturnType<typeof saveSkillComparison>>;
  const connected = new Set<string>();
  const connectedDirectories = new Set(dependencies.connectedRepos);
  const registryRoot = realpathSync.native(repoRoot);
  const lockedRepositories = new Set([registryRoot]);

  for (const directory of [...connectedDirectories, ...(dependencies.publisherRepos ?? [])]) {
    try {
      const root = resolveSkillPath(directory).resolved;
      lockedRepositories.add(root);

      if (connectedDirectories.has(directory) && root !== registryRoot) {
        connected.add(root);
      }
    } catch (cause) {
      failures.push(`${directory}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  try {
    const roots = [...lockedRepositories].toSorted();
    await withSkillLocks([registryRoot, ...connected].toSorted(), runtime, async () => {
      for (const root of connected) {
        const collection = path.join(
          "repositories",
          `${path.basename(root)}-${sha256(root).slice(0, 8)}`
        );

        collections.push(collection);

        try {
          if (
            readRepoImportRecipeStore(root).recipes.length === 0 &&
            !existsSync(path.join(root, SKILL_RESTORE_MARKER))
          ) {
            collections.pop();
            continue;
          }

          writeMessage(`Updating repo imports: ${root}\n`);

          // Publisher updates run in connection order before consumer publication.
          // oxlint-disable-next-line no-await-in-loop
          const result = await withSkillImportMutation(
            root,
            () =>
              updateSkills(
                options.interactive,
                {
                  confirmSlugReplacement: dependencies.confirmSlugReplacement,
                  repo: true,
                  repoRoot: root,
                  runtime,
                  writeMessage
                },
                path.join(before, collection),
                path.join(after, collection),
                revisions,
                registryRoot
              ),
            runtime
          );

          if (result.failure) {
            failures.push(`${root}: ${result.failure.message}`);
          }

          updatedCollections.push(result);
        } catch (cause) {
          failures.push(`${root}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }

      try {
        const update = async () => {
          const result = await withSkillImportMutation(
            repoRoot,
            () =>
              updateSkills(
                options.interactive,
                dependencies,
                before,
                after,
                revisions,
                registryRoot
              ),
            runtime
          );

          updatedCollections.push(result);

          if (result.failure) {
            failures.push(result.failure.message);
          }
        };

        await (dependencies.publishCollection
          ? dependencies.publishCollection(update, (recover) =>
              withSkillLocks(roots, runtime, recover, withSkillImportMutation)
            )
          : update());
      } catch (cause) {
        failures.push(cause instanceof Error ? cause.message : String(cause));
      }

      // Consumer restoration can change publisher files, so capture final bytes last.
      let capturedCollections = 0;

      for (const collection of updatedCollections) {
        try {
          // oxlint-disable-next-line no-await-in-loop
          await collection.snapshotAfter();
          capturedCollections += 1;
        } catch (cause) {
          failures.push(cause instanceof Error ? cause.message : String(cause));
        }
      }

      // Include every publisher and the consumer before saving or accepting baselines.
      if (capturedCollections !== collections.length + 1) {
        return;
      }

      try {
        await summarizeSkillChanges({ after, before, collections, runtime, writeMessage });
        comparison = await saveSkillComparison(before, after, runtime);

        // A failed save must leave prior baselines available for the next review.
        for (const collection of updatedCollections) {
          try {
            collection.rememberBaseline();
          } catch (cause) {
            failures.push(cause instanceof Error ? cause.message : String(cause));
          }
        }
      } catch (cause) {
        failures.push(cause instanceof Error ? cause.message : String(cause));
      }
    });

    try {
      if (comparison) {
        await openSkillComparison(comparison, { adapter: options.adapter, runtime, writeMessage });
      } else if (failures.length === 0) {
        writeMessage("No skill changes.\n");
      }
    } catch (cause) {
      failures.push(cause instanceof Error ? cause.message : String(cause));
    }
  } finally {
    rmSync(reviewDirectory, { force: true, recursive: true });
  }

  if (failures.length > 0) {
    throw new MonkeError(failures.join("\n"));
  }
}

// Reserve accepted declarations for the update; materialization locks also protect snapshots.
async function withSkillLocks(
  roots: string[],
  runtime: Runtime,
  update: () => Promise<void>,
  lock = withSkillImportUpdate
): Promise<void> {
  const [root, ...remaining] = roots;

  if (root === undefined) {
    await update();

    return;
  }

  await lock(root, () => withSkillLocks(remaining, runtime, update, lock), runtime);
}

async function updateSkills(
  interactive: boolean,
  dependencies: UpdateSkillsDependencies,
  before: string,
  after: string,
  revisions: Map<string, ReturnType<typeof resolveSkillRevision>>,
  reviewOwner: string
) {
  const repoRoot = dependencies.repoRoot ?? process.cwd();
  assertManagedGuidanceRoots(repoRoot);

  const runtime =
    dependencies.runtime ??
    createRuntime({ cwd: repoRoot, writeStdout: dependencies.writeMessage });

  const readStore = dependencies.repo ? readRepoImportRecipeStore : readImportRecipeStore;
  let store = readStore(repoRoot);

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

  if (!dependencies.repo) {
    validateImportedGuidanceDirectoriesAreTracked(repoRoot, store);
  } else {
    ignoreRepoImports(repoRoot, runtime);
  }

  const migrating = store.recipes.some((recipe) => !recipe.localSource && !recipe.commit);

  const forgetBefore = snapshotUpdateBefore({
    before,
    migrating,
    repo: dependencies.repo,
    repoRoot,
    reviewOwner,
    runtime,
    store
  });

  if (dependencies.reconcile) {
    acceptedGuidance.push(...dependencies.reconcile());
    store = readStore(repoRoot);
  }

  const { recipes } = store;

  const prepare = createGitSkillPreparer({
    before,
    recipes,
    repo: dependencies.repo,
    repoRoot,
    revisions,
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

      if (!prepared) {
        acceptedGuidance.push(...recipe.skills);
        continue;
      }

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
          guidanceDigest(preparedRoot, nextRecipe.skills, true);
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
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
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

  let reviewedStore: SkillImportRecipeStore | undefined;

  return {
    failure: skillUpdateFailure(failures, finalizationFailure),
    rememberBaseline: () => {
      if (reviewedStore) {
        if (existsSync(path.join(repoRoot, ".monke-skill-baseline"))) {
          rememberSkillGuidance(repoRoot, acceptedGuidance, reviewedStore);
        }

        forgetBefore?.();
      }
    },
    snapshotAfter: () =>
      withSkillImportMutation(
        repoRoot,
        () => {
          // Publication recovery may have restored the installed collection's store.
          const currentStore = readStore(repoRoot);
          snapshotSkillGuidance(repoRoot, after, currentStore);
          snapshotRepoDeclaration(repoRoot, after, dependencies.repo);
          reviewedStore = currentStore;
        },
        runtime
      )
  };
}

function snapshotUpdateBefore(options: {
  before: string;
  migrating: boolean;
  repo?: boolean;
  repoRoot: string;
  reviewOwner: string;
  runtime: Runtime;
  store: SkillImportRecipeStore;
}) {
  const { before, migrating, repoRoot, runtime, store } = options;

  if (!options.repo) {
    snapshotSkillUpdateBaseline(repoRoot, before, migrating, store);

    return;
  }

  const home = getMonkeHome(runtime);
  const key = sha256(realpathSync.native(repoRoot));
  const retained = path.join(home, "skill-update-baselines", key, sha256(options.reviewOwner));

  // Each consumer owns its retry baseline, even if another consumer saves a review.
  // The lock on accepted declarations covers this snapshot until the review is saved.
  if (!existsSync(retained)) {
    mkdirSync(path.dirname(retained), { mode: 0o700, recursive: true });
    const staging = mkdtempSync(`${retained}-`);

    try {
      snapshotSkillUpdateBaseline(repoRoot, staging, migrating, store);
      snapshotRepoDeclaration(repoRoot, staging, true);
      renameSync(staging, retained);
    } finally {
      rmSync(staging, { force: true, recursive: true });
    }
  }

  cpSync(retained, before, { recursive: true, verbatimSymlinks: true });

  return () => {
    rmSync(retained, { force: true, recursive: true });
  };
}

function snapshotRepoDeclaration(repoRoot: string, destination: string, repo = false) {
  const file = path.join(repoRoot, "monke.yml");

  if (repo && existsSync(file)) {
    cpSync(file, path.join(destination, "monke.yml"));
  }
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
  } catch (cause) {
    failure = `Skill update finalization failed: ${cause instanceof Error ? cause.message : String(cause)}`;
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
  revisions: Map<string, ReturnType<typeof resolveSkillRevision>>;
  runtime: Runtime;
}) {
  const { before, recipes, repoRoot, runtime } = options;
  const limit = pLimit(8);

  const prepared = new Map<
    string,
    Promise<PromiseSettledResult<Awaited<ReturnType<typeof prepareGitSkillUpdate>>>[]>
  >();

  // Settle each preparation so its failure surfaces when publication reaches its recipe.
  const start = (recipe: SkillImportRecipe) => {
    prepared.set(
      recipe.source,
      Promise.allSettled([
        limit(() =>
          prepareGitSkillUpdate(repoRoot, recipe, before, runtime, options.revisions, options.repo)
        )
      ])
    );
  };

  // Installer commands cannot change remote sources, so their preparation need not wait.
  for (const recipe of recipes) {
    if (!recipe.localSource && isRemoteSkillSource(recipe, repoRoot)) {
      start(recipe);
    }
  }

  return async (recipe: SkillImportRecipe, index: number) => {
    // Local Git sources prepare after earlier installer commands, which may change them.
    if (!prepared.has(recipe.source)) {
      for (const candidate of recipes.slice(index)) {
        if (candidate.localSource) {
          break;
        }

        if (!prepared.has(candidate.source)) {
          start(candidate);
        }
      }
    }

    const [result] = (await prepared.get(recipe.source)) ?? [];
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

function isRemoteSkillSource(recipe: SkillImportRecipe, repoRoot: string) {
  try {
    return !path.isAbsolute(describeSkillSource(recipe.source, repoRoot).repository);
  } catch {
    // An earlier installer command may create this local path.
    return false;
  }
}

async function prepareGitSkillUpdate(
  repoRoot: string,
  recipe: SkillImportRecipe,
  before: string,
  runtime: Runtime,
  revisions: Map<string, ReturnType<typeof resolveSkillRevision>>,
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

    const revisionKey = JSON.stringify([
      recipe.source,
      describeSkillSource(recipe.source, repoRoot)
    ]);

    let pendingRevision = revisions.get(revisionKey);

    if (!pendingRevision) {
      pendingRevision = resolveSkillRevision(recipe, repoRoot);
      revisions.set(revisionKey, pendingRevision);
    }

    const revision = await pendingRevision;

    // Restaging an intact restore at its current pin would reproduce the same guidance.
    if (
      revision.commit === recipe.commit &&
      revision.source === recipe.source &&
      isSkillRecipeRestored(repoRoot, recipe)
    ) {
      rmSync(stagingDirectory, { force: true, recursive: true });

      return;
    }

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
  } catch (cause) {
    rmSync(stagingDirectory, { force: true, recursive: true });
    throw cause;
  }
}

function parseCommand(argv: string[]) {
  const program = new Command()
    .name("mt skills update --repo")
    .description("Update imported agent guidance from recorded recipes")
    .option("--interactive", "Prompt before accepting staged Skill slug replacements")
    .option("--adapter <adapter>", "Complete review adapter: codiff or ms")
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
