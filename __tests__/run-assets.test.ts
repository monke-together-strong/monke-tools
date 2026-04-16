import { expect, test } from "vitest";

import {
  buildCleanupPrompt,
  buildImplementerPrompt,
  buildReviewerPrompt,
  loadRunCodingStandards,
  loadRunRoleInstructions,
} from "../src/run-assets.ts";

test("run prompt assets load the local role prompts and vendored standards cleanly", () => {
  const instructions = loadRunRoleInstructions();
  const codingStandards = loadRunCodingStandards();

  expect(instructions.cleanupInstructions).toContain("You are the cleanup checkpointing phase.");
  expect(instructions.implementerInstructions).toContain("# Context");
  expect(instructions.implementerInstructions).toContain(
    "You are a task implementer for the specified plan below",
  );
  expect(instructions.implementerInstructions).toContain(
    "Treat the user plan below as the only task for this pass.",
  );
  expect(instructions.implementerInstructions).not.toContain("{{LIST_TASKS_COMMAND}}");
  expect(instructions.implementerInstructions).not.toContain("{{CLOSE_TASK_COMMAND}}");
  expect(instructions.implementerInstructions).not.toContain("RALPH:");

  expect(instructions.reviewerInstructions).toContain("# Review Process");
  expect(instructions.reviewerInstructions).toContain(
    "You are an expert code reviewer focused on enhancing code clarity, consistency, and maintainability while preserving exact functionality.",
  );
  expect(instructions.reviewerInstructions).toContain("Do not create commits");
  expect(instructions.reviewerInstructions).toContain(
    "If you find worthwhile improvements to make:",
  );
  expect(instructions.reviewerInstructions).not.toContain("{{LIST_TASKS_COMMAND}}");
  expect(instructions.reviewerInstructions).not.toContain("{{CLOSE_TASK_COMMAND}}");

  expect(codingStandards).toContain(
    "Any public-facing properties or functions should have JSDOC comments explaining them.",
  );
  expect(codingStandards).toContain("## Testing");
  expect(codingStandards).toContain("## Interface Design");
});

test("implementer and reviewer prompts both load the shared coding standards contract", () => {
  const instructions = loadRunRoleInstructions();
  const codingStandards = loadRunCodingStandards();
  const plan = "1. Keep this line\n2. Preserve it exactly";

  const cleanupPrompt = buildCleanupPrompt(instructions.cleanupInstructions);
  const implementerPrompt = buildImplementerPrompt(
    plan,
    instructions.implementerInstructions,
    codingStandards,
  );
  const reviewerPrompt = buildReviewerPrompt(
    plan,
    instructions.reviewerInstructions,
    codingStandards,
    {
      kind: "last-commit",
      commit: {
        sha: "abc123",
        subject: "ship it",
      },
    },
  );

  expect(cleanupPrompt).toBe(instructions.cleanupInstructions);
  expect(cleanupPrompt).not.toContain("# Shared coding standards");

  expect(implementerPrompt).toContain(instructions.implementerInstructions);
  expect(implementerPrompt).toContain("# Shared coding standards");
  expect(implementerPrompt).toContain(codingStandards);
  expect(implementerPrompt.endsWith(`<<<MONKE_PLAN_START>>>\n${plan}`)).toBe(true);
  expect(implementerPrompt).not.toContain("<<<MONKE_PLAN_END>>>");

  expect(reviewerPrompt).toContain(instructions.reviewerInstructions);
  expect(reviewerPrompt).toContain("# Shared coding standards");
  expect(reviewerPrompt).toContain(codingStandards);
  expect(reviewerPrompt).toContain("# Explicit review target");
  expect(reviewerPrompt).toContain(
    "- Inspect the last commit because HEAD changed during implementation and the checkout is now clean.",
  );
  expect(reviewerPrompt).toContain("- Commit: abc123 ship it");
  expect(reviewerPrompt.endsWith(`<<<MONKE_PLAN_START>>>\n${plan}`)).toBe(true);
  expect(reviewerPrompt).not.toContain("<<<MONKE_PLAN_END>>>");
});
