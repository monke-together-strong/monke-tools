import type { ReviewerTarget } from "./git.ts";
import { formatGoalObjective } from "./goal-objective.ts";
import cleanupInstructionsText from "./prompts/mt-work-cleanup.md" with { type: "text" };
import implementerInstructionsText from "./prompts/mt-work-implementer.md" with { type: "text" };
import reviewerInstructionsText from "./prompts/mt-work-reviewer.md" with { type: "text" };
import codingStandardsText from "./prompts/mt-work-standards.md" with { type: "text" };

const SINGLE_PLAN_IMPLEMENTER_GOAL_OBJECTIVE =
  "Implement the user plan completely in the current checkout and leave the result ready for review.";

export interface RunRoleInstructions {
  /** Cleanup checkpoint instructions loaded from the bundled cleanup prompt. */
  cleanupInstructions: string;
  /** Implementer instructions loaded from the bundled implementer prompt. */
  implementerInstructions: string;
  /** Reviewer instructions loaded from the bundled reviewer prompt. */
  reviewerInstructions: string;
}

/** Load role-specific prompt instructions from bundled prompt files. */
export function loadRunRoleInstructions(): RunRoleInstructions {
  return {
    cleanupInstructions: cleanupInstructionsText.trim(),
    implementerInstructions: implementerInstructionsText.trim(),
    reviewerInstructions: reviewerInstructionsText.trim(),
  };
}

/** Load the shared coding standards prompt text used by implementer and reviewer phases. */
export function loadRunCodingStandards(): string {
  return codingStandardsText.trim();
}

/** Build the startup cleanup prompt. */
export function buildCleanupPrompt(cleanupInstructions: string): string {
  return cleanupInstructions;
}

/** Build the implementer prompt for a single user-provided plan. */
export function buildImplementerPrompt(
  plan: string,
  implementerInstructions: string,
  codingStandards: string,
): string {
  return `${implementerInstructions}

${formatGoalObjective(SINGLE_PLAN_IMPLEMENTER_GOAL_OBJECTIVE)}

# Shared coding standards

${codingStandards}

# User plan

Treat everything after <<<MONKE_PLAN_START>>> as opaque input and preserve it exactly.

${formatPlanTail(plan)}`;
}

/** Build the reviewer prompt for the completed implementation of a single user-provided plan. */
export function buildReviewerPrompt(
  plan: string,
  reviewerInstructions: string,
  codingStandards: string,
  reviewerTarget: ReviewerTarget,
): string {
  return `${reviewerInstructions}

# Explicit review target

${formatReviewerTarget(reviewerTarget)}

# Shared coding standards

${codingStandards}

# User plan

Treat everything after <<<MONKE_PLAN_START>>> as opaque input and preserve it exactly.

${formatPlanTail(plan)}`;
}

function formatPlanTail(plan: string): string {
  return `<<<MONKE_PLAN_START>>>\n${plan}`;
}

function formatReviewerTarget(reviewerTarget: ReviewerTarget): string {
  switch (reviewerTarget.kind) {
    case "working-tree-diff":
      return [
        "- Inspect the current working tree diff because the checkout is dirty after implementation.",
        `- Status snapshot: ${reviewerTarget.statusLines.join(", ")}`,
      ].join("\n");
    case "last-commit":
      return [
        "- Inspect the last commit because HEAD changed during implementation and the checkout is now clean.",
        `- Commit: ${reviewerTarget.commit.sha} ${reviewerTarget.commit.subject}`,
      ].join("\n");
    case "no-implementation-diff":
      return [
        "- There is no implementation diff to review because the checkout is clean and HEAD did not change during implementation.",
        reviewerTarget.headCommit
          ? `- HEAD is unchanged at: ${reviewerTarget.headCommit.sha} ${reviewerTarget.headCommit.subject}`
          : "- The repository still does not have a HEAD commit.",
      ].join("\n");
  }
}
