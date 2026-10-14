import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync
} from "node:fs";
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
  SKILL_LOCK_PATH,
  writeImportRecipeStore
} from "../scripts/skill-import-recipes.ts";
import type { SkillImportRecipe, SkillImportRecipeStore } from "../scripts/skill-import-recipes.ts";
import { reportSecurityRiskAssessment } from "../scripts/skill-import.ts";
import {
  assertRepoImportIgnoreFile,
  ignoreRepoImports,
  rememberRestoredRecipe,
  resolveSkillRevision,
  restoreLockedImports,
  stageGitSkillSource,
  stagedSkillGuidance,
  withSkillImportMutation
} from "../scripts/skill-lock.ts";
import { rememberSkillGuidance } from "../scripts/skill-review.ts";
import { runUpdateSkills } from "../scripts/update-skills.ts";
import { MonkeError } from "./errors.ts";
import { resolveGitRepoRoot } from "./git.ts";
import { loadGlobalMonkeConfig } from "./global-config.ts";
import { loadActiveToolInstall } from "./install-manifest.ts";
import { withInstallMutationLockAsync } from "./install-recovery.ts";
import { updateLocalSkillSource } from "./local-skill-source.ts";
import { acquireManagedSkillSource } from "./managed-skill-source.ts";
import {
  initializeProjectSkillRegistry,
  projectSkillRegistry,
  reconcileProjectSkillRegistry,
  withProjectSkillPublicationTransaction,
  withProjectSkillsLock
} from "./project-skills.ts";
import { getHomeDirectory, getMonkeHome } from "./runtime.ts";
import { withSkillPublicationTransaction } from "./skill-publication-transaction.ts";
import { resolveSkillSourceFolder } from "./skill-source-discovery.ts";
import {
  preflightAdoptedSkillLinks,
  preflightInstallGuidance,
  reconcileSkillNamespaces,
  retireAdoptedSkillLinks,
  skillPublicationPaths
} from "./skills.ts";
import type { ExplicitSkillTargetSelection, SkillPublicationScope } from "./skills.ts";
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
  if (repo && project) {
    throw new MonkeError("--repo and --project are mutually exclusive");
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

async function runRepoSkillsRegistry(runtime: Runtime, request: SkillsRequest) {
  const root = resolveGitRepoRoot(runtime, runtime.cwd);
  if (request.action === "update") {
    await runUpdateSkills(
      [
        ...(request.adapter ? ["--adapter", request.adapter] : []),
        ...(request.interactive ? ["--interactive"] : [])
      ],
      { repo: true, repoRoot: root, runtime, writeMessage: runtime.writeStdout }
    );
    return;
  }
  await withSkillImportMutation(
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
        ignoreRepoImports(root);
      } else if (request.action === "remove" || request.action === "policy") {
        const recipe = findRecipe(store, request.source);
        const recipes =
          request.action === "remove"
            ? store.recipes.filter((item) => item !== recipe)
            : store.recipes.map((item) =>
                item === recipe ? setRecipePolicy(recipe, request) : item
              );
        writeRepoImportRecipeStore(root, { ...store, recipes });
        await restoreLockedImports(root, false, runtime, { ...store, recipes });
      } else {
        throw new MonkeError(`${request.action} is machine-local and does not accept --repo`);
      }
    },
    runtime
  );
}

async function runSkillsRegistryLocked(
  runtime: Runtime,
  request: Exclude<SkillsRequest, { action: "restore" }>,
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
  if (request.action === "update") {
    try {
      await runUpdateSkills(
        [
          ...(request.adapter ? ["--adapter", request.adapter] : []),
          ...(request.interactive ? ["--interactive"] : [])
        ],
        {
          repoRoot: root,
          runtime,
          validatePrepared(prepared, recipe) {
            const previous = readImportRecipeStore(root).recipes.find(
              (item) => item.source === recipe.source
            );
            preflightRegistryChange(
              runtime,
              root,
              prepared,
              recipe.skills,
              previous?.skills ?? [],
              scope
            );
          },
          writeMessage: runtime.writeStdout
        }
      );
    } finally {
      retireAdoptedSkillLinks(root, store);
      distributeRegistry(runtime, root, scope);
    }
    return;
  }
  let changedSource: string;
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
    changedSource = await addSkillSource(runtime, root, store, request, scope);
  } else {
    const recipe = findRecipe(store, request.source);
    changedSource = recipe.source;
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
          completeRegistryChange(runtime, root, store, changedSource, scope);
        }
      );
      return;
    }
    const nextRecipe = setRecipePolicy(recipe, request);
    await applyRecipePolicy(runtime, root, store, nextRecipe, scope);
  }
  completeRegistryChange(runtime, root, store, changedSource, scope);
}

function completeRegistryChange(
  runtime: Runtime,
  root: string,
  store: SkillImportRecipeStore,
  changedSource: string,
  scope?: SkillPublicationScope
) {
  retireAdoptedSkillLinks(root, store);
  distributeRegistry(runtime, root, scope);
  const nextStore = readImportRecipeStore(root);
  rememberSkillGuidance(
    root,
    [...store.recipes, ...nextStore.recipes]
      .filter((recipe) => recipe.source === changedSource)
      .flatMap((recipe) => recipe.skills)
  );
}

function activeGuidanceRoot(runtime: Runtime) {
  const active = loadActiveToolInstall(getMonkeHome(runtime));
  if (!active) {
    throw new MonkeError("Install monke-tools before managing Skill imports");
  }
  return active.manifest.installKind === "local"
    ? active.manifest.sourceCheckout
    : active.installRoot;
}

/** Use the registry's imported collection with the active install's owned guidance. */
export function registryGuidanceRoot(runtime: Runtime, guidanceSourceRoot: string) {
  const root = path.join(getMonkeHome(runtime), "skill-registry");
  return existsSync(path.join(root, SKILL_LOCK_PATH))
    ? initializeSkillRegistry(runtime, guidanceSourceRoot, true)
    : guidanceSourceRoot;
}

function planRegistryImports(root: string, guidance: string, includeNewSources: boolean) {
  const store = readImportRecipeStore(root);
  const bundledRecipes =
    existsSync(path.join(guidance, "install-manifest.json")) &&
    !existsSync(path.join(guidance, "monke.yml"))
      ? readImportRecipeStore(guidance, false)
      : readRepoImportRecipeStore(guidance);
  const sources = new Set([
    ...store.recipes.map((recipe) => recipe.source),
    ...(store.removedSources ?? [])
  ]);
  const additions =
    includeNewSources || !existsSync(path.join(root, SKILL_LOCK_PATH))
      ? bundledRecipes.recipes.filter((recipe) => !sources.has(recipe.source))
      : [];
  const next = normalizeImportRecipeStore({ ...store, recipes: [...store.recipes, ...additions] });
  return { additions, next };
}

function copyBundledImports(root: string, guidance: string, additions: SkillImportRecipe[]) {
  for (const recipe of additions) {
    for (const item of recipe.skills) {
      const source = importedGuidancePath(guidance, item);
      const target = importedGuidancePath(root, item);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true, verbatimSymlinks: true });
    }
    rememberRestoredRecipe(root, recipe);
  }
}

function initializeSkillRegistry(runtime: Runtime, guidance: string, includeNewSources = false) {
  const root = path.join(getMonkeHome(runtime), "skill-registry");
  const { additions, next } = planRegistryImports(root, guidance, includeNewSources);
  mkdirSync(root, { recursive: true });
  copyBundledImports(root, guidance, additions);
  for (const folder of [
    "skills/internal",
    "skills/codex",
    "skills/references/internal",
    "instructions"
  ]) {
    const source = path.join(guidance, folder);
    const target = path.join(root, folder);
    if (!existsSync(source)) {
      continue;
    }
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (stat && !stat.isSymbolicLink()) {
      throw new MonkeError(`Registry guidance link is occupied: ${target}`);
    }
    rmSync(target, { force: true });
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(source, target, "dir");
  }
  mkdirSync(path.join(root, "skills", "imported"), { recursive: true });
  if (additions.length > 0 || !existsSync(path.join(root, SKILL_LOCK_PATH))) {
    writeImportRecipeStore(root, next);
  }
  if (additions.length > 0 || !existsSync(path.join(root, ".monke-skill-baseline"))) {
    rememberSkillGuidance(
      root,
      additions.length > 0 ? additions.flatMap((recipe) => recipe.skills) : undefined
    );
  }
  return root;
}

function distributeRegistry(runtime: Runtime, root: string, scope?: SkillPublicationScope) {
  if (scope) {
    reconcileProjectSkillRegistry(runtime, root, scope);
    return;
  }
  const config = loadGlobalMonkeConfig(getMonkeHome(runtime));
  if (!config.skillInstallPreference) {
    throw new MonkeError("Select targets first with: mt skills configure");
  }
  reconcileSkillNamespaces({
    cwd: runtime.cwd,
    environment: runtime.env,
    guidanceSourceRoot: root,
    homeDirectory: getHomeDirectory(runtime),
    nextPreference: config.skillInstallPreference,
    previousPreference: config.skillInstallPreference,
    writeMessage: runtime.writeStderr
  });
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
  return recipe.source;
}

/** Validate the retained imports together with a candidate install's owned guidance. */
export function preflightSkillRegistryInstall(
  runtime: Runtime,
  guidance: string,
  explicitTargets?: ExplicitSkillTargetSelection
) {
  const registry = path.join(getMonkeHome(runtime), "skill-registry");
  if (!existsSync(path.join(registry, SKILL_LOCK_PATH))) {
    preflightInstallGuidance(runtime, guidance, explicitTargets);
    return;
  }
  const adoptedLinks = preflightAdoptedSkillLinks(registry);
  const proposal = mkdtempSync(path.join(tmpdir(), "monke-install-guidance-"));
  try {
    const { additions } = planRegistryImports(registry, guidance, true);
    for (const folder of [
      "skills/internal",
      "skills/codex",
      "skills/references/internal",
      "instructions",
      "skills/imported",
      "skills/references/imported"
    ]) {
      const owner = folder.endsWith("/imported") ? registry : guidance;
      const source = path.join(owner, folder);
      if (existsSync(source)) {
        const target = path.join(proposal, folder);
        mkdirSync(path.dirname(target), { recursive: true });
        if (owner === registry) {
          cpSync(source, target, { recursive: true, verbatimSymlinks: true });
        } else {
          symlinkSync(source, target, "dir");
        }
      }
    }
    copyBundledImports(proposal, guidance, additions);
    preflightInstallGuidance(runtime, proposal, explicitTargets, adoptedLinks);
  } finally {
    rmSync(proposal, { force: true, recursive: true });
  }
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
    selection: request.skills ?? previous?.selection,
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
  const revision = await resolveSkillRevision({ skills: [], source }, root);
  const previous = store.recipes.find((recipe) => recipe.source === revision.source);
  const recipe: SkillImportRecipe = {
    ...previous,
    name: request.name ?? previous?.name,
    skills: previous?.skills ?? [],
    source: revision.source,
    ...(!repo ? { selection: request.skills ?? previous?.selection ?? ["*"] } : {}),
    ...(request.acceptOpenClawRisks ? { acceptOpenClawRisks: true as const } : {})
  };
  const selectors = request.skills ??
    previous?.selection ??
    previous?.skills.map((item) => item.selector) ?? ["*"];
  const staging = mkdtempSync(path.join(tmpdir(), "monke-skill-git-"));
  try {
    const installOutput = await stageGitSkillSource({
      includeDeclaredImports: !repo,
      previousRecipe: repo ? undefined : previous,
      recipe: { ...recipe, commit: revision.commit, source: revision.source },
      repoRoot: root,
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
      reference: request.reference
    });
    if (repo) {
      assertRepoSkillSelectorsMatched(recipe.source, selectors, skills);
    }
    const nextRecipe = { ...recipe, commit: revision.commit, skills, source: revision.source };
    const next = normalizeImportRecipeStore({
      ...store,
      recipes: [...store.recipes.filter((item) => item !== previous), nextRecipe]
    });

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
    return revision.source;
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

function assertRepoSkillSelectorsMatched(
  source: string,
  selectors: string[],
  skills: SkillImportRecipe["skills"]
) {
  if (selectors.includes("*")) {
    return;
  }
  const names = new Set(skills.map((skill) => skill.selector.toLowerCase()));
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
      }
    });
    rememberRestoredRecipe(root, recipe);
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

/** Check the proposed full collection against existing target ownership before publishing it. */
function preflightRegistryChange(
  runtime: Runtime,
  root: string,
  prepared: string,
  guidance: SkillImportRecipe["skills"],
  previous: SkillImportRecipe["skills"],
  scope?: SkillPublicationScope
) {
  preflightAdoptedSkillLinks(root);
  const proposal = mkdtempSync(path.join(tmpdir(), "monke-skill-preflight-"));
  try {
    for (const folder of ["skills/internal", "skills/codex", "skills/references", "instructions"]) {
      const source = path.join(root, folder);
      if (!existsSync(source)) {
        continue;
      }
      const target = path.join(proposal, folder);
      mkdirSync(path.dirname(target), { recursive: true });
      symlinkSync(source, target, "dir");
    }
    const imported = path.join(proposal, "skills/imported");
    mkdirSync(imported, { recursive: true });
    const store = readImportRecipeStore(root);
    for (const item of store.recipes.flatMap((recipe) => recipe.skills)) {
      if (
        item.kind !== "skill" ||
        previous.some((old) => old.kind === item.kind && old.slug === item.slug)
      ) {
        continue;
      }
      symlinkSync(importedGuidancePath(root, item), path.join(imported, item.slug), "dir");
    }
    for (const item of guidance.filter((entry) => entry.kind === "skill")) {
      symlinkSync(path.join(prepared, "skill", item.slug), path.join(imported, item.slug), "dir");
    }
    preflightInstallGuidance(runtime, proposal, undefined, undefined, scope);
  } finally {
    rmSync(proposal, { force: true, recursive: true });
  }
}
