#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { GroupMultiSelectPrompt } from "@clack/core";
import * as p from "@clack/prompts";
import { Command } from "@commander-js/extra-typings";
import pc from "picocolors";
import * as z from "zod";

import { configureCliParser, reportCliFailure } from "../src/cli-errors.ts";
import { MonkeError } from "../src/errors.ts";
import { parseBoundaryValue } from "../src/validation.ts";

interface ImportCommandOptions {
  acceptOpenClawRisks: boolean;
  install: boolean;
  kind: ImportedGuidanceKind;
  source: string;
}

/** Group of upstream Skill import selectors parsed from `skills add -l` output. */
export interface AvailableSkillGroup {
  /** Display heading from the upstream skills list. */
  name: string;
  /** Skill import selectors listed under the heading. */
  skills: string[];
}

/** Clack-compatible grouped prompt options keyed by upstream group heading. */
export type GroupedSkillOptions = Record<string, p.Option<string>[]>;

interface ImportSkillsDependencies {
  runInstallCommand?: (repoRoot: string) => void;
  selectSkills?: (
    availableSkillGroups: readonly AvailableSkillGroup[]
  ) => Promise<string[]> | string[];
  writeMessage?: (message: string) => void;
}

interface SecurityRiskAssessment {
  detailsUrl: string | null;
  rows: SecurityRiskRow[];
}

interface SecurityRiskRow {
  gen: string;
  skillName: string;
  snyk: string;
  socket: string;
}

const NPX_COMMAND = process.platform === "win32" ? "npx.cmd" : "npx";
const SKILLS_CLI_ARGS = ["--yes", "skills", "add"];
export const IMPORTED_SKILLS_ROOT = path.join("skills", "imported");
export const IMPORTED_REFERENCES_ROOT = path.join("skills", "references", "imported");
const INTERNAL_SKILLS_ROOT = path.join("skills", "internal");
const INTERNAL_REFERENCES_ROOT = path.join("skills", "references", "internal");
const IMPORT_RECIPE_STORE_PATH = path.join(IMPORTED_SKILLS_ROOT, ".monke-imports.json");
const CSI_RE = new RegExp(
  String.raw`\u001b\[[\u0030-\u003f]*[\u0020-\u002f]*[\u0040-\u007e]`,
  "gu"
);
const OSC_RE = new RegExp(String.raw`\u001b\][\s\S]*?(?:\u0007|\u001b\\)`, "gu");
const DCS_PM_APC_RE = new RegExp(String.raw`\u001b[P^_][\s\S]*?(?:\u001b\\)`, "gu");
const SIMPLE_ESC_RE = new RegExp(String.raw`\u001b[\u0020-\u007e]`, "gu");
const C1_RE = new RegExp(String.raw`[\u0080-\u009f]`, "gu");
const CONTROL_RE = new RegExp(
  String.raw`[\u0000-\u0006\u0007\u0008\u000b\u000c\u000d-\u001a\u001c-\u001f\u007f]`,
  "gu"
);

const SkillImportRecipeSkillSchema = z.strictObject(
  {
    kind: z.enum(["skill", "reference"], {
      error: "Import kind must be skill or reference"
    }),
    selector: z.string().refine((value) => value.trim().length > 0, {
      error: "Skill import selector must be a non-empty string"
    }),
    slug: z.string().refine((value) => value.trim().length > 0, {
      error: "Skill slug must be a non-empty string"
    })
  },
  { error: "Skill import recipe skill must be a JSON object" }
);
const SkillImportRecipeSchema = z.strictObject(
  {
    acceptOpenClawRisks: z
      .literal(true, {
        error: "Skill import recipe acceptOpenClawRisks must be true when present"
      })
      .optional(),
    skills: z
      .array(SkillImportRecipeSkillSchema, {
        error: "Skill import recipe skills must be a non-empty array"
      })
      .min(1, { error: "Skill import recipe skills must be a non-empty array" }),
    source: z.string().refine((value) => value.trim().length > 0, {
      error: "Skill import recipe source must be a non-empty string"
    })
  },
  { error: "Skill import recipe must be a JSON object" }
);
const SkillImportRecipeStoreSchema = z.strictObject(
  {
    recipes: z.array(SkillImportRecipeSchema, {
      error: "Skill import recipe store recipes must be an array"
    }),
    version: z.literal(2, { error: "Skill import recipe store version must be 2" })
  },
  { error: "Skill import recipe store must be a JSON object" }
);

/** Repo-tracked store for all Skill import recipes. */
export type SkillImportRecipeStore = z.output<typeof SkillImportRecipeStoreSchema>;

/** Local role assigned to one selected upstream guidance item. */
export type ImportedGuidanceKind = "skill" | "reference";

/** Source-scoped recipe used to rerun a Skill import. */
export type SkillImportRecipe = z.output<typeof SkillImportRecipeSchema>;

/** Mapping between an upstream Skill import selector and local Skill slug. */
export type SkillImportRecipeSkill = z.output<typeof SkillImportRecipeSkillSchema>;

/** Selector-to-slug mapping before an Import kind is assigned. */
export type StagedSkillSelection = Omit<SkillImportRecipeSkill, "kind">;

/** Input for recording newly imported skills in the recipe store. */
export interface RecordImportedGuidanceInput {
  /** Whether the dedicated OpenClaw risk acceptance flag was used. */
  acceptOpenClawRisks: boolean;
  /** Import kind applied to every selection in this invocation. */
  kind: ImportedGuidanceKind;
  /** Selector-to-slug ownership entries created by the import. */
  skills: StagedSkillSelection[];
  /** Human-facing source string passed through to upstream `skills add`. */
  source: string;
}

/** Captured output from an upstream `skills` CLI invocation. */
export interface CapturedCommandOutput {
  /** Captured standard error text. */
  stderr: string;
  /** Captured standard output text. */
  stdout: string;
}

/** Options for building an upstream staged Skill install command. */
export interface BuildSkillsInstallArgsOptions {
  /** Whether to pass the dedicated OpenClaw risk acceptance flag. */
  acceptOpenClawRisks: boolean;
  /** Upstream Skill import selectors to install. */
  selectors: readonly string[];
  /** Source string passed through to upstream `skills add`. */
  source: string;
}

/** Options for resolving exact selector-to-slug mappings with isolated installs. */
export interface ResolveSkillSelectorSlugMappingsOptions {
  /** Whether to pass the dedicated OpenClaw risk acceptance flag. */
  acceptOpenClawRisks: boolean;
  /** Upstream Skill import selectors to install one at a time. */
  selectors: readonly string[];
  /** Source string passed through to upstream `skills add`. */
  source: string;
}

/** Parses upstream skill selectors from grouped `skills add -l` output. */
export function parseAvailableSkillNames(output: string): string[] {
  return parseAvailableSkillGroups(output).flatMap((group) => group.skills);
}

/** Parses upstream skill groups and selectors from `skills add -l` output. */
export function parseAvailableSkillGroups(output: string): AvailableSkillGroup[] {
  const lines = stripTerminalEscapes(output).split(/\r?\n/u);
  const groups: AvailableSkillGroup[] = [];
  const seenNames = new Set<string>();
  let inAvailableSkillsSection = false;
  let currentGroupName = "General";

  for (const line of lines) {
    if (!inAvailableSkillsSection) {
      if (line.includes("Available Skills")) {
        inAvailableSkillsSection = true;
      }
      continue;
    }

    if (line.includes("Use --skill")) {
      break;
    }

    const skillName = parseSkillRow(line);
    if (skillName) {
      if (seenNames.has(skillName)) {
        continue;
      }

      seenNames.add(skillName);
      getOrCreateSkillGroup(groups, currentGroupName).skills.push(skillName);
      continue;
    }

    const groupName = parseGroupHeader(line);
    if (groupName) {
      currentGroupName = groupName;
      continue;
    }
  }

  if (seenNames.size === 0) {
    throw new MonkeError("Could not parse any skills from `skills add <source> -l` output");
  }

  return groups;
}

/** Resolves local source paths before the upstream CLI runs from temp staging. */
export function normalizeSourceForStaging(source: string, cwd: string): string {
  if (!isLocalPath(source)) {
    return source;
  }

  return path.resolve(cwd, source);
}

/** Builds arguments for listing skills from an upstream source. */
function buildSkillsListArgs(source: string, acceptOpenClawRisks: boolean): string[] {
  return [...SKILLS_CLI_ARGS, source, ...buildOpenClawRiskArgs(acceptOpenClawRisks), "-l"];
}

/** Builds arguments for installing selected skills from an upstream source into staging. */
export function buildSkillsInstallArgs(options: BuildSkillsInstallArgsOptions): string[] {
  return [
    ...SKILLS_CLI_ARGS,
    options.source,
    ...buildOpenClawRiskArgs(options.acceptOpenClawRisks),
    ...options.selectors.flatMap((skill) => ["--skill", skill]),
    "--agent",
    "universal",
    "--copy",
    "--yes"
  ];
}

/** Reads the repo-tracked Skill import recipe store, returning an empty store when absent. */
export function readImportRecipeStore(repoRoot: string): SkillImportRecipeStore {
  const storePath = path.join(repoRoot, IMPORT_RECIPE_STORE_PATH);
  if (!existsSync(storePath)) {
    return {
      recipes: [],
      version: 2
    };
  }

  return normalizeImportRecipeStore(JSON.parse(readFileSync(storePath, "utf-8")));
}

/** Writes the Skill import recipe store with deterministic recipe and skill ordering. */
export function writeImportRecipeStore(repoRoot: string, store: SkillImportRecipeStore): void {
  const normalizedStore = normalizeImportRecipeStore(store);
  const storePath = path.join(repoRoot, IMPORT_RECIPE_STORE_PATH);
  mkdirSync(path.dirname(storePath), { recursive: true });
  const temporaryStorePath = `${storePath}.tmp`;
  writeFileSync(temporaryStorePath, `${JSON.stringify(normalizedStore, null, 2)}\n`, "utf-8");
  renameSync(temporaryStorePath, storePath);
}

/** Records Imported guidance ownership, merging compatible imports for the same source. */
export function recordImportedGuidance(repoRoot: string, input: RecordImportedGuidanceInput): void {
  const store = mergeImportedGuidanceIntoRecipeStore(readImportRecipeStore(repoRoot), input);
  writeImportRecipeStore(repoRoot, store);
}

/** Lists Skill slugs staged by the upstream CLI under `.agents/skills`. */
export function listStagedSkillSlugs(stagingDirectory: string): string[] {
  const stagedSkillsRoot = path.join(stagingDirectory, ".agents", "skills");
  if (!existsSync(stagedSkillsRoot)) {
    throw new MonkeError(`Expected staged skills at ${stagedSkillsRoot}`);
  }

  const stagedSkillNames = readdirSync(stagedSkillsRoot)
    .filter((entry) => {
      const entryPath = path.join(stagedSkillsRoot, entry);
      return statSync(entryPath).isDirectory();
    })
    .toSorted();

  if (stagedSkillNames.length === 0) {
    throw new MonkeError(`No staged skill directories found at ${stagedSkillsRoot}`);
  }

  return stagedSkillNames;
}

/** Materializes staged upstream guidance using its recorded local Import kind. */
export function copyStagedGuidanceToManagedRoots(options: {
  commitState?: () => void;
  guidance: readonly SkillImportRecipeSkill[];
  obsoleteGuidance?: readonly SkillImportRecipeSkill[];
  repoRoot: string;
  stagingDirectory: string;
}): void {
  const stagedSkillsRoot = path.join(options.stagingDirectory, ".agents", "skills");
  const preparedRoot = mkdtempSync(path.join(tmpdir(), "monke-guidance-prepared-"));
  const backupRoot = mkdtempSync(path.join(options.repoRoot, ".monke-guidance-backup-"));
  const affectedPaths = new Map<string, string>();

  try {
    for (const item of options.guidance) {
      const sourcePath = path.join(stagedSkillsRoot, item.slug);
      if (!existsSync(sourcePath)) {
        throw new MonkeError(`Expected staged Skill directory at ${sourcePath}`);
      }
      if (!lstatSync(sourcePath).isDirectory()) {
        throw new MonkeError(`Expected staged Skill directory to be a regular directory`);
      }

      const preparedPath = path.join(preparedRoot, item.kind, item.slug);
      mkdirSync(path.dirname(preparedPath), { recursive: true });
      cpSync(sourcePath, preparedPath, { recursive: true, verbatimSymlinks: true });
      if (item.kind === "reference") {
        transformPreparedReference(preparedPath);
      }
    }

    const affectedGuidance = [...options.guidance, ...(options.obsoleteGuidance ?? [])];
    assertObsoleteReferencesAreUnconsumed(options.repoRoot, options.obsoleteGuidance ?? []);
    for (const [index, item] of affectedGuidance.entries()) {
      const targetPath = importedGuidancePath(options.repoRoot, item);
      if (affectedPaths.has(targetPath)) {
        continue;
      }
      const backupPath = path.join(backupRoot, String(index));
      affectedPaths.set(targetPath, backupPath);
      if (existsSync(targetPath)) {
        renameSync(targetPath, backupPath);
      }
    }

    for (const item of options.guidance) {
      const targetPath = importedGuidancePath(options.repoRoot, item);
      mkdirSync(path.dirname(targetPath), { recursive: true });
      cpSync(path.join(preparedRoot, item.kind, item.slug), targetPath, {
        recursive: true,
        verbatimSymlinks: true
      });
    }
    options.commitState?.();
  } catch (error) {
    for (const [targetPath, backupPath] of affectedPaths) {
      rmSync(targetPath, { force: true, recursive: true });
      if (existsSync(backupPath)) {
        mkdirSync(path.dirname(targetPath), { recursive: true });
        renameSync(backupPath, targetPath);
      }
    }
    throw error;
  } finally {
    rmSync(preparedRoot, { force: true, recursive: true });
    rmSync(backupRoot, { force: true, recursive: true });
  }
}

function transformPreparedReference(referencePath: string): void {
  const skillEntryPath = path.join(referencePath, "SKILL.md");
  const referenceEntryPath = path.join(referencePath, "MAIN.md");
  if (existsSync(referenceEntryPath)) {
    throw new MonkeError(
      `Cannot import reference because upstream guidance already contains MAIN.md at ${referenceEntryPath}`
    );
  }
  if (!existsSync(skillEntryPath)) {
    throw new MonkeError(`Expected staged Skill entry document at ${skillEntryPath}`);
  }
  if (!lstatSync(skillEntryPath).isFile()) {
    throw new MonkeError(`Expected staged Skill entry document to be a regular file`);
  }

  const body = removeLeadingYamlFrontmatter(readFileSync(skillEntryPath, "utf-8"));
  unlinkSync(skillEntryPath);
  writeFileSync(referenceEntryPath, body, { encoding: "utf-8", flag: "wx" });
}

function removeLeadingYamlFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    return markdown;
  }

  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(markdown);
  if (!match) {
    throw new MonkeError("Imported reference has unterminated leading YAML frontmatter");
  }
  return markdown.slice(match[0].length);
}

function assertObsoleteReferencesAreUnconsumed(
  repoRoot: string,
  obsoleteGuidance: readonly SkillImportRecipeSkill[]
): void {
  for (const guidance of obsoleteGuidance) {
    if (guidance.kind !== "reference") {
      continue;
    }

    const obsoleteReferenceRoot = importedGuidancePath(repoRoot, guidance);
    const referencePathPrefix = `${path.posix.join("references", "imported", guidance.slug)}/`;
    const consumers = [
      INTERNAL_SKILLS_ROOT,
      IMPORTED_SKILLS_ROOT,
      INTERNAL_REFERENCES_ROOT,
      IMPORTED_REFERENCES_ROOT
    ]
      .flatMap((root) =>
        listReferenceConsumers(
          path.join(repoRoot, root),
          obsoleteReferenceRoot,
          referencePathPrefix
        )
      )
      .map((entryPath) => path.relative(repoRoot, entryPath))
      .toSorted();

    if (consumers.length > 0) {
      throw new MonkeError(
        `Cannot replace Imported reference ${guidance.slug}; it is used by ${consumers.join(", ")}`
      );
    }
  }
}

function listReferenceConsumers(
  root: string,
  obsoleteReferenceRoot: string,
  referencePathPrefix: string
): string[] {
  if (!existsSync(root) || isPathWithin(obsoleteReferenceRoot, root)) {
    return [];
  }

  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return listReferenceConsumers(entryPath, obsoleteReferenceRoot, referencePathPrefix);
    }
    if (entry.isFile()) {
      const content = readFileSync(entryPath, "utf-8");
      const consumesReference =
        content.includes(referencePathPrefix) ||
        contentContainsRelativePathInto(content, path.dirname(entryPath), obsoleteReferenceRoot);
      return consumesReference ? [entryPath] : [];
    }
    if (entry.isSymbolicLink()) {
      const linkTarget = readlinkSync(entryPath);
      const resolvedTarget = path.resolve(path.dirname(entryPath), linkTarget);
      return linkTarget.includes(referencePathPrefix) ||
        isPathWithin(obsoleteReferenceRoot, resolvedTarget)
        ? [entryPath]
        : [];
    }
    return [];
  });
}

function contentContainsRelativePathInto(
  content: string,
  consumerDirectory: string,
  targetRoot: string
): boolean {
  const relativePathPattern = /(?:\.\.?\/)+[^\s)"'`>]+/gu;
  return [...content.matchAll(relativePathPattern)].some((match) =>
    isPathWithin(targetRoot, path.resolve(consumerDirectory, match[0] ?? ""))
  );
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relativePath = path.relative(parent, candidate);
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== ".." &&
      !path.isAbsolute(relativePath))
  );
}

export function importedGuidancePath(
  repoRoot: string,
  guidance: Pick<SkillImportRecipeSkill, "kind" | "slug">
): string {
  const root = guidance.kind === "reference" ? IMPORTED_REFERENCES_ROOT : IMPORTED_SKILLS_ROOT;
  return path.join(repoRoot, root, guidance.slug);
}

function mergeImportedGuidanceIntoRecipeStore(
  store: SkillImportRecipeStore,
  input: RecordImportedGuidanceInput
): SkillImportRecipeStore {
  if (input.skills.length === 0) {
    throw new MonkeError("At least one imported skill must be recorded");
  }

  const nextStore = normalizeImportRecipeStore(store);
  assertUniqueImportedSkillOwners(nextStore);
  const importedGuidance = input.skills.map((skill) => ({ ...skill, kind: input.kind }));

  const recipe = nextStore.recipes.find((candidate) => candidate.source === input.source);
  if (recipe) {
    if (Boolean(recipe.acceptOpenClawRisks) !== input.acceptOpenClawRisks) {
      throw new MonkeError(
        `Skill import recipe for ${input.source} already exists with a different OpenClaw risk setting`
      );
    }

    for (const skill of importedGuidance) {
      assertSkillCanBeOwnedByRecipe(nextStore, recipe, skill);
      const existingSkill = recipe.skills.find(
        (candidate) => candidate.selector === skill.selector
      );
      if (existingSkill) {
        if (existingSkill.slug !== skill.slug) {
          throw new MonkeError(
            `Skill import selector ${skill.selector} is already recorded with slug ${existingSkill.slug}`
          );
        }
        if (
          recipe.skills.some(
            (candidate) =>
              candidate !== existingSkill &&
              candidate.kind === skill.kind &&
              candidate.slug === skill.slug
          )
        ) {
          throw new MonkeError(
            `Imported ${skill.kind} slug ${skill.slug} is already owned by ${input.source}`
          );
        }
        existingSkill.kind = skill.kind;
        continue;
      }

      if (
        recipe.skills.some(
          (candidate) => candidate.kind === skill.kind && candidate.slug === skill.slug
        )
      ) {
        throw new MonkeError(
          `Imported ${skill.kind} slug ${skill.slug} is already owned by ${input.source}`
        );
      }

      recipe.skills.push(skill);
    }
  } else {
    const newRecipe: SkillImportRecipe = {
      source: input.source,
      ...(input.acceptOpenClawRisks ? { acceptOpenClawRisks: true as const } : {}),
      skills: importedGuidance
    };

    for (const skill of importedGuidance) {
      assertSkillCanBeOwnedByRecipe(nextStore, newRecipe, skill);
    }

    nextStore.recipes.push(newRecipe);
  }

  return nextStore;
}

/** Extracts and renders the upstream security assessment from noisy install output. */
export function extractSecurityRiskAssessment(output: string): string | null {
  const assessment = parseSecurityRiskAssessment(output);
  if (!assessment) {
    return null;
  }

  return renderSecurityRiskAssessment(assessment);
}

/** Writes a non-empty upstream security assessment when one is present. */
export function reportSecurityRiskAssessment(
  output: string,
  writeMessage: (message: string) => unknown
): void {
  const assessment = extractSecurityRiskAssessment(output);
  if (assessment) {
    writeMessage(assessment);
  }
}

/** Parses upstream security assessment rows from install output. */
function parseSecurityRiskAssessment(output: string): SecurityRiskAssessment | null {
  const rawLines = output.split(/\r?\n/u);
  const strippedLines = rawLines.map(stripTerminalEscapes);
  const startIndex = strippedLines.findIndex((line) => line.includes("Security Risk Assessments"));
  if (startIndex === -1) {
    return null;
  }

  const rows: SecurityRiskRow[] = [];
  let detailsUrl: string | null = null;

  for (let index = startIndex + 1; index < strippedLines.length; index += 1) {
    const rawLine = strippedLines[index];
    if (rawLine === undefined) {
      continue;
    }
    const line = cleanSecurityRiskAssessmentLine(rawLine);
    if (
      line.includes("Installation complete") ||
      line.includes("Installed ") ||
      line.startsWith("Done!")
    ) {
      break;
    }

    if (!line || line.includes("Gen") || line.includes("Socket") || line.includes("Snyk")) {
      continue;
    }

    if (line.startsWith("Details:")) {
      detailsUrl = line.slice("Details:".length).trim() || null;
      continue;
    }

    const row = parseSecurityRiskRow(line);
    if (row) {
      rows.push(row);
    }
  }

  if (rows.length === 0 && !detailsUrl) {
    return null;
  }

  return {
    detailsUrl,
    rows
  };
}

/** Runs the source-maintenance Skill import workflow. */
export async function runImportSkills(
  argv: string[] = process.argv.slice(2),
  dependencies: ImportSkillsDependencies = {}
): Promise<void> {
  const { acceptOpenClawRisks, install, kind, source } = parseCommand(argv);
  const repoRoot = process.cwd();
  const normalizedSource = normalizeSourceForStaging(source, repoRoot);
  const stagingDirectory = mkdtempSync(path.join(tmpdir(), "monke-skills-import-"));
  const writeMessage = dependencies.writeMessage ?? process.stdout.write.bind(process.stdout);

  try {
    const listOutput = runSkillsCaptured(
      buildSkillsListArgs(normalizedSource, acceptOpenClawRisks),
      stagingDirectory
    );
    const availableSkillGroups = parseAvailableSkillGroups(
      `${listOutput.stdout}\n${listOutput.stderr}`
    );
    const selectedSkills = await (dependencies.selectSkills ?? promptForSkillSelection)(
      availableSkillGroups
    );

    const installOutput = runSkillsCaptured(
      buildSkillsInstallArgs({
        acceptOpenClawRisks,
        selectors: selectedSkills,
        source: normalizedSource
      }),
      stagingDirectory
    );
    reportSecurityRiskAssessment(`${installOutput.stdout}\n${installOutput.stderr}`, writeMessage);

    const stagedSlugs = listStagedSkillSlugs(stagingDirectory);
    const stagedSelections = mapSelectedSkillsToImportedSlugs({
      acceptOpenClawRisks,
      importedSkillSlugs: stagedSlugs,
      selectors: selectedSkills,
      source: normalizedSource
    });
    const previousRecipeStore = readImportRecipeStore(repoRoot);
    const importedGuidance = stagedSelections.map((selection) => ({ ...selection, kind }));
    const obsoleteGuidance = findMigratedGuidanceCopies({
      importedGuidance,
      previousStore: previousRecipeStore,
      source
    });
    const nextRecipeStore = mergeImportedGuidanceIntoRecipeStore(previousRecipeStore, {
      acceptOpenClawRisks,
      kind,
      skills: stagedSelections,
      source
    });
    copyStagedGuidanceToManagedRoots({
      commitState() {
        writeImportRecipeStore(repoRoot, nextRecipeStore);
      },
      guidance: importedGuidance,
      obsoleteGuidance,
      repoRoot,
      stagingDirectory
    });

    if (install) {
      writeMessage("Installing imported skills into configured agent roots...\n");
      (dependencies.runInstallCommand ?? runInstallCommand)(repoRoot);
    }
  } finally {
    rmSync(stagingDirectory, { force: true, recursive: true });
  }
}

function findMigratedGuidanceCopies(options: {
  importedGuidance: readonly SkillImportRecipeSkill[];
  previousStore: SkillImportRecipeStore;
  source: string;
}): SkillImportRecipeSkill[] {
  const previousRecipe = options.previousStore.recipes.find(
    (recipe) => recipe.source === options.source
  );
  if (!previousRecipe) {
    return [];
  }

  const migrated: SkillImportRecipeSkill[] = [];
  for (const guidance of options.importedGuidance) {
    const previous = previousRecipe.skills.find(
      (candidate) => candidate.selector === guidance.selector
    );
    if (!previous || previous.kind === guidance.kind) {
      continue;
    }
    migrated.push(previous);
  }
  return migrated;
}

function parseCommand(argv: string[]): ImportCommandOptions {
  const program = new Command()
    .name("bun run skills:import")
    .description("Import external agent guidance as skills or references")
    .argument("<source>")
    .option("-i, --install", "Run the monke-tools skill install command after importing")
    .option("--ref", "Import every selection as a non-discoverable reference")
    .option("--accept-openclaw-risks", "Pass the upstream OpenClaw risk acceptance flag")
    .allowExcessArguments(false);

  configureCliParser(program);
  program.parse(argv, { from: "user" });

  const options = program.opts();
  return {
    acceptOpenClawRisks: Boolean(options.acceptOpenclawRisks),
    install: Boolean(options.install),
    kind: options.ref ? "reference" : "skill",
    source: program.processedArgs[0]
  };
}

function buildOpenClawRiskArgs(acceptOpenClawRisks: boolean): string[] {
  return acceptOpenClawRisks ? ["--dangerously-accept-openclaw-risks"] : [];
}

/** Runs the local skill install command against a monke-tools source checkout. */
export function runInstallCommand(repoRoot: string): void {
  const result = spawnSync(
    process.execPath,
    ["run", path.join(repoRoot, "src", "index.ts"), "skills", "local-install", repoRoot],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit"
    }
  );

  if (result.error) {
    throw new MonkeError(`Failed to run skill install command: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new MonkeError(
      `Skill install command failed with ${result.signal ? `signal ${result.signal}` : `exit code ${result.status ?? "unknown"}`}`
    );
  }
}

/** Runs upstream `skills` CLI arguments and returns captured output or throws on failure. */
export function runSkillsCaptured(args: string[], cwd: string): CapturedCommandOutput {
  const result = spawnSync(NPX_COMMAND, args, {
    cwd,
    encoding: "utf-8",
    env: process.env
  });

  if (result.error) {
    throw new MonkeError(`Failed to run skills CLI: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new MonkeError(
      `Command failed: ${formatCommand(NPX_COMMAND, args)}${details ? `\n${details}` : ""}`
    );
  }

  return {
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? ""
  };
}

function formatCommand(command: string, args: readonly string[]): string {
  return [path.basename(command), ...args].join(" ");
}

function renderSecurityRiskAssessment(assessment: SecurityRiskAssessment): string {
  const skillWidth = Math.max(
    "Skill".length,
    ...assessment.rows.map((row) => row.skillName.length)
  );
  const genWidth = Math.max("Gen".length, ...assessment.rows.map((row) => row.gen.length), 8);
  const socketWidth = Math.max(
    "Socket".length,
    ...assessment.rows.map((row) => row.socket.length),
    12
  );
  const snykWidth = Math.max("Snyk".length, ...assessment.rows.map((row) => row.snyk.length), 8);
  const bodyLines = [
    [
      " ".repeat(skillWidth + 2),
      pc.dim(padEndVisible("Gen", genWidth + 2)),
      pc.dim(padEndVisible("Socket", socketWidth + 2)),
      pc.dim(padEndVisible("Snyk", snykWidth))
    ].join(""),
    ...assessment.rows.map((row) =>
      [
        padEndVisible(pc.cyan(row.skillName), skillWidth + 2),
        padEndVisible(riskValueLabel(row.gen), genWidth + 2),
        padEndVisible(socketValueLabel(row.socket), socketWidth + 2),
        padEndVisible(riskValueLabel(row.snyk), snykWidth)
      ].join("")
    )
  ];

  if (assessment.detailsUrl) {
    bodyLines.push("", `${pc.dim("Details:")} ${pc.dim(assessment.detailsUrl)}`);
  }

  return renderNoteBox("Security Risk Assessments", bodyLines);
}

function parseSecurityRiskRow(line: string): SecurityRiskRow | null {
  const wideParts = line.split(/\s{2,}/u).filter(Boolean);
  if (wideParts.length >= 4) {
    const [skillName, gen, socket, snyk] = wideParts;
    if (
      skillName === undefined ||
      gen === undefined ||
      socket === undefined ||
      snyk === undefined
    ) {
      return null;
    }
    return {
      gen,
      skillName,
      snyk,
      socket
    };
  }

  const riskPattern = "(?:Critical Risk|High Risk|Med Risk|Low Risk|Safe|--)";
  const rowPattern = new RegExp(
    `^(\\S+)\\s+(${riskPattern})\\s+((?:\\d+ alerts?)|--)\\s+(${riskPattern})$`,
    "u"
  );
  const match = line.match(rowPattern);
  if (!match) {
    return null;
  }

  const [, skillName = "", gen = "", socket = "", snyk = ""] = match;
  return {
    gen,
    skillName,
    snyk,
    socket
  };
}

function cleanSecurityRiskAssessmentLine(line: string): string {
  let cleaned = line.trim();
  if (cleaned.startsWith("\u2502")) {
    cleaned = cleaned.slice(1).trimEnd();
  }
  if (cleaned.endsWith("\u2502")) {
    cleaned = cleaned.slice(0, -1).trimEnd();
  }

  return cleaned.trim();
}

function renderNoteBox(title: string, bodyLines: string[]): string {
  const contentWidth = Math.max(
    visibleLength(title) + 2,
    ...bodyLines.map((line) => visibleLength(line))
  );
  const titlePrefix = `${pc.green("\u25C7")}  ${title} `;
  const topRuleWidth = Math.max(1, contentWidth - visibleLength(title) - 1);
  const lines = [
    `${titlePrefix}${pc.dim("\u2500".repeat(topRuleWidth))}${pc.dim("\u256E")}`,
    ...bodyLines.map((line) => {
      const padding = " ".repeat(contentWidth - visibleLength(line));
      return `${pc.dim("\u2502")} ${line}${padding} ${pc.dim("\u2502")}`;
    }),
    `${pc.dim("\u2570")}${pc.dim("\u2500".repeat(contentWidth + 2))}${pc.dim("\u256F")}`
  ];

  return `${lines.join("\n")}\n`;
}

function riskValueLabel(value: string): string {
  switch (value.toLowerCase()) {
    case "safe":
    case "low risk": {
      return pc.green(value);
    }
    case "med risk": {
      return pc.yellow(value);
    }
    case "high risk":
    case "critical risk": {
      return pc.red(value);
    }
    case "--": {
      return pc.dim(value);
    }
    default: {
      return value;
    }
  }
}

function socketValueLabel(value: string): string {
  if (value === "--") {
    return pc.dim(value);
  }

  if (value.startsWith("0 ")) {
    return pc.green(value);
  }

  return pc.red(value);
}

function padEndVisible(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}

function visibleLength(value: string): number {
  return stripTerminalEscapes(value).length;
}

async function promptForSkillSelection(
  availableSkillGroups: readonly AvailableSkillGroup[]
): Promise<string[]> {
  const groupedOptions = buildGroupedSkillOptions(availableSkillGroups);
  const firstSkillName = availableSkillGroups.find((group) => group.skills.length > 0)?.skills[0];
  const selectedSkills = await groupedSkillMultiselect({
    cursorAt: firstSkillName,
    maxItems: 10,
    message: `Select skills to import ${pc.dim("(space to toggle)")}`,
    options: groupedOptions,
    required: true
  });

  if (p.isCancel(selectedSkills)) {
    throw new MonkeError("Skill import cancelled");
  }

  return [...selectedSkills];
}

/** Builds grouped prompt options for the interactive Skill import selector. */
export function buildGroupedSkillOptions(
  availableSkillGroups: readonly AvailableSkillGroup[]
): GroupedSkillOptions {
  return Object.fromEntries(
    availableSkillGroups
      .filter((group) => group.skills.length > 0)
      .map((group) => [
        group.name,
        group.skills.map((skill) => ({
          label: skill,
          value: skill
        }))
      ])
  );
}

async function groupedSkillMultiselect(options: {
  cursorAt?: string;
  maxItems: number;
  message: string;
  options: GroupedSkillOptions;
  required: boolean;
}): Promise<string[] | symbol> {
  const result: unknown = await new GroupMultiSelectPrompt<p.Option<string>>({
    cursorAt: options.cursorAt,
    options: options.options,
    render() {
      const rawValue: unknown = this.value;
      const selectedValues = Array.isArray(rawValue)
        ? rawValue.filter((value): value is string => typeof value === "string")
        : [];
      const title = `${pc.gray("\u2502")}
${stepSymbol(this.state)}  ${options.message}
`;

      switch (this.state) {
        case "submit": {
          return `${title}${pc.gray("\u2502")}  ${this.options
            .filter((option) => selectedValues.includes(option.value))
            .map((option) => renderGroupedPromptOption(option, "submitted", this.options))
            .join(pc.dim(", "))}`;
        }
        case "cancel": {
          const selected = this.options
            .filter((option) => selectedValues.includes(option.value))
            .map((option) => renderGroupedPromptOption(option, "cancelled", this.options))
            .join(pc.dim(", "));
          return `${title}${pc.gray("\u2502")}  ${
            selected.trim() ? `${selected}\n${pc.gray("\u2502")}` : ""
          }`;
        }
        case "error": {
          const rawError: unknown = this.error;
          const error = (typeof rawError === "string" ? rawError : "")
            .split("\n")
            .map((line, index) =>
              index === 0 ? `${pc.yellow("\u2514")}  ${pc.yellow(line)}` : `   ${line}`
            )
            .join("\n");
          return `${title}${pc.yellow("\u2502")}  ${renderVisibleGroupedPromptOptions({
            bar: pc.yellow("\u2502"),
            cursor: this.cursor,
            maxItems: options.maxItems,
            options: this.options,
            selectedValues
          })}
${error}
`;
        }
        case "active":
        case "initial": {
          return `${title}${pc.cyan("\u2502")}  ${renderVisibleGroupedPromptOptions({
            bar: pc.cyan("\u2502"),
            cursor: this.cursor,
            maxItems: options.maxItems,
            options: this.options,
            selectedValues
          })}
${pc.cyan("\u2514")}
`;
        }
        default: {
          throw new MonkeError("Unsupported grouped prompt state");
        }
      }
    },
    required: options.required,
    selectableGroups: false,
    validate(value) {
      const rawValue: unknown = value;
      if (this.required === true && Array.isArray(rawValue) && rawValue.length === 0) {
        return `Please select at least one skill.
${pc.reset(pc.dim(`Press ${pc.gray(pc.bgWhite(pc.inverse(" space ")))} to select, ${pc.gray(pc.bgWhite(pc.inverse(" enter ")))} to submit`))}`;
      }
      // Clack uses undefined as the successful validation sentinel.
      // oxlint-disable-next-line unicorn/no-useless-undefined
      return undefined;
    }
  }).prompt();

  if (typeof result === "symbol") {
    return result;
  }
  if (Array.isArray(result) && result.every((value) => typeof value === "string")) {
    return result;
  }
  throw new MonkeError("Grouped Skill selection returned an invalid value");
}

type GroupedPromptOption = p.Option<string> & { group: string | boolean };
type GroupedPromptOptionState =
  | "active"
  | "inactive"
  | "selected"
  | "active-selected"
  | "submitted"
  | "cancelled";

function renderVisibleGroupedPromptOptions(options: {
  bar: string;
  cursor: number;
  maxItems: number;
  options: readonly GroupedPromptOption[];
  selectedValues: readonly string[];
}): string {
  const visibleOptions = getVisibleGroupedPromptOptions({
    cursor: options.cursor,
    maxItems: options.maxItems,
    options: options.options
  });

  return visibleOptions
    .map((option) => {
      const selected = options.selectedValues.includes(option.value);
      const active = option.index === options.cursor;
      const state =
        active && selected
          ? "active-selected"
          : active
            ? "active"
            : selected
              ? "selected"
              : "inactive";
      return renderGroupedPromptOption(option, state, options.options);
    })
    .join(`\n${options.bar}  `);
}

function getVisibleGroupedPromptOptions(options: {
  cursor: number;
  maxItems: number;
  options: readonly GroupedPromptOption[];
}): (GroupedPromptOption & { index: number })[] {
  const terminalRows =
    process.stdout.rows !== undefined && process.stdout.rows > 0 ? process.stdout.rows - 4 : 10;
  const maxItems = Math.max(5, Math.min(options.maxItems, terminalRows));
  const indexedOptions = options.options.map((option, index) => ({ ...option, index }));
  let start = Math.max(
    0,
    Math.min(options.cursor - Math.floor(maxItems / 2), options.options.length - maxItems)
  );
  let end = Math.min(options.options.length, start + maxItems);
  const cursorOption = options.options[options.cursor];
  const cursorGroupName = typeof cursorOption?.group === "string" ? cursorOption.group : null;

  if (cursorGroupName) {
    const groupHeaderIndex = options.options.findIndex(
      (option) => option.group === true && option.value === cursorGroupName
    );
    if (groupHeaderIndex !== -1 && groupHeaderIndex < start) {
      start = groupHeaderIndex;
      end = Math.min(options.options.length, start + maxItems);
      if (options.cursor >= end) {
        end = options.cursor + 1;
        start = Math.max(0, end - maxItems);
      }
    }
  }

  const visible = indexedOptions.slice(start, end);
  const hasCurrentGroupHeader =
    !cursorGroupName ||
    visible.some((option) => option.group === true && option.value === cursorGroupName);
  if (cursorGroupName && !hasCurrentGroupHeader) {
    visible.unshift({
      group: true,
      index: -1,
      label: cursorGroupName,
      value: cursorGroupName
    });
  }

  if (start > 0) {
    visible.unshift({
      group: true,
      index: -1,
      label: "...",
      value: "__more_before__"
    });
  }
  if (end < options.options.length) {
    visible.push({
      group: true,
      index: -1,
      label: "...",
      value: "__more_after__"
    });
  }

  return visible;
}

function renderGroupedPromptOption(
  option: GroupedPromptOption & { index?: number },
  state: GroupedPromptOptionState,
  allOptions: readonly GroupedPromptOption[]
): string {
  const label = option.label ?? option.value;
  if (option.group === true) {
    return pc.dim(label);
  }

  const optionIndex = option.index ?? allOptions.indexOf(option);
  const nextOption = allOptions[optionIndex + 1];
  const isLastInGroup = nextOption?.group === true;
  const branch = pc.dim(`${isLastInGroup ? "\u2514" : "\u2502"} `);

  switch (state) {
    case "active": {
      return `${branch}${pc.cyan("\u25FB")} ${label}`;
    }
    case "selected": {
      return `${branch}${pc.green("\u25FC")} ${pc.dim(label)}`;
    }
    case "active-selected": {
      return `${branch}${pc.green("\u25FC")} ${label}`;
    }
    case "submitted": {
      return pc.dim(label);
    }
    case "cancelled": {
      return pc.strikethrough(pc.dim(label));
    }
    case "inactive": {
      return `${branch}${pc.dim("\u25FB")} ${pc.dim(label)}`;
    }
    default: {
      throw new MonkeError("Unsupported grouped prompt option state");
    }
  }
}

function stepSymbol(state: string): string {
  switch (state) {
    case "cancel": {
      return pc.red("\u25A0");
    }
    case "error": {
      return pc.yellow("\u25B2");
    }
    case "submit": {
      return pc.green("\u25C7");
    }
    default: {
      return pc.cyan("\u25C6");
    }
  }
}

export function normalizeImportRecipeStore(input: unknown): SkillImportRecipeStore {
  const store = parseBoundaryValue(
    SkillImportRecipeStoreSchema,
    input,
    "Skill import recipe store"
  );

  const recipes = store.recipes.map((recipe) => {
    assertUniqueRecipeSkillSelectors(recipe.source, recipe.skills);
    assertUniqueRecipeSkillSlugs(recipe.source, recipe.skills);
    return {
      ...recipe,
      skills: recipe.skills.toSorted((left, right) => {
        const slugOrder = left.slug.localeCompare(right.slug);
        return slugOrder === 0 ? left.selector.localeCompare(right.selector) : slugOrder;
      })
    };
  });
  assertUniqueRecipeSources(recipes);
  assertUniqueImportedSkillOwners({ recipes, version: 2 });

  return {
    recipes: recipes.toSorted((left, right) => {
      const sourceOrder = left.source.localeCompare(right.source);
      if (sourceOrder !== 0) {
        return sourceOrder;
      }

      return Number(Boolean(left.acceptOpenClawRisks)) - Number(Boolean(right.acceptOpenClawRisks));
    }),
    version: 2
  };
}

function assertUniqueRecipeSources(recipes: readonly SkillImportRecipe[]): void {
  const sources = new Set<string>();
  for (const recipe of recipes) {
    if (sources.has(recipe.source)) {
      throw new MonkeError(`Duplicate skill import recipe source: ${recipe.source}`);
    }

    sources.add(recipe.source);
  }
}

function assertUniqueRecipeSkillSelectors(
  source: string,
  skills: readonly SkillImportRecipeSkill[]
): void {
  const selectors = new Set<string>();
  for (const skill of skills) {
    if (selectors.has(skill.selector)) {
      throw new MonkeError(`Duplicate skill selector in recipe ${source}: ${skill.selector}`);
    }

    selectors.add(skill.selector);
  }
}

function assertUniqueRecipeSkillSlugs(
  source: string,
  skills: readonly SkillImportRecipeSkill[]
): void {
  const slugs = new Set<string>();
  for (const skill of skills) {
    if (slugs.has(skill.slug)) {
      throw new MonkeError(`Duplicate imported slug in recipe ${source}: ${skill.slug}`);
    }

    slugs.add(skill.slug);
  }
}

function assertUniqueImportedSkillOwners(store: SkillImportRecipeStore): void {
  const owners = new Map<string, string>();

  for (const recipe of store.recipes) {
    for (const skill of recipe.skills) {
      const ownershipKey = `${skill.kind}:${skill.slug}`;
      const existingOwner = owners.get(ownershipKey);
      if (existingOwner !== undefined) {
        throw new MonkeError(
          `Imported ${skill.kind} slug ${skill.slug} is owned by both ${existingOwner} and ${recipe.source}`
        );
      }

      owners.set(ownershipKey, recipe.source);
    }
  }
}

function assertSkillCanBeOwnedByRecipe(
  store: SkillImportRecipeStore,
  owningRecipe: SkillImportRecipe,
  skill: SkillImportRecipeSkill
): void {
  for (const recipe of store.recipes) {
    if (recipe === owningRecipe) {
      continue;
    }

    if (
      recipe.skills.some(
        (candidate) => candidate.kind === skill.kind && candidate.slug === skill.slug
      )
    ) {
      throw new MonkeError(
        `Imported ${skill.kind} slug ${skill.slug} is already owned by recipe ${recipe.source}`
      );
    }
  }
}

function mapSelectedSkillsToImportedSlugs(options: {
  acceptOpenClawRisks: boolean;
  importedSkillSlugs: readonly string[];
  selectors: readonly string[];
  source: string;
}): StagedSkillSelection[] {
  try {
    return mapSelectedSkillsToImportedSlugsFromSet(options.selectors, options.importedSkillSlugs);
  } catch {
    const mappings = resolveSkillSelectorSlugMappings({
      acceptOpenClawRisks: options.acceptOpenClawRisks,
      selectors: options.selectors,
      source: options.source
    });
    assertSkillSelectorSlugMappingsMatchStagedSlugs(
      options.source,
      mappings,
      options.importedSkillSlugs
    );
    return mappings;
  }
}

function mapSelectedSkillsToImportedSlugsFromSet(
  selectors: readonly string[],
  importedSkillSlugs: readonly string[]
): StagedSkillSelection[] {
  if (selectors.length === 0) {
    throw new MonkeError("At least one Skill import selector must be selected");
  }

  const remainingSlugs = new Set(importedSkillSlugs);
  const mappings: StagedSkillSelection[] = [];
  const unmatchedSelectors: string[] = [];

  for (const selector of selectors) {
    if (remainingSlugs.delete(selector)) {
      mappings.push({
        selector,
        slug: selector
      });
      continue;
    }

    unmatchedSelectors.push(selector);
  }

  if (unmatchedSelectors.length === 1 && remainingSlugs.size === 1) {
    const [selector] = unmatchedSelectors;
    const [slug] = remainingSlugs;
    if (selector === undefined || slug === undefined) {
      throw new MonkeError("Expected one unmatched selector and one remaining staged slug");
    }
    mappings.push({
      selector,
      slug
    });
    remainingSlugs.delete(slug);
    unmatchedSelectors.pop();
  }

  if (unmatchedSelectors.length > 0 || remainingSlugs.size > 0) {
    throw new MonkeError(
      [
        "Could not map selected Skill import selectors to staged Skill slugs.",
        `Selectors: ${selectors.join(", ")}`,
        `Staged slugs: ${importedSkillSlugs.join(", ")}`
      ].join("\n")
    );
  }

  return mappings;
}

/** Resolves exact selector-to-local-slug mappings by staging each selector in isolation. */
export function resolveSkillSelectorSlugMappings(
  options: ResolveSkillSelectorSlugMappingsOptions
): StagedSkillSelection[] {
  if (options.selectors.length === 0) {
    throw new MonkeError("At least one Skill import selector must be selected");
  }

  return options.selectors.map((selector) => resolveSkillSelectorSlugMapping(options, selector));
}

function resolveSkillSelectorSlugMapping(
  options: ResolveSkillSelectorSlugMappingsOptions,
  selector: string
): StagedSkillSelection {
  const stagingDirectory = mkdtempSync(path.join(tmpdir(), "monke-skills-selector-"));
  try {
    runSkillsCaptured(
      buildSkillsInstallArgs({
        acceptOpenClawRisks: options.acceptOpenClawRisks,
        selectors: [selector],
        source: options.source
      }),
      stagingDirectory
    );

    const stagedSlugs = listStagedSkillSlugs(stagingDirectory);
    if (stagedSlugs.length !== 1) {
      throw new MonkeError(
        `Expected selector ${selector} from ${options.source} to stage exactly one Skill, but staged ${stagedSlugs.join(", ")}`
      );
    }
    const [slug] = stagedSlugs;
    if (slug === undefined) {
      throw new MonkeError(`Expected selector ${selector} to resolve to one staged Skill`);
    }
    return { selector, slug };
  } finally {
    rmSync(stagingDirectory, { force: true, recursive: true });
  }
}

/** Ensures isolated selector installs match the batched staged install result. */
export function assertSkillSelectorSlugMappingsMatchStagedSlugs(
  source: string,
  mappings: readonly StagedSkillSelection[],
  stagedSlugs: readonly string[]
): void {
  const mappedSlugs = mappings.map((mapping) => mapping.slug).toSorted();
  const sortedStagedSlugs = [...stagedSlugs].toSorted();
  if (
    mappedSlugs.length !== sortedStagedSlugs.length ||
    mappedSlugs.some((slug, index) => slug !== sortedStagedSlugs[index])
  ) {
    throw new MonkeError(
      [
        `Could not map selected Skill import selectors to staged Skill slugs for ${source}.`,
        `Mapped slugs: ${mappedSlugs.join(", ")}`,
        `Staged slugs: ${sortedStagedSlugs.join(", ")}`
      ].join("\n")
    );
  }
}

function parseSkillRow(line: string): string | null {
  const match = /^\s*(?:\u2502)?(?<indentation> +)(?<rawName>\S.*)$/u.exec(line);
  if (!match?.groups) {
    return null;
  }

  const { indentation = "", rawName = "" } = match.groups;
  if (indentation.length !== 4) {
    return null;
  }

  const skillName = rawName.trim();
  if (!skillName || skillName.startsWith("-") || skillName.includes(":")) {
    return null;
  }

  return skillName;
}

function parseGroupHeader(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("\u2502") || trimmed.startsWith("\u2514")) {
    return null;
  }

  if (trimmed.includes("Available Skills")) {
    return null;
  }

  return trimmed;
}

function getOrCreateSkillGroup(
  groups: AvailableSkillGroup[],
  groupName: string
): AvailableSkillGroup {
  const existing = groups.find((group) => group.name === groupName);
  if (existing) {
    return existing;
  }

  const newGroup = {
    name: groupName,
    skills: []
  };
  groups.push(newGroup);
  return newGroup;
}

function stripTerminalEscapes(value: string): string {
  return value
    .replace(OSC_RE, "")
    .replace(DCS_PM_APC_RE, "")
    .replace(CSI_RE, "")
    .replace(SIMPLE_ESC_RE, "")
    .replace(C1_RE, "")
    .replace(CONTROL_RE, "");
}

function isLocalPath(input: string): boolean {
  return (
    path.isAbsolute(input) ||
    input.startsWith("./") ||
    input.startsWith("../") ||
    input === "." ||
    input === ".." ||
    /^[a-zA-Z]:[/\\]/u.test(input)
  );
}

if (import.meta.main) {
  try {
    await runImportSkills();
  } catch (error) {
    reportCliFailure(error);
  }
}
