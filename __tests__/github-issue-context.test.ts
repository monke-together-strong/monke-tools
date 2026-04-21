import { expect, test } from "vitest";

import {
  createGitHubIssueContextLoader,
  loadGitHubIssueRunContext,
} from "../src/github-issue-context.ts";
import type { ExecOptions, ExecResult, Runtime } from "../src/types.ts";

test("GitHub issue context loader keeps only issue text fields from gh output", () => {
  const invocations: { command: string; args: string[] }[] = [];
  const runtime: Runtime = {
    cwd: "/repo",
    env: {},
    exec(command: string, args: string[] = [], _options?: ExecOptions): ExecResult {
      invocations.push({ command, args });
      return {
        stdout: JSON.stringify({
          number: 23,
          title: "Add issue context loader",
          body: "Implement the text loader.",
          labels: [{ name: "backend" }],
          assignees: [{ login: "octocat" }],
          comments: [
            {
              body: "Please include clarification comments.",
              author: { login: "maintainer" },
            },
          ],
        }),
        stderr: "",
        exitCode: 0,
      };
    },
    writeStdout() {},
    writeStderr() {},
  };

  const loader = createGitHubIssueContextLoader(runtime, { repo: "owner/repo" });

  const context = loader.loadIssue(23);

  expect(invocations).toEqual([
    {
      command: "gh",
      args: ["issue", "view", "23", "--repo", "owner/repo", "--json", "number,title,body,comments"],
    },
  ]);
  expect(context).toEqual({
    number: 23,
    title: "Add issue context loader",
    body: "Implement the text loader.",
    comments: [{ body: "Please include clarification comments." }],
  });
  expect(JSON.stringify(context)).not.toContain("backend");
  expect(JSON.stringify(context)).not.toContain("octocat");
  expect(JSON.stringify(context)).not.toContain("maintainer");
});

test("GitHub issue run context loads the PRD and current issue only", () => {
  const loadedIssueNumbers: string[] = [];
  const runtime: Runtime = {
    cwd: "/repo",
    env: {},
    exec(_command: string, args: string[] = [], _options?: ExecOptions): ExecResult {
      const issueNumber = args[2];
      loadedIssueNumbers.push(issueNumber ?? "");
      const issues: Record<string, unknown> = {
        "22": {
          number: 22,
          title: "PRD",
          body: "Parent context",
          comments: [],
        },
        "23": {
          number: 23,
          title: "Current issue",
          body: "Current issue context",
          comments: [],
        },
        "24": {
          number: 24,
          title: "Future issue should not load",
          body: "Future context",
          comments: [],
        },
      };

      return {
        stdout: JSON.stringify(issues[issueNumber ?? ""]),
        stderr: "",
        exitCode: 0,
      };
    },
    writeStdout() {},
    writeStderr() {},
  };

  const loader = createGitHubIssueContextLoader(runtime, { repo: "owner/repo" });

  const context = loadGitHubIssueRunContext(loader, {
    prdIssueNumber: 22,
    currentIssueNumber: 23,
  });

  expect(loadedIssueNumbers).toEqual(["22", "23"]);
  expect(context.prd.title).toBe("PRD");
  expect(context.issue.title).toBe("Current issue");
  expect(JSON.stringify(context)).not.toContain("Future issue should not load");
});
