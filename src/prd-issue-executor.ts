import path from "node:path";

import type {
  AgentProvider,
  AgentRunResult,
  AgentPhase,
  CodexReasoningEffort,
} from "./agent-provider.ts";
import { MonkeError } from "./errors.ts";
import { getHeadCommitInfo } from "./git.ts";
import type { GitHubIssueRunContext } from "./github-issue-context.ts";
import {
  buildIssueImplementerPrompt,
  buildIssueReviewerPrompt,
  loadIssueRunRoleInstructions,
} from "./issue-run-assets.ts";
import { loadRunCodingStandards } from "./run-assets.ts";
import type { Runtime } from "./types.ts";

type IssuePhase = Extract<AgentPhase, "implementer" | "reviewer">;

interface IssuePhaseResult {
  readonly phase: IssuePhase;
  readonly exitCode: number;
}

interface IssuePhaseRequest {
  readonly phase: IssuePhase;
  readonly repoRoot: string;
  readonly runLogDirectory: string;
  readonly issueOrdinal: number;
  readonly issueNumber: number;
  readonly prompt: string;
  readonly effort?: CodexReasoningEffort;
}

/** Dependency that performs tracker closure after a PRD issue has passed review. */
export interface IssueCloser {
  /** Close exactly the current GitHub issue after a successful single-issue execution. */
  closeIssue(issueNumber: number): void;
}

/** Repository-scoped options for constructing a GitHub issue closer. */
export interface GitHubIssueCloserOptions {
  /** GitHub repository in OWNER/REPO format. */
  readonly repo: string;
}

/** Create a GitHub CLI-backed closer for successful PRD issue executions. */
export function createGitHubIssueCloser(
  runtime: Runtime,
  options: GitHubIssueCloserOptions,
): IssueCloser {
  return {
    closeIssue(issueNumber: number): void {
      runtime.exec("gh", ["issue", "close", String(issueNumber), "--repo", options.repo]);
    },
  };
}

/** Options for executing one resolved PRD task issue in the current checkout. */
export interface PrdIssueExecutionOptions {
  /** Git repository root where the issue phases should run. */
  readonly repoRoot: string;
  /** Existing top-level run log directory that receives this issue's phase logs. */
  readonly runLogDirectory: string;
  /** One-based ordinal of this issue in the resolved PRD task order. */
  readonly issueOrdinal: number;
  /** Resolved PRD plus current issue context; no future issue context should be included. */
  readonly context: GitHubIssueRunContext;
  /** Reasoning effort forwarded to both issue execution phases. */
  readonly effort?: CodexReasoningEffort;
}

/** Observable result for one PRD task issue execution. */
export interface PrdIssueExecutionOutcome {
  /** Current GitHub issue number this executor attempted. */
  readonly issueNumber: number;
  /** Process-level exit code for this single issue. */
  readonly exitCode: number;
  /** Number of commits created across implementer plus reviewer phases. */
  readonly commitCount: number;
  /** Whether the current issue was closed after successful review. */
  readonly issueClosed: boolean;
  /** Human-readable summary of phase results and host policy checks. */
  readonly summary: string;
}

/** Executes one PRD task issue with implementer/reviewer sequencing and commit policy. */
export class PrdIssueExecutor {
  readonly #runtime: Runtime;
  readonly #agentProvider: AgentProvider;
  readonly #issueCloser: IssueCloser;

  /** Create a single-issue PRD executor with concrete runtime, agent, and issue closer. */
  constructor(runtime: Runtime, agentProvider: AgentProvider, issueCloser: IssueCloser) {
    this.#runtime = runtime;
    this.#agentProvider = agentProvider;
    this.#issueCloser = issueCloser;
  }

  /** Run implementer and reviewer for one current issue, then close it only on success. */
  async run(options: PrdIssueExecutionOptions): Promise<PrdIssueExecutionOutcome> {
    assertIssueOrdinal(options.issueOrdinal);
    const beforeIssueHead = getHeadCommitInfo(this.#runtime, options.repoRoot);
    const instructions = loadIssueRunRoleInstructions();
    const codingStandards = loadRunCodingStandards();
    const issueNumber = options.context.issue.number;
    const implementerResult = await this.#runIssuePhase({
      phase: "implementer",
      repoRoot: options.repoRoot,
      runLogDirectory: options.runLogDirectory,
      issueOrdinal: options.issueOrdinal,
      issueNumber,
      prompt: buildIssueImplementerPrompt(
        options.context,
        instructions.implementerInstructions,
        codingStandards,
      ),
      effort: options.effort,
    });
    const reviewerResult = await this.#runIssuePhase({
      phase: "reviewer",
      repoRoot: options.repoRoot,
      runLogDirectory: options.runLogDirectory,
      issueOrdinal: options.issueOrdinal,
      issueNumber,
      prompt: buildIssueReviewerPrompt(
        options.context,
        instructions.reviewerInstructions,
        codingStandards,
      ),
      effort: options.effort,
    });
    const commitCount = countCommitsAfter(this.#runtime, options.repoRoot, beforeIssueHead?.sha);
    const policyViolation =
      commitCount === 0 ? `Issue #${issueNumber} produced zero commits.` : null;
    const phaseFailed = implementerResult.exitCode !== 0 || reviewerResult.exitCode !== 0;
    const issueFailed = phaseFailed || policyViolation !== null;
    let issueClosed = false;

    if (!issueFailed) {
      this.#issueCloser.closeIssue(issueNumber);
      issueClosed = true;
    }

    return {
      issueNumber,
      exitCode: issueFailed ? 1 : 0,
      commitCount,
      issueClosed,
      summary: formatIssueExecutionSummary(
        issueNumber,
        implementerResult,
        reviewerResult,
        commitCount,
        policyViolation,
        issueClosed,
      ),
    };
  }

  async #runIssuePhase(options: IssuePhaseRequest): Promise<IssuePhaseResult> {
    const result: AgentRunResult = await this.#agentProvider.run({
      repoRoot: options.repoRoot,
      phase: options.phase,
      prompt: options.prompt,
      logPath: path.join(
        options.runLogDirectory,
        `${formatIssueOrdinal(options.issueOrdinal)}-issue-${options.issueNumber}-${options.phase}.log`,
      ),
      reasoningEffort: options.effort,
    });

    return {
      phase: options.phase,
      exitCode: result.exitCode,
    };
  }
}

function countCommitsAfter(
  runtime: Runtime,
  repoRoot: string,
  beforeSha: string | undefined,
): number {
  const headCommit = getHeadCommitInfo(runtime, repoRoot);
  if (!headCommit) {
    return 0;
  }

  if (beforeSha === undefined) {
    return parseGitCount(runtime.exec("git", ["rev-list", "--count", "HEAD"], { cwd: repoRoot }));
  }

  if (headCommit.sha === beforeSha) {
    return 0;
  }

  return parseGitCount(
    runtime.exec("git", ["rev-list", "--count", `${beforeSha}..HEAD`], { cwd: repoRoot }),
  );
}

function parseGitCount(result: { stdout: string }): number {
  const count = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isInteger(count) || count < 0) {
    throw new MonkeError(
      `Expected git commit count to be a non-negative integer, got "${result.stdout.trim()}".`,
    );
  }

  return count;
}

function formatIssueExecutionSummary(
  issueNumber: number,
  implementerResult: IssuePhaseResult,
  reviewerResult: IssuePhaseResult,
  commitCount: number,
  policyViolation: string | null,
  issueClosed: boolean,
): string {
  const parts = [
    `Issue #${issueNumber}:`,
    formatIssuePhaseSummary(implementerResult),
    formatIssuePhaseSummary(reviewerResult),
    `Commits created: ${commitCount}.`,
  ];

  if (policyViolation) {
    parts.push(policyViolation);
  }

  if (issueClosed) {
    parts.push("Issue closed.");
  }

  return parts.join(" ");
}

function formatIssuePhaseSummary(result: IssuePhaseResult): string {
  const label = result.phase.charAt(0).toUpperCase() + result.phase.slice(1);
  if (result.exitCode === 0) {
    return `${label} finished successfully.`;
  }

  return `${label} finished with failures (exit code ${result.exitCode}).`;
}

function formatIssueOrdinal(issueOrdinal: number): string {
  return String(issueOrdinal).padStart(2, "0");
}

function assertIssueOrdinal(issueOrdinal: number): void {
  if (!Number.isInteger(issueOrdinal) || issueOrdinal < 1) {
    throw new MonkeError("Issue ordinal must be a positive integer.");
  }
}
