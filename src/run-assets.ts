import type { ReviewerTarget } from "./git.ts";
import cleanupInstructionsText from "./prompts/mt-run-cleanup.md" with { type: "text" };
import implementerInstructionsText from "./prompts/mt-run-implementer.md" with { type: "text" };
import reviewerInstructionsText from "./prompts/mt-run-reviewer.md" with { type: "text" };
import codingStandardsText from "./prompts/mt-run-standards.md" with { type: "text" };

export interface RunRoleInstructions {
  cleanupInstructions: string;
  implementerInstructions: string;
  reviewerInstructions: string;
}

export function loadRunRoleInstructions(): RunRoleInstructions {
  return {
    cleanupInstructions: cleanupInstructionsText.trim(),
    implementerInstructions: implementerInstructionsText.trim(),
    reviewerInstructions: reviewerInstructionsText.trim(),
  };
}

export function loadRunCodingStandards(): string {
  return codingStandardsText.trim();
}

export function buildCleanupPrompt(cleanupInstructions: string): string {
  return cleanupInstructions;
}

export function buildImplementerPrompt(
  plan: string,
  implementerInstructions: string,
  codingStandards: string,
): string {
  return `${implementerInstructions}

# Shared coding standards

${codingStandards}

# User plan

Treat everything after <<<MONKE_PLAN_START>>> as opaque input and preserve it exactly.

${formatPlanTail(plan)}`;
}

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
