import path from "node:path";

import {
  CODEX_REASONING_EFFORTS,
  CodexAgentProvider,
  type CodexReasoningEffort,
} from "./agent-provider.ts";
import { MonkeError } from "./errors.ts";
import { resolveGitRepoRoot } from "./git.ts";
import {
  createGitHubIssueContextLoader,
  type GitHubIssueContextLoader,
} from "./github-issue-context.ts";
import { loadIssuePlannerInstructions, runIssuePlanner } from "./issue-planner.ts";
import { createGitHubIssueCloser, type IssueCloser } from "./prd-issue-executor.ts";
import { formatPrdIssuePlanSummary, PrdIssueLoopOrchestrator } from "./prd-issue-loop.ts";
import { findExecutable } from "./runtime.ts";
import { loadRunRoleInstructions } from "./run-assets.ts";
import type { Runtime } from "./types.ts";
import {
  createRunLogDirectory,
  runStartupCleanupCheckpoint,
  WorkflowOrchestrator,
  type RunOutcome,
} from "./workflow-orchestrator.ts";

/** Options accepted by the public `mt run` workflow entrypoint. */
export interface RunWorkflowOptions {
  /** Reasoning effort forwarded to every attempted Codex-backed phase. */
  readonly effort?: CodexReasoningEffort;
}

/** Execute the PRD-driven `mt run --prd` workflow and write the final summary. */
export async function runPrdIssueWorkflow(
  runtime: Runtime,
  prdInput: string,
  options: RunWorkflowOptions,
): Promise<void> {
  if (!prdInput) {
    throw new MonkeError("mt run requires --prd");
  }

  const outcome = await executePrdIssueWorkflow(runtime, prdInput, options);
  if (outcome.exitCode !== 0) {
    throw new MonkeError(outcome.summary);
  }

  runtime.writeStdout(`${outcome.summary}\n`);
}

/** Execute `mt run` and write the final summary to the runtime streams. */
export async function runSinglePassWorkflow(
  runtime: Runtime,
  plan: string,
  options: RunWorkflowOptions,
): Promise<void> {
  if (!plan) {
    throw new MonkeError("mt run requires --plan");
  }

  const outcome = await executeRunWorkflow(runtime, plan, options);
  if (outcome.exitCode !== 0) {
    throw new MonkeError(outcome.summary);
  }

  runtime.writeStdout(`${outcome.summary}\n`);
}

/** Execute the `mt run` workflow and return the summary without applying CLI exit behavior. */
export async function executeRunWorkflow(
  runtime: Runtime,
  plan: string,
  options: RunWorkflowOptions,
): Promise<RunOutcome> {
  const codex = findExecutable("codex", runtime.env);
  if (!codex) {
    throw new MonkeError("Could not find `codex` on PATH");
  }

  const orchestrator = new WorkflowOrchestrator(runtime, new CodexAgentProvider(runtime, codex));
  return orchestrator.run(plan, options);
}

/** Execute the PRD-driven workflow and return the summary without applying CLI exit behavior. */
export async function executePrdIssueWorkflow(
  runtime: Runtime,
  prdInput: string,
  options: RunWorkflowOptions,
): Promise<RunOutcome> {
  const codex = findExecutable("codex", runtime.env);
  if (!codex) {
    throw new MonkeError("Could not find `codex` on PATH");
  }
  const gh = findExecutable("gh", runtime.env);
  if (!gh) {
    throw new MonkeError("Could not find `gh` on PATH");
  }

  const repoRoot = resolveGitRepoRoot(runtime, runtime.cwd);
  const repo = resolveGitHubRepository(runtime, repoRoot);
  const agentProvider = new CodexAgentProvider(runtime, codex);
  const runLogDirectory = createRunLogDirectory(runtime, repoRoot);
  const runRoleInstructions = loadRunRoleInstructions();
  const startupCleanup = await runStartupCleanupCheckpoint(runtime, agentProvider, {
    repoRoot,
    runLogDirectory,
    cleanupInstructions: runRoleInstructions.cleanupInstructions,
    effort: options.effort,
  });
  if (startupCleanup.failureSummary) {
    return {
      repoRoot,
      runLogDirectory,
      exitCode: startupCleanup.exitCode,
      summary: `${startupCleanup.failureSummary} Run logs: ${runLogDirectory}`,
    };
  }

  const plan = await runIssuePlanner({
    codexPath: codex,
    cwd: repoRoot,
    prdInput,
    plannerInstructions: loadIssuePlannerInstructions(),
    effort: options.effort,
    env: runtime.env,
    logPath: path.join(runLogDirectory, "planner.log"),
  });
  runtime.writeStdout(`${formatPrdIssuePlanSummary(plan)}\n`);

  const issueContextLoader: GitHubIssueContextLoader = createGitHubIssueContextLoader(runtime, {
    repo,
  });
  const issueCloser: IssueCloser = createGitHubIssueCloser(runtime, { repo });
  const orchestrator = new PrdIssueLoopOrchestrator(
    runtime,
    agentProvider,
    issueContextLoader,
    issueCloser,
  );

  return orchestrator.runPrepared(plan, {
    repoRoot,
    runLogDirectory,
    startupCleanupCompleted: startupCleanup.completed,
    effort: options.effort,
  });
}

function resolveGitHubRepository(runtime: Runtime, repoRoot: string): string {
  const result = runtime.exec(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    { cwd: repoRoot },
  );
  const repo = result.stdout.trim();
  if (!repo) {
    throw new MonkeError("Could not resolve GitHub repository for `mt run --prd`.");
  }

  return repo;
}

export type { CodexReasoningEffort, RunOutcome };
export { CODEX_REASONING_EFFORTS };
export { formatRunSummary, WorkflowOrchestrator } from "./workflow-orchestrator.ts";
