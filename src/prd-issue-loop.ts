import type { AgentProvider, CodexReasoningEffort } from "./agent-provider.ts";
import type { GitHubIssueContextLoader, GitHubIssueRunContext } from "./github-issue-context.ts";
import { resolveGitRepoRoot } from "./git.ts";
import { PrdIssueExecutor, type IssueCloser } from "./prd-issue-executor.ts";
import { loadRunRoleInstructions } from "./run-assets.ts";
import type { Runtime } from "./types.ts";
import {
  createRunLogDirectory,
  runStartupCleanupCheckpoint,
  type RunOutcome,
} from "./workflow-orchestrator.ts";

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
        summary: formatIssueLoopSummary([startupCleanup.failureSummary], runLogDirectory),
      };
    }

    return this.runPrepared(plan, {
      repoRoot,
      runLogDirectory,
      startupCleanupCompleted: startupCleanup.completed,
      effort: options.effort,
    });
  }

  /** Execute a validated plan using a caller-prepared run directory and cleanup state. */
  async runPrepared(
    plan: PrdIssueLoopPlan,
    options: PreparedPrdIssueLoopOptions,
  ): Promise<RunOutcome> {
    const { effort, repoRoot, runLogDirectory, startupCleanupCompleted } = options;
    const prd = this.#issueContextLoader.loadIssue(plan.prdIssueNumber);
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
          summary: formatIssueLoopSummary(summaries, runLogDirectory),
        };
      }
    }

    return {
      repoRoot,
      runLogDirectory,
      exitCode: 0,
      summary: formatIssueLoopSummary(summaries, runLogDirectory),
    };
  }
}

/** Format the resolved PRD issue and ordered executable task issue list. */
export function formatPrdIssuePlanSummary(plan: PrdIssueLoopPlan): string {
  const issueList = plan.taskIssueNumbers.map((issueNumber) => `#${issueNumber}`).join(", ");
  return `PRD #${plan.prdIssueNumber} planned issues: ${issueList}.`;
}

function formatIssueLoopSummary(summaries: readonly string[], runLogDirectory: string): string {
  return appendRunLogDirectory(summaries.join(" "), runLogDirectory);
}

function appendRunLogDirectory(summary: string, runLogDirectory: string): string {
  return `${summary} Run logs: ${runLogDirectory}`;
}
