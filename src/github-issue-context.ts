import { MonkeError } from "./errors.ts";
import type { Runtime } from "./types.ts";

/** Text-only comment context included in PRD-driven issue prompts. */
export interface GitHubIssueCommentContext {
  /** Markdown body of the GitHub issue comment. */
  readonly body: string;
}

/** Text-only GitHub issue context used by PRD-driven issue execution. */
export interface GitHubIssueContext {
  /** GitHub issue number that identifies this context. */
  readonly number: number;
  /** GitHub issue title. */
  readonly title: string;
  /** GitHub issue body as Markdown. */
  readonly body: string;
  /** GitHub issue comment bodies in GitHub's returned order. */
  readonly comments: readonly GitHubIssueCommentContext[];
}

/** Repository-scoped options for constructing a GitHub issue context loader. */
export interface GitHubIssueContextLoaderOptions {
  /** GitHub repository in OWNER/REPO format. */
  readonly repo: string;
}

/** Loader that fetches text-only GitHub issue context on demand. */
export interface GitHubIssueContextLoader {
  /** Fetch one GitHub issue and return only the prompt-safe text context. */
  loadIssue(issueNumber: number): GitHubIssueContext;
}

/** Issue numbers required to build context for one PRD-driven execution step. */
export interface GitHubIssueRunContextSelection {
  /** Parent PRD issue number. */
  readonly prdIssueNumber: number;
  /** Current executable task issue number. */
  readonly currentIssueNumber: number;
}

/** Text-only PRD and current issue context for one execution step. */
export interface GitHubIssueRunContext {
  /** Parent PRD issue context. */
  readonly prd: GitHubIssueContext;
  /** Current executable issue context. */
  readonly issue: GitHubIssueContext;
}

/** Create a GitHub CLI-backed issue context loader for one repository. */
export function createGitHubIssueContextLoader(
  runtime: Runtime,
  options: GitHubIssueContextLoaderOptions,
): GitHubIssueContextLoader {
  return {
    loadIssue(issueNumber: number): GitHubIssueContext {
      const result = runtime.exec("gh", [
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        options.repo,
        "--json",
        "number,title,body,comments",
      ]);

      return parseIssueContext(issueNumber, result.stdout);
    },
  };
}

/** Load only the PRD and current issue context needed for one execution step. */
export function loadGitHubIssueRunContext(
  loader: GitHubIssueContextLoader,
  selection: GitHubIssueRunContextSelection,
): GitHubIssueRunContext {
  return {
    prd: loader.loadIssue(selection.prdIssueNumber),
    issue: loader.loadIssue(selection.currentIssueNumber),
  };
}

function parseIssueContext(expectedIssueNumber: number, stdout: string): GitHubIssueContext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new MonkeError(`Failed to parse GitHub issue JSON: ${formatUnknownError(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new MonkeError("GitHub issue JSON must be an object.");
  }

  const number = parsed["number"];
  if (typeof number !== "number" || !Number.isInteger(number)) {
    throw new MonkeError("GitHub issue JSON must include an integer number.");
  }

  if (number !== expectedIssueNumber) {
    throw new MonkeError(
      `GitHub issue JSON returned #${number} while loading #${expectedIssueNumber}.`,
    );
  }

  const title = parsed["title"];
  if (typeof title !== "string") {
    throw new MonkeError("GitHub issue JSON must include a string title.");
  }

  const body = parsed["body"];
  if (typeof body !== "string") {
    throw new MonkeError("GitHub issue JSON must include a string body.");
  }

  const comments = parsed["comments"];
  if (!Array.isArray(comments)) {
    throw new MonkeError("GitHub issue JSON must include a comments array.");
  }

  return {
    number,
    title,
    body,
    comments: comments.map((comment, index) => parseCommentContext(comment, index)),
  };
}

function parseCommentContext(comment: unknown, index: number): GitHubIssueCommentContext {
  if (!isRecord(comment)) {
    throw new MonkeError(`GitHub issue comment at index ${index} must be an object.`);
  }

  const body = comment["body"];
  if (typeof body !== "string") {
    throw new MonkeError(`GitHub issue comment at index ${index} must include a string body.`);
  }

  return { body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
