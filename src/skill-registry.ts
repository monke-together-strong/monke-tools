import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as z from "zod";

import {
  copyStagedGuidanceToManagedRoots,
  importedGuidancePath
} from "../scripts/import-guidance.ts";
import { reportSecurityRiskAssessment } from "../scripts/import-skills.ts";
import {
  normalizeImportRecipeStore,
  readImportRecipeStore,
  replaceRecipeSkills,
  SKILL_LOCK_PATH,
  writeImportRecipeStore
} from "../scripts/skill-import-recipes.ts";
import type { SkillImportRecipe, SkillImportRecipeStore } from "../scripts/skill-import-recipes.ts";
import { guidanceDigest, pinnedSkillSource, resolveSkillRevision } from "../scripts/skill-lock.ts";
import { rememberSkillGuidance } from "../scripts/skill-review.ts";
import { buildSkillsInstallArgs, listStagedSkillSlugs } from "../scripts/skills-cli.ts";
import { runUpdateSkills } from "../scripts/update-skills.ts";
import { MonkeError } from "./errors.ts";
import { loadGlobalMonkeConfig } from "./global-config.ts";
import { loadActiveToolInstall } from "./install-manifest.ts";
import { withInstallMutationLockAsync } from "./install-recovery.ts";
import { resolveSkillSourceFolder, updateLocalSkillSource } from "./local-skill-source.ts";
import { acquireManagedSkillSource } from "./managed-skill-source.ts";
import { getHomeDirectory, getMonkeHome } from "./runtime.ts";
import { withSkillPublicationTransaction } from "./skill-publication-transaction.ts";
import {
  preflightAdoptedSkillLinks,
  preflightInstallGuidance,
  reconcileSkillNamespaces,
  retireAdoptedSkillLinks,
  skillPublicationPaths
} from "./skills.ts";
import type { ExplicitSkillTargetSelection } from "./skills.ts";
import type { Runtime } from "./types.ts";
import { parseOwnedYamlText } from "./validation.ts";

type SkillsRequest =
  | { action: "create"; description?: string; name: string }
  | { action: "adopt"; name?: string; skills?: string[]; source: string }
  | {
      action: "add";
      command?: string;
      cwd?: string;
      link?: boolean;
      name?: string;
      skills?: string[];
      source?: string;
    }
  | { action: "policy"; disable: boolean; skill?: string; source: string }
  | { action: "remove"; source: string }
  | { action: "update"; adapter?: string; interactive?: boolean }
  | { action: "list" };

/** Register imports, get their content, and distribute the resulting shared collection. */
export function runSkillsRegistry(runtime: Runtime, request: SkillsRequest) {
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

async function runSkillsRegistryLocked(runtime: Runtime, request: SkillsRequest, guidance: string) {
  const root = initializeSkillRegistry(runtime, guidance);
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
            preflightRegistryChange(runtime, root, prepared, recipe.skills, previous?.skills ?? []);
          },
          writeMessage: runtime.writeStdout
        }
      );
    } finally {
      retireAdoptedSkillLinks(root, store);
      distributeRegistry(runtime, root);
    }
    return;
  }
  let changedSource: string;
  if (request.action === "create" || request.action === "adopt") {
    await acquireManagedSkillSource({
      guidanceRoot: guidance,
      async publish(source, name) {
        await addSkillSource(runtime, root, store, { action: "add", link: true, name, source });
      },
      reconcile() {
        distributeRegistry(runtime, root);
      },
      registryRoot: root,
      request,
      runtime,
      store
    });
    return;
  } else if (request.action === "add") {
    changedSource = await addSkillSource(runtime, root, store, request);
  } else {
    const recipe = findRecipe(store, request.source);
    changedSource = recipe.source;
    if (request.action === "remove") {
      await withSkillPublicationTransaction(
        runtime,
        [realpathSync.native(root), ...skillPublicationPaths(runtime, root, [])],
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
          completeRegistryChange(runtime, root, store, changedSource);
        }
      );
      return;
    }
    const nextRecipe = setRecipePolicy(recipe, request);
    await applyRecipePolicy(runtime, root, store, nextRecipe);
  }
  completeRegistryChange(runtime, root, store, changedSource);
}

function completeRegistryChange(
  runtime: Runtime,
  root: string,
  store: SkillImportRecipeStore,
  changedSource: string
) {
  retireAdoptedSkillLinks(root, store);
  distributeRegistry(runtime, root);
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
  const bundledRecipes = readImportRecipeStore(guidance);
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

function distributeRegistry(runtime: Runtime, root: string) {
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
  request: Extract<SkillsRequest, { action: "add" }>
) {
  const suppliedPath = request.source ? resolveUserPath(runtime, request.source) : undefined;
  const local = suppliedPath !== undefined && existsSync(suppliedPath);
  if (!request.command && !local) {
    if (!request.source || request.link) {
      throw new MonkeError(
        "Provide a Git source, an existing linked directory, or --command with --name"
      );
    }
    await addGitSkillSource(runtime, root, store, request.source, request);
    return request.source;
  }
  const recipe = localSourceRecipe(runtime, store, request, local ? suppliedPath : undefined);
  const previous = store.recipes.find((item) => item.source === recipe.source);
  await updateLocalSkillSource({
    executeCommand: request.link !== true,
    recipe,
    repoRoot: root,
    runtime,
    store,
    validatePrepared(prepared, nextRecipe) {
      preflightRegistryChange(runtime, root, prepared, nextRecipe.skills, previous?.skills ?? []);
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
  directory?: string
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
    localSource: localSourceOptions(runtime, request, name, directory, previous?.localSource),
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
  previous?: SkillImportRecipe["localSource"]
): NonNullable<SkillImportRecipe["localSource"]> {
  const cwd = request.cwd
    ? resolveUserPath(runtime, request.cwd)
    : (directory ??
      previous?.workingDirectory ??
      path.join(getMonkeHome(runtime), "skill-sources", name));
  return {
    command: request.command ?? previous?.command,
    kind: (request.command ?? previous?.command) ? "command" : "link",
    skillSourceFolder: directory
      ? resolveSkillSourceFolder(realpathSync.native(directory))
      : request.cwd
        ? resolveSkillSourceFolder(cwd)
        : (previous?.skillSourceFolder ?? resolveSkillSourceFolder(cwd)),
    workingDirectory: cwd
  };
}

async function addGitSkillSource(
  runtime: Runtime,
  root: string,
  store: SkillImportRecipeStore,
  source: string,
  request: Extract<SkillsRequest, { action: "add" }>
) {
  const previous = store.recipes.find((recipe) => recipe.source === source);
  const recipe: SkillImportRecipe = {
    ...previous,
    name: request.name ?? previous?.name,
    skills: previous?.skills ?? [],
    source
  };
  const staging = mkdtempSync(path.join(tmpdir(), "monke-skill-git-"));
  try {
    const revision = resolveSkillRevision(recipe, root);
    const normalized = pinnedSkillSource({ ...revision, digest: "" }, staging);
    const installOutput = await runtime.execAsync(
      runtime.platform === "win32" ? "npx.cmd" : "npx",
      buildSkillsInstallArgs({
        selectors: request.skills ?? previous?.skills.map((item) => item.selector) ?? ["*"],
        source: normalized
      }),
      { cwd: staging }
    );
    reportSecurityRiskAssessment(
      `${installOutput.stdout}\n${installOutput.stderr}`,
      runtime.writeStdout
    );
    const skills = listStagedSkillSlugs(staging).map((slug) => {
      const entry = path.join(staging, ".agents", "skills", slug, "SKILL.md");
      const frontmatter = /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(
        readFileSync(entry, "utf-8")
      );
      if (!frontmatter) {
        throw new MonkeError(`Expected leading YAML frontmatter at ${entry}`);
      }
      const metadata = parseOwnedYamlText(
        frontmatter.groups?.frontmatter ?? "",
        entry,
        z.looseObject({ name: z.string().optional() })
      );
      const existing = previous?.skills.find((item) => item.slug === slug);
      return {
        ...existing,
        kind: existing?.kind ?? ("skill" as const),
        selector: metadata.name ?? slug,
        slug
      };
    });
    const nextRecipe = replaceRecipeSkills(recipe, skills);
    const next = normalizeImportRecipeStore({
      ...store,
      recipes: [...store.recipes.filter((item) => item !== previous), nextRecipe]
    });
    const recorded = findRecipe(next, source);
    copyStagedGuidanceToManagedRoots({
      commitState() {
        writeImportRecipeStore(root, next);
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
        preflightRegistryChange(runtime, root, prepared, nextRecipe.skills, previous?.skills ?? []);
        recorded.lock = { ...revision, digest: guidanceDigest(prepared, nextRecipe.skills, true) };
      }
    });
  } finally {
    rmSync(staging, { force: true, recursive: true });
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
  if (!request.skill) {
    return { ...recipe, disableModelInvocation: request.disable };
  }
  if (!recipe.skills.some((item) => item.kind === "skill" && item.slug === request.skill)) {
    throw new MonkeError(`Unknown Skill ${request.skill} in ${recipe.source}`);
  }
  return replaceRecipeSkills(
    recipe,
    recipe.skills.map((item) =>
      item.slug === request.skill ? { ...item, disableModelInvocation: request.disable } : item
    )
  );
}

async function applyRecipePolicy(
  runtime: Runtime,
  root: string,
  store: SkillImportRecipeStore,
  recipe: SkillImportRecipe
) {
  if (recipe.localSource) {
    await updateLocalSkillSource({
      executeCommand: false,
      recipe,
      repoRoot: root,
      runtime,
      store,
      validatePrepared(prepared, nextRecipe) {
        preflightRegistryChange(runtime, root, prepared, nextRecipe.skills, recipe.skills);
      }
    });
    return;
  }
  const staging = mkdtempSync(path.join(tmpdir(), "monke-skill-policy-"));
  const next = normalizeImportRecipeStore({
    ...store,
    recipes: store.recipes.map((item) => (item.source === recipe.source ? recipe : item))
  });
  const recorded = findRecipe(next, recipe.source);
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
        preflightRegistryChange(runtime, root, prepared, recipe.skills, recipe.skills);
        for (const item of recipe.skills.filter((entry) => entry.kind === "reference")) {
          cpSync(importedGuidancePath(root, item), path.join(prepared, item.kind, item.slug), {
            recursive: true,
            verbatimSymlinks: true
          });
        }
        if (recorded.lock) {
          recorded.lock.digest = guidanceDigest(prepared, recipe.skills, true);
        }
      }
    });
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
  previous: SkillImportRecipe["skills"]
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
    preflightInstallGuidance(runtime, proposal);
  } finally {
    rmSync(proposal, { force: true, recursive: true });
  }
}
