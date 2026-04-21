import path from "node:path";
import { expect, test } from "vitest";

import { parseIssuePlannerResult, runIssuePlanner } from "../src/issue-planner.ts";
import { installFakeCodex, makeTempDir, read } from "./helpers.ts";

function readLoggedArgs(root: string, argsLogPath: string): string[] {
  return read(root, path.relative(root, argsLogPath)).trim().split("\n");
}

function getLoggedArgValue(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  if (index === -1 || args[index + 1] === undefined) {
    throw new Error(`Expected logged Codex args to include ${name} with a value`);
  }

  return args[index + 1]!;
}

test("issue planner accepts one PRD issue number and an ordered task issue list", () => {
  const result = parseIssuePlannerResult({
    prdIssueNumber: 22,
    taskIssueNumbers: [24, 25, 27],
  });

  expect(result).toEqual({
    prdIssueNumber: 22,
    taskIssueNumbers: [24, 25, 27],
  });
});

test("issue planner runs through codexJson with the PRD input and validates the result", async () => {
  const sandbox = makeTempDir("issue-planner-codex-json");
  const binDirectory = path.join(sandbox, "bin");
  const { argsLogPath, stdinLogPath, schemaLogPath } = installFakeCodex(binDirectory, {
    jsonOutput: JSON.stringify({
      prdIssueNumber: 22,
      taskIssueNumbers: [24, 25],
    }),
  });

  const result = await runIssuePlanner({
    codexPath: path.join(binDirectory, "codex"),
    cwd: sandbox,
    prdInput: "Use PRD https://github.com/monke-together-strong/monke-tools/issues/22",
    plannerInstructions: "Resolve one PRD and the executable task issues.",
    effort: "high",
  });

  expect(result).toEqual({
    prdIssueNumber: 22,
    taskIssueNumbers: [24, 25],
  });
  expect(read(sandbox, path.relative(sandbox, stdinLogPath))).toContain(
    "Resolve one PRD and the executable task issues.",
  );
  expect(read(sandbox, path.relative(sandbox, stdinLogPath))).toContain(
    "<<<MONKE_PRD_INPUT_START>>>\nUse PRD https://github.com/monke-together-strong/monke-tools/issues/22",
  );

  const args = readLoggedArgs(sandbox, argsLogPath);
  const schemaPath = getLoggedArgValue(args, "--output-schema");
  const outputPath = getLoggedArgValue(args, "--output-last-message");
  expect(args).toEqual([
    "exec",
    "--ephemeral",
    "-s",
    "read-only",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "--config",
    'model_reasoning_effort="high"',
    "-",
  ]);
  expect(JSON.parse(read(sandbox, path.relative(sandbox, schemaLogPath)))).toMatchObject({
    type: "object",
    properties: {
      prdIssueNumber: { type: "integer", exclusiveMinimum: 0 },
      taskIssueNumbers: {
        type: "array",
        items: { type: "integer", exclusiveMinimum: 0 },
      },
    },
  });
});

test("issue planner rejects an empty task issue list", () => {
  expect(() =>
    parseIssuePlannerResult({
      prdIssueNumber: 22,
      taskIssueNumbers: [],
    }),
  ).toThrow("Planner output must include at least one task issue number.");
});

test("issue planner rejects duplicate task issue numbers", () => {
  expect(() =>
    parseIssuePlannerResult({
      prdIssueNumber: 22,
      taskIssueNumbers: [24, 25, 24],
    }),
  ).toThrow("Planner output must not include duplicate task issue numbers: 24.");
});

test("issue planner rejects task lists that contain the PRD issue number", () => {
  expect(() =>
    parseIssuePlannerResult({
      prdIssueNumber: 22,
      taskIssueNumbers: [24, 22, 25],
    }),
  ).toThrow("Planner output must not include the PRD issue #22 as a task issue.");
});

test("issue planner rejects malformed planner output", () => {
  expect(() =>
    parseIssuePlannerResult({
      prdIssueNumber: "22",
      taskIssueNumbers: [24],
    }),
  ).toThrow("Planner output is malformed.");
});

test("issue planner rejects non-positive issue numbers", () => {
  expect(() =>
    parseIssuePlannerResult({
      prdIssueNumber: 0,
      taskIssueNumbers: [24],
    }),
  ).toThrow("Planner output issue numbers must be positive integers.");
});

test("issue planner rejects ambiguous PRD issue resolution", () => {
  expect(() =>
    parseIssuePlannerResult({
      prdIssueNumber: [22, 23],
      taskIssueNumbers: [24],
    }),
  ).toThrow("Planner output must resolve exactly one PRD issue number.");
});
