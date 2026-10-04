import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { copyStagedGuidanceToManagedRoots } from "../scripts/import-guidance.ts";
import {
  normalizeImportRecipeStore,
  writeImportRecipeStore
} from "../scripts/skill-import-recipes.ts";
import type { SkillImportRecipe, SkillImportRecipeStore } from "../scripts/skill-import-recipes.ts";
import { errorMessage, MonkeError, ThrownValueSchema } from "./errors.ts";
import type { Runtime } from "./types.ts";

/** Choose one skill source folder from a checkout or installer output. */
export function resolveSkillSourceFolder(directory: string) {
  if (existsSync(path.join(directory, "SKILL.md"))) {
    return realpathSync.native(directory);
  }
  const candidates = [
    path.join(directory, ".agents", "skills"),
    path.join(directory, "skills"),
    path.join(directory, ".claude", "skills"),
    path.join(directory, ".codex", "skills"),
    path.join(directory, ".cursor", "skills")
  ];
  const root = candidates.find((candidate) => existsSync(candidate)) ?? directory;
  return existsSync(root) ? realpathSync.native(root) : root;
}

/** Discover Skills without asking which agent should receive them. */
function discoverSourceSkills(root: string) {
  if (!existsSync(root)) {
    throw new MonkeError(`Skill source is missing: ${root}`);
  }
  const skills = new Map<string, string>();
  function visit(directory: string) {
    if (existsSync(path.join(directory, "SKILL.md"))) {
      const slug = path.basename(directory);
      if (skills.has(slug)) {
        throw new MonkeError(`Duplicate Skill slug ${slug} in ${root}`);
      }
      skills.set(slug, directory);
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        !["node_modules", "references"].includes(entry.name)
      ) {
        visit(path.join(directory, entry.name));
      }
    }
  }
  visit(root);
  if (skills.size === 0) {
    throw new MonkeError(`No skills found in ${root}`);
  }
  return skills;
}

/** Refresh a command or linked source and publish it through the existing import materializer. */
export async function updateLocalSkillSource(options: {
  executeCommand?: boolean;
  recipe: SkillImportRecipe;
  repoRoot: string;
  runtime: Runtime;
  store: SkillImportRecipeStore;
  validatePrepared?: (prepared: string, recipe: SkillImportRecipe) => void;
}) {
  const { recipe, repoRoot, runtime, store } = options;
  const { localSource } = recipe;
  if (!localSource) {
    throw new MonkeError(`Missing local skill source for ${recipe.source}`);
  }
  const staging = mkdtempSync(path.join(tmpdir(), "monke-skill-source-"));
  const previous = store.recipes.find((item) => item.source === recipe.source);
  const backup = path.join(staging, "original");
  const previousPath = localSource.skillSourceFolder;
  const hasBackup = existsSync(previousPath);
  let retainRecovery = false;
  if (hasBackup) {
    cpSync(previousPath, backup, { recursive: true, verbatimSymlinks: true });
  }
  try {
    if (localSource.command && options.executeCommand !== false) {
      mkdirSync(localSource.workingDirectory, { recursive: true });
      const shell = runtime.platform === "win32" ? "cmd.exe" : "sh";
      const args =
        runtime.platform === "win32"
          ? ["/d", "/s", "/c", localSource.command]
          : ["-c", localSource.command];
      const result = await runtime.execAsync(shell, args, {
        cwd: localSource.workingDirectory,
        inheritStdio: true
      });
      if (result.exitCode !== 0) {
        throw new MonkeError(
          `Skill installer for ${recipe.source} exited with code ${result.exitCode}`
        );
      }
    }
    const root =
      localSource.skillSourceFolder === localSource.workingDirectory
        ? resolveSkillSourceFolder(localSource.workingDirectory)
        : localSource.skillSourceFolder;
    const discovered = discoverSourceSkills(root);
    const selected = recipe.selection ?? [...discovered.keys()];
    const skills = selected.map((slug) => {
      const sourcePath = discovered.get(slug);
      if (!sourcePath) {
        throw new MonkeError(`Selected Skill ${slug} is missing from ${root}`);
      }
      cpSync(sourcePath, path.join(staging, ".agents", "skills", slug), {
        dereference: true,
        recursive: true
      });
      return {
        ...recipe.skills.find((item) => item.slug === slug),
        kind: "skill" as const,
        selector: slug,
        slug
      };
    });
    const nextRecipe: SkillImportRecipe = {
      ...recipe,
      localSource: { ...localSource, skillSourceFolder: root },
      skills
    };
    const next = normalizeImportRecipeStore({
      ...store,
      recipes: [...store.recipes.filter((item) => item.source !== recipe.source), nextRecipe]
    });
    copyStagedGuidanceToManagedRoots({
      commitState() {
        writeImportRecipeStore(repoRoot, next);
      },
      guidance: skills.map((item) => ({
        ...item,
        disableModelInvocation: item.disableModelInvocation ?? recipe.disableModelInvocation
      })),
      linkedSkills: discovered,
      obsoleteGuidance: previous?.skills.filter((item) => !selected.includes(item.slug)),
      repoRoot,
      stagingDirectory: staging,
      validatePrepared(prepared) {
        options.validatePrepared?.(prepared, nextRecipe);
      }
    });
    return next;
  } catch (error) {
    if (hasBackup) {
      try {
        rmSync(previousPath, { force: true, recursive: true });
        cpSync(backup, previousPath, { recursive: true, verbatimSymlinks: true });
      } catch (recoveryError) {
        retainRecovery = true;
        throw new MonkeError(
          `${errorMessage(ThrownValueSchema.parse(error))}\nSource restoration failed: ${errorMessage(ThrownValueSchema.parse(recoveryError))}\nRecovery copy retained at ${backup}`,
          { cause: error }
        );
      }
    }
    throw error;
  } finally {
    if (!retainRecovery) {
      rmSync(staging, { force: true, recursive: true });
    }
  }
}
