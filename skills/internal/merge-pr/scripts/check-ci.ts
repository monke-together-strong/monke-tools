#!/usr/bin/env bun

import { Command } from "@commander-js/extra-typings";
import * as z from "zod";

const PullRequestSchema = z.object({
  headRefOid: z.string().regex(/^[\da-f]{40}$/u),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  statusCheckRollup: z
    .array(
      z.discriminatedUnion("__typename", [
        z.object({
          __typename: z.literal("CheckRun"),
          conclusion: z.string().nullable(),
          name: z.string(),
          status: z.string()
        }),
        z.object({
          __typename: z.literal("StatusContext"),
          context: z.string(),
          state: z.string()
        })
      ])
    )
    .nullable()
});

type PullRequest = z.infer<typeof PullRequestSchema>;

type Check = NonNullable<PullRequest["statusCheckRollup"]>[number];

type Outcome = "failed" | "passed" | "pending" | "skipped";

type CiStatus = "failed" | "no_checks" | "no_success" | "passed" | "pending";

export interface CiResult {
  checks: { name: string; outcome: Outcome; state: string }[];
  head: string;
  status: CiStatus;
}

function checkOutcome(check: Check): Outcome {
  if (check.__typename === "StatusContext") {
    if (check.state === "SUCCESS") {
      return "passed";
    }

    return ["EXPECTED", "PENDING"].includes(check.state) ? "pending" : "failed";
  }

  if (["IN_PROGRESS", "PENDING", "QUEUED", "REQUESTED", "WAITING"].includes(check.status)) {
    return "pending";
  }

  if (check.status !== "COMPLETED") {
    return "failed";
  }

  switch (check.conclusion ?? "") {
    case "SUCCESS": {
      return "passed";
    }

    case "NEUTRAL":
    case "SKIPPED": {
      return "skipped";
    }

    default: {
      return "failed";
    }
  }
}

/** Read the head and its rollup from one response so checks cannot belong to a previous head. */
export function inspectCi(json: string): CiResult {
  const pr = PullRequestSchema.parse(JSON.parse(json));

  if (pr.state !== "OPEN") {
    throw new Error(`PR is ${pr.state}; resolve its landing before attempting a merge.`);
  }

  const checks = (pr.statusCheckRollup ?? []).map((check) => ({
    name: check.__typename === "CheckRun" ? check.name : check.context,
    outcome: checkOutcome(check),
    state:
      check.__typename === "CheckRun" ? `${check.status}/${check.conclusion ?? ""}` : check.state
  }));

  let status: CiStatus = "no_success";

  if (checks.length === 0) {
    status = "no_checks";
  } else if (checks.some((check) => check.outcome === "failed")) {
    status = "failed";
  } else if (checks.some((check) => check.outcome === "pending")) {
    status = "pending";
  } else if (checks.some((check) => check.outcome === "passed")) {
    status = "passed";
  }

  return { checks, head: pr.headRefOid, status };
}

function createProgram() {
  return new Command()
    .name("check-ci")
    .description("Read current PR head CI. Print JSON; never merge or change PR tracking.")
    .requiredOption("--repo <owner/name>", "GitHub repository")
    .requiredOption("--pr <number>", "pull request number")
    .option("--waive-head <sha>", "full head SHA covered by explicit user approval")
    .option("--waiver <approval>", "user's CI waiver and its task or message reference")
    .addHelpText("after", "\nExit codes: 0 passed or waived, 1 CI blocked, 64 usage or read error.")
    .exitOverride((error) => process.exit(error.exitCode === 0 ? 0 : 64))
    .action((options) => {
      if ((options.waiveHead === undefined) !== (options.waiver === undefined)) {
        throw new Error("Supply both --waive-head and --waiver.");
      }

      if (options.waiver !== undefined && options.waiver.trim() === "") {
        throw new Error("--waiver must record the user's explicit approval.");
      }

      const read = Bun.spawnSync(
        [
          "gh",
          "pr",
          "view",
          options.pr,
          "--repo",
          options.repo,
          "--json",
          "state,headRefOid,statusCheckRollup"
        ],
        { stderr: "pipe", stdout: "pipe" }
      );

      if (read.exitCode !== 0) {
        throw new Error(`Cannot read PR head CI: ${read.stderr.toString().trim()}`);
      }

      const result = inspectCi(read.stdout.toString());

      if (options.waiveHead !== undefined && options.waiveHead !== result.head) {
        throw new Error(`Head changed to ${result.head}; the waiver covers ${options.waiveHead}.`);
      }

      const allowed = result.status === "passed" || options.waiver !== undefined;
      process.stdout.write(`${JSON.stringify({ ...result, allowed, waiver: options.waiver })}\n`);
      process.exitCode = allowed ? 0 : 1;
    });
}

if (import.meta.main) {
  try {
    createProgram().parse(process.argv);
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 64;
  }
}
