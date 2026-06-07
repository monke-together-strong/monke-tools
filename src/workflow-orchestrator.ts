import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import type {
  AgentProvider,
  AgentRunResult,
  AgentPhase,
  CodexReasoningEffort,
} from "./agent-provider.ts";
import { formatDuration } from "./duration.ts";
import {
  determineReviewerTarget,
  getHeadCommitInfo,
  inspectCheckoutState,
  resolveGitRepoRoot,
} from "./git.ts";
import {
  buildCleanupPrompt,
  buildImplementerPrompt,
  buildReviewerPrompt,
  loadRunCodingStandards,
  loadRunRoleInstructions,
} from "./run-assets.ts";
import type { Runtime } from "./types.ts";

const REQUIRED_CLEANUP_COMMIT_PREFIX = "clean up";
const STARTUP_CLEANUP_REASONING_EFFORT: CodexReasoningEffort = "medium";
const MAX_RUN_LOG_DIRECTORY_ATTEMPTS = 10;

type WorkflowRole = "implementer" | "reviewer";

interface WorkflowPhaseResult {
  role: WorkflowRole;
  exitCode: number;
  durationMs?: number;
  commitViolation: string | null;
}

interface AgentPhaseRequest {
  phase: AgentPhase;
  repoRoot: string;
  runLogDirectory: string;
  prompt: string;
  effort?: CodexReasoningEffort;
}

interface WorkflowPhaseRequest extends Omit<AgentPhaseRequest, "phase"> {
  role: WorkflowRole;
}

/** Options that apply to a full single-pass run workflow. */
export interface WorkflowRunOptions {
  /** Reasoning effort forwarded to implementer and reviewer phases. */
  readonly effort?: CodexReasoningEffort;
}

/** Final observable outcome for an `mt work` workflow invocation. */
export interface RunOutcome {
  /** Git repository root where the run executed. */
  readonly repoRoot: string;
  /** Dedicated directory containing phase logs for this run. */
  readonly runLogDirectory: string;
  /** Process-level exit code the CLI should surface. */
  readonly exitCode: number;
  /** Human-readable final summary for stdout or stderr. */
  readonly summary: string;
}

/** Result of applying the shared dirty-checkout cleanup checkpoint before workflow execution. */
export interface StartupCleanupOutcome {
  /** Whether cleanup ran and created the required checkpoint successfully. */
  readonly completed: boolean;
  /** Process exit code to surface when cleanup failed; zero when cleanup was not needed or succeeded. */
  readonly exitCode: number;
  /** Human-readable failure summary when cleanup failed before workflow execution. */
  readonly failureSummary: string | null;
}

/** Inputs for the shared dirty-checkout cleanup checkpoint phase. */
export interface StartupCleanupOptions {
  /** Git repository root where cleanup should inspect and checkpoint changes. */
  readonly repoRoot: string;
  /** Existing top-level run log directory that receives cleanup.log. */
  readonly runLogDirectory: string;
  /** Cleanup role instructions loaded by the calling workflow. */
  readonly cleanupInstructions: string;
}

/** Coordinates the cleanup, implementer, and reviewer phases for `mt work`. */
export class WorkflowOrchestrator {
  readonly #runtime: Runtime;
  readonly #agentProvider: AgentProvider;

  /** Create an orchestrator with a concrete runtime and agent provider. */
  constructor(runtime: Runtime, agentProvider: AgentProvider) {
    this.#runtime = runtime;
    this.#agentProvider = agentProvider;
  }

  /** Execute the current single-pass cleanup -> implementer -> reviewer workflow. */
  async run(plan: string, options: WorkflowRunOptions): Promise<RunOutcome> {
    const startedAtMs = Date.now();
    const repoRoot = resolveGitRepoRoot(this.#runtime, this.#runtime.cwd);
    const runLogDirectory = createRunLogDirectory(this.#runtime, repoRoot);
    const instructions = loadRunRoleInstructions();
    const codingStandards = loadRunCodingStandards();
    const startupCleanup = await runStartupCleanupCheckpoint(this.#runtime, this.#agentProvider, {
      repoRoot,
      runLogDirectory,
      cleanupInstructions: instructions.cleanupInstructions,
    });
    if (startupCleanup.failureSummary) {
      return {
        repoRoot,
        runLogDirectory,
        exitCode: startupCleanup.exitCode,
        summary: appendRunLogDirectory(startupCleanup.failureSummary, runLogDirectory),
      };
    }

    const preImplementerHead = getHeadCommitInfo(this.#runtime, repoRoot);
    const implementerResult = await this.#runWorkflowPhase({
      role: "implementer",
      repoRoot,
      runLogDirectory,
      prompt: buildImplementerPrompt(plan, instructions.implementerInstructions, codingStandards),
      effort: options.effort,
    });
    const reviewerTarget = determineReviewerTarget(this.#runtime, repoRoot, preImplementerHead);
    const reviewerResult = await this.#runWorkflowPhase({
      role: "reviewer",
      repoRoot,
      runLogDirectory,
      prompt: buildReviewerPrompt(
        plan,
        instructions.reviewerInstructions,
        codingStandards,
        reviewerTarget,
      ),
      effort: options.effort,
    });
    const workflowFailed =
      implementerResult.exitCode !== 0 ||
      reviewerResult.exitCode !== 0 ||
      implementerResult.commitViolation !== null ||
      reviewerResult.commitViolation !== null;

    return {
      repoRoot,
      runLogDirectory,
      exitCode: workflowFailed ? 1 : 0,
      summary: formatRunSummary(
        startupCleanup.completed,
        implementerResult,
        reviewerResult,
        runLogDirectory,
        Date.now() - startedAtMs,
      ),
    };
  }

  async #runWorkflowPhase(options: WorkflowPhaseRequest): Promise<WorkflowPhaseResult> {
    const beforePhaseCommit = getHeadCommitInfo(this.#runtime, options.repoRoot);
    const phaseResult = await this.#runAgentPhase({
      phase: options.role,
      repoRoot: options.repoRoot,
      runLogDirectory: options.runLogDirectory,
      prompt: options.prompt,
      effort: options.effort,
    });
    const afterPhaseCommit = getHeadCommitInfo(this.#runtime, options.repoRoot);

    return {
      role: options.role,
      exitCode: phaseResult.exitCode,
      durationMs: phaseResult.durationMs,
      commitViolation: getWorkflowCommitViolation(
        options.role,
        beforePhaseCommit?.sha ?? null,
        afterPhaseCommit,
      ),
    };
  }

  async #runAgentPhase(options: AgentPhaseRequest): Promise<AgentRunResult> {
    return this.#agentProvider.run({
      repoRoot: options.repoRoot,
      phase: options.phase,
      prompt: options.prompt,
      logPath: path.join(options.runLogDirectory, `${options.phase}.log`),
      reasoningEffort: options.effort,
    });
  }
}

/** Checkpoint dirty startup work with the shared cleanup phase before a run modifies the checkout. */
export async function runStartupCleanupCheckpoint(
  runtime: Runtime,
  agentProvider: AgentProvider,
  options: StartupCleanupOptions,
): Promise<StartupCleanupOutcome> {
  const startupState = inspectCheckoutState(runtime, options.repoRoot);
  if (!startupState.isDirty) {
    return {
      completed: false,
      exitCode: 0,
      failureSummary: null,
    };
  }

  const beforeCleanupCommit = getHeadCommitInfo(runtime, options.repoRoot);
  const cleanupResult = await agentProvider.run({
    repoRoot: options.repoRoot,
    phase: "cleanup",
    prompt: buildCleanupPrompt(options.cleanupInstructions),
    logPath: path.join(options.runLogDirectory, "cleanup.log"),
    reasoningEffort: STARTUP_CLEANUP_REASONING_EFFORT,
  });
  const afterCleanupCommit = getHeadCommitInfo(runtime, options.repoRoot);
  const postCleanupState = inspectCheckoutState(runtime, options.repoRoot);
  const cleanupFailure = getCleanupFailureSummary(
    cleanupResult.exitCode,
    beforeCleanupCommit?.sha ?? null,
    afterCleanupCommit,
    postCleanupState,
  );

  if (cleanupFailure) {
    return {
      completed: false,
      exitCode: cleanupResult.exitCode === 0 ? 1 : cleanupResult.exitCode,
      failureSummary: cleanupFailure,
    };
  }

  return {
    completed: true,
    exitCode: 0,
    failureSummary: null,
  };
}

/** Format the user-facing run summary including phase outcomes and log location. */
export function formatRunSummary(
  cleanupCompleted: boolean,
  implementerResult: WorkflowPhaseResult,
  reviewerResult: WorkflowPhaseResult,
  runLogDirectory: string,
  totalDurationMs?: number,
): string {
  const phaseSummaries = [
    formatWorkflowPhaseSummary(implementerResult),
    formatWorkflowPhaseSummary(reviewerResult),
  ];
  const durationSummary = formatWorkflowDurationBreakdown(implementerResult, reviewerResult);
  const basePhaseSummary = cleanupCompleted
    ? `Cleanup checkpointed existing changes. ${phaseSummaries.join(" ")}`
    : phaseSummaries.join(" ");
  const phaseSummary = durationSummary
    ? `${basePhaseSummary} ${durationSummary}`
    : basePhaseSummary;

  return appendRunLogDirectory(appendTotalDuration(phaseSummary, totalDurationMs), runLogDirectory);
}

/** Create one ignored top-level log directory for a workflow run. */
export function createRunLogDirectory(runtime: Runtime, repoRoot: string): string {
  ensureRunLogsIgnored(runtime, repoRoot);
  const logsRoot = path.join(repoRoot, "logs");
  mkdirSync(logsRoot, { recursive: true });
  let lastError: Error | null = null;

  for (let attempts = 1; attempts <= MAX_RUN_LOG_DIRECTORY_ATTEMPTS; attempts += 1) {
    const timestamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
    const suffix = randomBytes(3).toString("hex");
    const runLogDirectory = path.join(logsRoot, `${timestamp}-${suffix}`);

    try {
      mkdirSync(runLogDirectory, { recursive: false });
      return runLogDirectory;
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }

      throw error;
    }
  }

  const lastErrorSummary = lastError ? ` Last error: ${lastError.message}` : "";
  throw new Error(
    `Failed to create a unique run log directory in ${logsRoot} after ${MAX_RUN_LOG_DIRECTORY_ATTEMPTS} attempts.${lastErrorSummary}`,
  );
}

function ensureRunLogsIgnored(runtime: Runtime, repoRoot: string): void {
  const excludePathOutput = runtime.exec("git", ["rev-parse", "--git-path", "info/exclude"], {
    cwd: repoRoot,
  }).stdout;
  const excludePath = excludePathOutput.trim();
  const absoluteExcludePath = path.isAbsolute(excludePath)
    ? excludePath
    : path.join(repoRoot, excludePath);
  mkdirSync(path.dirname(absoluteExcludePath), { recursive: true });

  let contents = "";
  try {
    contents = readFileSync(absoluteExcludePath, "utf8");
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }

  const alreadyIgnored = contents
    .split(/\r?\n/)
    .some((line) => line.trim() === "logs/" || line.trim() === "/logs/");
  if (alreadyIgnored) {
    return;
  }

  const separator = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
  appendFileSync(absoluteExcludePath, `${separator}logs/\n`, "utf8");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function appendRunLogDirectory(summary: string, runLogDirectory: string): string {
  return `${summary} Run logs: ${runLogDirectory}`;
}

/** Append total wall-clock duration when the caller measured it. */
export function appendTotalDuration(summary: string, totalDurationMs: number | undefined): string {
  if (totalDurationMs === undefined) {
    return summary;
  }

  return `${summary} Total duration: ${formatDuration(totalDurationMs)}.`;
}

function getCleanupFailureSummary(
  cleanupExitCode: number,
  beforeCleanupSha: string | null,
  afterCleanupCommit: { sha: string; subject: string } | null,
  postCleanupState: { isDirty: boolean; statusLines: string[] },
): string | null {
  if (cleanupExitCode !== 0) {
    return `Cleanup finished with failures (exit code ${cleanupExitCode}). Aborting before implementation.`;
  }

  if (!afterCleanupCommit || afterCleanupCommit.sha === beforeCleanupSha) {
    return `Cleanup did not create the required checkpoint commit (message must start with "${REQUIRED_CLEANUP_COMMIT_PREFIX}"). Aborting before implementation.`;
  }

  if (!afterCleanupCommit.subject.startsWith(REQUIRED_CLEANUP_COMMIT_PREFIX)) {
    return `Cleanup created "${afterCleanupCommit.subject}" but the commit message must start with "${REQUIRED_CLEANUP_COMMIT_PREFIX}". Aborting before implementation.`;
  }

  if (postCleanupState.isDirty) {
    const remainingChanges = postCleanupState.statusLines.join(", ");
    return `Cleanup left the checkout dirty (${remainingChanges}). Aborting before implementation.`;
  }

  return null;
}

function getWorkflowCommitViolation(
  role: WorkflowRole,
  beforePhaseSha: string | null,
  afterPhaseCommit: { sha: string; subject: string } | null,
): string | null {
  if (afterPhaseCommit && afterPhaseCommit.sha !== beforePhaseSha) {
    const label = capitalizeRole(role);
    return `${label} created commit "${afterPhaseCommit.subject}" but ${role} must not create commits.`;
  }

  return null;
}

function formatWorkflowPhaseSummary(result: WorkflowPhaseResult): string {
  const label = capitalizeRole(result.role);
  const parts: string[] = [];

  if (result.exitCode === 0) {
    parts.push(`${label} finished successfully.`);
  } else {
    parts.push(`${label} finished with failures (exit code ${result.exitCode}).`);
  }

  if (result.commitViolation) {
    parts.push(result.commitViolation);
  }

  return parts.join(" ");
}

function capitalizeRole(role: WorkflowRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function formatWorkflowDurationBreakdown(
  implementerResult: WorkflowPhaseResult,
  reviewerResult: WorkflowPhaseResult,
): string | null {
  const parts = [
    formatPhaseDuration("Implementer", implementerResult.durationMs),
    formatPhaseDuration("Reviewer", reviewerResult.durationMs),
  ].filter((part): part is string => part !== null);

  return parts.length > 0 ? `Durations: ${parts.join(", ")}.` : null;
}

function formatPhaseDuration(label: string, durationMs: number | undefined): string | null {
  if (durationMs === undefined) {
    return null;
  }

  return `${label} ${formatDuration(durationMs)}`;
}
