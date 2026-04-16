import { spawnSync } from "node:child_process";

import { MonkeError } from "./errors.ts";
import {
  determineReviewerTarget,
  getHeadCommitInfo,
  inspectCheckoutState,
  resolveGitRepoRoot,
} from "./git.ts";
import { findExecutable, formatCommand } from "./runtime.ts";
import {
  buildCleanupPrompt,
  buildImplementerPrompt,
  buildReviewerPrompt,
  loadRunCodingStandards,
  loadRunRoleInstructions,
} from "./run-assets.ts";
import type { Runtime } from "./types.ts";

const REQUIRED_CLEANUP_COMMIT_PREFIX = "clean up";

type WorkflowRole = "implementer" | "reviewer";

interface WorkflowPhaseResult {
  role: WorkflowRole;
  exitCode: number;
  commitViolation: string | null;
}

export interface RunOutcome {
  repoRoot: string;
  exitCode: number;
  summary: string;
}

export function runSinglePassWorkflow(runtime: Runtime, plan: string): void {
  if (!plan) {
    throw new MonkeError("mt run requires --plan");
  }

  const outcome = executeRunWorkflow(runtime, plan);
  if (outcome.exitCode !== 0) {
    throw new MonkeError(outcome.summary);
  }

  runtime.writeStdout(`${outcome.summary}\n`);
}

export function executeRunWorkflow(runtime: Runtime, plan: string): RunOutcome {
  const repoRoot = resolveGitRepoRoot(runtime, runtime.cwd);
  const codex = findExecutable("codex", runtime.env);
  if (!codex) {
    throw new MonkeError("Could not find `codex` on PATH");
  }

  const instructions = loadRunRoleInstructions();
  const codingStandards = loadRunCodingStandards();
  const startupState = inspectCheckoutState(runtime, repoRoot);
  let cleanupCompleted = false;

  if (startupState.isDirty) {
    const beforeCleanupCommit = getHeadCommitInfo(runtime, repoRoot);
    const cleanupResult = runHarnessPhase(
      runtime,
      codex,
      repoRoot,
      buildCleanupPrompt(instructions.cleanupInstructions),
    );
    const afterCleanupCommit = getHeadCommitInfo(runtime, repoRoot);
    const postCleanupState = inspectCheckoutState(runtime, repoRoot);
    const cleanupFailure = getCleanupFailureSummary(
      cleanupResult.exitCode,
      beforeCleanupCommit?.sha ?? null,
      afterCleanupCommit,
      postCleanupState,
    );
    if (cleanupFailure) {
      return {
        repoRoot,
        exitCode: cleanupResult.exitCode === 0 ? 1 : cleanupResult.exitCode,
        summary: cleanupFailure,
      };
    }

    cleanupCompleted = true;
  }

  const implementerResult = runWorkflowPhase(
    runtime,
    codex,
    repoRoot,
    "implementer",
    buildImplementerPrompt(plan, instructions.implementerInstructions, codingStandards),
  );
  const reviewerTarget = determineReviewerTarget(runtime, repoRoot);
  const reviewerResult = runWorkflowPhase(
    runtime,
    codex,
    repoRoot,
    "reviewer",
    buildReviewerPrompt(plan, instructions.reviewerInstructions, codingStandards, reviewerTarget),
  );
  const workflowFailed =
    implementerResult.exitCode !== 0 ||
    reviewerResult.exitCode !== 0 ||
    implementerResult.commitViolation !== null ||
    reviewerResult.commitViolation !== null;

  return {
    repoRoot,
    exitCode: workflowFailed ? 1 : 0,
    summary: formatRunSummary(cleanupCompleted, implementerResult, reviewerResult),
  };
}

export function formatRunSummary(
  cleanupCompleted: boolean,
  implementerResult: WorkflowPhaseResult,
  reviewerResult: WorkflowPhaseResult,
): string {
  const phaseSummaries = [
    formatWorkflowPhaseSummary(implementerResult),
    formatWorkflowPhaseSummary(reviewerResult),
  ];

  if (!cleanupCompleted) {
    return phaseSummaries.join(" ");
  }

  return `Cleanup checkpointed existing changes. ${phaseSummaries.join(" ")}`;
}

function runWorkflowPhase(
  runtime: Runtime,
  codex: string,
  repoRoot: string,
  role: WorkflowRole,
  prompt: string,
): WorkflowPhaseResult {
  const beforePhaseCommit = getHeadCommitInfo(runtime, repoRoot);
  const phaseResult = runHarnessPhase(runtime, codex, repoRoot, prompt);
  const afterPhaseCommit = getHeadCommitInfo(runtime, repoRoot);

  return {
    role,
    exitCode: phaseResult.exitCode,
    commitViolation: getWorkflowCommitViolation(
      role,
      beforePhaseCommit?.sha ?? null,
      afterPhaseCommit,
    ),
  };
}

function runHarnessPhase(
  runtime: Runtime,
  codex: string,
  repoRoot: string,
  prompt: string,
): { exitCode: number } {
  const args = ["exec", "--full-auto", "--cd", repoRoot, "-"];
  const result = spawnSync(codex, args, {
    cwd: repoRoot,
    env: runtime.env,
    input: prompt,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });

  if (result.error) {
    throw new MonkeError(`Failed to run ${formatCommand(codex, args)}: ${result.error.message}`);
  }

  if (result.status === null) {
    const reason = result.signal ? `terminated by signal ${result.signal}` : "terminated by signal";
    throw new MonkeError(`Command failed: ${formatCommand(codex, args)}\n${reason}`);
  }

  return {
    exitCode: result.status,
  };
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
