import { z } from "zod";

import { isHttpUrl, isReviewUrl } from "./comparison-plan.ts";
import type { ComparisonPlan } from "./comparison-plan.ts";
import { MonkeError } from "./errors.ts";
import { findExecutable } from "./runtime.ts";
import type { Runtime } from "./types.ts";

const ReviewUrlSchema = z.string().refine(isHttpUrl);
const ReviewResponseSchema = z.object({
  command: z.literal("review.create"),
  data: z.object({ url: ReviewUrlSchema }),
  ok: z.literal(true),
  version: z.literal(1)
});
const ReviewFailureSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    hint: z.string().optional(),
    message: z.string().min(1)
  }),
  ok: z.literal(false),
  version: z.literal(1)
});

export function resolveLfv(runtime: Runtime) {
  const executable = findExecutable("lfv", runtime.env);
  if (executable === null) {
    throw new MonkeError(
      "LFV is unavailable. Install and configure lfv review before retrying mt diff --adapter lfv."
    );
  }
  return executable;
}

export async function launchLfv(runtime: Runtime, executable: string, plan: ComparisonPlan) {
  const sourceArgs = await resolveSourceArgs(runtime, plan);
  const result = await runtime.execAsync(
    executable,
    ["--json", "review", "create", plan.worktreePath, ...sourceArgs],
    {
      allowFailure: true,
      cwd: plan.worktreePath
    }
  );
  runtime.writeStderr(result.stderr);
  let response: unknown;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new MonkeError("LFV review create returned invalid JSON; no review URL was returned.");
  }
  const failure = ReviewFailureSchema.safeParse(response);
  if (failure.success) {
    const { code, hint, message } = failure.data.error;
    throw new MonkeError(`LFV review create failed: ${code}: ${message}${hint ? `\n${hint}` : ""}`);
  }
  const parsed = ReviewResponseSchema.safeParse(response);
  if (result.exitCode !== 0 || !parsed.success) {
    throw new MonkeError(
      "LFV review create failed or returned an invalid response; no review URL was returned."
    );
  }
  runtime.writeStdout(`${parsed.data.data.url}\n`);
}

async function resolveSourceArgs(runtime: Runtime, plan: ComparisonPlan) {
  switch (plan.kind) {
    case "working-tree": {
      return ["--source", "working-tree"];
    }
    case "branch-working-tree": {
      return ["--source", "branch-working-tree", "--ref", plan.baseRef];
    }
    case "commit": {
      return ["--source", "commit", "--ref", plan.ref];
    }
    case "range": {
      return [
        "--source",
        "range",
        "--base",
        plan.base,
        "--head",
        plan.head,
        plan.symmetric ? "--merge-base" : "--direct"
      ];
    }
    case "pull-request": {
      return await resolveProviderArgs(runtime, plan);
    }
    default: {
      throw new MonkeError("Unsupported LFV comparison source.");
    }
  }
}

async function resolveProviderArgs(
  runtime: Runtime,
  plan: Extract<ComparisonPlan, { kind: "pull-request" }>
) {
  const [target = "", value] = plan.target;
  if (isReviewUrl(target)) {
    return ["--source", "pull-request", "--url", target];
  }
  const gitlab = target === "mr";
  const command = gitlab ? "glab" : "gh";
  const executable = findExecutable(command, runtime.env);
  if (executable === null) {
    throw new MonkeError(
      `${command} is required to resolve this Diff review; provide a full PR/MR URL or install and authenticate ${command}.`
    );
  }
  const selector = (value ?? target).replace(/^#/u, "");
  const result = await runtime.execAsync(
    executable,
    gitlab
      ? ["mr", "view", selector, "--output", "json"]
      : ["pr", "view", selector, "--json", "url"],
    {
      allowFailure: true,
      cwd: plan.worktreePath
    }
  );
  runtime.writeStderr(result.stderr);
  let response: unknown;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new MonkeError(`${command} could not resolve the Diff review URL.`);
  }
  const urlSchema = z.string().refine(isReviewUrl);
  const parsed = (
    gitlab
      ? z.object({ web_url: urlSchema }).transform((data) => data.web_url)
      : z.object({ url: urlSchema }).transform((data) => data.url)
  ).safeParse(response);
  if (result.exitCode !== 0 || !parsed.success) {
    throw new MonkeError(`${command} could not resolve the Diff review URL.`);
  }
  return [
    "--source",
    "pull-request",
    "--url",
    parsed.data,
    "--provider",
    gitlab ? "gitlab" : "github"
  ];
}
