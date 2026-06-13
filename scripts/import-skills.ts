#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GroupMultiSelectPrompt } from "@clack/core";
import * as p from "@clack/prompts";
import { Command, CommanderError } from "commander";
import pc from "picocolors";

interface ImportCommandOptions {
  source: string;
  install: boolean;
  acceptOpenClawRisks: boolean;
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
  selectSkills?: (availableSkillGroups: readonly AvailableSkillGroup[]) => Promise<string[]>;
  runInstallCommand?: (repoRoot: string) => void;
  writeMessage?: (message: string) => void;
}

interface SecurityRiskAssessment {
  rows: SecurityRiskRow[];
  detailsUrl: string | null;
}

interface SecurityRiskRow {
  skillName: string;
  gen: string;
  socket: string;
  snyk: string;
}

const NPX_COMMAND = process.platform === "win32" ? "npx.cmd" : "npx";
const SKILLS_CLI_ARGS = ["--yes", "skills", "add"];
const IMPORTED_SKILLS_ROOT = path.join("skills", "imported");
const IMPORT_RECIPE_STORE_PATH = path.join(IMPORTED_SKILLS_ROOT, ".monke-imports.json");
const CSI_RE = new RegExp(String.raw`\u001b\[[\u0030-\u003f]*[\u0020-\u002f]*[\u0040-\u007e]`, "g");
const OSC_RE = new RegExp(String.raw`\u001b\][\s\S]*?(?:\u0007|\u001b\\)`, "g");
const DCS_PM_APC_RE = new RegExp(String.raw`\u001b[P^_][\s\S]*?(?:\u001b\\)`, "g");
const SIMPLE_ESC_RE = new RegExp(String.raw`\u001b[\u0020-\u007e]`, "g");
const C1_RE = new RegExp(String.raw`[\u0080-\u009f]`, "g");
const CONTROL_RE = new RegExp(
  String.raw`[\u0000-\u0006\u0007\u0008\u000b\u000c\u000d-\u001a\u001c-\u001f\u007f]`,
  "g",
);

/** Repo-tracked store for all Skill import recipes. */
export interface SkillImportRecipeStore {
  /** Recipe store schema version. */
  version: 1;
  /** Source-scoped recipes that own imported Skill slugs. */
  recipes: SkillImportRecipe[];
}

/** Source-scoped recipe used to rerun a Skill import. */
export interface SkillImportRecipe {
  /** Human-facing source string passed through to upstream `skills add`. */
  source: string;
  /** Whether the dedicated OpenClaw risk acceptance flag is required. */
  acceptOpenClawRisks?: true;
  /** Imported skills owned by this recipe. */
  skills: SkillImportRecipeSkill[];
}

/** Mapping between an upstream Skill import selector and local Skill slug. */
export interface SkillImportRecipeSkill {
  /** Upstream-facing selector passed as `skills add --skill`. */
  selector: string;
  /** Local imported Skill directory name under `skills/imported`. */
  slug: string;
}

/** Input for recording newly imported skills in the recipe store. */
export interface RecordImportedSkillsInput {
  /** Human-facing source string passed through to upstream `skills add`. */
  source: string;
  /** Whether the dedicated OpenClaw risk acceptance flag was used. */
  acceptOpenClawRisks: boolean;
  /** Selector-to-slug ownership entries created by the import. */
  skills: SkillImportRecipeSkill[];
}

/** Captured output from an upstream `skills` CLI invocation. */
export interface CapturedCommandOutput {
  /** Captured standard output text. */
  stdout: string;
  /** Captured standard error text. */
  stderr: string;
}

/** Options for building an upstream staged Skill install command. */
export interface BuildSkillsInstallArgsOptions {
  /** Source string passed through to upstream `skills add`. */
  source: string;
  /** Whether to pass the dedicated OpenClaw risk acceptance flag. */
  acceptOpenClawRisks: boolean;
  /** Upstream Skill import selectors to install. */
  selectors: readonly string[];
}

/** Options for copying staged Skill directories into the Imported skill mirror. */
export interface CopyStagedSkillsToImportedOptions {
  /** Temporary staging directory containing `.agents/skills`. */
  stagingDirectory: string;
  /** monke-tools source checkout root. */
  repoRoot: string;
}

/** Parses upstream skill selectors from grouped `skills add -l` output. */
export function parseAvailableSkillNames(output: string): string[] {
  return parseAvailableSkillGroups(output).flatMap((group) => group.skills);
}

/** Parses upstream skill groups and selectors from `skills add -l` output. */
export function parseAvailableSkillGroups(output: string): AvailableSkillGroup[] {
  const lines = stripTerminalEscapes(output).split(/\r?\n/);
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
    throw new Error("Could not parse any skills from `skills add <source> -l` output");
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
export function buildSkillsListArgs(source: string, acceptOpenClawRisks: boolean): string[] {
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
    "--yes",
  ];
}

/** Reads the repo-tracked Skill import recipe store, returning an empty store when absent. */
export function readImportRecipeStore(repoRoot: string): SkillImportRecipeStore {
  const storePath = path.join(repoRoot, IMPORT_RECIPE_STORE_PATH);
  if (!existsSync(storePath)) {
    return {
      version: 1,
      recipes: [],
    };
  }

  return normalizeImportRecipeStore(JSON.parse(readFileSync(storePath, "utf8")));
}

/** Writes the Skill import recipe store with deterministic recipe and skill ordering. */
export function writeImportRecipeStore(repoRoot: string, store: SkillImportRecipeStore): void {
  const normalizedStore = normalizeImportRecipeStore(store);
  const storePath = path.join(repoRoot, IMPORT_RECIPE_STORE_PATH);
  mkdirSync(path.dirname(storePath), { recursive: true });
  writeFileSync(storePath, `${JSON.stringify(normalizedStore, null, 2)}\n`, "utf8");
}

/** Records imported skill ownership, merging compatible imports for the same source. */
export function recordImportedSkills(repoRoot: string, input: RecordImportedSkillsInput): void {
  const store = mergeImportedSkillsIntoRecipeStore(readImportRecipeStore(repoRoot), input);
  writeImportRecipeStore(repoRoot, store);
}

/** Lists Skill slugs staged by the upstream CLI under `.agents/skills`. */
export function listStagedSkillSlugs(stagingDirectory: string): string[] {
  const stagedSkillsRoot = path.join(stagingDirectory, ".agents", "skills");
  if (!existsSync(stagedSkillsRoot)) {
    throw new Error(`Expected staged skills at ${stagedSkillsRoot}`);
  }

  const stagedSkillNames = readdirSync(stagedSkillsRoot)
    .filter((entry) => {
      const entryPath = path.join(stagedSkillsRoot, entry);
      return statSync(entryPath).isDirectory();
    })
    .sort();

  if (stagedSkillNames.length === 0) {
    throw new Error(`No staged skill directories found at ${stagedSkillsRoot}`);
  }

  return stagedSkillNames;
}

/** Copies staged Skill directories into `skills/imported` and returns copied slugs. */
export function copyStagedSkillsToImported(options: CopyStagedSkillsToImportedOptions): string[] {
  const stagedSkillsRoot = path.join(options.stagingDirectory, ".agents", "skills");
  const importedSkillsRoot = path.join(options.repoRoot, IMPORTED_SKILLS_ROOT);
  const stagedSkillNames = listStagedSkillSlugs(options.stagingDirectory);

  mkdirSync(importedSkillsRoot, { recursive: true });

  for (const skillName of stagedSkillNames) {
    const sourcePath = path.join(stagedSkillsRoot, skillName);
    const targetPath = path.join(importedSkillsRoot, skillName);
    rmSync(targetPath, { recursive: true, force: true });
    cpSync(sourcePath, targetPath, { recursive: true });
  }

  return stagedSkillNames;
}

function mergeImportedSkillsIntoRecipeStore(
  store: SkillImportRecipeStore,
  input: RecordImportedSkillsInput,
): SkillImportRecipeStore {
  if (input.skills.length === 0) {
    throw new Error("At least one imported skill must be recorded");
  }

  const nextStore = normalizeImportRecipeStore(store);
  assertUniqueImportedSkillOwners(nextStore);

  const recipe = nextStore.recipes.find((candidate) => candidate.source === input.source);
  if (recipe) {
    if (Boolean(recipe.acceptOpenClawRisks) !== input.acceptOpenClawRisks) {
      throw new Error(
        `Skill import recipe for ${input.source} already exists with a different OpenClaw risk setting`,
      );
    }

    for (const skill of input.skills) {
      assertSkillCanBeOwnedByRecipe(nextStore, recipe, skill);
      const existingSkill = recipe.skills.find(
        (candidate) => candidate.selector === skill.selector,
      );
      if (existingSkill) {
        if (existingSkill.slug !== skill.slug) {
          throw new Error(
            `Skill import selector ${skill.selector} is already recorded with slug ${existingSkill.slug}`,
          );
        }
        continue;
      }

      if (recipe.skills.some((candidate) => candidate.slug === skill.slug)) {
        throw new Error(`Imported skill slug ${skill.slug} is already owned by ${input.source}`);
      }

      recipe.skills.push(skill);
    }
  } else {
    const newRecipe: SkillImportRecipe = {
      source: input.source,
      ...(input.acceptOpenClawRisks ? { acceptOpenClawRisks: true as const } : {}),
      skills: [...input.skills],
    };

    for (const skill of input.skills) {
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

/** Parses upstream security assessment rows from install output. */
export function parseSecurityRiskAssessment(output: string): SecurityRiskAssessment | null {
  const rawLines = output.split(/\r?\n/);
  const strippedLines = rawLines.map(stripTerminalEscapes);
  const startIndex = strippedLines.findIndex((line) => line.includes("Security Risk Assessments"));
  if (startIndex === -1) {
    return null;
  }

  const rows: SecurityRiskRow[] = [];
  let detailsUrl: string | null = null;

  for (let index = startIndex + 1; index < strippedLines.length; index++) {
    const line = cleanSecurityRiskAssessmentLine(strippedLines[index]!);
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
    rows,
    detailsUrl,
  };
}

/** Runs the source-maintenance Skill import workflow. */
export async function runImportSkills(
  argv: string[] = process.argv.slice(2),
  dependencies: ImportSkillsDependencies = {},
): Promise<void> {
  const { source, install, acceptOpenClawRisks } = parseCommand(argv);
  const repoRoot = process.cwd();
  const normalizedSource = normalizeSourceForStaging(source, repoRoot);
  const stagingDirectory = mkdtempSync(path.join(tmpdir(), "monke-skills-import-"));
  const writeMessage = dependencies.writeMessage ?? process.stdout.write.bind(process.stdout);

  try {
    const listOutput = runSkillsCaptured(
      buildSkillsListArgs(normalizedSource, acceptOpenClawRisks),
      stagingDirectory,
    );
    const availableSkillGroups = parseAvailableSkillGroups(
      `${listOutput.stdout}\n${listOutput.stderr}`,
    );
    const selectedSkills = await (dependencies.selectSkills ?? promptForSkillSelection)(
      availableSkillGroups,
    );

    const installOutput = runSkillsCaptured(
      buildSkillsInstallArgs({
        source: normalizedSource,
        acceptOpenClawRisks,
        selectors: selectedSkills,
      }),
      stagingDirectory,
    );
    const securityAssessment = extractSecurityRiskAssessment(
      `${installOutput.stdout}\n${installOutput.stderr}`,
    );
    if (securityAssessment) {
      writeMessage(securityAssessment);
    }

    const importedSkillSlugs = listStagedSkillSlugs(stagingDirectory);
    const nextRecipeStore = mergeImportedSkillsIntoRecipeStore(readImportRecipeStore(repoRoot), {
      source,
      acceptOpenClawRisks,
      skills: mapSelectedSkillsToImportedSlugs(selectedSkills, importedSkillSlugs),
    });
    copyStagedSkillsToImported({
      stagingDirectory,
      repoRoot,
    });
    writeImportRecipeStore(repoRoot, nextRecipeStore);

    if (install) {
      writeMessage("Installing imported skills into configured agent roots...\n");
      (dependencies.runInstallCommand ?? runInstallCommand)(repoRoot);
    }
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

function parseCommand(argv: string[]): ImportCommandOptions {
  const program = new Command()
    .name("bun run skills:import")
    .description("Import external agent skills into skills/imported")
    .argument("<source>")
    .option("-i, --install", "Run the monke-tools skill install command after importing")
    .option("--accept-openclaw-risks", "Pass the upstream OpenClaw risk acceptance flag")
    .allowExcessArguments(false)
    .showSuggestionAfterError(false);

  program.exitOverride();

  try {
    program.parse(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new Error("Usage: bun run skills:import -- <source>");
    }

    throw error;
  }

  const options = program.opts<{ install?: boolean; acceptOpenclawRisks?: boolean }>();
  return {
    source: program.args[0]!,
    install: Boolean(options.install),
    acceptOpenClawRisks: Boolean(options.acceptOpenclawRisks),
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
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw new Error(`Failed to run skill install command: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(
      `Skill install command failed with ${result.signal ? `signal ${result.signal}` : `exit code ${result.status ?? "unknown"}`}`,
    );
  }
}

/** Runs upstream `skills` CLI arguments and returns captured output or throws on failure. */
export function runSkillsCaptured(args: string[], cwd: string): CapturedCommandOutput {
  const result = spawnSync(NPX_COMMAND, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
  });

  if (result.error) {
    throw new Error(`Failed to run skills CLI: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `Command failed: ${formatCommand(NPX_COMMAND, args)}${details ? `\n${details}` : ""}`,
    );
  }

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function formatCommand(command: string, args: readonly string[]): string {
  return [path.basename(command), ...args].join(" ");
}

function renderSecurityRiskAssessment(assessment: SecurityRiskAssessment): string {
  const skillWidth = Math.max(
    "Skill".length,
    ...assessment.rows.map((row) => row.skillName.length),
  );
  const genWidth = Math.max("Gen".length, ...assessment.rows.map((row) => row.gen.length), 8);
  const socketWidth = Math.max(
    "Socket".length,
    ...assessment.rows.map((row) => row.socket.length),
    12,
  );
  const snykWidth = Math.max("Snyk".length, ...assessment.rows.map((row) => row.snyk.length), 8);
  const bodyLines = [
    [
      " ".repeat(skillWidth + 2),
      pc.dim(padEndVisible("Gen", genWidth + 2)),
      pc.dim(padEndVisible("Socket", socketWidth + 2)),
      pc.dim(padEndVisible("Snyk", snykWidth)),
    ].join(""),
    ...assessment.rows.map((row) =>
      [
        padEndVisible(pc.cyan(row.skillName), skillWidth + 2),
        padEndVisible(riskValueLabel(row.gen), genWidth + 2),
        padEndVisible(socketValueLabel(row.socket), socketWidth + 2),
        padEndVisible(riskValueLabel(row.snyk), snykWidth),
      ].join(""),
    ),
  ];

  if (assessment.detailsUrl) {
    bodyLines.push("", `${pc.dim("Details:")} ${pc.dim(assessment.detailsUrl)}`);
  }

  return renderNoteBox("Security Risk Assessments", bodyLines);
}

function parseSecurityRiskRow(line: string): SecurityRiskRow | null {
  const wideParts = line.split(/\s{2,}/).filter(Boolean);
  if (wideParts.length >= 4) {
    const [skillName, gen, socket, snyk] = wideParts;
    return {
      skillName: skillName!,
      gen: gen!,
      socket: socket!,
      snyk: snyk!,
    };
  }

  const riskPattern = "(?:Critical Risk|High Risk|Med Risk|Low Risk|Safe|--)";
  const rowPattern = new RegExp(
    `^(\\S+)\\s+(${riskPattern})\\s+((?:\\d+ alerts?)|--)\\s+(${riskPattern})$`,
  );
  const match = line.match(rowPattern);
  if (!match) {
    return null;
  }

  const [, skillName = "", gen = "", socket = "", snyk = ""] = match;
  return {
    skillName,
    gen,
    socket,
    snyk,
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
    ...bodyLines.map((line) => visibleLength(line)),
  );
  const titlePrefix = `${pc.green("\u25c7")}  ${title} `;
  const topRuleWidth = Math.max(1, contentWidth - visibleLength(title) - 1);
  const lines = [
    `${titlePrefix}${pc.dim("\u2500".repeat(topRuleWidth))}${pc.dim("\u256e")}`,
    ...bodyLines.map((line) => {
      const padding = " ".repeat(contentWidth - visibleLength(line));
      return `${pc.dim("\u2502")} ${line}${padding} ${pc.dim("\u2502")}`;
    }),
    `${pc.dim("\u2570")}${pc.dim("\u2500".repeat(contentWidth + 2))}${pc.dim("\u256f")}`,
  ];

  return `${lines.join("\n")}\n`;
}

function riskValueLabel(value: string): string {
  switch (value.toLowerCase()) {
    case "safe":
    case "low risk":
      return pc.green(value);
    case "med risk":
      return pc.yellow(value);
    case "high risk":
    case "critical risk":
      return pc.red(value);
    case "--":
      return pc.dim(value);
    default:
      return value;
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
  availableSkillGroups: readonly AvailableSkillGroup[],
): Promise<string[]> {
  const groupedOptions = buildGroupedSkillOptions(availableSkillGroups);
  const firstSkillName = availableSkillGroups.find((group) => group.skills.length > 0)?.skills[0];
  const selectedSkills = await groupedSkillMultiselect({
    message: `Select skills to import ${pc.dim("(space to toggle)")}`,
    options: groupedOptions,
    cursorAt: firstSkillName,
    maxItems: 10,
    required: true,
  });

  if (p.isCancel(selectedSkills)) {
    throw new Error("Skill import cancelled");
  }

  return [...selectedSkills];
}

/** Builds grouped prompt options for the interactive Skill import selector. */
export function buildGroupedSkillOptions(
  availableSkillGroups: readonly AvailableSkillGroup[],
): GroupedSkillOptions {
  return Object.fromEntries(
    availableSkillGroups
      .filter((group) => group.skills.length > 0)
      .map((group) => [
        group.name,
        group.skills.map((skill) => ({
          value: skill,
          label: skill,
        })),
      ]),
  );
}

function groupedSkillMultiselect(options: {
  message: string;
  options: GroupedSkillOptions;
  cursorAt?: string;
  maxItems: number;
  required: boolean;
}): Promise<string[] | symbol> {
  return new GroupMultiSelectPrompt<p.Option<string>>({
    options: options.options,
    cursorAt: options.cursorAt,
    required: options.required,
    selectableGroups: false,
    validate(value) {
      if (this.required && value.length === 0) {
        return `Please select at least one skill.
${pc.reset(pc.dim(`Press ${pc.gray(pc.bgWhite(pc.inverse(" space ")))} to select, ${pc.gray(pc.bgWhite(pc.inverse(" enter ")))} to submit`))}`;
      }
    },
    render() {
      const title = `${pc.gray("\u2502")}
${stepSymbol(this.state)}  ${options.message}
`;

      switch (this.state) {
        case "submit":
          return `${title}${pc.gray("\u2502")}  ${this.options
            .filter((option) => this.value.includes(option.value))
            .map((option) => renderGroupedPromptOption(option, "submitted", this.options))
            .join(pc.dim(", "))}`;
        case "cancel": {
          const selected = this.options
            .filter((option) => this.value.includes(option.value))
            .map((option) => renderGroupedPromptOption(option, "cancelled", this.options))
            .join(pc.dim(", "));
          return `${title}${pc.gray("\u2502")}  ${
            selected.trim() ? `${selected}\n${pc.gray("\u2502")}` : ""
          }`;
        }
        case "error": {
          const error = this.error
            .split("\n")
            .map((line, index) =>
              index === 0 ? `${pc.yellow("\u2514")}  ${pc.yellow(line)}` : `   ${line}`,
            )
            .join("\n");
          return `${title}${pc.yellow("\u2502")}  ${renderVisibleGroupedPromptOptions({
            options: this.options,
            cursor: this.cursor,
            selectedValues: this.value,
            maxItems: options.maxItems,
            bar: pc.yellow("\u2502"),
          })}
${error}
`;
        }
        default:
          return `${title}${pc.cyan("\u2502")}  ${renderVisibleGroupedPromptOptions({
            options: this.options,
            cursor: this.cursor,
            selectedValues: this.value,
            maxItems: options.maxItems,
            bar: pc.cyan("\u2502"),
          })}
${pc.cyan("\u2514")}
`;
      }
    },
  }).prompt() as Promise<string[] | symbol>;
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
  options: readonly GroupedPromptOption[];
  cursor: number;
  selectedValues: readonly string[];
  maxItems: number;
  bar: string;
}): string {
  const visibleOptions = getVisibleGroupedPromptOptions({
    options: options.options,
    cursor: options.cursor,
    maxItems: options.maxItems,
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
  options: readonly GroupedPromptOption[];
  cursor: number;
  maxItems: number;
}): Array<GroupedPromptOption & { index: number }> {
  const terminalRows =
    process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows - 4 : 10;
  const maxItems = Math.max(5, Math.min(options.maxItems, terminalRows));
  const indexedOptions = options.options.map((option, index) => ({ ...option, index }));
  let start = Math.max(
    0,
    Math.min(options.cursor - Math.floor(maxItems / 2), options.options.length - maxItems),
  );
  let end = Math.min(options.options.length, start + maxItems);
  const cursorOption = options.options[options.cursor];
  const cursorGroupName = typeof cursorOption?.group === "string" ? cursorOption.group : null;

  if (cursorGroupName) {
    const groupHeaderIndex = options.options.findIndex(
      (option) => option.group === true && option.value === cursorGroupName,
    );
    if (groupHeaderIndex >= 0 && groupHeaderIndex < start) {
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
      value: cursorGroupName,
      label: cursorGroupName,
      group: true,
      index: -1,
    });
  }

  if (start > 0) {
    visible.unshift({
      value: "__more_before__",
      label: "...",
      group: true,
      index: -1,
    });
  }
  if (end < options.options.length) {
    visible.push({
      value: "__more_after__",
      label: "...",
      group: true,
      index: -1,
    });
  }

  return visible;
}

function renderGroupedPromptOption(
  option: GroupedPromptOption & { index?: number },
  state: GroupedPromptOptionState,
  allOptions: readonly GroupedPromptOption[],
): string {
  const label = option.label ?? String(option.value);
  if (option.group === true) {
    return pc.dim(label);
  }

  const optionIndex = option.index ?? allOptions.indexOf(option);
  const nextOption = allOptions[optionIndex + 1];
  const isLastInGroup = nextOption?.group === true;
  const branch = pc.dim(`${isLastInGroup ? "\u2514" : "\u2502"} `);

  switch (state) {
    case "active":
      return `${branch}${pc.cyan("\u25fb")} ${label}`;
    case "selected":
      return `${branch}${pc.green("\u25fc")} ${pc.dim(label)}`;
    case "active-selected":
      return `${branch}${pc.green("\u25fc")} ${label}`;
    case "submitted":
      return pc.dim(label);
    case "cancelled":
      return pc.strikethrough(pc.dim(label));
    case "inactive":
      return `${branch}${pc.dim("\u25fb")} ${pc.dim(label)}`;
  }
}

function stepSymbol(state: string): string {
  switch (state) {
    case "cancel":
      return pc.red("\u25a0");
    case "error":
      return pc.yellow("\u25b2");
    case "submit":
      return pc.green("\u25c7");
    default:
      return pc.cyan("\u25c6");
  }
}

function normalizeImportRecipeStore(input: unknown): SkillImportRecipeStore {
  if (!isRecord(input)) {
    throw new Error("Skill import recipe store must be a JSON object");
  }

  if (input.version !== 1) {
    throw new Error("Skill import recipe store version must be 1");
  }

  if (!Array.isArray(input.recipes)) {
    throw new Error("Skill import recipe store recipes must be an array");
  }

  return {
    version: 1,
    recipes: input.recipes.map(normalizeImportRecipe).sort((left, right) => {
      const sourceOrder = left.source.localeCompare(right.source);
      if (sourceOrder !== 0) {
        return sourceOrder;
      }

      return Number(Boolean(left.acceptOpenClawRisks)) - Number(Boolean(right.acceptOpenClawRisks));
    }),
  };
}

function normalizeImportRecipe(input: unknown): SkillImportRecipe {
  if (!isRecord(input)) {
    throw new Error("Skill import recipe must be a JSON object");
  }

  if (typeof input.source !== "string" || input.source.trim() === "") {
    throw new Error("Skill import recipe source must be a non-empty string");
  }

  if (input.acceptOpenClawRisks !== undefined && input.acceptOpenClawRisks !== true) {
    throw new Error("Skill import recipe acceptOpenClawRisks must be true when present");
  }

  if (!Array.isArray(input.skills) || input.skills.length === 0) {
    throw new Error("Skill import recipe skills must be a non-empty array");
  }

  return {
    source: input.source,
    ...(input.acceptOpenClawRisks === true ? { acceptOpenClawRisks: true as const } : {}),
    skills: input.skills.map(normalizeImportRecipeSkill).sort((left, right) => {
      const slugOrder = left.slug.localeCompare(right.slug);
      if (slugOrder !== 0) {
        return slugOrder;
      }

      return left.selector.localeCompare(right.selector);
    }),
  };
}

function normalizeImportRecipeSkill(input: unknown): SkillImportRecipeSkill {
  if (!isRecord(input)) {
    throw new Error("Skill import recipe skill must be a JSON object");
  }

  if (typeof input.selector !== "string" || input.selector.trim() === "") {
    throw new Error("Skill import selector must be a non-empty string");
  }

  if (typeof input.slug !== "string" || input.slug.trim() === "") {
    throw new Error("Skill slug must be a non-empty string");
  }

  return {
    selector: input.selector,
    slug: input.slug,
  };
}

function assertUniqueImportedSkillOwners(store: SkillImportRecipeStore): void {
  const owners = new Map<string, string>();

  for (const recipe of store.recipes) {
    for (const skill of recipe.skills) {
      const existingOwner = owners.get(skill.slug);
      if (existingOwner) {
        throw new Error(
          `Imported skill slug ${skill.slug} is owned by both ${existingOwner} and ${recipe.source}`,
        );
      }

      owners.set(skill.slug, recipe.source);
    }
  }
}

function assertSkillCanBeOwnedByRecipe(
  store: SkillImportRecipeStore,
  owningRecipe: SkillImportRecipe,
  skill: SkillImportRecipeSkill,
): void {
  for (const recipe of store.recipes) {
    if (recipe === owningRecipe) {
      continue;
    }

    if (recipe.skills.some((candidate) => candidate.slug === skill.slug)) {
      throw new Error(
        `Imported skill slug ${skill.slug} is already owned by recipe ${recipe.source}`,
      );
    }
  }
}

function mapSelectedSkillsToImportedSlugs(
  selectors: readonly string[],
  importedSkillSlugs: readonly string[],
): SkillImportRecipeSkill[] {
  if (selectors.length === 0) {
    throw new Error("At least one Skill import selector must be selected");
  }

  const remainingSlugs = new Set(importedSkillSlugs);
  const mappings: SkillImportRecipeSkill[] = [];
  const unmatchedSelectors: string[] = [];

  for (const selector of selectors) {
    if (remainingSlugs.delete(selector)) {
      mappings.push({
        selector,
        slug: selector,
      });
      continue;
    }

    unmatchedSelectors.push(selector);
  }

  if (unmatchedSelectors.length === 1 && remainingSlugs.size === 1) {
    const selector = unmatchedSelectors[0]!;
    const slug = [...remainingSlugs][0]!;
    mappings.push({
      selector,
      slug,
    });
    remainingSlugs.delete(slug);
    unmatchedSelectors.pop();
  }

  if (unmatchedSelectors.length > 0 || remainingSlugs.size > 0) {
    throw new Error(
      [
        "Could not map selected Skill import selectors to staged Skill slugs.",
        `Selectors: ${selectors.join(", ")}`,
        `Staged slugs: ${importedSkillSlugs.join(", ")}`,
      ].join("\n"),
    );
  }

  return mappings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSkillRow(line: string): string | null {
  const match = line.match(/^\s*(?:\u2502)?( +)(\S.*)$/);
  if (!match) {
    return null;
  }

  const [, indentation = "", rawName = ""] = match;
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
  groupName: string,
): AvailableSkillGroup {
  const existing = groups.find((group) => group.name === groupName);
  if (existing) {
    return existing;
  }

  const newGroup = {
    name: groupName,
    skills: [],
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
    /^[a-zA-Z]:[/\\]/.test(input)
  );
}

if (import.meta.main) {
  try {
    await runImportSkills();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
