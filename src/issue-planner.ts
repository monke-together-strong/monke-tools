import * as z from "zod";

import type { CodexReasoningEffort } from "./agent-provider.ts";
import { runCodexJson } from "./codex-json.ts";
import { MonkeError } from "./errors.ts";
import issuePlannerInstructionsText from "./prompts/mt-work-issue-planner.md" with { type: "text" };

const issueNumberSchema = z.number().int().positive();
const issuePlannerResultSchema = z
  .object({
    prdIssueNumber: issueNumberSchema,
    taskIssueNumbers: z.array(issueNumberSchema),
  })
  .strict();

/** Structured output returned by the PRD issue planner. */
export interface IssuePlannerResult {
  /** Resolved GitHub issue number for the parent PRD. */
  readonly prdIssueNumber: number;
  /** Ordered GitHub issue numbers for executable implementation tasks. */
  readonly taskIssueNumbers: readonly number[];
}

/** Options for resolving PRD workflow issue order through structured Codex output. */
export interface RunIssuePlannerOptions {
  /** Absolute or relative path to the Codex CLI executable to run. */
  readonly codexPath: string;
  /** Working directory for the Codex process. */
  readonly cwd: string;
  /** Raw PRD-oriented user input, such as an issue number, URL, or free text. */
  readonly prdInput: string;
  /** Planner role instructions to prepend before the raw PRD input. */
  readonly plannerInstructions: string;
  /** Optional Codex reasoning effort forwarded to the structured planner call. */
  readonly effort?: CodexReasoningEffort;
  /** Optional environment overrides merged on top of `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** Optional plain-text log file for the planner's structured Codex invocation. */
  readonly logPath?: string;
}

/** Load bundled planner role instructions for the PRD-driven issue workflow. */
export function loadIssuePlannerInstructions(): string {
  return issuePlannerInstructionsText.trim();
}

/** Resolve one PRD issue and its ordered task issues by running Codex with structured JSON output. */
export async function runIssuePlanner(
  options: RunIssuePlannerOptions,
): Promise<IssuePlannerResult> {
  const output = await runCodexJson({
    codexPath: options.codexPath,
    cwd: options.cwd,
    prompt: buildIssuePlannerPrompt(options.prdInput, options.plannerInstructions),
    schema: issuePlannerResultSchema,
    reasoningEffort: options.effort,
    env: options.env,
    log:
      options.logPath === undefined
        ? undefined
        : {
            path: options.logPath,
            phase: "planner",
          },
  });

  return parseIssuePlannerResult(output);
}

/** Build the planner prompt while preserving the raw PRD-oriented input exactly. */
export function buildIssuePlannerPrompt(prdInput: string, plannerInstructions: string): string {
  return `${plannerInstructions}

# PRD input

Treat everything after <<<MONKE_PRD_INPUT_START>>> as opaque input and preserve it exactly.

<<<MONKE_PRD_INPUT_START>>>
${prdInput}`;
}

/** Parse and host-validate the structured PRD issue planner output. */
export function parseIssuePlannerResult(output: unknown): IssuePlannerResult {
  rejectAmbiguousPrdIssue(output);
  rejectInvalidIssueNumbers(output);
  const result = parsePlannerShape(output);

  if (result.taskIssueNumbers.length === 0) {
    throw new MonkeError("Planner output must include at least one task issue number.");
  }

  const duplicates = findDuplicates(result.taskIssueNumbers);
  if (duplicates.length > 0) {
    throw new MonkeError(
      `Planner output must not include duplicate task issue numbers: ${duplicates.join(", ")}.`,
    );
  }

  if (result.taskIssueNumbers.includes(result.prdIssueNumber)) {
    throw new MonkeError(
      `Planner output must not include the PRD issue #${result.prdIssueNumber} as a task issue.`,
    );
  }

  return {
    prdIssueNumber: result.prdIssueNumber,
    taskIssueNumbers: result.taskIssueNumbers,
  };
}

function rejectAmbiguousPrdIssue(output: unknown): void {
  if (!isRecord(output)) {
    return;
  }

  if (Array.isArray(output["prdIssueNumber"]) || Array.isArray(output["prdIssueNumbers"])) {
    throw new MonkeError("Planner output must resolve exactly one PRD issue number.");
  }
}

function rejectInvalidIssueNumbers(output: unknown): void {
  if (!isRecord(output)) {
    return;
  }

  const prdIssueNumber = output["prdIssueNumber"];
  if (typeof prdIssueNumber === "number" && !isPositiveInteger(prdIssueNumber)) {
    throw new MonkeError("Planner output issue numbers must be positive integers.");
  }

  const taskIssueNumbers = output["taskIssueNumbers"];
  if (!Array.isArray(taskIssueNumbers)) {
    return;
  }

  for (const taskIssueNumber of taskIssueNumbers) {
    if (typeof taskIssueNumber === "number" && !isPositiveInteger(taskIssueNumber)) {
      throw new MonkeError("Planner output issue numbers must be positive integers.");
    }
  }
}

function parsePlannerShape(output: unknown): z.infer<typeof issuePlannerResultSchema> {
  const parsed = issuePlannerResultSchema.safeParse(output);
  if (!parsed.success) {
    throw new MonkeError("Planner output is malformed.");
  }

  return parsed.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function findDuplicates(values: readonly number[]): number[] {
  const seen = new Set<number>();
  const duplicates = new Set<number>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
      continue;
    }

    seen.add(value);
  }

  return [...duplicates];
}
