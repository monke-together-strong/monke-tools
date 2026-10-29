import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import * as z from "zod";

import { errorMessage, MonkeError, ThrownValueSchema } from "./errors.ts";
import { schedulePoll, unschedulePoll } from "./poll-scheduler.ts";
import { findExecutable, getHomeDirectory, getMonkeHome, withScopedLockAsync } from "./runtime.ts";
import { shellQuote } from "./shell-quote.ts";
import type { Runtime } from "./types.ts";

const T3_TIMEOUT_SECONDS = 60;

const PULL_REQUEST_URL =
  /^https:\/\/github\.com\/(?<owner>[^/\s]+)\/(?<name>[^/\s]+)\/pull\/(?<number>\d+)\/?$/u;

const TrackedPrSchema = z.strictObject({
  checkout: z.string().refine(path.isAbsolute),
  number: z.number().int().positive(),
  repo: z.string().min(1),
  sourceCheckout: z.string().refine(path.isAbsolute),
  thread: z.string().min(1),
  trackedAt: z.string(),
  url: z.string()
});

const TrackedPrsFileSchema = z.strictObject({
  prs: z.array(TrackedPrSchema),
  version: z.literal(1)
});

const PullRequestStateSchema = z.object({ state: z.enum(["CLOSED", "MERGED", "OPEN"]) });

type TrackedPr = z.infer<typeof TrackedPrSchema>;

/** Publish through gh, then persist tracking and schedule the post-merge poll before success. */
export async function runPrsCreate(
  runtime: Runtime,
  args: string[],
  options: { checkout: string; thread: string }
) {
  const checkout = gitOutput(runtime, path.resolve(runtime.cwd, options.checkout), [
    "rev-parse",
    "--show-toplevel"
  ]);

  const created = await runtime.execAsync("gh", ["pr", "create", ...args], { cwd: checkout });
  const { url } = parsePullRequestUrl(created.stdout.trim());

  try {
    await runPrsTrack(runtime, url, { ...options, checkout });
  } catch (cause) {
    throw new MonkeError(
      `Created ${url}, but post-merge tracking is incomplete: ${errorMessage(ThrownValueSchema.parse(cause))}\n` +
        `Register this existing PR with mt prs track ${url} --thread ${shellQuote(options.thread)} --checkout ${shellQuote(checkout)}`,
      { cause }
    );
  }
}

/** Track an open PR so `mt prs poll` can hand its post-merge work back to its thread. */
export async function runPrsTrack(
  runtime: Runtime,
  url: string,
  options: { checkout: string; thread: string }
) {
  const pullRequest = parsePullRequestUrl(url);
  const requestedCheckout = path.resolve(runtime.cwd, options.checkout);

  if (!existsSync(requestedCheckout)) {
    throw new MonkeError(`Checkout does not exist: ${requestedCheckout}`);
  }

  const checkout = gitOutput(runtime, requestedCheckout, ["rev-parse", "--show-toplevel"]);

  // Git lists the main worktree first; that is the folder T3 Code knows as the project.
  const worktrees = gitOutput(runtime, checkout, ["worktree", "list", "--porcelain"]);
  const sourceCheckout = /^worktree (?<path>.+)$/mu.exec(worktrees)?.groups?.path ?? checkout;

  const record: TrackedPr = {
    ...pullRequest,
    checkout,
    sourceCheckout,
    thread: options.thread,
    trackedAt: new Date().toISOString()
  };

  await updateTrackedPrs(runtime, (prs) => [
    ...prs.filter((tracked) => tracked.url !== record.url),
    record
  ]);
  schedulePoll(runtime);
  runtime.writeStdout(`Tracking ${record.url}\n`);
}

/** Stop tracking a PR, such as right before an agent merges it. */
export async function runPrsUntrack(runtime: Runtime, url: string) {
  const { url: canonicalUrl } = parsePullRequestUrl(url);
  let removed: TrackedPr | undefined;
  let remaining = 0;

  await updateTrackedPrs(runtime, (prs) => {
    removed = prs.find((tracked) => tracked.url === canonicalUrl);
    const kept = prs.filter((tracked) => tracked.url !== canonicalUrl);
    remaining = kept.length;

    return kept;
  });

  runtime.writeStdout(
    removed === undefined
      ? `Not tracked: ${canonicalUrl}\n`
      : `Untracked ${canonicalUrl} (thread ${removed.thread}, checkout ${removed.checkout})\n`
  );

  if (remaining === 0) {
    unschedulePoll(runtime);
  }
}

export function runPrsList(runtime: Runtime) {
  for (const tracked of readTrackedPrs(trackedPrsPath(runtime))) {
    runtime.writeStdout(`${tracked.url}\tthread ${tracked.thread}\tcheckout ${tracked.checkout}\n`);
  }
}

/**
 * Hand each externally merged PR to its thread, then drop handed-off and closed PRs. A PR whose
 * read or hand-off fails stays tracked for the next poll.
 */
export async function runPrsPoll(runtime: Runtime) {
  const file = trackedPrsPath(runtime);
  const tracked = readTrackedPrs(file);

  if (tracked.length > 0) {
    const t3 = resolveT3Cli(runtime);
    const results = await Promise.all(tracked.map(async (pr) => await pollPr(runtime, t3, pr)));
    const failures = results.filter((failure) => failure !== undefined);

    if (failures.length > 0) {
      throw new MonkeError(failures.join("\n"));
    }
  }

  // Last step: a launchd poll that unschedules itself is stopped by launchd.
  if (readTrackedPrs(file).length === 0) {
    unschedulePoll(runtime);
  }
}

async function pollPr(runtime: Runtime, t3: string, pr: TrackedPr): Promise<string | undefined> {
  const view = await runtime.execAsync("gh", ["pr", "view", pr.url, "--json", "state"], {
    allowFailure: true
  });

  if (view.exitCode !== 0) {
    return `Could not read ${pr.url}: ${view.stderr.trim()}`;
  }

  const { state } = PullRequestStateSchema.parse(JSON.parse(view.stdout));

  if (state === "OPEN") {
    return undefined;
  }

  // An agent that merges a PR untracks it first, so a PR still tracked after GitHub reports it
  // merged was merged outside its thread. Claim it by removing the record under the lock; a
  // record that `track` replaced since the GitHub read waits for the next poll.
  const claimed = await withTrackedPrsLock(runtime, () => {
    const file = trackedPrsPath(runtime);
    const current = readTrackedPrs(file);
    const unchanged = current.some((candidate) => isDeepStrictEqual(candidate, pr));

    if (unchanged) {
      writeTrackedPrs(
        file,
        current.filter((candidate) => candidate.url !== pr.url)
      );
    }

    return unchanged;
  });

  if (!claimed || state === "CLOSED") {
    return undefined;
  }

  // Hand off outside the lock, since T3 can be slow, and restore the claim if the hand-off fails.
  const failure = await handOffPostMerge(runtime, t3, pr);

  if (failure !== undefined) {
    await updateTrackedPrs(runtime, (prs) =>
      prs.some((candidate) => candidate.url === pr.url) ? prs : [...prs, pr]
    );
  }

  return failure;
}

async function handOffPostMerge(
  runtime: Runtime,
  t3: string,
  pr: TrackedPr
): Promise<string | undefined> {
  // Post-merge is manual-only, so the message points at its installed SKILL.md.
  const skill = path.join(
    getMonkeHome(runtime),
    "skill-registry",
    "skills",
    "internal",
    "post-merge",
    "SKILL.md"
  );

  if (!existsSync(skill)) {
    return `Could not hand off ${pr.url}: post-merge is not installed at ${skill}`;
  }

  const message = `${pr.url} was merged outside this thread. Follow ${skill} for it. Its checkout was ${pr.checkout}.`;

  const sent = await runtime.execAsync(t3, ["thread", "send", pr.thread, message], {
    allowFailure: true,
    timeoutSeconds: T3_TIMEOUT_SECONDS
  });

  if (sent.exitCode === 0) {
    runtime.writeStdout(`Sent post-merge for ${pr.url} to thread ${pr.thread}\n`);

    return undefined;
  }

  // The thread may be gone; start one in the source checkout, which T3 knows as the project.
  const started = await runtime.execAsync(
    t3,
    ["thread", "start", "--title", `Verify #${pr.number}`, pr.sourceCheckout, message],
    { allowFailure: true, timeoutSeconds: T3_TIMEOUT_SECONDS }
  );

  if (started.exitCode === 0) {
    runtime.writeStdout(`Started a thread for post-merge of ${pr.url}\n`);

    return undefined;
  }

  return `Could not hand off ${pr.url}: ${sent.stderr.trim()} ${started.stderr.trim()}`.trim();
}

function resolveT3Cli(runtime: Runtime) {
  const fallback = path.join(getHomeDirectory(runtime), ".t3", "bin", "t3");
  const t3 = findExecutable("t3", runtime.env) ?? (existsSync(fallback) ? fallback : null);

  if (t3 === null) {
    throw new MonkeError(`T3 Code CLI not found on PATH or at ${fallback}`);
  }

  return t3;
}

function parsePullRequestUrl(url: string) {
  const match = PULL_REQUEST_URL.exec(url);
  const { name, number, owner } = match?.groups ?? {};

  if (name === undefined || number === undefined || owner === undefined) {
    throw new MonkeError(`Expected a GitHub pull request URL, got ${url}`);
  }

  return {
    number: Number(number),
    repo: `${owner}/${name}`,
    url: `https://github.com/${owner}/${name}/pull/${number}`
  };
}

function gitOutput(runtime: Runtime, cwd: string, args: string[]) {
  return runtime.exec("git", args, { cwd }).stdout.trim();
}

function trackedPrsPath(runtime: Runtime) {
  return path.join(getMonkeHome(runtime), "tracked-prs.json");
}

function readTrackedPrs(file: string): TrackedPr[] {
  if (!existsSync(file)) {
    return [];
  }

  return TrackedPrsFileSchema.parse(JSON.parse(readFileSync(file, "utf-8"))).prs;
}

function writeTrackedPrs(file: string, prs: TrackedPr[]) {
  const temporary = `${file}.${process.pid}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true });

  try {
    writeFileSync(temporary, JSON.stringify(TrackedPrsFileSchema.parse({ prs, version: 1 })), {
      mode: 0o600
    });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function withTrackedPrsLock<T>(runtime: Runtime, callback: () => T | Promise<T>) {
  return await withScopedLockAsync(getMonkeHome(runtime), "tracked-prs", callback);
}

async function updateTrackedPrs(runtime: Runtime, update: (prs: TrackedPr[]) => TrackedPr[]) {
  await withTrackedPrsLock(runtime, () => {
    const file = trackedPrsPath(runtime);
    writeTrackedPrs(file, update(readTrackedPrs(file)));
  });
}
