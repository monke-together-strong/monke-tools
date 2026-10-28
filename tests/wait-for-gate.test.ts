import { describe, expect, it } from "vite-plus/test";

import { waitForGate } from "../skills/internal/post-merge/scripts/wait-for-gate.ts";
import type {
  Gate,
  GateResult,
  GhApi
} from "../skills/internal/post-merge/scripts/wait-for-gate.ts";

type Endpoint = "jobs" | "runs" | "status";

/** Serves each endpoint's responses in order, repeating the last one. */
function scriptedGh(script: Partial<Record<Endpoint, unknown[]>>): GhApi {
  return async (endpoint, schema) => {
    const key: Endpoint = endpoint.includes("/jobs?")
      ? "jobs"
      : endpoint.includes("/actions/runs?")
        ? "runs"
        : "status";

    const queue = script[key] ?? [];

    if (queue.length === 0) {
      throw new Error(`unexpected gh api ${endpoint}`);
    }

    return schema.parse(queue.length > 1 ? queue.shift() : queue[0]);
  };
}

function wait(gate: Gate, script: Partial<Record<Endpoint, unknown[]>>): Promise<GateResult> {
  let now = 0;

  return waitForGate(gate, {
    gh: scriptedGh(script),
    intervalMs: 15_000,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    timeoutMs: 10 * 60_000
  });
}

describe("waitForGate on a Railway commit status", () => {
  const context = "Monke Together Strong - true-ice-quant";

  const gate: Gate = {
    context,
    kind: "status",
    repo: "monke-together-strong/winters-echo",
    sha: "1062839"
  };

  const status = (state: string, description: string) => ({
    statuses: [{ context, description, state }]
  });

  it.each<{ expected: GateResult; name: string; responses: unknown[] }>([
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
    await expect(wait(gate, { status: responses })).resolves.toStrictEqual(expected);
  });
});

describe("waitForGate on a deploy job within a pipeline", () => {
  const url = "https://github.com/o/r/actions/runs/7";

  const gate: Gate = {
    job: "Deploy",
    kind: "workflow",
    repo: "o/r",
    sha: "abc123",
    workflow: "CI"
  };

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

  it.each<{ expected: GateResult; jobs: unknown[]; name: string; runs: unknown[] }>([
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
      expected: { detail: `Deploy is not started: ${url}`, status: "timed_out" },
      jobs: [jobs(["Test", "in_progress", null])],
      name: "times out while the pipeline is still running",
      runs: [run("in_progress")]
    }
  ])("$name", async ({ expected, jobs: jobResponses, runs }) => {
    await expect(wait(gate, { jobs: jobResponses, runs })).resolves.toStrictEqual(expected);
  });
});
