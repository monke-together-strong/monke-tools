import path from "node:path";
import { mkdirSync } from "node:fs";
import { expect, test } from "vitest";

import type { AgentProvider, AgentRunOptions, AgentRunResult } from "../src/agent-provider.ts";
import {
  createGitHubIssueCloser,
  PrdIssueExecutor,
  type IssueCloser,
} from "../src/prd-issue-executor.ts";
import type { GitHubIssueRunContext } from "../src/github-issue-context.ts";
import { createRuntime } from "../src/runtime.ts";
import type { ExecOptions, ExecResult, Runtime } from "../src/types.ts";
import { createRepo, git, makeTempDir } from "./helpers.ts";

type IssuePhase = Extract<AgentRunOptions["phase"], "implementer" | "reviewer">;
type IssuePhaseHandler = (options: AgentRunOptions) => AgentRunResult;
type IssuePhaseHandlers = Partial<Record<IssuePhase, IssuePhaseHandler>>;

interface ExecutorScenario {
  readonly repoRoot: string;
  readonly runLogDirectory: string;
  readonly closer: RecordingIssueCloser;
  readonly agentProvider: RecordingAgentProvider;
  readonly executor: PrdIssueExecutor;
}

class RecordingAgentProvider implements AgentProvider {
  readonly id = "recording";
  readonly calls: AgentRunOptions[] = [];

  readonly #handlers: IssuePhaseHandlers;

  constructor(handlers: IssuePhaseHandlers) {
    this.#handlers = handlers;
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    this.calls.push(options);
    if (!isIssuePhase(options.phase)) {
      throw new Error(`Unexpected PRD issue executor phase: ${options.phase}`);
    }

    return this.#handlers[options.phase]?.(options) ?? { exitCode: 0 };
  }
}

class RecordingIssueCloser implements IssueCloser {
  readonly closedIssueNumbers: number[] = [];

  closeIssue(issueNumber: number): void {
    this.closedIssueNumbers.push(issueNumber);
  }
}

test("PRD issue executor runs implementer then reviewer for the current issue and closes it after a commit-backed success", async () => {
  const futureIssueTitle = "Future issue should not be visible";
  const { repoRoot, runLogDirectory, closer, agentProvider, executor } = createExecutorScenario(
    "prd-issue-success",
    {
      implementer(options) {
        git(options.repoRoot, ["commit", "--allow-empty", "-m", "implement issue 25"]);
        return { exitCode: 0, durationMs: 65_000 };
      },
      reviewer() {
        return { exitCode: 0, durationMs: 2_000 };
      },
    },
  );
  const outcome = await executor.run({
    repoRoot,
    runLogDirectory,
    issueOrdinal: 1,
    effort: "high",
    context: {
      prd: {
        number: 22,
        title: "PRD issue-loop workflow",
        body: "Parent PRD context.",
        comments: [{ body: "PRD clarification." }],
      },
      issue: {
        number: 25,
        title: "Build single-issue PRD executor",
        body: "Run implementer and reviewer for this one issue.",
        comments: [{ body: "Current issue clarification." }],
      },
    },
  });

  expect(outcome.exitCode).toBe(0);
  expect(outcome.commitCount).toBe(1);
  expect(closer.closedIssueNumbers).toEqual([25]);
  expect(agentProvider.calls.map((call) => call.phase)).toEqual(["implementer", "reviewer"]);
  expect(agentProvider.calls.map((call) => call.reasoningEffort)).toEqual(["high", "high"]);
  expect(agentProvider.calls.map((call) => path.basename(call.logPath))).toEqual([
    "01-issue-25-implementer.log",
    "01-issue-25-reviewer.log",
  ]);
  expect(outcome.summary).toContain("Durations: Implementer 1m 5s, Reviewer 2s.");

  for (const call of agentProvider.calls) {
    expect(call.repoRoot).toBe(repoRoot);
    expect(call.prompt).toContain("PRD #22: PRD issue-loop workflow");
    expect(call.prompt).toContain("Current issue #25: Build single-issue PRD executor");
    expect(call.prompt).toContain("Run implementer and reviewer for this one issue.");
    expect(call.prompt).not.toContain(futureIssueTitle);
  }
});

test("GitHub issue closer closes only the requested issue in the configured repo", () => {
  const invocations: { command: string; args: string[] }[] = [];
  const runtime: Runtime = {
    cwd: "/repo",
    env: {},
    exec(command: string, args: string[] = [], _options?: ExecOptions): ExecResult {
      invocations.push({ command, args });
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    writeStdout() {},
    writeStderr() {},
  };

  const closer = createGitHubIssueCloser(runtime, { repo: "owner/repo" });

  closer.closeIssue(25);

  expect(invocations).toEqual([
    {
      command: "gh",
      args: ["issue", "close", "25", "--repo", "owner/repo"],
    },
  ]);
});

test("PRD issue executor fails and leaves the issue open when both phases create zero commits", async () => {
  const { repoRoot, runLogDirectory, closer, agentProvider, executor } = createExecutorScenario(
    "prd-issue-zero-commits",
    {
      implementer() {
        return { exitCode: 0 };
      },
      reviewer() {
        return { exitCode: 0 };
      },
    },
  );

  const outcome = await executor.run({
    repoRoot,
    runLogDirectory,
    issueOrdinal: 2,
    context: issueContext(25),
  });

  expect(outcome.exitCode).toBe(1);
  expect(outcome.commitCount).toBe(0);
  expect(outcome.issueClosed).toBe(false);
  expect(outcome.summary).toContain("Issue #25 produced zero commits.");
  expect(closer.closedIssueNumbers).toEqual([]);
  expect(agentProvider.calls.map((call) => call.phase)).toEqual(["implementer", "reviewer"]);
});

test("PRD issue executor succeeds when only the reviewer creates the issue commit", async () => {
  const { repoRoot, runLogDirectory, closer, agentProvider, executor } = createExecutorScenario(
    "prd-issue-reviewer-only-commit",
    {
      implementer() {
        return { exitCode: 0 };
      },
      reviewer(options) {
        git(options.repoRoot, ["commit", "--allow-empty", "-m", "review issue 25"]);
        return { exitCode: 0 };
      },
    },
  );

  const outcome = await executor.run({
    repoRoot,
    runLogDirectory,
    issueOrdinal: 3,
    context: issueContext(25),
  });

  expect(outcome.exitCode).toBe(0);
  expect(outcome.commitCount).toBe(1);
  expect(outcome.issueClosed).toBe(true);
  expect(closer.closedIssueNumbers).toEqual([25]);
  expect(agentProvider.calls.map((call) => call.phase)).toEqual(["implementer", "reviewer"]);
});

test("PRD issue executor still runs reviewer after implementer failure but does not close the issue", async () => {
  const { repoRoot, runLogDirectory, closer, agentProvider, executor } = createExecutorScenario(
    "prd-issue-implementer-failure",
    {
      implementer() {
        return { exitCode: 7 };
      },
      reviewer(options) {
        git(options.repoRoot, ["commit", "--allow-empty", "-m", "review issue 25 after failure"]);
        return { exitCode: 0 };
      },
    },
  );

  const outcome = await executor.run({
    repoRoot,
    runLogDirectory,
    issueOrdinal: 4,
    context: issueContext(25),
  });

  expect(outcome.exitCode).toBe(1);
  expect(outcome.commitCount).toBe(1);
  expect(outcome.issueClosed).toBe(false);
  expect(outcome.summary).toContain("Implementer finished with failures (exit code 7).");
  expect(closer.closedIssueNumbers).toEqual([]);
  expect(agentProvider.calls.map((call) => call.phase)).toEqual(["implementer", "reviewer"]);
});

test("PRD issue executor leaves the issue open when reviewer fails after implementer commits", async () => {
  const { repoRoot, runLogDirectory, closer, agentProvider, executor } = createExecutorScenario(
    "prd-issue-reviewer-failure",
    {
      implementer(options) {
        git(options.repoRoot, ["commit", "--allow-empty", "-m", "implement issue 25"]);
        return { exitCode: 0 };
      },
      reviewer() {
        return { exitCode: 9 };
      },
    },
  );

  const outcome = await executor.run({
    repoRoot,
    runLogDirectory,
    issueOrdinal: 5,
    context: issueContext(25),
  });

  expect(outcome.exitCode).toBe(1);
  expect(outcome.commitCount).toBe(1);
  expect(outcome.issueClosed).toBe(false);
  expect(outcome.summary).toContain("Reviewer finished with failures (exit code 9).");
  expect(closer.closedIssueNumbers).toEqual([]);
  expect(agentProvider.calls.map((call) => call.phase)).toEqual(["implementer", "reviewer"]);
});

function createExecutorScenario(name: string, handlers: IssuePhaseHandlers): ExecutorScenario {
  const sandbox = makeTempDir(name);
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
  });
  const runLogDirectory = path.join(repoRoot, "logs", "run-1");
  mkdirSync(runLogDirectory, { recursive: true });
  const runtime = createRuntime({ cwd: repoRoot });
  const closer = new RecordingIssueCloser();
  const agentProvider = new RecordingAgentProvider(handlers);
  const executor = new PrdIssueExecutor(runtime, agentProvider, closer);

  return {
    repoRoot,
    runLogDirectory,
    closer,
    agentProvider,
    executor,
  };
}

function issueContext(issueNumber: number): GitHubIssueRunContext {
  return {
    prd: {
      number: 22,
      title: "PRD issue-loop workflow",
      body: "Parent PRD context.",
      comments: [],
    },
    issue: {
      number: issueNumber,
      title: "Build single-issue PRD executor",
      body: "Run implementer and reviewer for this one issue.",
      comments: [],
    },
  };
}

function isIssuePhase(phase: AgentRunOptions["phase"]): phase is IssuePhase {
  return phase === "implementer" || phase === "reviewer";
}
