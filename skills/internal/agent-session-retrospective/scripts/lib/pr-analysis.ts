import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isNonEmptyString } from "@sindresorhus/is";
import {
  array,
  boolean,
  enum as enumSchema,
  literal,
  number as numberSchema,
  object,
  strictObject,
  string,
} from "zod";
import type { output, ZodType } from "zod";

import { hashKey } from "./identity.ts";
import { RetrospectiveWindowSchema } from "./schemas.ts";
import {
  prAnalysisPath,
  readRunWindow,
  retroHome,
  runDir,
} from "./store.ts";
import type { RetrospectiveWindow } from "./types.ts";

export interface CommandResult {
  error?: string;
  status: number | null;
  stderr: string;
  stdout: string;
}

export type CommandRunner = (command: string, args: string[], options?: { cwd?: string }) => CommandResult;

export interface PrAnalysisGap {
  impact: string;
  number?: number;
  reason: string;
  repo: string;
}

export interface PrCommitReference {
  committedDate?: string;
  message: string;
  sha: string;
}

export interface PrWorkItemSummary {
  analysisPath: string;
  commitShas: string[];
  createdAt: string;
  finalHeadSha?: string;
  mergeCommitSha?: string;
  mergedAt: string;
  number: number;
  openingSnapshot: {
    confidence: "exact" | "inferred" | "unknown";
    reason: string;
    ref?: string;
  };
  repo: string;
  title: string;
  url: string;
  workItemPath: string;
}

export interface PrAnalysisManifest {
  author: string;
  gaps: PrAnalysisGap[];
  generatedAt: string;
  org: string;
  runTs: string;
  version: 1;
  window: RetrospectiveWindow;
  workItems: PrWorkItemSummary[];
}

export interface PrWorkItem extends PrWorkItemSummary {
  baseBranch?: string;
  changedFiles: string[];
  commitMessages: PrCommitReference[];
  headBranch?: string;
  postOpeningDelta: {
    body: string;
    confidence: "primary" | "lower" | "none";
    note?: string;
    source: "local-git" | "github-pr-diff-fallback" | "unavailable";
  };
  runTs: string;
  version: 1;
}

export interface RunPrCollectOptions {
  exec?: CommandRunner;
  home?: string;
  nowIso?: string;
  repoCacheRoot?: string;
  retroRoot?: string;
  runTs: string;
}

export interface RunPrAggregateOptions {
  home?: string;
  retroRoot?: string;
  runTs: string;
}

const GhRepoSchema = object({
  isArchived: boolean().optional(),
  nameWithOwner: string(),
});
const GhCommitSchema = object({
  committedDate: string().optional(),
  message: string().optional(),
  messageBody: string().optional(),
  messageHeadline: string().optional(),
  oid: string().optional(),
  sha: string().optional(),
});
const GhFileSchema = object({
  filename: string().optional(),
  path: string().optional(),
});
const GhMergeCommitSchema = object({
  oid: string().optional(),
  sha: string().optional(),
});
const GhPrSchema = object({
  baseRefName: string().optional(),
  commits: array(GhCommitSchema).optional(),
  createdAt: string(),
  createdHeadRefOid: string().optional(),
  creationHeadRefOid: string().optional(),
  files: array(GhFileSchema).optional(),
  headRefName: string().optional(),
  headRefOid: string().optional(),
  mergeCommit: GhMergeCommitSchema.nullish(),
  mergedAt: string(),
  number: numberSchema(),
  openingSnapshotOid: string().optional(),
  openingSnapshotRef: string().optional(),
  title: string(),
  url: string(),
});
const GhRepoListSchema = array(GhRepoSchema);
const GhPrListSchema = array(GhPrSchema);
const GhPrFilesResponseSchema = object({
  files: array(GhFileSchema),
});
type GhCommit = output<typeof GhCommitSchema>;
type GhFile = output<typeof GhFileSchema>;
type GhMergeCommit = output<typeof GhMergeCommitSchema>;
type GhPr = output<typeof GhPrSchema>;
type GhRepo = output<typeof GhRepoSchema>;

const PrAnalysisManifestSchema: ZodType<PrAnalysisManifest> = strictObject({
  author: string(),
  gaps: array(
    strictObject({
      impact: string(),
      number: numberSchema().optional(),
      reason: string(),
      repo: string(),
    }),
  ),
  generatedAt: string(),
  org: string(),
  runTs: string(),
  version: literal(1),
  window: RetrospectiveWindowSchema,
  workItems: array(
    strictObject({
      analysisPath: string(),
      commitShas: array(string()),
      createdAt: string(),
      finalHeadSha: string().optional(),
      mergeCommitSha: string().optional(),
      mergedAt: string(),
      number: numberSchema(),
      openingSnapshot: strictObject({
        confidence: enumSchema(["exact", "inferred", "unknown"]),
        reason: string(),
        ref: string().optional(),
      }),
      repo: string(),
      title: string(),
      url: string(),
      workItemPath: string(),
    }),
  ),
});

const DEFAULT_ORG = "monke-together-strong";
const PR_LIST_LIMIT = 100;
const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;
const PR_LIST_FIELDS = ["number", "url", "title", "createdAt", "mergedAt"].join(",");
const PR_DETAIL_FIELDS = [
  "number",
  "url",
  "title",
  "createdAt",
  "mergedAt",
  "baseRefName",
  "headRefName",
  "headRefOid",
  "mergeCommit",
  "commits",
].join(",");

export function runPrCollect(options: RunPrCollectOptions) {
  const root = options.retroRoot ?? retroHome(options.home);
  const window = readRunWindow(root, options.runTs);
  if (!window) {
    throw new Error(`PR collect requires runs/${options.runTs}/window.json`);
  }

  const exec = options.exec ?? defaultRunner;
  const org = DEFAULT_ORG;
  const author = runText(exec, "gh", ["api", "user", "--jq", ".login"]).trim();
  const generatedAt = options.nowIso ?? new Date().toISOString();
  const gaps: PrAnalysisGap[] = [];
  const workItems: PrWorkItemSummary[] = [];

  let repos: GhRepo[] = [];
  try {
    repos = parseJson(
      runText(exec, "gh", [
        "repo",
        "list",
        org,
        "--limit",
        "1000",
        "--json",
        "nameWithOwner,isArchived,isPrivate",
      ]),
      GhRepoListSchema,
    );
  } catch (error) {
    gaps.push({
      impact: "No PR trajectory evidence could be collected for the organization.",
      reason: `repository enumeration failed: ${errorMessage(error)}`,
      repo: `${org}/*`,
    });
  }

  for (const repo of repos) {
    if (!isNonEmptyString(repo.nameWithOwner)) {
      continue;
    }
    if (repo.isArchived === true) {
      continue;
    }

    const repoResult = collectRepoPrs(repo.nameWithOwner, author, window, exec);
    gaps.push(...repoResult.gaps);

    for (const pr of repoResult.prs) {
      const item = buildWorkItem(root, options.runTs, repo.nameWithOwner, pr, exec, options.repoCacheRoot);
      writeWorkItem(item);
      workItems.push(summaryOf(item));
      if (item.postOpeningDelta.source === "unavailable") {
        gaps.push({
          impact: "Primary post-opening delta evidence is missing, so PR trajectory analysis for this PR is degraded.",
          number: item.number,
          reason: `post-opening delta unavailable: ${item.postOpeningDelta.note ?? "no diff evidence"}`,
          repo: item.repo,
        });
      }
    }
  }

  const manifest: PrAnalysisManifest = {
    author,
    gaps: gaps.toSorted((a, b) => comparePrLabels(a.repo, a.number, b.repo, b.number)),
    generatedAt,
    org,
    runTs: options.runTs,
    version: 1,
    window,
    workItems: workItems.toSorted((a, b) => comparePrLabels(a.repo, a.number, b.repo, b.number)),
  };
  writePrManifest(root, options.runTs, manifest);
  return manifest;
}

function collectRepoPrs(
  repo: string,
  author: string,
  window: RetrospectiveWindow,
  exec: CommandRunner,
) {
  const gaps: PrAnalysisGap[] = [];
  const summariesByNumber = new Map<number, GhPr>();

  for (const day of eachDateOnly(window.since, window.until)) {
    let summaries: GhPr[];
    try {
      summaries = parseJson(
        runText(exec, "gh", [
          "pr",
          "list",
          "--repo",
          repo,
          "--author",
          author,
          "--state",
          "merged",
          "--search",
          `merged:${day}..${day}`,
          "--limit",
          String(PR_LIST_LIMIT),
          "--json",
          PR_LIST_FIELDS,
        ]),
        GhPrListSchema,
      );
    } catch (error) {
      gaps.push({
        impact: "Merged PRs from this date bucket are absent from PR trajectory analysis.",
        reason: `PR lookup failed for ${day}: ${errorMessage(error)}`,
        repo,
      });
      continue;
    }

    if (summaries.length >= PR_LIST_LIMIT) {
      gaps.push({
        impact: "That date bucket may be incomplete if additional merged PRs exist beyond the limit.",
        reason: `PR lookup for ${day} returned ${summaries.length} entries, hitting the per-day limit of ${PR_LIST_LIMIT}.`,
        repo,
      });
    }

    for (const summary of summaries.filter((candidate) => prInWindow(candidate, window))) {
      summariesByNumber.set(summary.number, summary);
    }
  }

  const prs: GhPr[] = [];
  for (const summary of [...summariesByNumber.values()].toSorted((a, b) => a.number - b.number)) {
    try {
      prs.push(hydratePr(repo, summary, exec, gaps));
    } catch (error) {
      gaps.push({
        impact: "This PR is absent from PR trajectory analysis.",
        number: summary.number,
        reason: `PR metadata lookup failed: ${errorMessage(error)}`,
        repo,
      });
    }
  }

  return { gaps, prs };
}

function hydratePr(repo: string, summary: GhPr, exec: CommandRunner, gaps: PrAnalysisGap[]) {
  const detail = parseJson(
    runText(exec, "gh", [
      "pr",
      "view",
      String(summary.number),
      "--repo",
      repo,
      "--json",
      PR_DETAIL_FIELDS,
    ]),
    GhPrSchema,
  );
  let files: GhFile[] = [];
  try {
    const response = parseJson(
      runText(exec, "gh", ["pr", "view", String(summary.number), "--repo", repo, "--json", "files"]),
      GhPrFilesResponseSchema,
    );
    ({ files } = response);
  } catch (error) {
    gaps.push({
      impact: "Changed-file context is missing, but post-opening delta analysis can still proceed.",
      number: summary.number,
      reason: `PR files lookup failed: ${errorMessage(error)}`,
      repo,
    });
  }
  return {
    ...summary,
    ...detail,
    files,
  };
}

export function runPrAggregate(options: RunPrAggregateOptions) {
  const root = options.retroRoot ?? retroHome(options.home);
  const manifest = readPrManifest(root, options.runTs);
  if (!manifest) {
    throw new Error(`PR aggregate requires runs/${options.runTs}/pr-analysis/manifest.json`);
  }

  const gaps = [...manifest.gaps];
  const out: string[] = [
    "# PR trajectory analysis",
    "",
    `Window: ${manifest.window.since} to ${manifest.window.until} (${manifest.window.sinceSource} to ${manifest.window.untilSource})`,
    `Scope: ${manifest.org}; author: ${manifest.author}`,
    "",
    "## Recurring Corrective Patterns",
    "",
  ];

  const analyses = manifest.workItems.map((item) => ({
    body: existsSync(item.analysisPath) ? readFileSync(item.analysisPath, "utf-8").trim() : "",
    item,
  }));
  const groupedPatterns = groupCorrectivePatterns(analyses);
  const recurringPatterns = groupedPatterns.filter((pattern) => pattern.items.length > 1);
  if (recurringPatterns.length === 0) {
    out.push("_No recurring corrective-change patterns were extracted from per-PR analyses._");
  } else {
    for (const pattern of recurringPatterns) {
      out.push(`- ${pattern.label} (${pattern.items.length} PRs: ${pattern.items.join(", ")})`);
    }
  }
  out.push("", "## Observed One-Off Corrective Patterns", "");
  const oneOffPatterns = groupedPatterns.filter((pattern) => pattern.items.length === 1);
  if (oneOffPatterns.length === 0) {
    out.push("_No one-off corrective-change patterns were extracted._");
  } else {
    for (const pattern of oneOffPatterns) {
      out.push(`- \`${pattern.items[0]}\` — ${pattern.label}`);
    }
  }
  out.push("");

  for (const { body, item } of analyses) {
    if (!body && !gaps.some((gap) => gap.repo === item.repo && gap.number === item.number)) {
      gaps.push({
        impact: "This PR is represented as a gap instead of an analyzed trajectory.",
        number: item.number,
        reason: `missing per-PR analysis at ${item.analysisPath}`,
        repo: item.repo,
      });
    }
  }

  out.push("## PR Analysis Gaps", "");
  const uniqueGaps = dedupeGaps(gaps);
  if (uniqueGaps.length === 0) {
    out.push("_No PR analysis gaps._");
  } else {
    for (const gap of uniqueGaps) {
      out.push(`- \`${formatPrLabel(gap)}\` — ${sentence(gap.reason)} Impact: ${gap.impact}`);
    }
  }
  out.push("", "## Per-PR Analyses", "");
  const represented = analyses.filter(({ body }) => body);
  if (represented.length === 0) {
    out.push("_No per-PR analyses were written._");
  }
  for (const { body, item } of represented) {
    out.push(`### ${item.repo}#${item.number}`, "", `URL: ${item.url}`, `Opening snapshot: ${item.openingSnapshot.confidence}${
        isNonEmptyString(item.openingSnapshot.ref) ? ` ${item.openingSnapshot.ref}` : ""
      }`);
    if (isNonEmptyString(item.finalHeadSha)) {
      out.push(`Final head: ${item.finalHeadSha}`);
    }
    if (isNonEmptyString(item.mergeCommitSha)) {
      out.push(`Merge commit: ${item.mergeCommitSha}`);
    }
    if (item.commitShas.length > 0) {
      out.push(`PR commits: ${item.commitShas.join(", ")}`);
    }
    out.push("", body, "");
  }

  const filePath = prAnalysisPath(root, options.runTs);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, out.join("\n"), "utf-8");
  return { gaps: uniqueGaps, path: filePath };
}

export function prManifestPath(root: string, runTs: string) {
  return path.join(runDir(root, runTs), "pr-analysis", "manifest.json");
}

export function readPrManifest(root: string, runTs: string) {
  const filePath = prManifestPath(root, runTs);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return parseJson(readFileSync(filePath, "utf-8"), PrAnalysisManifestSchema);
  } catch {
    return null;
  }
}

function writePrManifest(root: string, runTs: string, manifest: PrAnalysisManifest) {
  const filePath = prManifestPath(root, runTs);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(manifest, null, 2), "utf-8");
}

function buildWorkItem(
  root: string,
  runTs: string,
  repo: string,
  pr: GhPr,
  exec: CommandRunner,
  repoCacheRoot?: string,
): PrWorkItem {
  const commits = normalizeCommits(pr.commits);
  const openingSnapshot = inferOpeningSnapshot(pr, commits);
  const finalHeadSha = isNonEmptyString(pr.headRefOid) ? pr.headRefOid : commits.at(-1)?.sha;
  const mergeCommitSha = normalizeMergeCommit(pr.mergeCommit);
  const id = workItemId(repo, pr.number);
  const dir = path.join(runDir(root, runTs), "pr-analysis", "prs");
  const workItemPath = path.join(dir, `${id}.json`);
  const analysisPath = path.join(dir, `${id}.analysis.md`);
  const postOpeningDelta = materializeDelta(repo, pr.number, openingSnapshot.ref, finalHeadSha, exec, repoCacheRoot);

  return {
    analysisPath,
    baseBranch: pr.baseRefName,
    changedFiles: normalizeFiles(pr.files),
    commitMessages: commits,
    commitShas: commits.map((commit) => commit.sha),
    createdAt: pr.createdAt,
    finalHeadSha,
    headBranch: pr.headRefName,
    mergeCommitSha,
    mergedAt: pr.mergedAt,
    number: pr.number,
    openingSnapshot,
    postOpeningDelta,
    repo,
    runTs,
    title: pr.title,
    url: pr.url,
    version: 1,
    workItemPath,
  };
}

function writeWorkItem(item: PrWorkItem) {
  mkdirSync(path.dirname(item.workItemPath), { recursive: true });
  writeFileSync(item.workItemPath, JSON.stringify(item, null, 2), "utf-8");
}

function summaryOf(item: PrWorkItem) {
  return {
    analysisPath: item.analysisPath,
    commitShas: item.commitShas,
    createdAt: item.createdAt,
    finalHeadSha: item.finalHeadSha,
    mergeCommitSha: item.mergeCommitSha,
    mergedAt: item.mergedAt,
    number: item.number,
    openingSnapshot: item.openingSnapshot,
    repo: item.repo,
    title: item.title,
    url: item.url,
    workItemPath: item.workItemPath,
  };
}

function inferOpeningSnapshot(
  pr: GhPr,
  commits: PrCommitReference[],
): PrWorkItemSummary["openingSnapshot"] {
  const exactRef = pr.openingSnapshotOid ?? pr.openingSnapshotRef ?? pr.createdHeadRefOid ?? pr.creationHeadRefOid;
  if (isNonEmptyString(exactRef)) {
    return {
      confidence: "exact",
      reason: "GitHub provided a creation-time PR head ref.",
      ref: exactRef,
    };
  }

  const createdAtMs = Date.parse(pr.createdAt);
  if (!Number.isNaN(createdAtMs)) {
    const candidate = commits.findLast(
      (commit) =>
        commit.committedDate !== undefined && Date.parse(commit.committedDate) <= createdAtMs,
    );
    if (candidate) {
      return {
        confidence: "inferred",
        reason: "Latest PR commit whose commit date is at or before the PR creation time.",
        ref: candidate.sha,
      };
    }
  }
  return {
    confidence: "unknown",
    reason: "No creation-time head ref or inferable pre-open commit was available.",
  };
}

function materializeDelta(
  repo: string,
  number: number,
  openingRef: string | undefined,
  finalHeadSha: string | undefined,
  exec: CommandRunner,
  repoCacheRoot?: string,
): PrWorkItem["postOpeningDelta"] {
  const missingRefNote =
    !isNonEmptyString(openingRef) || !isNonEmptyString(finalHeadSha)
      ? "Opening or final ref was unavailable, so no post-opening delta could be materialized."
      : undefined;

  const repoDir = isNonEmptyString(repoCacheRoot)
    ? path.join(repoCacheRoot, repo.replaceAll("/", "__"))
    : null;
  if (
    !isNonEmptyString(missingRefNote) &&
    isNonEmptyString(repoDir) &&
    isNonEmptyString(openingRef) &&
    isNonEmptyString(finalHeadSha)
  ) {
    try {
      ensureRepoCache(repo, repoDir, exec);
      runText(exec, "git", ["fetch", "origin", `pull/${number}/head:refs/remotes/pr/${number}`, "--force"], {
        cwd: repoDir,
      });
      const body = runText(exec, "git", ["diff", "--find-renames", openingRef, finalHeadSha], {
        cwd: repoDir,
      });
      return {
        body: clipDelta(body),
        confidence: "primary",
        source: "local-git",
      };
    } catch {
      // Fall through to the GitHub diff fallback below.
    }
  }

  try {
    const body = runText(exec, "gh", ["pr", "diff", String(number), "--repo", repo, "--patch"]);
    return {
      body: clipDelta(body),
      confidence: "lower",
      note: "GitHub PR diff is the whole PR diff, not a true post-opening delta.",
      source: "github-pr-diff-fallback",
    };
  } catch (error) {
    return {
      body: "",
      confidence: "none",
      note: missingRefNote
        ? `${missingRefNote} GitHub PR diff fallback failed: ${errorMessage(error)}`
        : `Diff materialization failed: ${errorMessage(error)}`,
      source: "unavailable",
    };
  }
}

function ensureRepoCache(repo: string, repoDir: string, exec: CommandRunner) {
  if (existsSync(path.join(repoDir, ".git"))) {
    return;
  }
  mkdirSync(path.dirname(repoDir), { recursive: true });
  runText(exec, "gh", ["repo", "clone", repo, repoDir, "--", "--filter=blob:none", "--no-checkout"]);
}

function normalizeCommits(commits: GhCommit[] | undefined) {
  return (commits ?? [])
    .map((commit) => {
      const sha = commit.oid ?? commit.sha;
      if (!isNonEmptyString(sha)) {
        return null;
      }
      const headline = commit.messageHeadline ?? commit.message ?? "";
      const normalized: PrCommitReference = {
        committedDate: commit.committedDate,
        message: isNonEmptyString(commit.messageBody)
          ? `${headline}\n\n${commit.messageBody}`
          : headline,
        sha,
      };
      return normalized;
    })
    .filter((entry): entry is PrCommitReference => entry !== null);
}

function normalizeFiles(files: GhFile[] | undefined) {
  return (files ?? [])
    .map((file) => file.path ?? file.filename)
    .filter((entry): entry is string => Boolean(entry))
    .toSorted();
}

function normalizeMergeCommit(commit: GhMergeCommit | null | undefined) {
  return commit?.oid ?? commit?.sha;
}

function parseJson<T extends ZodType>(text: string, schema: T) {
  const value: unknown = JSON.parse(text);
  return schema.parse(value);
}

function prInWindow(pr: GhPr, window: RetrospectiveWindow) {
  const mergedAt = Date.parse(pr.mergedAt);
  return !Number.isNaN(mergedAt) && mergedAt >= Date.parse(window.since) && mergedAt <= Date.parse(window.until);
}

function extractCorrectivePatternLines(body: string) {
  const section = extractSection(body, "Corrective Patterns");
  if (!isNonEmptyString(section)) {
    return [];
  }
  return section
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s+/u, ""))
    .filter(Boolean)
    .filter((line) => !line.startsWith("##"))
    .slice(0, 8);
}

function groupCorrectivePatterns(
  analyses: { body: string; item: PrWorkItemSummary; }[],
) {
  const byPattern = new Map<string, { items: string[]; label: string; }>();
  for (const { body, item } of analyses) {
    if (!body) {
      continue;
    }
    for (const line of extractCorrectivePatternLines(body)) {
      const key = normalizePattern(line);
      if (!key) {
        continue;
      }
      const existing = byPattern.get(key) ?? { items: [], label: line };
      existing.items.push(`${item.repo}#${item.number}`);
      byPattern.set(key, existing);
    }
  }
  return [...byPattern.values()].toSorted((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
}

function normalizePattern(value: string) {
  return value
    .toLowerCase()
    .replaceAll(/`[^`]+`/gu, "")
    .replaceAll(/#[0-9]+/gu, "")
    .replaceAll(/[0-9a-f]{7,40}/gu, "")
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim();
}

function dedupeGaps(gaps: PrAnalysisGap[]) {
  const byKey = new Map<string, PrAnalysisGap>();
  for (const gap of gaps) {
    byKey.set(`${gap.repo}#${gap.number ?? ""}#${gap.reason}`, gap);
  }
  return [...byKey.values()].toSorted((a, b) => comparePrLabels(a.repo, a.number, b.repo, b.number));
}

function comparePrLabels(repoA: string, numberA: number | undefined, repoB: string, numberB: number | undefined) {
  return repoA.localeCompare(repoB) || (numberA ?? 0) - (numberB ?? 0);
}

export function extractSection(body: string, heading: string) {
  const pattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "mu");
  const match = body.match(pattern);
  if (!match || match.index === undefined) {
    return null;
  }
  const start = match.index + match[0].length;
  const rest = body.slice(start);
  const next = rest.search(/^##\s+/mu);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function formatPrLabel(gap: PrAnalysisGap) {
  return gap.number === undefined ? gap.repo : `${gap.repo}#${gap.number}`;
}

function sentence(value: string) {
  return /[.!?]\s*$/u.test(value) ? `${value} ` : `${value}. `;
}

function workItemId(repo: string, number: number) {
  const readable = repo.replaceAll("/", "__").replaceAll(/[^a-zA-Z0-9_.-]/gu, "-");
  return `${readable}__${number}__${hashKey(`${repo}#${number}`).slice(0, 12)}`;
}

function dateOnly(value: string) {
  return value.slice(0, 10);
}

function eachDateOnly(since: string, until: string) {
  const days: string[] = [];
  const cursor = new Date(`${dateOnly(since)}T00:00:00.000Z`);
  const end = new Date(`${dateOnly(until)}T00:00:00.000Z`);
  while (cursor.getTime() <= end.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function clipDelta(value: string) {
  const limit = 100_000;
  if (value.length <= limit) {
    return value;
  }
  const keep = Math.floor((limit - 80) / 2);
  return `${value.slice(0, keep)}\n\n[${value.length - keep * 2} chars elided]\n\n${value.slice(-keep)}`;
}

function defaultRunner(command: string, args: string[], options: { cwd?: string } = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf-8",
    timeout: DEFAULT_COMMAND_TIMEOUT_MS,
  });
  return {
    error: result.error ? errorMessage(result.error) : undefined,
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function runText(
  exec: CommandRunner,
  command: string,
  args: string[],
  options?: { cwd?: string },
) {
  const result = exec(command, args, options);
  if (result.status !== 0) {
    const detail =
      [result.stderr, result.stdout, result.error].find(isNonEmptyString) ?? "unknown error";
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout;
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function escapeRegExp(value: string) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
