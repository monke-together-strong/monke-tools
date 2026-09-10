import path from "node:path";

import { localWorkDescription } from "./cleanup-eligibility.ts";
import type { CleanupEvidence } from "./cleanup-eligibility.ts";
import {
  decideSessionCleanupEligibility,
  decideSessionCleanupMember,
  SETTLED_BLOCKERS
} from "./session-cleanup-eligibility.ts";
import type {
  SessionCleanupEvidence,
  SessionCleanupMember,
  SessionCleanupReason
} from "./session-cleanup-eligibility.ts";
import type { SessionAction } from "./session-lifecycle-progress.ts";

const messages: Record<SessionCleanupReason, string> = {
  "ambiguous-pr": "More than one merged pull request matches this commit.",
  "ancestry-unavailable": "The commit's relationship to the default branch could not be verified.",
  "changed-during-inspection":
    "The local branch, commit, index, or pending files changed during inspection.",
  "closed-unmerged-pr": "The pull request for this commit was closed without merging.",
  "commit-pr-unavailable":
    "Pull requests associated with the current commit could not be verified.",
  "default-branch": "The worktree is on the repository's default branch.",
  "detached-head": "The worktree is not attached to a branch.",
  "diff-unavailable": "The complete branch change could not be compared with the landed merge.",
  "dirty-worktree":
    "The worktree has staged, modified, or untracked files, including submodule changes.",
  "exact-merged-pr": "The current commit matches an exact merged pull request in this repository.",
  "head-mismatch": "The current commit does not match a qualifying merged pull request's head.",
  held: "The Session has an explicit cleanup hold.",
  "hidden-index-entries": "Git index flags may hide changes, including in submodules.",
  "identity-unverified":
    "The worktree's repository identity or Git registration could not be verified.",
  "invalid-state": "The retained Session state is invalid or cannot be read.",
  "invalid-state-overlap": "Invalid Session state may claim the same worktrees.",
  "local-evidence-unavailable": "Git could not establish the local branch, commit, or cleanliness.",
  "matching-default-tree": "The complete committed tree occurs in verified default history.",
  "matching-merged-diff":
    "The complete branch change exactly matches a merged PR's change in the default branch.",
  "member-changed-during-inspection": "A member changed after inspection; inspect again.",
  "member-identity-unverified":
    "A member's Source checkout, recorded path, or registration could not be verified.",
  "member-missing-or-unverified": "The member has no usable worktree evidence.",
  "merged-pr-head":
    "The current commit matches a merged PR head under another branch, and its merge remains in the default branch.",
  "missing-worktree": "The worktree path is missing; ownership must be verified.",
  "no-merged-pr":
    "No qualifying merged pull request proves this work is complete, and the branch has commits outside the default branch.",
  "open-pr": "A pull request for this branch is still open.",
  "operation-lock-present":
    "A Monke operation lock is present; its status has not been overridden.",
  "owned-worktree-gone":
    "The owned worktree is already removed; its Source and registrations were verified.",
  "owned-worktrees-gone": "All owned worktrees are already removed; Session finalization remains.",
  "ownership-conflict":
    "Session ownership conflicts with another record or an overlapping registered worktree; remove the wrong Session state file from Monke home, then rerun Cleanup.",
  "recent-worktree":
    "Ancestry or matching merged work provides completion evidence, but the worktree must have a verified age of at least one day.",
  "repository-changed-during-inspection": "The repository remote changed during inspection.",
  "repository-unavailable": "The repository or its default branch could not be verified.",
  "source-checkout": "Source checkouts cannot be removed.",
  "source-missing":
    "A member's recorded Source checkout no longer exists; Chop cannot run and the state is retained.",
  "state-changed-during-inspection": "Session state changed during inspection; inspect again.",
  "unchanged-branch": "The branch has no commits outside the verified default branch."
};

type CheckStatus = "passed" | "blocked" | "unknown" | "not-checked" | "not-needed";

export interface CleanupCheckReport {
  code: SessionCleanupReason | null;
  /** Collected facts behind the status, such as the paths that make a worktree dirty. */
  details?: string[];
  message: string;
  status: CheckStatus;
}

/** Supplied by the executor only after an actual attempt. Reporting performs no effects. */
export type SessionCleanupExecution = (
  | { outcome: "not-attempted" }
  | { outcome: "cleaned" }
  | {
      message: string;
      outcome: "failed" | "skipped";
      sourceRoot: string;
      step: SessionAction["step"] | "teardown" | "finalization";
    }
) & {
  attemptedAction?: SessionAction;
  completedActions?: SessionAction[];
  remainingActions?: SessionAction[];
  retryCleanupCommands?: SessionAction[];
};

const NOT_ATTEMPTED: SessionCleanupExecution = { outcome: "not-attempted" };

function check(status: CheckStatus, code: SessionCleanupReason): CleanupCheckReport {
  return { code, message: messages[code], status };
}

function committedWorkCheck(
  evidence: CleanupEvidence,
  decision: ReturnType<typeof decideSessionCleanupMember>
): CleanupCheckReport {
  if (evidence.committedWorkAttempted === false) {
    return {
      code: null,
      message: "Not checked because the local worktree check stopped inspection.",
      status: "not-checked"
    };
  }
  if (evidence.localBlock) {
    return {
      code: evidence.localBlock.code,
      message:
        evidence.committedWorkAttempted === true
          ? "Committed-work inspection was attempted, but later local validation failed; its proof is not accepted."
          : "The saved evidence does not establish whether committed work was checked.",
      status: "unknown"
    };
  }
  const report = check(
    decision.eligible ? "passed" : decision.status === "ineligible" ? "blocked" : "unknown",
    decision.code
  );
  if (decision.evidence.length > 0) {
    report.details = decision.evidence;
  }
  return report;
}

function memberReport(snapshot: SessionCleanupEvidence, member: SessionCleanupMember) {
  const decision = decideSessionCleanupMember(snapshot.rootSourceRoot, member);
  const problems = (snapshot.problems ?? []).filter(
    (problem) => problem.worktreePath === member.worktreePath
  );
  let local: CleanupCheckReport;
  let committedWork: CleanupCheckReport;
  if (problems.length > 0 || member.mode === "unverified") {
    const code = problems[0]?.code ?? "member-identity-unverified";
    local = check(SETTLED_BLOCKERS.has(code) ? "blocked" : "unknown", code);
    committedWork =
      member.evidence && member.evidence.committedWorkAttempted !== false
        ? {
            code: null,
            message: "Member identity changed; previously collected proof is not accepted.",
            status: "unknown"
          }
        : {
            code: null,
            message: "Not checked because member identity could not be verified.",
            status: "not-checked"
          };
  } else if (member.mode === "gone" || member.mode === "stale") {
    local = check("passed", "owned-worktree-gone");
    committedWork = {
      code: null,
      message: "Not needed for a verified, already removed worktree.",
      status: "not-needed"
    };
  } else if (member.evidence) {
    const block = member.evidence.localBlock;
    if (block) {
      local = check(block.status === "ineligible" ? "blocked" : "unknown", block.code);
      if (block.evidence.length > 0) {
        local.details = block.evidence;
      }
    } else {
      local = {
        code: null,
        message: localWorkDescription(member.evidence),
        ...(member.evidence.pendingWork ? { details: member.evidence.pendingWork.paths } : {}),
        status: "passed"
      };
    }
    committedWork = committedWorkCheck(member.evidence, decision);
  } else {
    local = check("unknown", "member-missing-or-unverified");
    committedWork = {
      code: null,
      message: "Not checked; no member evidence was collected.",
      status: "not-checked"
    };
  }
  return {
    checks: { committedWork, local },
    problems,
    sourceRoot: member.sourceRoot,
    worktreePath: member.worktreePath
  };
}

/** JSON and text share this projection, including checks skipped by the collector. */
export function createSessionCleanupReport(
  snapshot: SessionCleanupEvidence,
  execution: SessionCleanupExecution = NOT_ATTEMPTED,
  options: { dryRun?: boolean; plannedActions?: SessionAction[] } = {}
) {
  const eligibility = decideSessionCleanupEligibility(snapshot);
  const members = snapshot.members.map((member) => memberReport(snapshot, member));
  // Eligibility can be conclusively false while another check still lacks evidence.
  const inspectionFailed =
    snapshot.blockers.some((blocker) => !SETTLED_BLOCKERS.has(blocker)) ||
    members.some(
      (member) =>
        member.checks.local.status === "unknown" || member.checks.committedWork.status === "unknown"
    );
  return {
    eligibility,
    execution,
    inspectionFailed,
    members,
    outcome:
      execution.outcome === "not-attempted"
        ? eligibility.eligible
          ? options.dryRun
            ? ("would-clean" as const)
            : ("eligible" as const)
          : ("skipped" as const)
        : execution.outcome,
    plannedActions: options.plannedActions ?? [],
    problems: snapshot.problems ?? [],
    reasons: eligibility.reasons.map((code) => ({ code, message: messages[code] })),
    rootSourceRoot: snapshot.rootSourceRoot,
    session: snapshot.session,
    stateFile: snapshot.filePath
  };
}

export function formatSessionCleanupReport(report: ReturnType<typeof createSessionCleanupReport>) {
  const root = report.rootSourceRoot ? path.basename(report.rootSourceRoot) : "unknown Root repo";
  const label = report.session ?? report.stateFile;
  const labels = {
    cleaned: "Cleaned",
    eligible: "Eligible (not attempted)",
    failed: "Failed",
    skipped: "Skipped",
    "would-clean": "Would clean"
  };
  const lines = [`${labels[report.outcome]}: ${root} / ${label}`];
  if (report.execution.outcome === "failed" || report.execution.outcome === "skipped") {
    lines.push(
      `  ${report.execution.step} failed in ${report.execution.sourceRoot}: ${report.execution.message}`
    );
  }
  for (const reason of report.reasons) {
    lines.push(`  ${reason.code}: ${reason.message}`);
  }
  for (const problem of report.problems) {
    lines.push(`  ${problem.message}`);
  }
  for (const member of report.members) {
    lines.push(
      `  ${member.sourceRoot} — ${member.worktreePath}`,
      `    Local worktree [${member.checks.local.status}]: ${member.checks.local.message}`,
      ...(member.checks.local.details ?? []).map((detail) => `      ${detail}`),
      `    Committed work [${member.checks.committedWork.status}]: ${member.checks.committedWork.message}`,
      ...(member.checks.committedWork.details ?? []).map((detail) => `      ${detail}`)
    );
  }
  if (report.outcome === "skipped") {
    lines.push("  Entire Session retained; no removal attempted.");
  }
  if (report.outcome === "failed") {
    lines.push("  Cleanup was attempted and did not complete; earlier steps may have succeeded.");
  }
  lines.push(...formatProgress(report));
  return `${lines.join("\n")}\n`;
}

function formatProgress(report: ReturnType<typeof createSessionCleanupReport>) {
  const lines: string[] = [];
  for (const action of report.plannedActions) {
    lines.push(`  Planned: ${formatAction(action)}`);
  }
  for (const action of report.execution.completedActions ?? []) {
    lines.push(`  Completed this attempt: ${formatAction(action)}`);
  }
  for (const action of report.execution.remainingActions ?? []) {
    lines.push(`  Remaining: ${formatAction(action)}`);
  }
  if (report.execution.attemptedAction && report.outcome === "failed") {
    lines.push("  The failed action may have produced effects; its completion is unverified.");
  }
  if (report.outcome === "failed" && (report.execution.retryCleanupCommands?.length ?? 0) > 0) {
    lines.push(
      "  Retry runs recorded Cleanup commands from the beginning, including earlier successes."
    );
  }
  return lines;
}

function formatAction(action: SessionAction) {
  return `${action.step} ${action.sourceRoot}${action.worktreePath ? ` (${action.worktreePath})` : ""}${action.command ? `: ${action.command}` : ""}${action.retainedRef ? `; retained HEAD: ${action.retainedRef}` : ""}${action.recoveryCommand ? `; recover: ${action.recoveryCommand}` : ""}`;
}
