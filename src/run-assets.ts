import { readFileSync } from "node:fs";

import type { ReviewerTarget } from "./git.ts";

export interface RunRoleInstructions {
  cleanupInstructions: string;
  implementerInstructions: string;
  reviewerInstructions: string;
}

export function loadRunRoleInstructions(): RunRoleInstructions {
  return {
    cleanupInstructions: readText("./prompts/mt-run-cleanup.md"),
    implementerInstructions: readText("./prompts/mt-run-implementer.md"),
    reviewerInstructions: readText("./prompts/mt-run-reviewer.md"),
  };
}

export function loadRunCodingStandards(): string {
  return readText("./prompts/mt-run-standards.md");
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

function readText(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8").trim();
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
