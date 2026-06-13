#!/usr/bin/env bun

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import { Command, CommanderError } from "commander";

import {
  buildSkillsInstallArgs,
  copyStagedSkillsToImported,
  extractSecurityRiskAssessment,
  listStagedSkillSlugs,
  normalizeSourceForStaging,
  readImportRecipeStore,
  runInstallCommand,
  runSkillsCaptured,
  writeImportRecipeStore,
} from "./import-skills.ts";
import type { SkillImportRecipe, SkillImportRecipeStore } from "./import-skills.ts";

const IMPORTED_SKILLS_ROOT = path.join("skills", "imported");

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

/** Reruns all recorded Skill import recipes into `skills/imported`. */
export async function runUpdateSkills(
  argv: string[] = process.argv.slice(2),
  dependencies: UpdateSkillsDependencies = {},
): Promise<void> {
  const { install, interactive } = parseCommand(argv);
  const repoRoot = process.cwd();
  const store = readImportRecipeStore(repoRoot);
  const writeMessage = dependencies.writeMessage ?? process.stdout.write.bind(process.stdout);
  const failures: string[] = [];

  validateImportedSkillOwnership(repoRoot, store);

  for (const recipe of store.recipes) {
    const stagingDirectory = mkdtempSync(path.join(tmpdir(), "monke-skills-update-"));
    try {
      const normalizedSource = normalizeSourceForStaging(recipe.source, repoRoot);
      const installOutput = runSkillsCaptured(
        buildSkillsInstallArgs({
          source: normalizedSource,
          acceptOpenClawRisks: recipe.acceptOpenClawRisks === true,
          selectors: recipe.skills.map((skill) => skill.selector),
        }),
        stagingDirectory,
      );
      const securityAssessment = extractSecurityRiskAssessment(
        `${installOutput.stdout}\n${installOutput.stderr}`,
      );
      if (securityAssessment) {
        writeMessage(securityAssessment);
      }

      const slugReplacements = await resolveStagedSkillReplacements({
        recipe,
        stagingDirectory,
        interactive,
        confirmSlugReplacement: dependencies.confirmSlugReplacement ?? promptForSlugReplacement,
      });
      assertSlugReplacementsKeepUniqueOwnership(store, recipe, slugReplacements);
      copyStagedSkillsToImported({
        stagingDirectory,
        repoRoot,
      });
      applyAcceptedSlugReplacements(repoRoot, recipe, slugReplacements);
      if (slugReplacements.length > 0) {
        writeImportRecipeStore(repoRoot, store);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${recipe.source}: ${message}`);
    } finally {
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Skill update failed for ${failures.length} recipe(s):\n${failures.join("\n")}`,
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
    .description("Update imported external agent skills from recorded recipes")
    .option("-i, --install", "Run the monke-tools skill install command after updating")
    .option("--interactive", "Prompt before accepting staged Skill slug replacements")
    .allowExcessArguments(false)
    .showSuggestionAfterError(false);

  program.exitOverride();

  try {
    program.parse(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new Error("Usage: bun run skills:update -- [--install] [--interactive]");
    }

    throw error;
  }

  const options = program.opts<{ install?: boolean; interactive?: boolean }>();
  return {
    install: Boolean(options.install),
    interactive: Boolean(options.interactive),
  };
}

function validateImportedSkillOwnership(repoRoot: string, store: SkillImportRecipeStore): void {
  const ownedSlugs = new Map<string, string>();

  for (const recipe of store.recipes) {
    for (const skill of recipe.skills) {
      const existingOwner = ownedSlugs.get(skill.slug);
      if (existingOwner) {
        throw new Error(
          `Imported skill slug ${skill.slug} is owned by both ${existingOwner} and ${recipe.source}`,
        );
      }

      ownedSlugs.set(skill.slug, recipe.source);
    }
  }

  const untrackedSlugs = listImportedSkillDirectories(repoRoot).filter(
    (slug) => !ownedSlugs.has(slug),
  );
  if (untrackedSlugs.length > 0) {
    throw new Error(`Untracked imported skill directories: ${untrackedSlugs.join(", ")}`);
  }
}

async function resolveStagedSkillReplacements(options: {
  recipe: SkillImportRecipe;
  stagingDirectory: string;
  interactive: boolean;
  confirmSlugReplacement: (request: SlugReplacementRequest) => boolean | Promise<boolean>;
}): Promise<SlugReplacementRequest[]> {
  const { recipe, stagingDirectory } = options;
  const recordedSlugs = recipe.skills.map((skill) => skill.slug).sort();
  const stagedSlugs = listStagedSkillSlugs(stagingDirectory);
  const missingSlugs = recordedSlugs.filter((slug) => !stagedSlugs.includes(slug));
  const unexpectedSlugs = stagedSlugs.filter((slug) => !recordedSlugs.includes(slug));

  if (missingSlugs.length === 0 && unexpectedSlugs.length === 0) {
    return [];
  }

  if (!options.interactive || missingSlugs.length !== 1 || unexpectedSlugs.length !== 1) {
    throw new Error(renderSlugMismatchMessage(recipe.source, missingSlugs, unexpectedSlugs));
  }

  const recordedSlug = missingSlugs[0]!;
  const stagedSlug = unexpectedSlugs[0]!;
  const skill = recipe.skills.find((candidate) => candidate.slug === recordedSlug);
  if (!skill) {
    throw new Error(renderSlugMismatchMessage(recipe.source, missingSlugs, unexpectedSlugs));
  }

  const request = {
    source: recipe.source,
    selector: skill.selector,
    recordedSlug,
    stagedSlug,
  };
  const accepted = await options.confirmSlugReplacement(request);
  if (!accepted) {
    throw new Error(renderSlugMismatchMessage(recipe.source, missingSlugs, unexpectedSlugs));
  }

  return [request];
}

function assertSlugReplacementsKeepUniqueOwnership(
  store: SkillImportRecipeStore,
  owningRecipe: SkillImportRecipe,
  replacements: readonly SlugReplacementRequest[],
): void {
  for (const replacement of replacements) {
    for (const recipe of store.recipes) {
      if (recipe === owningRecipe) {
        continue;
      }

      if (recipe.skills.some((skill) => skill.slug === replacement.stagedSlug)) {
        throw new Error(
          `Cannot replace Skill slug ${replacement.recordedSlug} with ${replacement.stagedSlug}: ${replacement.stagedSlug} is already owned by recipe ${recipe.source}`,
        );
      }
    }
  }
}

function applyAcceptedSlugReplacements(
  repoRoot: string,
  recipe: SkillImportRecipe,
  replacements: readonly SlugReplacementRequest[],
): void {
  for (const replacement of replacements) {
    const skill = recipe.skills.find(
      (candidate) =>
        candidate.selector === replacement.selector && candidate.slug === replacement.recordedSlug,
    );
    if (!skill) {
      throw new Error(`Could not update recorded Skill slug ${replacement.recordedSlug}`);
    }

    rmSync(path.join(repoRoot, IMPORTED_SKILLS_ROOT, replacement.recordedSlug), {
      recursive: true,
      force: true,
    });
    skill.slug = replacement.stagedSlug;
  }
}

function renderSlugMismatchMessage(
  source: string,
  missingSlugs: readonly string[],
  unexpectedSlugs: readonly string[],
): string {
  return [
    `Skill slug mismatch for ${source}:`,
    `recorded ${missingSlugs.join(", ") || "(none)"}`,
    `but staged ${unexpectedSlugs.join(", ") || "(none)"}`,
  ].join(" ");
}

async function promptForSlugReplacement(request: SlugReplacementRequest): Promise<boolean> {
  const accepted = await p.confirm({
    message: `Staged Skill slug changed for ${request.source}: ${request.recordedSlug} -> ${request.stagedSlug}. Replace the recorded slug and imported directory?`,
    initialValue: false,
  });

  if (p.isCancel(accepted)) {
    throw new Error("Skill update cancelled");
  }

  return accepted;
}

function listImportedSkillDirectories(repoRoot: string): string[] {
  const importedSkillsRoot = path.join(repoRoot, IMPORTED_SKILLS_ROOT);
  return listSkillDirectories(importedSkillsRoot);
}

function listSkillDirectories(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  return readdirSync(root)
    .filter((entry) => {
      const entryPath = path.join(root, entry);
      return statSync(entryPath).isDirectory();
    })
    .sort();
}

if (import.meta.main) {
  try {
    await runUpdateSkills();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
