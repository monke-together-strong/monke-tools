import path from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { runCliAsync } from "../src/index.ts";
import { makeTempDir, write, writeExecutable } from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

type Endpoint = "jobs" | "runs" | "status";

// The exit codes `mt prs wait-for-gate --help` documents for each gate status.
const exitCodes = { failed: 1, passed: 0, skipped: 2, timed_out: 3 };

interface Expected {
  detail: string;
  status: keyof typeof exitCodes;
}

/**
 * Runs `mt prs wait-for-gate` against a fake `gh` that serves each endpoint's responses in order,
 * repeating the last one, on a virtual clock that advances only while the wait sleeps.
 */
async function waitForGate(
  args: string[],
  script: Partial<Record<Endpoint, unknown[]>>,
  timing = ["--interval", "15s", "--timeout", "10m"]
) {
  const bin = makeTempDir("wait-for-gate");

  for (const [endpoint, responses] of Object.entries(script)) {
    for (const [index, response] of responses.entries()) {
      write(bin, `${endpoint}.${index}.json`, JSON.stringify(response));
    }
  }

  writeExecutable(
    path.join(bin, "gh"),
    `#!/bin/sh
case "$2" in
  */jobs\\?*) key=jobs ;;
  */actions/runs\\?*) key=runs ;;
  *) key=status ;;
esac
dir=$(dirname "$0")
n=$(cat "$dir/$key.next" 2>/dev/null || echo 0)
[ -f "$dir/$key.$n.json" ] || { echo "unexpected gh $*" >&2; exit 1; }
cat "$dir/$key.$n.json"
[ ! -f "$dir/$key.$((n + 1)).json" ] || echo $((n + 1)) > "$dir/$key.next"
`
  );

  let now = 0;
  let stdout = "";
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);

  const sleep = vi.spyOn(Bun, "sleep").mockImplementation(async (ms) => {
    now += Number(ms);
  });

  try {
    await runCliAsync(
      ["prs", "wait-for-gate", ...timing, ...args],
      createTestRuntime({
        env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
        onStdout(text) {
          stdout += text;
        }
      })
    );

    return { exitCode: process.exitCode, now, stdout };
  } finally {
    clock.mockRestore();
    sleep.mockRestore();
    process.exitCode = undefined;
  }
}

function result({ detail, status }: Expected) {
  return { exitCode: exitCodes[status], stdout: `${status}: ${detail}\n` };
}

describe("mt prs wait-for-gate on a Railway commit status", () => {
  const context = "Monke Together Strong - true-ice-quant";
  const gate = ["--repo", "monke-together-strong/winters-echo", "--sha", "1062839"];

  const status = (state: string, description: string) => ({
    statuses: [{ context, description, state }]
  });

  it.each<{ expected: Expected; name: string; responses: unknown[] }>([
    {
      expected: {
        detail: `${context}: Success - true-ice-quant-demo.up.railway.app`,
        status: "passed"
      },
      name: "passes once the service deploys",
      responses: [
        { statuses: [] },
        status("pending", "Deploying"),
        status("success", "Success - true-ice-quant-demo.up.railway.app")
      ]
    },
    {
      expected: {
        detail: `${context}: No deployment needed - watched paths not modified`,
        status: "skipped"
      },
      name: "skips a service Railway did not deploy",
      responses: [status("success", "No deployment needed - watched paths not modified")]
    },
    {
      expected: { detail: `${context}: Deployment failed`, status: "failed" },
      name: "fails when the deploy fails",
      responses: [status("pending", "Deploying"), status("failure", "Deployment failed")]
    }
  ])("$name", async ({ expected, responses }) => {
    await expect(
      waitForGate([...gate, "--status", context], { status: responses })
    ).resolves.toMatchObject(result(expected));
  });
});

describe("mt prs wait-for-gate on a deploy job within a pipeline", () => {
  const url = "https://github.com/o/r/actions/runs/7";
  const gate = ["--repo", "o/r", "--sha", "abc123", "--workflow", "CI", "--job", "Deploy"];

  const run = (status: string, conclusion: string | null = null) => ({
    workflow_runs: [
      {
        conclusion,
        created_at: "2026-10-24T16:44:29Z",
        html_url: url,
        id: 7,
        name: "CI",
        path: ".github/workflows/ci.yml",
        status
      }
    ]
  });

  const jobs = (...entries: [name: string, status: string, conclusion: string | null][]) => ({
    jobs: entries.map(([name, status, conclusion]) => ({ conclusion, name, status }))
  });

  it.each<{ expected: Expected; jobs: unknown[]; name: string; runs: unknown[] }>([
    {
      expected: { detail: `Deploy succeeded: ${url}`, status: "passed" },
      jobs: [
        jobs(["Test", "in_progress", null]),
        jobs(
          ["Test", "completed", "success"],
          ["Deploy", "completed", "success"],
          ["Notify", "queued", null]
        )
      ],
      name: "passes when the deploy job succeeds, before the run completes",
      runs: [{ workflow_runs: [] }, run("in_progress")]
    },
    {
      expected: { detail: `Deploy skipped; upstream failed: Test: ${url}`, status: "failed" },
      jobs: [
        jobs(
          ["Test", "completed", "failure"],
          ["Deploy", "completed", "skipped"],
          ["Lint", "in_progress", null]
        )
      ],
      name: "fails as soon as an upstream failure skips the deploy job",
      runs: [run("in_progress")]
    },
    {
      expected: {
        detail: `Deploy never ran; CI concluded failure (failed: Test): ${url}`,
        status: "failed"
      },
      jobs: [jobs(["Test", "in_progress", null]), jobs(["Test", "completed", "failure"])],
      name: "fails when the run fails before the deploy job is reached",
      runs: [run("in_progress"), run("completed", "failure")]
    },
    {
      expected: { detail: `Deploy concluded failure: ${url}`, status: "failed" },
      jobs: [jobs(["Test", "completed", "success"], ["Deploy", "completed", "failure"])],
      name: "fails when the deploy job fails",
      runs: [run("in_progress")]
    },
    {
      expected: { detail: `Deploy skipped: ${url}`, status: "skipped" },
      jobs: [jobs(["Test", "completed", "success"], ["Deploy", "completed", "skipped"])],
      name: "skips when the deploy job's condition is false",
      runs: [run("completed", "success")]
    },
    {
      expected: { detail: `Deploy skipped; upstream failed: Test: ${url}`, status: "failed" },
      jobs: [
        jobs(["Test", "in_progress", null], ["Deploy", "completed", "skipped"]),
        jobs(["Test", "completed", "failure"], ["Deploy", "completed", "skipped"])
      ],
      name: "waits for the run before reporting a skipped deploy job",
      runs: [run("in_progress")]
    },
    {
      expected: { detail: `Deploy is not started: ${url}`, status: "timed_out" },
      jobs: [jobs(["Test", "in_progress", null])],
      name: "times out while the pipeline is still running",
      runs: [run("in_progress")]
    }
  ])("$name", async ({ expected, jobs: jobResponses, runs }) => {
    await expect(waitForGate(gate, { jobs: jobResponses, runs })).resolves.toMatchObject(
      result(expected)
    );
  });

  it("stops at the timeout when it is shorter than the interval", async () => {
    const waited = await waitForGate(
      gate,
      { jobs: [jobs(["Test", "in_progress", null])], runs: [run("in_progress")] },
      ["--interval", "5m", "--timeout", "1m"]
    );

    expect([waited.exitCode, waited.now]).toStrictEqual([exitCodes.timed_out, 60_000]);
  });
});
