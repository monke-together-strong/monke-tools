import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { inspectCi } from "../skills/internal/merge-pr/scripts/check-ci.ts";

const head = "a".repeat(40);

const checkRun = (conclusion: string | null, status = "COMPLETED") => ({
  __typename: "CheckRun",
  conclusion,
  name: "Acceptance journeys",
  status
});

const context = (state: string) => ({ __typename: "StatusContext", context: "external CI", state });

const snapshot = (checks: unknown[], sha = head) =>
  JSON.stringify({
    headRefOid: sha,
    state: "OPEN",
    statusCheckRollup: checks
  });

describe("PR head CI", () => {
  it.each([
    { checks: [], expected: "no_checks", name: "no reported checks" },
    { checks: [checkRun(null, "IN_PROGRESS")], expected: "pending", name: "running acceptance" },
    { checks: [checkRun(null, "QUEUED")], expected: "pending", name: "queued CI" },
    { checks: [context("PENDING")], expected: "pending", name: "pending external status" },
    { checks: [context("EXPECTED")], expected: "pending", name: "expected external status" },
    { checks: [checkRun("FAILURE")], expected: "failed", name: "failed CI" },
    { checks: [checkRun("CANCELLED")], expected: "failed", name: "cancelled acceptance" },
    { checks: [context("ERROR")], expected: "failed", name: "external status error" },
    { checks: [checkRun("SUCCESS")], expected: "passed", name: "successful CI" },
    { checks: [context("SUCCESS")], expected: "passed", name: "successful external status" },
    { checks: [checkRun("SKIPPED")], expected: "no_success", name: "only skipped CI" },
    { checks: [checkRun("NEUTRAL")], expected: "no_success", name: "only neutral CI" },
    {
      checks: [checkRun("SUCCESS"), checkRun("SKIPPED")],
      expected: "passed",
      name: "success with a conditional skipped job"
    },
    {
      checks: [checkRun("SUCCESS"), checkRun(null, "IN_PROGRESS")],
      expected: "pending",
      name: "one success does not hide a running check"
    },
    {
      checks: [checkRun("FAILURE"), checkRun(null, "IN_PROGRESS")],
      expected: "failed",
      name: "a failure remains visible while another check runs"
    }
  ])("$name", ({ checks, expected }) => {
    expect(inspectCi(snapshot(checks))).toMatchObject({ head, status: expected });
  });

  it("rejects unreadable check data instead of treating it as no checks", () => {
    expect(() => inspectCi(JSON.stringify({ headRefOid: head, state: "OPEN" }))).toThrow(
      "statusCheckRollup"
    );
  });
});

function runCli(response: string, args: string[] = [], readError = false) {
  const directory = mkdtempSync(path.join(tmpdir(), "merge-ci-"));
  const gh = path.join(directory, "gh");

  try {
    writeFileSync(path.join(directory, "response.json"), response);
    writeFileSync(
      gh,
      `#!${process.execPath}
if (${readError}) { process.stderr.write("fixture API failure"); process.exit(1); }
process.stdout.write(await Bun.file(${JSON.stringify(path.join(directory, "response.json"))}).text());
`
    );
    chmodSync(gh, 0o755);

    const result = Bun.spawnSync(
      [
        process.execPath,
        path.resolve(import.meta.dirname, "../skills/internal/merge-pr/scripts/check-ci.ts"),
        "--repo",
        "fixture/repo",
        "--pr",
        "45",
        ...args
      ],
      { env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}` } }
    );

    return {
      exitCode: result.exitCode,
      stderr: result.stderr.toString(),
      stdout: result.stdout.toString()
    };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe.each([
  { args: [], name: "immediate merge", requirePassing: false },
  { args: ["--require-passing"], name: "conditional merge", requirePassing: true }
])("check-ci command for $name", ({ args, requirePassing }) => {
  it.each([
    { checks: [], status: "no_checks" },
    { checks: [checkRun(null, "IN_PROGRESS")], status: "pending" },
    { checks: [checkRun("FAILURE")], status: "failed" },
    { checks: [checkRun("SKIPPED")], status: "no_success" }
  ])("reports $status and enforces the selected timing", ({ checks, status }) => {
    const result = runCli(snapshot(checks), args);
    expect(result.exitCode).toBe(requirePassing ? 1 : 0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      allowed: !requirePassing,
      head,
      requirePassing,
      status
    });
  });

  it("returns the checked head on success", () => {
    const result = runCli(snapshot([checkRun("SUCCESS")]), args);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      allowed: true,
      head,
      requirePassing,
      status: "passed"
    });
  });

  it("rejects an API read error", () => {
    const result = runCli("{}", args, true);
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain("fixture API failure");
  });

  it.each([
    { name: "malformed response", response: "not JSON" },
    { name: "missing check data", response: JSON.stringify({ headRefOid: head, state: "OPEN" }) },
    {
      name: "already merged PR",
      response: JSON.stringify({ headRefOid: head, state: "MERGED", statusCheckRollup: [] })
    }
  ])("rejects $name", ({ response }) => {
    const result = runCli(response, args);
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toBe("");
  });
});
