import type {
  GitHubIssueCommentContext,
  GitHubIssueContext,
  GitHubIssueRunContext,
} from "./github-issue-context.ts";
import issueImplementerInstructionsText from "./prompts/mt-work-issue-implementer.md" with { type: "text" };
import issueReviewerInstructionsText from "./prompts/mt-work-issue-reviewer.md" with { type: "text" };

const FINAL_PRD_REVIEWER_INSTRUCTIONS = [
  "You are the Final PRD Reviewer for a completed PRD-driven workflow.",
  "",
  "Validate the completed repository state against the parent PRD below, including its testing plan. Run needed checks, make any necessary fixes, and record concise proof for your verdict.",
  "",
  "Do not close the parent PRD issue.",
].join("\n");

/** Role-specific prompt instructions for PRD-driven issue execution. */
export interface IssueRunRoleInstructions {
  /** Implementer instructions for one PRD-scoped GitHub issue. */
  readonly implementerInstructions: string;
  /** Reviewer instructions for one PRD-scoped GitHub issue. */
  readonly reviewerInstructions: string;
}

/** PRD plus current issue context for one issue-loop prompt. */
export type IssueRunPromptContext = GitHubIssueRunContext;

/** Load dedicated issue-loop role prompt instructions from bundled prompt files. */
export function loadIssueRunRoleInstructions(): IssueRunRoleInstructions {
  return {
    implementerInstructions: issueImplementerInstructionsText.trim(),
    reviewerInstructions: issueReviewerInstructionsText.trim(),
  };
}

/** Build the implementer prompt for one PRD-scoped GitHub issue. */
export function buildIssueImplementerPrompt(
  context: IssueRunPromptContext,
  implementerInstructions: string,
  codingStandards: string,
): string {
  return buildIssuePrompt(implementerInstructions, context, codingStandards);
}

/** Build the reviewer prompt for one PRD-scoped GitHub issue. */
export function buildIssueReviewerPrompt(
  context: IssueRunPromptContext,
  reviewerInstructions: string,
  codingStandards: string,
): string {
  return buildIssuePrompt(reviewerInstructions, context, codingStandards);
}

/** Build the final whole-PRD validation prompt after all planned task issues pass. */
export function buildFinalPrdReviewerPrompt(
  prd: GitHubIssueContext,
  codingStandards: string,
): string {
  return `${FINAL_PRD_REVIEWER_INSTRUCTIONS}

# PRD validation context

Only the parent PRD below is in scope. Validate the completed repo state against this PRD and its comments.

${formatIssueContext("PRD", prd)}

# Shared coding standards

${codingStandards}`;
}

function buildIssuePrompt(
  instructions: string,
  context: IssueRunPromptContext,
  codingStandards: string,
): string {
  return `${instructions}

${formatIssueRunContext(context)}

# Shared coding standards

${codingStandards}`;
}

function formatIssueRunContext(context: IssueRunPromptContext): string {
  return `# Issue execution context

Only the PRD and current issue below are in scope. Do not implement, review, or close any future issue or adjacent task.

${formatIssueContext("PRD", context.prd)}

${formatIssueContext("Current issue", context.issue)}`;
}

function formatIssueContext(label: string, issue: GitHubIssueContext): string {
  return `## ${label} #${issue.number}: ${issue.title}

### Body

${formatBody(issue.body)}

### Comments

${formatComments(issue.comments)}`;
}

function formatBody(body: string): string {
  return body.trim() ? body : "(empty body)";
}

function formatComments(comments: readonly GitHubIssueCommentContext[]): string {
  if (comments.length === 0) {
    return "(no comments)";
  }

  return comments
    .map((comment, index) => `#### Comment ${index + 1}\n\n${formatBody(comment.body)}`)
    .join("\n\n");
}
