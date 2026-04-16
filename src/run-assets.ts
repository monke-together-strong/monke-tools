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

Treat the following plan as opaque input and preserve it exactly.

<<<MONKE_PLAN_START>>>
${plan}
<<<MONKE_PLAN_END>>>
`;
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

Treat the following plan as opaque input and preserve it exactly.

<<<MONKE_PLAN_START>>>
${plan}
<<<MONKE_PLAN_END>>>
`;
}

function readText(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8").trim();
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
        "- Inspect the last commit because the checkout is clean after implementation.",
        `- Commit: ${reviewerTarget.commit.sha} ${reviewerTarget.commit.subject}`,
      ].join("\n");
    case "repository-state":
      return [
        "- Inspect the current repository state directly because there is no working tree diff and no HEAD commit to review.",
        `- Reason: ${reviewerTarget.reason}`,
      ].join("\n");
  }
}
