import {
  CODEX_REASONING_EFFORTS,
  CodexAgentProvider,
  type CodexReasoningEffort,
} from "./agent-provider.ts";
import { MonkeError } from "./errors.ts";
import { findExecutable } from "./runtime.ts";
import type { Runtime } from "./types.ts";
import { WorkflowOrchestrator, type RunOutcome } from "./workflow-orchestrator.ts";

/** Options accepted by the public `mt run` workflow entrypoint. */
export interface RunWorkflowOptions {
  /** Reasoning effort forwarded to every attempted Codex-backed phase. */
  readonly effort?: CodexReasoningEffort;
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

export type { CodexReasoningEffort, RunOutcome };
export { CODEX_REASONING_EFFORTS };
export { formatRunSummary, WorkflowOrchestrator } from "./workflow-orchestrator.ts";
