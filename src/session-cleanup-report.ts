import path from "node:path";

import type { CleanupEvidence } from "./cleanup-eligibility.ts";
import {
  decideSessionCleanupEligibility,
  decideSessionCleanupMember
} from "./session-cleanup-eligibility.ts";
import type {
  SessionCleanupEvidence,
  SessionCleanupMember,
  SessionCleanupReason
} from "./session-cleanup-eligibility.ts";

const messages: Record<SessionCleanupReason, string> = {
  "ambiguous-pr": "More than one merged pull request matches this commit.",
  "ancestry-unavailable":
    "The dependency's relationship to the default branch could not be verified.",
  "changed-during-inspection": "The local branch or commit changed during inspection.",
  "closed-unmerged-pr": "The pull request for this commit was closed without merging.",
  "default-branch": "The worktree is on the repository's default branch.",
  "detached-head": "The worktree is not attached to a branch.",
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
  "member-changed-during-inspection": "A member changed after inspection; inspect again.",
  "member-identity-unverified":
    "A member's Source checkout, recorded path, or registration could not be verified.",
  "member-missing-or-unverified": "The member has no usable worktree evidence.",
  "missing-worktree": "The worktree path is missing; ownership must be verified.",
  "no-merged-pr": "No qualifying merged pull request proves this work is complete.",
  "open-pr": "A pull request for this branch is still open.",
  "operation-lock-present":
    "A Monke operation lock is present; its status has not been overridden.",
  "owned-worktree-gone":
    "The owned worktree is already removed; its Source and registrations were verified.",
  "owned-worktrees-gone": "All owned worktrees are already removed; Session finalization remains.",
  "ownership-conflict": "More than one Session record claims this Session or one of its worktrees.",
  "repository-changed-during-inspection": "The repository remote changed during inspection.",
  "repository-unavailable": "The repository or its default branch could not be verified.",
  "source-checkout": "Source checkouts cannot be removed.",
  "state-changed-during-inspection": "Session state changed during inspection; inspect again.",
  "unchanged-dependency": "The dependency has no commits outside the verified default branch.",
  "unique-dependency-commits":
    "The dependency has commits outside the verified default branch and no qualifying merge proof."
};

type CheckStatus = "passed" | "blocked" | "unknown" | "not-checked" | "not-needed";

export interface CleanupCheckReport {
  code: SessionCleanupReason | null;
  message: string;
  status: CheckStatus;
}

/** Supplied by the executor only after an actual attempt. Reporting performs no effects. */
export type SessionCleanupExecution =
  | { outcome: "not-attempted" }
  | { outcome: "cleaned" }
  | {
      message: string;
      outcome: "failed";
      sourceRoot: string;
      step: "revalidation" | "teardown" | "worktree-removal" | "finalization";
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
  return check(
    decision.eligible ? "passed" : decision.status === "ineligible" ? "blocked" : "unknown",
    decision.code
  );
}

function memberReport(snapshot: SessionCleanupEvidence, member: SessionCleanupMember) {
  const decision = decideSessionCleanupMember(snapshot.rootSourceRoot, member);
  const problems = (snapshot.problems ?? []).filter(
    (problem) => problem.worktreePath === member.worktreePath
  );
  let local: CleanupCheckReport;
  let committedWork: CleanupCheckReport;
  if (problems.length > 0 || member.mode === "unverified") {
    local = check("unknown", problems[0]?.code ?? "member-identity-unverified");
    committedWork = member.evidence?.committedWorkAttempted
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
    local = block
      ? check(block.status === "ineligible" ? "blocked" : "unknown", block.code)
      : {
          code: null,
          message: "Registered linked worktree; clean including untracked files and submodules.",
          status: "passed"
        };
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
  execution: SessionCleanupExecution = NOT_ATTEMPTED
) {
  const eligibility = decideSessionCleanupEligibility(snapshot);
  return {
    eligibility,
    execution,
    members: snapshot.members.map((member) => memberReport(snapshot, member)),
    outcome:
      execution.outcome === "not-attempted"
        ? eligibility.eligible
          ? ("eligible" as const)
          : ("skipped" as const)
        : execution.outcome,
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
    skipped: "Skipped"
  };
  const lines = [`${labels[report.outcome]}: ${root} / ${label}`];
  if (report.execution.outcome === "failed") {
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
      `    Committed work [${member.checks.committedWork.status}]: ${member.checks.committedWork.message}`
    );
  }
  if (report.outcome === "skipped") {
    lines.push("  Entire Session retained; no removal attempted.");
  }
  if (report.outcome === "failed") {
    lines.push("  Cleanup was attempted and did not complete; earlier steps may have succeeded.");
  }
  return `${lines.join("\n")}\n`;
}
