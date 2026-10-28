import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as z from "zod";

import { MonkeError } from "./errors.ts";
import { findExecutable, getHomeDirectory, getMonkeHome, withScopedLockAsync } from "./runtime.ts";
import type { Runtime } from "./types.ts";

const POLLER_LABEL = "com.monke-together-strong.mt-prs-poll";
const POLL_INTERVAL_SECONDS = 300;

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
  runtime.writeStdout(`Tracking ${record.url}\n`);
}

/** Stop tracking a PR, such as right before an agent merges it. */
export async function runPrsUntrack(runtime: Runtime, url: string) {
  const { url: canonicalUrl } = parsePullRequestUrl(url);
  let removed: TrackedPr | undefined;

  await updateTrackedPrs(runtime, (prs) => {
    removed = prs.find((tracked) => tracked.url === canonicalUrl);

    return prs.filter((tracked) => tracked.url !== canonicalUrl);
  });

  runtime.writeStdout(
    removed === undefined
      ? `Not tracked: ${canonicalUrl}\n`
      : `Untracked ${canonicalUrl} (thread ${removed.thread}, checkout ${removed.checkout})\n`
  );
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
  const tracked = readTrackedPrs(trackedPrsPath(runtime));

  if (tracked.length === 0) {
    return;
  }

  const t3 = resolveT3Cli(runtime);
  const results = await Promise.all(tracked.map(async (pr) => await pollPr(runtime, t3, pr)));
  const failures = results.filter((failure) => failure !== undefined);

  if (failures.length > 0) {
    throw new MonkeError(failures.join("\n"));
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

  // Recheck under the lock: an agent that merges a PR untracks it first, so a PR still
  // tracked after GitHub reports it merged was merged outside its thread.
  return await withTrackedPrsLock(runtime, async () => {
    const file = trackedPrsPath(runtime);
    const current = readTrackedPrs(file);

    // Hand off the record as it is now, since `track` may have replaced its thread or checkout.
    const record = current.find((candidate) => candidate.url === pr.url);

    const failure =
      record !== undefined && state === "MERGED"
        ? await handOffPostMerge(runtime, t3, record)
        : undefined;

    if (record !== undefined && failure === undefined) {
      writeTrackedPrs(
        file,
        current.filter((candidate) => candidate.url !== pr.url)
      );
    }

    return failure;
  });
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
    allowFailure: true
  });

  if (sent.exitCode === 0) {
    runtime.writeStdout(`Sent post-merge for ${pr.url} to thread ${pr.thread}\n`);

    return undefined;
  }

  // The thread may be gone; start one in the source checkout, which T3 knows as the project.
  const started = await runtime.execAsync(
    t3,
    ["thread", "start", "--title", `Verify #${pr.number}`, pr.sourceCheckout, message],
    { allowFailure: true }
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

/** Install a launchd agent that runs `mt prs poll` every five minutes. */
export function runPrsInstall(runtime: Runtime) {
  if (runtime.platform !== "darwin") {
    throw new MonkeError("mt prs install supports macOS launchd only");
  }

  const mt = findExecutable("mt", runtime.env);

  if (mt === null) {
    throw new MonkeError("mt was not found on PATH");
  }

  const plist = launchAgentPath(runtime);
  const log = path.join(getMonkeHome(runtime), "logs", "prs-poll.log");
  mkdirSync(path.dirname(plist), { recursive: true });
  mkdirSync(path.dirname(log), { recursive: true });

  writeFileSync(
    plist,
    launchAgentPlist({
      environment: {
        PATH: runtime.env.PATH ?? "",
        ...(runtime.env.MONKE_HOME === undefined ? {} : { MONKE_HOME: getMonkeHome(runtime) })
      },
      log,
      programArguments: [mt, "prs", "poll"]
    })
  );

  const domain = launchdDomain();
  runtime.exec("launchctl", ["bootout", `${domain}/${POLLER_LABEL}`], { allowFailure: true });
  runtime.exec("launchctl", ["bootstrap", domain, plist]);
  runtime.writeStdout(
    `Installed ${plist}; mt prs poll runs every ${POLL_INTERVAL_SECONDS / 60} minutes and logs to ${log}\n`
  );
}

export function runPrsUninstall(runtime: Runtime) {
  const plist = launchAgentPath(runtime);
  runtime.exec("launchctl", ["bootout", `${launchdDomain()}/${POLLER_LABEL}`], {
    allowFailure: true
  });
  rmSync(plist, { force: true });
  runtime.writeStdout(`Removed ${plist}\n`);
}

function launchAgentPath(runtime: Runtime) {
  return path.join(getHomeDirectory(runtime), "Library", "LaunchAgents", `${POLLER_LABEL}.plist`);
}

function launchdDomain() {
  return `gui/${process.getuid?.() ?? 0}`;
}

function launchAgentPlist(options: {
  environment: Record<string, string>;
  log: string;
  programArguments: string[];
}) {
  const strings = (values: string[]) =>
    values.map((value) => `    <string>${escapeXml(value)}</string>`).join("\n");

  const environment = Object.entries(options.environment)
    .map(
      ([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${POLLER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings(options.programArguments)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
  <key>StartInterval</key>
  <integer>${POLL_INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(options.log)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(options.log)}</string>
</dict>
</plist>
`;
}

function escapeXml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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
