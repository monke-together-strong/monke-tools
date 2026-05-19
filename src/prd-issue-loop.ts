import path from "node:path";
import { appendFileSync } from "node:fs";

import type { AgentProvider, CodexReasoningEffort } from "./agent-provider.ts";
import type { GitHubIssueContextLoader, GitHubIssueRunContext } from "./github-issue-context.ts";
import { getHeadCommitInfo, inspectCheckoutState, resolveGitRepoRoot } from "./git.ts";
import { PrdIssueExecutor, type IssueCloser } from "./prd-issue-executor.ts";
import { buildFinalPrdReviewerPrompt } from "./issue-run-assets.ts";
import { loadRunCodingStandards, loadRunRoleInstructions } from "./run-assets.ts";
import type { Runtime } from "./types.ts";
import {
  appendTotalDuration,
  createRunLogDirectory,
  runStartupCleanupCheckpoint,
  type RunOutcome,
} from "./workflow-orchestrator.ts";
import { formatDuration } from "./duration.ts";

/** Validated ordered issue plan for one PRD-driven workflow run. */
export interface PrdIssueLoopPlan {
  /** Resolved parent PRD issue number. */
  readonly prdIssueNumber: number;
  /** Ordered task issue numbers to execute exactly in this sequence. */
  readonly taskIssueNumbers: readonly number[];
}

/** Options that apply to every issue execution in one PRD issue loop. */
export interface PrdIssueLoopOptions {
  /** Reasoning effort forwarded to every attempted issue execution phase. */
  readonly effort?: CodexReasoningEffort;
}

/** Prepared PRD issue-loop context after shared startup work has already completed. */
export interface PreparedPrdIssueLoopOptions extends PrdIssueLoopOptions {
  /** Git repository root where the prepared PRD issue loop should execute. */
  readonly repoRoot: string;
  /** Existing top-level run log directory that receives every issue phase log. */
  readonly runLogDirectory: string;
  /** Whether the shared startup cleanup checkpoint completed before planning. */
  readonly startupCleanupCompleted: boolean;
  /** Optional wall-clock start time for the full workflow, including caller-owned setup. */
  readonly totalStartedAtMs?: number;
}

interface FinalPrdReviewResult {
  readonly exitCode: number;
  readonly durationMs?: number;
  readonly mutationSummary: string | null;
  readonly workingTreeViolation: string | null;
}

/** Coordinates ordered execution of validated PRD task issues in the current checkout. */
export class PrdIssueLoopOrchestrator {
  readonly #runtime: Runtime;
  readonly #agentProvider: AgentProvider;
  readonly #issueContextLoader: GitHubIssueContextLoader;
  readonly #issueExecutor: PrdIssueExecutor;

  /** Create a PRD issue-loop orchestrator with concrete issue-loading and execution dependencies. */
  constructor(
    runtime: Runtime,
    agentProvider: AgentProvider,
    issueContextLoader: GitHubIssueContextLoader,
    issueCloser: IssueCloser,
  ) {
    this.#runtime = runtime;
    this.#agentProvider = agentProvider;
    this.#issueContextLoader = issueContextLoader;
    this.#issueExecutor = new PrdIssueExecutor(runtime, agentProvider, issueCloser);
  }

  /** Execute planned task issues in order, stopping immediately after the first failed issue. */
  async run(plan: PrdIssueLoopPlan, options: PrdIssueLoopOptions): Promise<RunOutcome> {
    const startedAtMs = Date.now();
    const repoRoot = resolveGitRepoRoot(this.#runtime, this.#runtime.cwd);
    const runLogDirectory = createRunLogDirectory(this.#runtime, repoRoot);
    const startupCleanup = await runStartupCleanupCheckpoint(this.#runtime, this.#agentProvider, {
      repoRoot,
      runLogDirectory,
      cleanupInstructions: loadRunRoleInstructions().cleanupInstructions,
      effort: options.effort,
    });
    if (startupCleanup.failureSummary) {
      return {
        repoRoot,
        runLogDirectory,
        exitCode: startupCleanup.exitCode,
        summary: formatIssueLoopSummary(
          [startupCleanup.failureSummary],
          runLogDirectory,
          Date.now() - startedAtMs,
        ),
      };
    }

    return this.runPrepared(plan, {
      repoRoot,
      runLogDirectory,
      startupCleanupCompleted: startupCleanup.completed,
      totalStartedAtMs: startedAtMs,
      effort: options.effort,
    });
  }

  /** Execute a validated plan using a caller-prepared run directory and cleanup state. */
  async runPrepared(
    plan: PrdIssueLoopPlan,
    options: PreparedPrdIssueLoopOptions,
  ): Promise<RunOutcome> {
    const { effort, repoRoot, runLogDirectory, startupCleanupCompleted } = options;
    const totalStartedAtMs = options.totalStartedAtMs ?? Date.now();
    const prd = this.#issueContextLoader.loadIssue(plan.prdIssueNumber);
    const codingStandards = loadRunCodingStandards();
    const summaries = [
      ...(startupCleanupCompleted ? ["Cleanup checkpointed existing changes."] : []),
      formatPrdIssuePlanSummary(plan),
    ];

    for (const [index, issueNumber] of plan.taskIssueNumbers.entries()) {
      const context: GitHubIssueRunContext = {
        prd,
        issue: this.#issueContextLoader.loadIssue(issueNumber),
      };
      const issueOutcome = await this.#issueExecutor.run({
        repoRoot,
        runLogDirectory,
        issueOrdinal: index + 1,
        context,
        effort,
      });
      summaries.push(issueOutcome.summary);

      if (issueOutcome.exitCode !== 0) {
        return {
          repoRoot,
          runLogDirectory,
          exitCode: 1,
          summary: formatIssueLoopSummary(
            summaries,
            runLogDirectory,
            Date.now() - totalStartedAtMs,
          ),
        };
      }
    }

    const finalPrdReviewResult = await this.#runFinalPrdReviewer({
      repoRoot,
      runLogDirectory,
      prompt: buildFinalPrdReviewerPrompt(prd, codingStandards),
      effort,
    });
    summaries.push(
      formatFinalPrdReviewSummary(
        finalPrdReviewResult.exitCode,
        finalPrdReviewResult.durationMs,
        finalPrdReviewResult.mutationSummary,
        finalPrdReviewResult.workingTreeViolation,
      ),
    );

    return {
      repoRoot,
      runLogDirectory,
      exitCode:
        finalPrdReviewResult.exitCode === 0 && finalPrdReviewResult.workingTreeViolation === null
          ? 0
          : 1,
      summary: formatIssueLoopSummary(summaries, runLogDirectory, Date.now() - totalStartedAtMs),
    };
  }

  async #runFinalPrdReviewer(options: {
    readonly repoRoot: string;
    readonly runLogDirectory: string;
    readonly prompt: string;
    readonly effort?: CodexReasoningEffort;
  }): Promise<FinalPrdReviewResult> {
    const beforeCommit = getHeadCommitInfo(this.#runtime, options.repoRoot);
    const beforeState = inspectCheckoutState(this.#runtime, options.repoRoot);
    const logPath = path.join(options.runLogDirectory, "final-prd-review-proof.log");
    const result = await this.#agentProvider.run({
      repoRoot: options.repoRoot,
      phase: "final-prd-reviewer",
      prompt: options.prompt,
      logPath,
      reasoningEffort: options.effort,
    });
    const afterCommit = getHeadCommitInfo(this.#runtime, options.repoRoot);
    const afterState = inspectCheckoutState(this.#runtime, options.repoRoot);
    const mutationSummary = formatFinalPrdReviewMutationSummary(
      beforeCommit?.sha ?? null,
      afterCommit,
    );
    const workingTreeViolation = formatFinalPrdReviewWorkingTreeViolation(
      beforeState.statusLines,
      afterState.statusLines,
    );

    if (mutationSummary) {
      appendFileSync(logPath, `\n--- host mutation summary ---\n${mutationSummary}\n`, "utf8");
    }

    if (workingTreeViolation) {
      appendFileSync(logPath, `\n--- host policy violation ---\n${workingTreeViolation}\n`, "utf8");
    }

    return {
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      mutationSummary,
      workingTreeViolation,
    };
  }
}

/** Format the resolved PRD issue and ordered executable task issue list. */
export function formatPrdIssuePlanSummary(plan: PrdIssueLoopPlan): string {
  const issueList = plan.taskIssueNumbers.map((issueNumber) => `#${issueNumber}`).join(", ");
  return `PRD #${plan.prdIssueNumber} planned issues: ${issueList}.`;
}

function formatIssueLoopSummary(
  summaries: readonly string[],
  runLogDirectory: string,
  totalDurationMs?: number,
): string {
  return appendRunLogDirectory(
    appendTotalDuration(summaries.join(" "), totalDurationMs),
    runLogDirectory,
  );
}

function appendRunLogDirectory(summary: string, runLogDirectory: string): string {
  return `${summary} Run logs: ${runLogDirectory}`;
}

function formatFinalPrdReviewSummary(
  exitCode: number,
  durationMs: number | undefined,
  mutationSummary: string | null,
  workingTreeViolation: string | null,
): string {
  const parts: string[] = [];

  if (exitCode === 0) {
    parts.push("Final PRD validation finished successfully.");
  } else {
    parts.push(`Final PRD validation finished with failures (exit code ${exitCode}).`);
  }

  if (durationMs !== undefined) {
    parts.push(`Final PRD validation duration: ${formatDuration(durationMs)}.`);
  }

  if (mutationSummary) {
    parts.push(mutationSummary);
  }

  if (workingTreeViolation) {
    parts.push(workingTreeViolation);
  }

  return parts.join(" ");
}

function formatFinalPrdReviewMutationSummary(
  beforeSha: string | null,
  afterCommit: { readonly sha: string; readonly subject: string } | null,
): string | null {
  if (afterCommit && afterCommit.sha !== beforeSha) {
    return `Final PRD reviewer created commit "${afterCommit.subject}".`;
  }

  return null;
}

function formatFinalPrdReviewWorkingTreeViolation(
  beforeStatusLines: readonly string[],
  afterStatusLines: readonly string[],
): string | null {
  if (!areStatusLinesEqual(beforeStatusLines, afterStatusLines)) {
    return `Final PRD reviewer left uncommitted working tree changes: status changed from ${formatStatusLines(beforeStatusLines)} to ${formatStatusLines(afterStatusLines)}.`;
  }

  return null;
}

function areStatusLinesEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((line, index) => line === right[index]);
}

function formatStatusLines(statusLines: readonly string[]): string {
  return statusLines.length === 0 ? "clean" : statusLines.join(", ");
}
