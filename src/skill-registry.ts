import { cpSync, existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertManagedGuidanceRoots,
  copyStagedGuidanceToManagedRoots,
  importedGuidancePath
} from "../scripts/import-guidance.ts";
import {
  normalizeImportRecipeStore,
  readImportRecipeStore,
  readRepoImportRecipeStore,
  writeRepoImportRecipeStore,
  writeImportRecipeStore
} from "../scripts/skill-import-recipes.ts";
import type { SkillImportRecipe, SkillImportRecipeStore } from "../scripts/skill-import-recipes.ts";
import { reportSecurityRiskAssessment } from "../scripts/skill-import.ts";
import {
  assertRepoImportIgnoreFile,
  assertSkillRestoreMarker,
  guidanceDigest,
  ignoreRepoImports,
  isSkillRecipeRestored,
  rememberRestoredRecipe,
  resolveSkillRevision,
  restoreLockedImports,
  stageGitSkillSource,
  stagedSkillGuidance,
  withSkillImportMutation,
  withSkillImportUpdate
} from "../scripts/skill-lock.ts";
import { rememberSkillGuidance } from "../scripts/skill-review.ts";
import { runUpdateSkills } from "../scripts/update-skills.ts";
import { MonkeError } from "./errors.ts";
import { resolveGitRepoRoot } from "./git.ts";
import { loadGlobalMonkeConfig } from "./global-config.ts";
import { withInstallMutationLockAsync } from "./install-recovery.ts";
import { updateLocalSkillSource } from "./local-skill-source.ts";
import { acquireManagedSkillSource } from "./managed-skill-source.ts";
import {
  initializeProjectSkillRegistry,
  projectSkillRegistry,
  withProjectSkillPublicationTransaction,
  withProjectSkillsLock
} from "./project-skills.ts";
import { getHomeDirectory, getMonkeHome } from "./runtime.ts";
import { withSkillPublicationTransaction } from "./skill-publication-transaction.ts";
import {
  activeGuidanceRoot,
  distributeRegistry,
  initializeSkillRegistry,
  preflightRegistryChange
} from "./skill-registry-publication.ts";
import { resolveSkillSourceFolder } from "./skill-source-discovery.ts";
import { retireAdoptedSkillLinks, skillPublicationPaths } from "./skills.ts";
import type { SkillPublicationScope } from "./skills.ts";
import type { Runtime } from "./types.ts";

type SkillsRequest =
  | { action: "create"; description?: string; name: string }
  | { action: "adopt"; name?: string; skills?: string[]; source: string }
  | {
      acceptOpenClawRisks?: boolean;
      action: "add";
      command?: string;
      cwd?: string;
      link?: boolean;
      name?: string;
      reference?: boolean;
      replace?: boolean;
      skills?: string[];
      source?: string;
    }
  | { action: "policy"; description?: string; disable?: boolean; skill?: string; source: string }
  | { action: "remove"; source: string }
  | { action: "update"; adapter?: string; interactive?: boolean }
  | { action: "list" }
  | { action: "restore" };

/** Register imports, get their content, and distribute the resulting shared collection. */
export function runSkillsRegistry(
  runtime: Runtime,
  request: SkillsRequest,
  project = false,
  repo = false
) {
  if (request.action === "add" && request.reference && !repo) {
    throw new MonkeError("--ref requires --repo");
  }

  if (request.action === "add" && request.replace && !request.skills) {
    throw new MonkeError("--replace requires --skill");
  }

  if (repo && project) {
    throw new MonkeError("--repo and --project are mutually exclusive");
  }

  if (request.action === "update") {
    return runUpdateSkills(runtime, {
      adapter: request.adapter,
      interactive: request.interactive,
      scope: repo ? "repo" : project ? "project" : "global"
    });
  }

  if (repo) {
    return runRepoSkillsRegistry(runtime, request);
  }

  if (request.action === "restore") {
    throw new MonkeError("Restore requires --repo");
  }

  if (project) {
    const context = projectSkillRegistry(runtime);

    return withProjectSkillsLock(runtime, context, async () => {
      if (request.action === "list") {
        await runSkillsRegistryLocked(runtime, request, context.root, context.root);

        return;
      }

      const scope = initializeProjectSkillRegistry(runtime, context);

      await withProjectSkillPublicationTransaction(runtime, context, scope, () =>
        runSkillsRegistryLocked(runtime, request, context.root, context.root, scope)
      );
    });
  }

  return withInstallMutationLockAsync(getMonkeHome(runtime), async () => {
    const guidance = activeGuidanceRoot(runtime);

    if (
      request.action !== "list" &&
      !loadGlobalMonkeConfig(getMonkeHome(runtime)).skillInstallPreference
    ) {
      throw new MonkeError("Select targets first with: mt skills configure");
    }

    const registry = path.join(getMonkeHome(runtime), "skill-registry");

    if (
      (request.action === "create" || request.action === "adopt") &&
      !lstatSync(registry, { throwIfNoEntry: false })
    ) {
      await withSkillPublicationTransaction(runtime, [registry], () =>
        runSkillsRegistryLocked(runtime, request, guidance)
      );

      return;
    }

    await runSkillsRegistryLocked(runtime, request, guidance);
  });
}

async function runRepoSkillsRegistry(
  runtime: Runtime,
  request: Exclude<SkillsRequest, { action: "update" }>
) {
  const root = resolveGitRepoRoot(runtime, runtime.cwd);

  const mutate = () =>
    withSkillImportMutation(
      root,
      async () => {
        if (request.action !== "list") {
          assertManagedGuidanceRoots(root);
          assertRepoImportIgnoreFile(root);
        }

        const store = readRepoImportRecipeStore(root);

        if (request.action === "list") {
          for (const recipe of store.recipes) {
            runtime.writeStdout(
              `${recipe.source}\t${recipe.commit ?? "unpinned"}\t${recipe.skills.length} skills\n`
            );
          }
        } else if (request.action === "restore") {
          await restoreLockedImports(root, false, runtime, store);
        } else if (request.action === "add") {
          if (!request.source || request.command || request.link || request.cwd || request.name) {
            throw new MonkeError(
              "Repo recipes require a Git source; --command, --link, --cwd and --name are machine-local"
            );
          }

          await addGitSkillSource(runtime, root, store, request.source, request, undefined, true);
        } else if (request.action === "remove" || request.action === "policy") {
          const recipe = findRecipe(store, request.source);

          const recipes =
            request.action === "remove"
              ? store.recipes.filter((item) => item !== recipe)
              : store.recipes.map((item) =>
                  item === recipe ? setRecipePolicy(recipe, request) : item
                );

          if (recipes.some((nextRecipe) => !isSkillRecipeRestored(root, nextRecipe))) {
            assertSkillRestoreMarker(root);
          }

          await restoreLockedImports(root, false, runtime, { ...store, recipes }, () => {
            writeRepoImportRecipeStore(root, { ...store, recipes });
          });
        } else {
          throw new MonkeError(`${request.action} is machine-local and does not accept --repo`);
        }
      },
      runtime
    );

  await (request.action === "restore" || request.action === "list"
    ? mutate()
    : withSkillImportUpdate(root, mutate, runtime));
}

async function runSkillsRegistryLocked(
  runtime: Runtime,
  request: Exclude<SkillsRequest, { action: "restore" | "update" }>,
  guidance: string,
  projectRoot?: string,
  scope?: SkillPublicationScope
) {
  const root = projectRoot ?? initializeSkillRegistry(runtime, guidance);
  const store = readImportRecipeStore(root);

  if (request.action === "list") {
    for (const recipe of store.recipes) {
      runtime.writeStdout(
        `${recipe.name ?? recipe.source}\t${recipe.localSource?.kind ?? "git"}\t${recipe.skills.length} skills\n`
      );
    }

    return;
  }

  let changedSources: string[];

  if (request.action === "create" || request.action === "adopt") {
    await acquireManagedSkillSource({
      guidanceRoot: guidance,
      async publish(source, name) {
        await addSkillSource(
          runtime,
          root,
          store,
          { action: "add", link: true, name, source },
          scope
        );
      },
      reconcile() {
        distributeRegistry(runtime, root, scope);
      },
      registryRoot: root,
      request,
      runtime,
      store
    });

    return;
  } else if (request.action === "add") {
    changedSources = await addSkillSource(runtime, root, store, request, scope);
  } else {
    const recipe = findRecipe(store, request.source);
    changedSources = [recipe.source];

    if (request.action === "remove") {
      await withSkillPublicationTransaction(
        runtime,
        [realpathSync.native(root), ...skillPublicationPaths(runtime, root, [], scope)],
        () => {
          copyStagedGuidanceToManagedRoots({
            commitState() {
              writeImportRecipeStore(root, {
                ...store,
                recipes: store.recipes.filter((item) => item !== recipe),
                removedSources: [...(store.removedSources ?? []), recipe.source]
              });
            },
            guidance: [],
            obsoleteGuidance: recipe.skills,
            repoRoot: root,
            stagingDirectory: root
          });
          completeRegistryChange(runtime, root, store, changedSources, scope);
        }
      );

      return;
    }

    const nextRecipe = setRecipePolicy(recipe, request);
    await applyRecipePolicy(runtime, root, store, nextRecipe, scope);
  }

  completeRegistryChange(runtime, root, store, changedSources, scope);
}

function completeRegistryChange(
  runtime: Runtime,
  root: string,
  store: SkillImportRecipeStore,
  changedSources: readonly string[],
  scope?: SkillPublicationScope
) {
  retireAdoptedSkillLinks(root, store);
  distributeRegistry(runtime, root, scope);
  const nextStore = readImportRecipeStore(root);
  rememberSkillGuidance(
    root,
    [...store.recipes, ...nextStore.recipes]
      .filter((recipe) => changedSources.includes(recipe.source))
      .flatMap((recipe) => recipe.skills)
  );
}

function resolveUserPath(runtime: Runtime, input: string) {
  return input.startsWith("~/")
    ? path.join(getHomeDirectory(runtime), input.slice(2))
    : path.resolve(runtime.cwd, input);
}

async function addSkillSource(
  runtime: Runtime,
  root: string,
  store: SkillImportRecipeStore,
  request: Extract<SkillsRequest, { action: "add" }>,
  scope?: SkillPublicationScope
) {
  const suppliedPath = request.source ? resolveUserPath(runtime, request.source) : undefined;
  const local = suppliedPath !== undefined && existsSync(suppliedPath);

  if (!request.command && !local) {
    if (!request.source || request.link) {
      throw new MonkeError(
        "Provide a Git source, an existing linked directory, or --command with --name"
      );
    }

    return await addGitSkillSource(runtime, root, store, request.source, request, scope);
  }

  const recipe = localSourceRecipe(
    runtime,
    store,
    request,
    local ? suppliedPath : undefined,
    scope ? root : undefined
  );

  const previous = store.recipes.find((item) => item.source === recipe.source);
  await updateLocalSkillSource({
    executeCommand: request.link !== true,
    recipe,
    repoRoot: root,
    runtime,
    store,
    validatePrepared(prepared, nextRecipe) {
      preflightRegistryChange(
        runtime,
        root,
        prepared,
        nextRecipe.skills,
        previous?.skills ?? [],
        scope
      );
    }
  });

  return [recipe.source];
}

function localSourceRecipe(
  runtime: Runtime,
  store: SkillImportRecipeStore,
  request: Extract<SkillsRequest, { action: "add" }>,
  directory?: string,
  registryRoot?: string
): SkillImportRecipe {
  const name = request.name ?? (directory ? path.basename(directory) : undefined);

  if (!name || !/^[a-z\d][a-z\d_-]*$/u.test(name)) {
    throw new MonkeError("Command imports require --name with a lowercase source identifier");
  }

  const previous = store.recipes.find((item) => (item.name ?? item.source) === name);

  if (previous && !previous.localSource) {
    throw new MonkeError(`Source ${name} is already registered as a Git import`);
  }

  const recipe: SkillImportRecipe = {
    ...previous,
    localSource: localSourceOptions(
      runtime,
      request,
      name,
      directory,
      previous?.localSource,
      registryRoot
    ),
    name,
    selection:
      previous && !request.replace
        ? previous.selection && extendSelection(previous.selection, request.skills)
        : request.skills,
    skills: previous?.skills ?? [],
    source: previous?.source ?? name
  };

  return recipe;
}

function localSourceOptions(
  runtime: Runtime,
  request: Extract<SkillsRequest, { action: "add" }>,
  name: string,
  directory?: string,
  previous?: SkillImportRecipe["localSource"],
  registryRoot?: string
): NonNullable<SkillImportRecipe["localSource"]> {
  const cwd = request.cwd
    ? resolveUserPath(runtime, request.cwd)
    : (directory ??
      previous?.workingDirectory ??
      path.join(registryRoot ?? getMonkeHome(runtime), "skill-sources", name));

  return {
    command: request.command ?? previous?.command,
    kind: (request.command ?? previous?.command) ? "command" : "link",
    skillSourceFolder: directory
      ? resolveSkillSourceFolder(
          realpathSync.native(directory),
          false,
          registryRoot !== undefined || existsSync(path.join(directory, "monke.yml"))
        )
      : request.cwd
        ? resolveSkillSourceFolder(cwd, false, registryRoot !== undefined)
        : (previous?.skillSourceFolder ??
          resolveSkillSourceFolder(cwd, false, registryRoot !== undefined)),
    workingDirectory: cwd
  };
}

async function addGitSkillSource(
  runtime: Runtime,
  root: string,
  store: SkillImportRecipeStore,
  source: string,
  request: Extract<SkillsRequest, { action: "add" }>,
  scope?: SkillPublicationScope,
  repo = false
) {
  assertSkillRestoreMarker(root);
  const revision = await resolveSkillRevision({ skills: [], source }, root);

  const previous =
    store.recipes.find((recipe) => recipe.source === source) ??
    store.recipes.find((recipe) => recipe.source === revision.source);

  const selectors =
    previous && !request.replace
      ? extendSelection(
          previous.selection ?? previous.skills.map((item) => item.selector),
          request.skills
        )
      : (request.skills ?? ["*"]);

  const recipe = gitSourceRecipe(revision.source, request, previous, repo, selectors);

  const staging = mkdtempSync(path.join(tmpdir(), "monke-skill-git-"));

  try {
    const installOutput = await stageGitSkillSource({
      includeDeclaredImports: !repo,
      previousRecipe: repo ? undefined : previous,
      recipe: { ...recipe, commit: revision.commit, source: revision.source },
      rejectAmbiguousSelection: repo || selectors.includes("*"),
      repoRoot: root,
      retainSelection: !repo && request.skills === undefined,
      runtime,
      selectors,
      stagingDirectory: staging
    });

    reportSecurityRiskAssessment(
      `${installOutput.stdout}\n${installOutput.stderr}`,
      runtime.writeStdout
    );

    const skills = stagedSkillGuidance(staging, recipe, installOutput.declaredGuidance, {
      preserveImportKinds: repo,
      references: request.reference ? (request.skills ?? selectors) : undefined
    });

    assertGitSkillSelection({
      declaredSelectors: installOutput.declaredSelectors,
      previous,
      recipe,
      repo,
      requestedSkills: request.skills,
      selectors,
      skills
    });

    const nextRecipe = {
      ...recipe,
      commit: revision.commit,
      ...(installOutput.selection ? { selection: installOutput.selection } : {}),
      skills,
      source: revision.source
    };

    const next = normalizeImportRecipeStore({
      ...store,
      recipes: [...store.recipes.filter((item) => item !== previous), nextRecipe]
    });

    assertSkillRestoreMarker(root);

    if (repo) {
      ignoreRepoImports(root, runtime);
    }

    copyStagedGuidanceToManagedRoots({
      commitState() {
        (repo ? writeRepoImportRecipeStore : writeImportRecipeStore)(root, next);
      },
      defaultDisableModelInvocation: recipe.disableModelInvocation,
      guidance: nextRecipe.skills,
      obsoleteGuidance: previous?.skills.filter(
        (item) =>
          !nextRecipe.skills.some(
            (nextItem) => nextItem.kind === item.kind && nextItem.slug === item.slug
          )
      ),
      repoRoot: root,
      stagingDirectory: staging,
      validatePrepared(prepared) {
        guidanceDigest(prepared, nextRecipe.skills, true);

        if (!repo) {
          preflightRegistryChange(
            runtime,
            root,
            prepared,
            nextRecipe.skills,
            previous?.skills ?? [],
            scope
          );
        }
      }
    });
    rememberRestoredRecipe(root, nextRecipe);

    return previous ? [previous.source, revision.source] : [revision.source];
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

function gitSourceRecipe(
  source: string,
  request: Extract<SkillsRequest, { action: "add" }>,
  previous: SkillImportRecipe | undefined,
  repo: boolean,
  selection: string[]
): SkillImportRecipe {
  return {
    ...previous,
    name: request.name ?? previous?.name,
    skills: previous?.skills ?? [],
    source,
    ...(repo ? {} : { selection }),
    ...(request.acceptOpenClawRisks ? { acceptOpenClawRisks: true as const } : {})
  };
}

/** `*` in either list selects everything. */
function extendSelection(current: string[], requested?: string[]) {
  if (!requested) {
    return current;
  }

  if (current.includes("*") || requested.includes("*")) {
    return ["*"];
  }

  return [...current, ...requested.filter((selector) => !current.includes(selector))];
}

function assertGitSkillSelection(options: {
  declaredSelectors: string[];
  previous?: SkillImportRecipe;
  recipe: SkillImportRecipe;
  repo: boolean;
  requestedSkills?: string[];
  selectors: string[];
  skills: SkillImportRecipe["skills"];
}) {
  const { declaredSelectors, previous, recipe, repo, requestedSkills, selectors, skills } = options;

  if (repo || requestedSkills !== undefined) {
    assertSkillSelectorsMatched(recipe.source, selectors, skills, declaredSelectors);

    return;
  }

  if (!previous || selectors.includes("*")) {
    return;
  }

  const missing = previous.skills.filter((item) => !skills.some((next) => next.slug === item.slug));

  if (missing.length > 0) {
    throw new MonkeError(
      `Selected skills not found in ${recipe.source}: ${missing.map((item) => item.slug).join(", ")}`
    );
  }
}

function assertSkillSelectorsMatched(
  source: string,
  selectors: string[],
  skills: SkillImportRecipe["skills"],
  aliases: string[]
) {
  if (selectors.includes("*")) {
    return;
  }

  const names = new Set(
    [...skills.map((skill) => skill.selector), ...aliases].map((name) => name.toLowerCase())
  );

  const missing = selectors.filter((selector) => !names.has(selector.toLowerCase()));

  if (missing.length > 0) {
    throw new MonkeError(`Selected skills not found in ${source}: ${missing.join(", ")}`);
  }
}

function findRecipe(store: SkillImportRecipeStore, source: string) {
  const recipe = store.recipes.find((item) => item.source === source || item.name === source);

  if (!recipe) {
    throw new MonkeError(`Unknown Skill source: ${source}`);
  }

  return recipe;
}

function setRecipePolicy(
  recipe: SkillImportRecipe,
  request: Extract<SkillsRequest, { action: "policy" }>
): SkillImportRecipe {
  if (request.disable === undefined && request.description === undefined) {
    throw new MonkeError("Provide --model-invocation or --description");
  }

  if (request.description !== undefined) {
    if (!request.skill) {
      throw new MonkeError("--description requires a Skill slug");
    }

    if (request.description.trim().length === 0) {
      throw new MonkeError("Skill description must be a non-empty string");
    }
  }

  if (!request.skill) {
    return { ...recipe, disableModelInvocation: request.disable };
  }

  if (!recipe.skills.some((item) => item.kind === "skill" && item.slug === request.skill)) {
    throw new MonkeError(`Unknown Skill ${request.skill} in ${recipe.source}`);
  }

  return {
    ...recipe,
    skills: recipe.skills.map((item) =>
      item.slug === request.skill
        ? {
            ...item,
            ...(request.description !== undefined ? { description: request.description } : {}),
            ...(request.disable !== undefined ? { disableModelInvocation: request.disable } : {})
          }
        : item
    )
  };
}

async function applyRecipePolicy(
  runtime: Runtime,
  root: string,
  store: SkillImportRecipeStore,
  recipe: SkillImportRecipe,
  scope?: SkillPublicationScope
) {
  if (recipe.localSource) {
    await updateLocalSkillSource({
      executeCommand: false,
      recipe,
      repoRoot: root,
      runtime,
      store,
      validatePrepared(prepared, nextRecipe) {
        preflightRegistryChange(runtime, root, prepared, nextRecipe.skills, recipe.skills, scope);
      }
    });

    return;
  }

  assertSkillRestoreMarker(root);
  const staging = mkdtempSync(path.join(tmpdir(), "monke-skill-policy-"));

  const next = normalizeImportRecipeStore({
    ...store,
    recipes: store.recipes.map((item) => (item.source === recipe.source ? recipe : item))
  });

  try {
    const skills = recipe.skills.filter((item) => item.kind === "skill");

    for (const item of skills) {
      cpSync(importedGuidancePath(root, item), path.join(staging, ".agents", "skills", item.slug), {
        recursive: true,
        verbatimSymlinks: true
      });
    }

    copyStagedGuidanceToManagedRoots({
      commitState() {
        writeImportRecipeStore(root, next);
      },
      defaultDisableModelInvocation: recipe.disableModelInvocation,
      guidance: skills,
      repoRoot: root,
      stagingDirectory: staging,
      validatePrepared(prepared) {
        preflightRegistryChange(runtime, root, prepared, recipe.skills, recipe.skills, scope);

        for (const item of recipe.skills.filter((entry) => entry.kind === "reference")) {
          cpSync(importedGuidancePath(root, item), path.join(prepared, item.kind, item.slug), {
            recursive: true,
            verbatimSymlinks: true
          });
        }

        guidanceDigest(prepared, recipe.skills, true);
      }
    });
    rememberRestoredRecipe(root, recipe);
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}
