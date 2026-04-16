import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import type {
  AgentProvider,
  AgentRunResult,
  AgentPhase,
  CodexReasoningEffort,
} from "./agent-provider.ts";
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
const MAX_RUN_LOG_DIRECTORY_ATTEMPTS = 10;

type WorkflowRole = "implementer" | "reviewer";

interface WorkflowPhaseResult {
  role: WorkflowRole;
  exitCode: number;
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
  /** Reasoning effort forwarded to every attempted agent phase. */
  readonly effort?: CodexReasoningEffort;
}

/** Final observable outcome for an `mt run` workflow invocation. */
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

/** Coordinates the cleanup, implementer, and reviewer phases for `mt run`. */
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
    const repoRoot = resolveGitRepoRoot(this.#runtime, this.#runtime.cwd);
    const runLogDirectory = createRunLogDirectory(this.#runtime, repoRoot);
    const instructions = loadRunRoleInstructions();
    const codingStandards = loadRunCodingStandards();
    const startupState = inspectCheckoutState(this.#runtime, repoRoot);
    let cleanupCompleted = false;

    if (startupState.isDirty) {
      const beforeCleanupCommit = getHeadCommitInfo(this.#runtime, repoRoot);
      const cleanupResult = await this.#runAgentPhase({
        phase: "cleanup",
        repoRoot,
        runLogDirectory,
        prompt: buildCleanupPrompt(instructions.cleanupInstructions),
        effort: options.effort,
      });
      const afterCleanupCommit = getHeadCommitInfo(this.#runtime, repoRoot);
      const postCleanupState = inspectCheckoutState(this.#runtime, repoRoot);
      const cleanupFailure = getCleanupFailureSummary(
        cleanupResult.exitCode,
        beforeCleanupCommit?.sha ?? null,
        afterCleanupCommit,
        postCleanupState,
      );
      if (cleanupFailure) {
        return {
          repoRoot,
          runLogDirectory,
          exitCode: cleanupResult.exitCode === 0 ? 1 : cleanupResult.exitCode,
          summary: appendRunLogDirectory(cleanupFailure, runLogDirectory),
        };
      }

      cleanupCompleted = true;
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
        cleanupCompleted,
        implementerResult,
        reviewerResult,
        runLogDirectory,
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

/** Format the user-facing run summary including phase outcomes and log location. */
export function formatRunSummary(
  cleanupCompleted: boolean,
  implementerResult: WorkflowPhaseResult,
  reviewerResult: WorkflowPhaseResult,
  runLogDirectory: string,
): string {
  const phaseSummaries = [
    formatWorkflowPhaseSummary(implementerResult),
    formatWorkflowPhaseSummary(reviewerResult),
  ];
  const phaseSummary = cleanupCompleted
    ? `Cleanup checkpointed existing changes. ${phaseSummaries.join(" ")}`
    : phaseSummaries.join(" ");

  return appendRunLogDirectory(phaseSummary, runLogDirectory);
}

function createRunLogDirectory(runtime: Runtime, repoRoot: string): string {
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
