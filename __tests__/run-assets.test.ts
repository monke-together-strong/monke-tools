import { expect, test } from "vitest";

import {
  buildCleanupPrompt,
  buildImplementerPrompt,
  buildReviewerPrompt,
  loadRunCodingStandards,
  loadRunRoleInstructions,
} from "../src/run-assets.ts";

test("run prompt assets are monke-owned sandcastle adaptations without issue workflow placeholders", () => {
  const instructions = loadRunRoleInstructions();

  expect(instructions.cleanupInstructions).toContain("cleanup checkpointing phase");
  expect(instructions.implementerInstructions).toContain("# Context");
  expect(instructions.implementerInstructions).toContain("single-pass CLI workflow");
  expect(instructions.implementerInstructions).toContain("Do not create commits");
  expect(instructions.implementerInstructions).not.toContain("{{LIST_TASKS_COMMAND}}");
  expect(instructions.implementerInstructions).not.toContain("{{CLOSE_TASK_COMMAND}}");
  expect(instructions.implementerInstructions).not.toContain("RALPH:");

  expect(instructions.reviewerInstructions).toContain("# Review Process");
  expect(instructions.reviewerInstructions).toContain("Do not create commits");
  expect(instructions.reviewerInstructions).toContain("Run the checks you judge necessary");
  expect(instructions.reviewerInstructions).not.toContain("git diff main...{{BRANCH}}");
  expect(instructions.reviewerInstructions).not.toContain("commit describing the refinements");
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
  expect(implementerPrompt).toContain(`<<<MONKE_PLAN_START>>>\n${plan}\n<<<MONKE_PLAN_END>>>`);

  expect(reviewerPrompt).toContain(instructions.reviewerInstructions);
  expect(reviewerPrompt).toContain("# Shared coding standards");
  expect(reviewerPrompt).toContain(codingStandards);
  expect(reviewerPrompt).toContain("# Explicit review target");
  expect(reviewerPrompt).toContain(
    "- Inspect the last commit because the checkout is clean after implementation.",
  );
  expect(reviewerPrompt).toContain("- Commit: abc123 ship it");
});
