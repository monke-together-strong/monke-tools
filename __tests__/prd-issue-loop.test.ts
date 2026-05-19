import path from "node:path";
import { expect, test } from "vitest";

import type { AgentProvider, AgentRunOptions, AgentRunResult } from "../src/agent-provider.ts";
import type { GitHubIssueContext, GitHubIssueContextLoader } from "../src/github-issue-context.ts";
import type { IssueCloser } from "../src/prd-issue-executor.ts";
import { PrdIssueLoopOrchestrator } from "../src/prd-issue-loop.ts";
import { createRuntime } from "../src/runtime.ts";
import { createRepo, git, makeTempDir } from "./helpers.ts";

type AgentRunHandler = (options: AgentRunOptions) => AgentRunResult;

class RecordingAgentProvider implements AgentProvider {
  readonly id = "recording";
  readonly calls: AgentRunOptions[] = [];
  readonly loadSnapshots: number[][] = [];

  readonly #loadedIssueNumbers: readonly number[];
  readonly #handler: AgentRunHandler;

  constructor(
    loadedIssueNumbers: readonly number[],
    handler: AgentRunHandler = commitOnImplementer,
  ) {
    this.#loadedIssueNumbers = loadedIssueNumbers;
    this.#handler = handler;
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    this.calls.push(options);
    this.loadSnapshots.push([...this.#loadedIssueNumbers]);
    return this.#handler(options);
  }
}

class RecordingIssueLoader implements GitHubIssueContextLoader {
  readonly loadedIssueNumbers: number[] = [];

  loadIssue(issueNumber: number): GitHubIssueContext {
    this.loadedIssueNumbers.push(issueNumber);
    return issueContext(issueNumber);
  }
}

class RecordingIssueCloser implements IssueCloser {
  readonly closedIssueNumbers: number[] = [];

  closeIssue(issueNumber: number): void {
    this.closedIssueNumbers.push(issueNumber);
  }
}

test("PRD issue loop executes planned issues in order with lazy issue fetches and one run log directory", async () => {
  const sandbox = makeTempDir("prd-issue-loop-order");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
  });
  const runtime = createRuntime({ cwd: repoRoot });
  const loader = new RecordingIssueLoader();
  const agentProvider = new RecordingAgentProvider(loader.loadedIssueNumbers);
  const closer = new RecordingIssueCloser();
  const orchestrator = new PrdIssueLoopOrchestrator(runtime, agentProvider, loader, closer);

  const outcome = await orchestrator.run(
    {
      prdIssueNumber: 22,
      taskIssueNumbers: [25, 26],
    },
    { effort: "high" },
  );

  expect(outcome.exitCode).toBe(0);
  expect(loader.loadedIssueNumbers).toEqual([22, 25, 26]);
  expect(agentProvider.loadSnapshots).toEqual([
    [22, 25],
    [22, 25],
    [22, 25, 26],
    [22, 25, 26],
    [22, 25, 26],
  ]);
  expect(agentProvider.calls.map((call) => call.phase)).toEqual([
    "implementer",
    "reviewer",
    "implementer",
    "reviewer",
    "final-prd-reviewer",
  ]);
  expect(agentProvider.calls.map((call) => call.reasoningEffort)).toEqual([
    "high",
    "high",
    "high",
    "high",
    "high",
  ]);
  expect(agentProvider.calls.map((call) => path.basename(call.logPath))).toEqual([
    "01-issue-25-implementer.log",
    "01-issue-25-reviewer.log",
    "02-issue-26-implementer.log",
    "02-issue-26-reviewer.log",
    "final-prd-review-proof.log",
  ]);
  expect(new Set(agentProvider.calls.map((call) => path.dirname(call.logPath))).size).toBe(1);
  expect(agentProvider.calls.map((call) => call.prompt)).toEqual([
    expect.stringContaining("Current issue #25"),
    expect.stringContaining("Current issue #25"),
    expect.stringContaining("Current issue #26"),
    expect.stringContaining("Current issue #26"),
    expect.stringContaining("PRD #22: PRD issue-loop workflow"),
  ]);
  expect(agentProvider.calls[4]?.prompt).toContain("# Goal Objective");
  expect(agentProvider.calls[4]?.prompt).toContain("Parent PRD context.");
  expect(agentProvider.calls[4]?.prompt).not.toContain("Current issue #25");
  expect(agentProvider.calls[4]?.prompt).not.toContain("Current issue #26");
  expect(closer.closedIssueNumbers).toEqual([25, 26]);
  expect(outcome.summary).toContain("PRD #22 planned issues: #25, #26.");
  expect(outcome.summary).toContain("Issue #25:");
  expect(outcome.summary).toContain("Issue #26:");
  expect(outcome.summary).toContain("Final PRD validation finished successfully.");
});

test("PRD issue loop stops before later planned issues when an issue phase fails", async () => {
  const sandbox = makeTempDir("prd-issue-loop-phase-failure");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
  });
  const runtime = createRuntime({ cwd: repoRoot });
  const loader = new RecordingIssueLoader();
  const agentProvider = new RecordingAgentProvider(loader.loadedIssueNumbers, (options) => {
    if (options.phase === "implementer") {
      commitOnImplementer(options);
      return { exitCode: 0 };
    }

    return { exitCode: 9 };
  });
  const closer = new RecordingIssueCloser();
  const orchestrator = new PrdIssueLoopOrchestrator(runtime, agentProvider, loader, closer);

  const outcome = await orchestrator.run(
    {
      prdIssueNumber: 22,
      taskIssueNumbers: [25, 26],
    },
    { effort: "medium" },
  );

  expect(outcome.exitCode).toBe(1);
  expect(loader.loadedIssueNumbers).toEqual([22, 25]);
  expect(agentProvider.calls.map((call) => call.phase)).toEqual(["implementer", "reviewer"]);
  expect(agentProvider.calls.map((call) => path.basename(call.logPath))).toEqual([
    "01-issue-25-implementer.log",
    "01-issue-25-reviewer.log",
  ]);
  expect(closer.closedIssueNumbers).toEqual([]);
  expect(outcome.summary).toContain("Reviewer finished with failures (exit code 9).");
  expect(outcome.summary).not.toContain("Issue #26:");
  expect(outcome.summary).not.toContain("Final PRD validation");
});

test("PRD issue loop stops before later planned issues when an issue creates zero commits", async () => {
  const sandbox = makeTempDir("prd-issue-loop-zero-commits");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
  });
  const runtime = createRuntime({ cwd: repoRoot });
  const loader = new RecordingIssueLoader();
  const agentProvider = new RecordingAgentProvider(loader.loadedIssueNumbers, () => ({
    exitCode: 0,
  }));
  const closer = new RecordingIssueCloser();
  const orchestrator = new PrdIssueLoopOrchestrator(runtime, agentProvider, loader, closer);

  const outcome = await orchestrator.run(
    {
      prdIssueNumber: 22,
      taskIssueNumbers: [25, 26],
    },
    {},
  );

  expect(outcome.exitCode).toBe(1);
  expect(loader.loadedIssueNumbers).toEqual([22, 25]);
  expect(agentProvider.calls.map((call) => call.phase)).toEqual(["implementer", "reviewer"]);
  expect(closer.closedIssueNumbers).toEqual([]);
  expect(outcome.summary).toContain("Issue #25 produced zero commits.");
  expect(outcome.summary).not.toContain("Issue #26:");
  expect(outcome.summary).not.toContain("Final PRD validation");
});

test("PRD issue loop fails when final PRD validation fails without closing the parent PRD issue", async () => {
  const sandbox = makeTempDir("prd-issue-loop-final-review-failure");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
  });
  const runtime = createRuntime({ cwd: repoRoot });
  const loader = new RecordingIssueLoader();
  const agentProvider = new RecordingAgentProvider(loader.loadedIssueNumbers, (options) => {
    if (options.phase === "final-prd-reviewer") {
      return { exitCode: 8 };
    }

    return commitOnImplementer(options);
  });
  const closer = new RecordingIssueCloser();
  const orchestrator = new PrdIssueLoopOrchestrator(runtime, agentProvider, loader, closer);

  const outcome = await orchestrator.run(
    {
      prdIssueNumber: 22,
      taskIssueNumbers: [25],
    },
    {},
  );

  expect(outcome.exitCode).toBe(1);
  expect(agentProvider.calls.map((call) => call.phase)).toEqual([
    "implementer",
    "reviewer",
    "final-prd-reviewer",
  ]);
  expect(closer.closedIssueNumbers).toEqual([25]);
  expect(closer.closedIssueNumbers).not.toContain(22);
  expect(outcome.summary).toContain("Final PRD validation finished with failures (exit code 8).");
});

function issueContext(issueNumber: number): GitHubIssueContext {
  if (issueNumber === 22) {
    return {
      number: 22,
      title: "PRD issue-loop workflow",
      body: "Parent PRD context.",
      comments: [],
    };
  }

  return {
    number: issueNumber,
    title: `Task issue ${issueNumber}`,
    body: `Implement issue ${issueNumber}.`,
    comments: [],
  };
}

function commitOnImplementer(options: AgentRunOptions): AgentRunResult {
  if (options.phase === "implementer") {
    const issueNumber = extractCurrentIssueNumber(options.prompt);
    git(options.repoRoot, ["commit", "--allow-empty", "-m", `implement issue ${issueNumber}`]);
  }

  return { exitCode: 0 };
}

function extractCurrentIssueNumber(prompt: string): number {
  const match = prompt.match(/Current issue #(\d+)/);
  if (!match) {
    throw new Error("Expected prompt to include a current issue number.");
  }

  return Number.parseInt(match[1]!, 10);
}
