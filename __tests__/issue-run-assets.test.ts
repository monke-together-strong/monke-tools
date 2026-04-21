import { expect, test } from "vitest";

import {
  buildIssueImplementerPrompt,
  buildIssueReviewerPrompt,
  loadIssueRunRoleInstructions,
} from "../src/issue-run-assets.ts";
import { loadRunCodingStandards } from "../src/run-assets.ts";

test("issue run prompts include only PRD and current issue context", () => {
  const instructions = loadIssueRunRoleInstructions();
  const codingStandards = loadRunCodingStandards();
  const futureIssueTitle = "Future issue should not be visible";
  const labelName = "scope/future";
  const assigneeLogin = "octocat";
  const context = {
    prd: {
      number: 22,
      title: "PRD issue-loop workflow",
      body: "Build the PRD-driven run workflow.",
      comments: [{ body: "PRD clarification comment." }],
    },
    issue: {
      number: 23,
      title: "Add context loader",
      body: "Load issue text for this slice.",
      comments: [{ body: "Current issue clarification comment." }],
    },
  };

  const implementerPrompt = buildIssueImplementerPrompt(
    context,
    instructions.implementerInstructions,
    codingStandards,
  );
  const reviewerPrompt = buildIssueReviewerPrompt(
    context,
    instructions.reviewerInstructions,
    codingStandards,
  );

  for (const prompt of [implementerPrompt, reviewerPrompt]) {
    expect(prompt).toContain("PRD #22: PRD issue-loop workflow");
    expect(prompt).toContain("Build the PRD-driven run workflow.");
    expect(prompt).toContain("PRD clarification comment.");
    expect(prompt).toContain("Current issue #23: Add context loader");
    expect(prompt).toContain("Load issue text for this slice.");
    expect(prompt).toContain("Current issue clarification comment.");
    expect(prompt).toContain(codingStandards);
    expect(prompt).not.toContain(futureIssueTitle);
    expect(prompt).not.toContain(labelName);
    expect(prompt).not.toContain(assigneeLogin);
  }
});
