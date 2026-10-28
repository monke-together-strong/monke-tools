#!/usr/bin/env bun

import path from "node:path";

import { Command, InvalidArgumentError, Option } from "@commander-js/extra-typings";
import * as z from "zod";

export type GateStatus = "passed" | "failed" | "skipped" | "timed_out";

export interface GateResult {
  readonly detail: string;
  readonly status: GateStatus;
}

type PollResult = GateResult | { readonly detail: string; readonly status: "pending" };

export type Gate =
  | {
      readonly job?: string;
      readonly kind: "workflow";
      readonly repo: string;
      readonly sha: string;
      readonly workflow: string;
    }
  | {
      readonly context: string;
      readonly kind: "status";
      readonly repo: string;
      readonly sha: string;
    };

/** Reads one GitHub REST endpoint and parses its JSON body. */
export type GhApi = <T>(endpoint: string, schema: z.ZodType<T>) => Promise<T>;

export interface WaitOptions {
  readonly gh: GhApi;
  readonly intervalMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timeoutMs: number;
}

/** A failed `gh` call; the wait retries it once the gate has been read successfully. */
class GhError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhError";
  }
}

const EXIT_CODES: Record<GateStatus, number> = { failed: 1, passed: 0, skipped: 2, timed_out: 3 };
const USAGE_EXIT_CODE = 64;
const FAILED_CONCLUSIONS = new Set(["cancelled", "failure", "startup_failure", "timed_out"]);

const DURATION_UNIT_MS = new Map([
  ["h", 3_600_000],
  ["m", 60_000],
  ["s", 1000]
]);

const RunsSchema = z.object({
  workflow_runs: z.array(
    z.object({
      conclusion: z.string().nullable(),
      created_at: z.string(),
      html_url: z.string(),
      id: z.number(),
      name: z.string(),
      path: z.string(),
      status: z.string()
    })
  )
});

const JobsSchema = z.object({
  jobs: z.array(
    z.object({ conclusion: z.string().nullable(), name: z.string(), status: z.string() })
  )
});

const StatusSchema = z.object({
  statuses: z.array(
    z.object({ context: z.string(), description: z.string().nullable(), state: z.string() })
  )
});

export async function waitForGate(gate: Gate, options: WaitOptions): Promise<GateResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  const deadline = now() + options.timeoutMs;
  let reachable = false;

  for (;;) {
    let result: PollResult;

    try {
      // oxlint-disable-next-line no-await-in-loop -- Each check follows the previous one.
      result = await pollGate(gate, options.gh);
      reachable = true;
    } catch (cause) {
      // A bad repo or missing auth fails on the first read; later errors are transient.
      if (!(cause instanceof GhError) || !reachable) {
        throw cause;
      }

      result = { detail: cause.message, status: "pending" };
    }

    if (result.status !== "pending") {
      return result;
    }

    if (now() >= deadline) {
      return { detail: result.detail, status: "timed_out" };
    }

    // oxlint-disable-next-line no-await-in-loop -- The interval separates checks.
    await sleep(options.intervalMs);
  }
}

function pollGate(gate: Gate, gh: GhApi): Promise<PollResult> {
  return gate.kind === "workflow" ? pollWorkflow(gate, gh) : pollStatus(gate, gh);
}

async function pollWorkflow(
  gate: Extract<Gate, { kind: "workflow" }>,
  gh: GhApi
): Promise<PollResult> {
  const { workflow_runs: runs } = await gh(
    `repos/${gate.repo}/actions/runs?head_sha=${gate.sha}&per_page=100`,
    RunsSchema
  );

  const [run] = runs
    .filter(
      (candidate) =>
        candidate.name === gate.workflow || path.basename(candidate.path) === gate.workflow
    )
    .toSorted((left, right) => right.created_at.localeCompare(left.created_at));

  if (run === undefined) {
    return { detail: `no ${gate.workflow} run for ${gate.sha} yet`, status: "pending" };
  }

  const { jobs } = await gh(
    `repos/${gate.repo}/actions/runs/${run.id}/jobs?per_page=100`,
    JobsSchema
  );

  const failedJobs = jobs
    .filter((job) => FAILED_CONCLUSIONS.has(job.conclusion ?? ""))
    .map((job) => job.name);

  if (gate.job === undefined) {
    return run.status === "completed"
      ? conclude(gate.workflow, run.conclusion, failedJobs, run.html_url)
      : { detail: `${gate.workflow} is ${run.status}: ${run.html_url}`, status: "pending" };
  }

  const job = jobs.find((candidate) => candidate.name === gate.job);

  const otherFailedJobs = failedJobs.filter((name) => name !== gate.job);

  // A skip is only final once the run ends, since a later failure turns it into an upstream failure.
  const skipSettled =
    job?.conclusion !== "skipped" || otherFailedJobs.length > 0 || run.status === "completed";

  if (job?.status === "completed" && skipSettled) {
    return conclude(job.name, job.conclusion, otherFailedJobs, run.html_url);
  }

  if (run.status === "completed") {
    return {
      detail: `${gate.job} never ran; ${gate.workflow} concluded ${run.conclusion}${failedSuffix(failedJobs)}: ${run.html_url}`,
      status: "failed"
    };
  }

  return {
    detail:
      job?.conclusion === "skipped"
        ? `${gate.job} skipped; waiting for ${gate.workflow} to finish: ${run.html_url}`
        : `${gate.job} is ${job?.status ?? "not started"}: ${run.html_url}`,
    status: "pending"
  };
}

/**
 * A skipped job counts as failed when another job failed, since `needs` skips dependents of a
 * failure.
 */
function conclude(
  label: string,
  conclusion: string | null,
  failedJobs: readonly string[],
  url: string
): GateResult {
  if (conclusion === "success") {
    return { detail: `${label} succeeded: ${url}`, status: "passed" };
  }

  if (conclusion === "skipped") {
    return failedJobs.length > 0
      ? {
          detail: `${label} skipped; upstream failed: ${failedJobs.join(", ")}: ${url}`,
          status: "failed"
        }
      : { detail: `${label} skipped: ${url}`, status: "skipped" };
  }

  return {
    detail: `${label} concluded ${conclusion}${failedSuffix(failedJobs)}: ${url}`,
    status: "failed"
  };
}

function failedSuffix(failedJobs: readonly string[]): string {
  return failedJobs.length > 0 ? ` (failed: ${failedJobs.join(", ")})` : "";
}

async function pollStatus(gate: Extract<Gate, { kind: "status" }>, gh: GhApi): Promise<PollResult> {
  const { statuses } = await gh(
    `repos/${gate.repo}/commits/${gate.sha}/status?per_page=100`,
    StatusSchema
  );

  const status = statuses.find((candidate) => candidate.context === gate.context);

  if (status === undefined) {
    return { detail: `no ${gate.context} status on ${gate.sha} yet`, status: "pending" };
  }

  const detail = `${gate.context}: ${status.description ?? status.state}`;

  switch (status.state) {
    case "pending": {
      return { detail, status: "pending" };
    }

    case "success": {
      // Railway reports services whose watched paths did not change this way.
      const deployed = !/no deployment needed/iu.test(status.description ?? "");

      return { detail, status: deployed ? "passed" : "skipped" };
    }

    default: {
      return { detail, status: "failed" };
    }
  }
}

const ghApi: GhApi = async (endpoint, schema) => {
  const child = Bun.spawn(["gh", "api", endpoint], { stderr: "pipe", stdout: "pipe" });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);

  if (exitCode !== 0) {
    throw new GhError(`gh api ${endpoint} failed: ${stderr.trim()}`);
  }

  return schema.parse(JSON.parse(stdout));
};

function parseDuration(value: string): number {
  const match = /^(?<amount>\d+)(?<unit>[hms])$/u.exec(value);
  const unitMs = DURATION_UNIT_MS.get(match?.groups?.unit ?? "");

  if (match?.groups?.amount === undefined || unitMs === undefined) {
    throw new InvalidArgumentError("use a duration such as 30s, 15m, or 1h.");
  }

  return Number(match.groups.amount) * unitMs;
}

function resolveGate(options: {
  job?: string;
  repo: string;
  sha: string;
  status?: string;
  workflow?: string;
}): Gate {
  const { job, repo, sha, status, workflow } = options;

  if (workflow !== undefined) {
    return { kind: "workflow", repo, sha, workflow, ...(job === undefined ? {} : { job }) };
  }

  if (job !== undefined) {
    throw new InvalidArgumentError("--job requires --workflow.");
  }

  if (status === undefined) {
    throw new InvalidArgumentError("pass --workflow or --status.");
  }

  return { context: status, kind: "status", repo, sha };
}

function createProgram() {
  return new Command()
    .name("wait-for-gate")
    .description(
      "Wait for a merge commit's GitHub deployment gate, then print `<status>: <detail>`."
    )
    .requiredOption("--repo <owner/name>", "GitHub repository")
    .requiredOption("--sha <sha>", "merge commit SHA")
    .addOption(new Option("--workflow <name>", "workflow name or file").conflicts("status"))
    .option("--job <name>", "job within --workflow that is the gate")
    .addOption(new Option("--status <context>", "commit status context").conflicts("workflow"))
    .addOption(
      new Option("--timeout <duration>", "give up after this long")
        .argParser(parseDuration)
        .default(2 * 3_600_000, "2h")
    )
    .addOption(
      new Option("--interval <duration>", "time between checks")
        .argParser(parseDuration)
        .default(5 * 60_000, "5m")
    )
    .addHelpText(
      "after",
      "\nExit codes: 0 passed, 1 failed, 2 skipped, 3 timed_out, 64 usage or GitHub read error."
    )
    .exitOverride((error) => process.exit(error.exitCode === 0 ? 0 : USAGE_EXIT_CODE))
    .action(async (options) => {
      const result = await waitForGate(resolveGate(options), {
        gh: ghApi,
        intervalMs: options.interval,
        timeoutMs: options.timeout
      });

      process.stdout.write(`${result.status}: ${result.detail}\n`);
      process.exitCode = EXIT_CODES[result.status];
    });
}

if (import.meta.main) {
  try {
    await createProgram().parseAsync(process.argv);
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exit(USAGE_EXIT_CODE);
  }
}
