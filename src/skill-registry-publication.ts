import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { importedGuidancePath, transformPreparedReference } from "../scripts/import-guidance.ts";
import {
  normalizeImportRecipeStore,
  readImportRecipeStore,
  readRepoImportRecipeStore,
  SKILL_LOCK_PATH,
  writeImportRecipeStore
} from "../scripts/skill-import-recipes.ts";
import type { SkillImportRecipe } from "../scripts/skill-import-recipes.ts";
import { assertSkillRestoreMarker, rememberRestoredRecipe } from "../scripts/skill-lock.ts";
import { rememberSkillGuidance } from "../scripts/skill-review.ts";
import { MonkeError } from "./errors.ts";
import { loadGlobalMonkeConfig } from "./global-config.ts";
import { loadActiveToolInstall } from "./install-manifest.ts";
import { reconcileProjectSkillRegistry } from "./project-skills.ts";
import { getHomeDirectory, getMonkeHome } from "./runtime.ts";
import {
  preflightAdoptedSkillLinks,
  preflightInstallGuidance,
  reconcileSkillNamespaces
} from "./skills.ts";
import type { ExplicitSkillTargetSelection, SkillPublicationScope } from "./skills.ts";
import type { Runtime } from "./types.ts";

export function activeGuidanceRoot(runtime: Runtime) {
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

  const updates = includeNewSources
    ? store.recipes.flatMap((recipe) => {
        const bundled = bundledRecipes.recipes.find((item) => item.source === recipe.source);
        const update = bundled && followBundledRecipe(recipe, bundled);

        return update ? [update] : [];
      })
    : [];

  const imports: BundledImport[] = [
    ...updates,
    ...additions.map((recipe) => ({
      converted: false,
      copied: recipe.skills,
      obsolete: [],
      recipe
    }))
  ];

  const next = normalizeImportRecipeStore({
    ...store,
    recipes: [
      ...store.recipes.map(
        (recipe) =>
          updates.find((update) => update.recipe.source === recipe.source)?.recipe ?? recipe
      ),
      ...additions
    ]
  });

  return { imports, next };
}

/** Bundled guidance a registry copies for one recipe, replacing its obsolete items. */
interface BundledImport {
  /** Convert the registry's retained skills to the copied references instead of copying bytes. */
  converted: boolean;
  copied: SkillImportRecipe["skills"];
  obsolete: SkillImportRecipe["skills"];
  recipe: SkillImportRecipe;
}

/**
 * Follow the publisher's Import kinds and, for an unnarrowed selection, its added guidance. Bundled
 * bytes match a retained recipe only at the same pin. At another pin, only skills that became
 * references follow, converted from the retained bytes. Items that keep their kind keep their
 * overrides.
 */
function followBundledRecipe(
  recipe: SkillImportRecipe,
  bundled: SkillImportRecipe
): BundledImport | undefined {
  if (recipe.localSource || !recipe.commit) {
    return undefined;
  }

  const converted = recipe.commit !== bundled.commit;

  const copied = bundled.skills.flatMap((declared) => {
    const retained = recipe.skills.find((item) => item.slug === declared.slug);

    if (converted) {
      // Only the kind follows; the retained selector still resolves at the retained pin.
      return retained?.kind === "skill" && declared.kind === "reference"
        ? [{ ...declared, selector: retained.selector }]
        : [];
    }

    const follows = retained
      ? retained.kind !== declared.kind
      : !recipe.selection || recipe.selection.includes("*");

    return follows ? [declared] : [];
  });

  if (copied.length === 0) {
    return undefined;
  }

  const replaced = (item: SkillImportRecipe["skills"][number]) =>
    copied.some((declared) => declared.slug === item.slug);

  return {
    converted,
    copied,
    obsolete: recipe.skills.filter(replaced),
    recipe: { ...recipe, skills: [...recipe.skills.filter((item) => !replaced(item)), ...copied] }
  };
}

function copyBundledImports(root: string, guidance: string, imports: BundledImport[]) {
  for (const { converted, copied, obsolete, recipe } of imports) {
    for (const item of copied) {
      const source = converted
        ? importedGuidancePath(root, { ...item, kind: "skill" })
        : importedGuidancePath(guidance, item);

      const target = importedGuidancePath(root, item);

      if (converted) {
        // An interrupted conversion may have already replaced its retained skill.
        if (!existsSync(source)) {
          continue;
        }

        rmSync(target, { force: true, recursive: true });
      }

      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true, verbatimSymlinks: true });

      if (converted) {
        transformPreparedReference(target);
      }
    }

    for (const item of obsolete) {
      rmSync(importedGuidancePath(root, item), { force: true, recursive: true });
    }

    rememberRestoredRecipe(root, recipe);
  }
}

/** Follow the bundled declarations, returning the guidance they replaced and copied. */
export function followBundledImports(runtime: Runtime, root: string, guidance: string) {
  const { imports, next } = planRegistryImports(root, guidance, true);

  if (imports.length === 0) {
    return [];
  }

  // A followed skill can collide with another owner of its slug, so validate before persisting.
  preflightSkillRegistryInstall(runtime, guidance);
  assertSkillRestoreMarker(root);
  copyBundledImports(root, guidance, imports);
  writeImportRecipeStore(root, next);

  return imports.flatMap(({ copied, obsolete }) => [...obsolete, ...copied]);
}

export function initializeSkillRegistry(
  runtime: Runtime,
  guidance: string,
  includeNewSources = false
) {
  const root = path.join(getMonkeHome(runtime), "skill-registry");
  const { imports, next } = planRegistryImports(root, guidance, includeNewSources);

  if (imports.length > 0) {
    assertSkillRestoreMarker(root);
  }

  mkdirSync(root, { recursive: true });
  copyBundledImports(root, guidance, imports);

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

  if (imports.length > 0 || !existsSync(path.join(root, SKILL_LOCK_PATH))) {
    writeImportRecipeStore(root, next);
  }

  if (imports.length > 0 || !existsSync(path.join(root, ".monke-skill-baseline"))) {
    rememberSkillGuidance(
      root,
      imports.length > 0
        ? imports.flatMap(({ copied, obsolete }) => [...obsolete, ...copied])
        : undefined
    );
  }

  return root;
}

export function distributeRegistry(runtime: Runtime, root: string, scope?: SkillPublicationScope) {
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
    const { imports } = planRegistryImports(registry, guidance, true);

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

    copyBundledImports(proposal, guidance, imports);
    preflightInstallGuidance(runtime, proposal, explicitTargets, adoptedLinks);
  } finally {
    rmSync(proposal, { force: true, recursive: true });
  }
}

/** Check the proposed full collection against existing target ownership before publishing it. */
export function preflightRegistryChange(
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
