import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { hashKey } from "./identity.ts";
import {
  prAnalysisPath,
  readRunWindow,
  retroHome,
  runDir,
} from "./store.ts";
import type { RetrospectiveWindow } from "./types.ts";

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[], options?: { cwd?: string }) => CommandResult;

export interface PrAnalysisGap {
  repo: string;
  number?: number;
  reason: string;
  impact: string;
}

export interface PrCommitReference {
  sha: string;
  committedDate?: string;
  message: string;
}

export interface PrWorkItemSummary {
  repo: string;
  number: number;
  url: string;
  title: string;
  createdAt: string;
  mergedAt: string;
  workItemPath: string;
  analysisPath: string;
  openingSnapshot: {
    confidence: "exact" | "inferred" | "unknown";
    ref?: string;
    reason: string;
  };
  finalHeadSha?: string;
  mergeCommitSha?: string;
  commitShas: string[];
}

export interface PrAnalysisManifest {
  version: 1;
  runTs: string;
  window: RetrospectiveWindow;
  org: string;
  author: string;
  generatedAt: string;
  workItems: PrWorkItemSummary[];
  gaps: PrAnalysisGap[];
}

export interface PrWorkItem extends PrWorkItemSummary {
  version: 1;
  baseBranch?: string;
  headBranch?: string;
  changedFiles: string[];
  commitMessages: PrCommitReference[];
  postOpeningDelta: {
    source: "local-git" | "github-pr-diff-fallback" | "unavailable";
    confidence: "primary" | "lower" | "none";
    body: string;
    note?: string;
  };
}

export interface RunPrCollectOptions {
  retroRoot?: string;
  home?: string;
  runTs: string;
  nowIso?: string;
  repoCacheRoot?: string;
  exec?: CommandRunner;
}

export interface RunPrAggregateOptions {
  retroRoot?: string;
  home?: string;
  runTs: string;
}

interface GhRepo {
  nameWithOwner: string;
  isArchived?: boolean;
}

interface GhPr {
  number: number;
  url: string;
  title: string;
  createdAt: string;
  mergedAt: string;
  openingSnapshotOid?: string;
  openingSnapshotRef?: string;
  createdHeadRefOid?: string;
  creationHeadRefOid?: string;
  baseRefName?: string;
  headRefName?: string;
  headRefOid?: string;
  mergeCommit?: unknown;
  commits?: unknown[];
  files?: unknown[];
}

const DEFAULT_ORG = "monke-together-strong";
const PR_LIST_LIMIT = 100;
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

export function runPrCollect(options: RunPrCollectOptions): PrAnalysisManifest {
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
    repos = JSON.parse(
      runText(exec, "gh", [
        "repo",
        "list",
        org,
        "--limit",
        "1000",
        "--json",
        "nameWithOwner,isArchived,isPrivate",
      ]),
    ) as GhRepo[];
  } catch (error) {
    gaps.push({
      repo: `${org}/*`,
      reason: `repository enumeration failed: ${errorMessage(error)}`,
      impact: "No PR trajectory evidence could be collected for the organization.",
    });
  }

  for (const repo of repos) {
    if (!repo.nameWithOwner) {
      continue;
    }
    if (repo.isArchived) {
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
          repo: item.repo,
          number: item.number,
          reason: `post-opening delta unavailable: ${item.postOpeningDelta.note ?? "no diff evidence"}`,
          impact: "Primary post-opening delta evidence is missing, so PR trajectory analysis for this PR is degraded.",
        });
      }
    }
  }

  const manifest: PrAnalysisManifest = {
    version: 1,
    runTs: options.runTs,
    window,
    org,
    author,
    generatedAt,
    workItems: workItems.sort((a, b) => comparePrLabels(a.repo, a.number, b.repo, b.number)),
    gaps: gaps.sort((a, b) => comparePrLabels(a.repo, a.number, b.repo, b.number)),
  };
  writePrManifest(root, options.runTs, manifest);
  return manifest;
}

function collectRepoPrs(
  repo: string,
  author: string,
  window: RetrospectiveWindow,
  exec: CommandRunner,
): { prs: GhPr[]; gaps: PrAnalysisGap[] } {
  const gaps: PrAnalysisGap[] = [];
  const summariesByNumber = new Map<number, GhPr>();

  for (const day of eachDateOnly(window.since, window.until)) {
    let summaries: GhPr[];
    try {
      summaries = JSON.parse(
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
      ) as GhPr[];
    } catch (error) {
      gaps.push({
        repo,
        reason: `PR lookup failed for ${day}: ${errorMessage(error)}`,
        impact: "Merged PRs from this date bucket are absent from PR trajectory analysis.",
      });
      continue;
    }

    if (summaries.length >= PR_LIST_LIMIT) {
      gaps.push({
        repo,
        reason: `PR lookup for ${day} returned ${summaries.length} entries, hitting the per-day limit of ${PR_LIST_LIMIT}.`,
        impact: "That date bucket may be incomplete if additional merged PRs exist beyond the limit.",
      });
    }

    for (const summary of summaries.filter((candidate) => prInWindow(candidate, window))) {
      summariesByNumber.set(summary.number, summary);
    }
  }

  const prs: GhPr[] = [];
  for (const summary of [...summariesByNumber.values()].sort((a, b) => a.number - b.number)) {
    try {
      prs.push(hydratePr(repo, summary, exec, gaps));
    } catch (error) {
      gaps.push({
        repo,
        number: summary.number,
        reason: `PR metadata lookup failed: ${errorMessage(error)}`,
        impact: "This PR is absent from PR trajectory analysis.",
      });
    }
  }

  return { prs, gaps };
}

function hydratePr(repo: string, summary: GhPr, exec: CommandRunner, gaps: PrAnalysisGap[]): GhPr {
  const detail = JSON.parse(
    runText(exec, "gh", [
      "pr",
      "view",
      String(summary.number),
      "--repo",
      repo,
      "--json",
      PR_DETAIL_FIELDS,
    ]),
  ) as GhPr;
  let files: unknown[] = [];
  try {
    files = normalizePrFilesResponse(
      JSON.parse(
        runText(exec, "gh", ["pr", "view", String(summary.number), "--repo", repo, "--json", "files"]),
      ),
    );
  } catch (error) {
    gaps.push({
      repo,
      number: summary.number,
      reason: `PR files lookup failed: ${errorMessage(error)}`,
      impact: "Changed-file context is missing, but post-opening delta analysis can still proceed.",
    });
  }
  return {
    ...summary,
    ...detail,
    files,
  };
}

export function runPrAggregate(options: RunPrAggregateOptions): { path: string; gaps: PrAnalysisGap[] } {
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
    item,
    body: existsSync(item.analysisPath) ? readFileSync(item.analysisPath, "utf8").trim() : "",
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
  out.push("");

  out.push("## Observed One-Off Corrective Patterns");
  out.push("");
  const oneOffPatterns = groupedPatterns.filter((pattern) => pattern.items.length === 1);
  if (oneOffPatterns.length === 0) {
    out.push("_No one-off corrective-change patterns were extracted._");
  } else {
    for (const pattern of oneOffPatterns) {
      out.push(`- \`${pattern.items[0]}\` — ${pattern.label}`);
    }
  }
  out.push("");

  for (const { item, body } of analyses) {
    if (!body && !gaps.some((gap) => gap.repo === item.repo && gap.number === item.number)) {
      gaps.push({
        repo: item.repo,
        number: item.number,
        reason: `missing per-PR analysis at ${item.analysisPath}`,
        impact: "This PR is represented as a gap instead of an analyzed trajectory.",
      });
    }
  }

  out.push("## PR Analysis Gaps");
  out.push("");
  const uniqueGaps = dedupeGaps(gaps);
  if (uniqueGaps.length === 0) {
    out.push("_No PR analysis gaps._");
  } else {
    for (const gap of uniqueGaps) {
      out.push(`- \`${formatPrLabel(gap)}\` — ${sentence(gap.reason)} Impact: ${gap.impact}`);
    }
  }
  out.push("");

  out.push("## Per-PR Analyses");
  out.push("");
  const represented = analyses.filter(({ body }) => body);
  if (represented.length === 0) {
    out.push("_No per-PR analyses were written._");
  }
  for (const { item, body } of represented) {
    out.push(`### ${item.repo}#${item.number}`);
    out.push("");
    out.push(`URL: ${item.url}`);
    out.push(
      `Opening snapshot: ${item.openingSnapshot.confidence}${
        item.openingSnapshot.ref ? ` ${item.openingSnapshot.ref}` : ""
      }`,
    );
    if (item.finalHeadSha) {
      out.push(`Final head: ${item.finalHeadSha}`);
    }
    if (item.mergeCommitSha) {
      out.push(`Merge commit: ${item.mergeCommitSha}`);
    }
    if (item.commitShas.length > 0) {
      out.push(`PR commits: ${item.commitShas.join(", ")}`);
    }
    out.push("");
    out.push(body);
    out.push("");
  }

  const filePath = prAnalysisPath(root, options.runTs);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, out.join("\n"), "utf8");
  return { path: filePath, gaps: uniqueGaps };
}

export function prManifestPath(root: string, runTs: string): string {
  return path.join(runDir(root, runTs), "pr-analysis", "manifest.json");
}

export function readPrManifest(root: string, runTs: string): PrAnalysisManifest | null {
  const filePath = prManifestPath(root, runTs);
  if (!existsSync(filePath)) {
    return null;
  }
  return JSON.parse(readFileSync(filePath, "utf8")) as PrAnalysisManifest;
}

function writePrManifest(root: string, runTs: string, manifest: PrAnalysisManifest): void {
  const filePath = prManifestPath(root, runTs);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(manifest, null, 2), "utf8");
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
  const finalHeadSha = pr.headRefOid || commits.at(-1)?.sha;
  const mergeCommitSha = normalizeMergeCommit(pr.mergeCommit);
  const id = workItemId(repo, pr.number);
  const dir = path.join(runDir(root, runTs), "pr-analysis", "prs");
  const workItemPath = path.join(dir, `${id}.json`);
  const analysisPath = path.join(dir, `${id}.analysis.md`);
  const postOpeningDelta = materializeDelta(repo, pr.number, openingSnapshot.ref, finalHeadSha, exec, repoCacheRoot);

  return {
    version: 1,
    runTs,
    repo,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    baseBranch: pr.baseRefName,
    headBranch: pr.headRefName,
    workItemPath,
    analysisPath,
    openingSnapshot,
    finalHeadSha,
    mergeCommitSha,
    commitShas: commits.map((commit) => commit.sha),
    changedFiles: normalizeFiles(pr.files),
    commitMessages: commits,
    postOpeningDelta,
  };
}

function writeWorkItem(item: PrWorkItem): void {
  mkdirSync(path.dirname(item.workItemPath), { recursive: true });
  writeFileSync(item.workItemPath, JSON.stringify(item, null, 2), "utf8");
}

function summaryOf(item: PrWorkItem): PrWorkItemSummary {
  return {
    repo: item.repo,
    number: item.number,
    url: item.url,
    title: item.title,
    createdAt: item.createdAt,
    mergedAt: item.mergedAt,
    workItemPath: item.workItemPath,
    analysisPath: item.analysisPath,
    openingSnapshot: item.openingSnapshot,
    finalHeadSha: item.finalHeadSha,
    mergeCommitSha: item.mergeCommitSha,
    commitShas: item.commitShas,
  };
}

function inferOpeningSnapshot(
  pr: GhPr,
  commits: PrCommitReference[],
): PrWorkItemSummary["openingSnapshot"] {
  const exactRef = pr.openingSnapshotOid ?? pr.openingSnapshotRef ?? pr.createdHeadRefOid ?? pr.creationHeadRefOid;
  if (exactRef) {
    return {
      confidence: "exact",
      ref: exactRef,
      reason: "GitHub provided a creation-time PR head ref.",
    };
  }

  const createdAtMs = Date.parse(pr.createdAt);
  if (!Number.isNaN(createdAtMs)) {
    const candidate = commits
      .filter((commit) => commit.committedDate && Date.parse(commit.committedDate) <= createdAtMs)
      .at(-1);
    if (candidate) {
      return {
        confidence: "inferred",
        ref: candidate.sha,
        reason: "Latest PR commit whose commit date is at or before the PR creation time.",
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
  if (!openingRef || !finalHeadSha) {
    return {
      source: "unavailable",
      confidence: "none",
      body: "",
      note: "Opening or final ref was unavailable, so no post-opening delta could be materialized.",
    };
  }

  const repoDir = repoCacheRoot ? path.join(repoCacheRoot, repo.replaceAll("/", "__")) : null;
  if (repoDir) {
    try {
      ensureRepoCache(repo, repoDir, exec);
      runText(exec, "git", ["fetch", "origin", `pull/${number}/head:refs/remotes/pr/${number}`, "--force"], {
        cwd: repoDir,
      });
      const body = runText(exec, "git", ["diff", "--find-renames", openingRef, finalHeadSha], {
        cwd: repoDir,
      });
      return {
        source: "local-git",
        confidence: "primary",
        body: clipDelta(body),
      };
    } catch {
      // Fall through to the GitHub diff fallback below.
    }
  }

  try {
    const body = runText(exec, "gh", ["pr", "diff", String(number), "--repo", repo, "--patch"]);
    return {
      source: "github-pr-diff-fallback",
      confidence: "lower",
      body: clipDelta(body),
      note: "GitHub PR diff is the whole PR diff, not a true post-opening delta.",
    };
  } catch (error) {
    return {
      source: "unavailable",
      confidence: "none",
      body: "",
      note: `Diff materialization failed: ${errorMessage(error)}`,
    };
  }
}

function ensureRepoCache(repo: string, repoDir: string, exec: CommandRunner): void {
  if (existsSync(path.join(repoDir, ".git"))) {
    return;
  }
  mkdirSync(path.dirname(repoDir), { recursive: true });
  runText(exec, "gh", ["repo", "clone", repo, repoDir, "--", "--filter=blob:none", "--no-checkout"]);
}

function normalizeCommits(value: unknown): PrCommitReference[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      const record = asRecord(entry);
      const sha = asString(record?.oid) ?? asString(record?.sha);
      if (!sha) {
        return null;
      }
      const headline = asString(record?.messageHeadline) ?? asString(record?.message) ?? "";
      const body = asString(record?.messageBody);
      return {
        sha,
        committedDate: asString(record?.committedDate),
        message: body ? `${headline}\n\n${body}` : headline,
      };
    })
    .filter((entry): entry is PrCommitReference => entry !== null);
}

function normalizeFiles(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      const record = asRecord(entry);
      return asString(record?.path) ?? asString(record?.filename);
    })
    .filter((entry): entry is string => Boolean(entry))
    .sort();
}

function normalizePrFilesResponse(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  const record = asRecord(value);
  const files = record?.files;
  return Array.isArray(files) ? files : [];
}

function normalizeMergeCommit(value: unknown): string | undefined {
  const record = asRecord(value);
  return asString(record?.oid) ?? asString(record?.sha);
}

function prInWindow(pr: GhPr, window: RetrospectiveWindow): boolean {
  const mergedAt = Date.parse(pr.mergedAt);
  return !Number.isNaN(mergedAt) && mergedAt >= Date.parse(window.since) && mergedAt <= Date.parse(window.until);
}

function extractCorrectivePatternLines(body: string): string[] {
  const section = extractSection(body, "Corrective Patterns");
  if (!section) {
    return [];
  }
  return section
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean)
    .filter((line) => !line.startsWith("##"))
    .slice(0, 8);
}

function groupCorrectivePatterns(
  analyses: { item: PrWorkItemSummary; body: string }[],
): { label: string; items: string[] }[] {
  const byPattern = new Map<string, { label: string; items: string[] }>();
  for (const { item, body } of analyses) {
    if (!body) {
      continue;
    }
    for (const line of extractCorrectivePatternLines(body)) {
      const key = normalizePattern(line);
      if (!key) {
        continue;
      }
      const existing = byPattern.get(key) ?? { label: line, items: [] };
      existing.items.push(`${item.repo}#${item.number}`);
      byPattern.set(key, existing);
    }
  }
  return [...byPattern.values()].sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
}

function normalizePattern(value: string): string {
  return value
    .toLowerCase()
    .replace(/`[^`]+`/g, "")
    .replace(/#[0-9]+/g, "")
    .replace(/[0-9a-f]{7,40}/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function dedupeGaps(gaps: PrAnalysisGap[]): PrAnalysisGap[] {
  const byKey = new Map<string, PrAnalysisGap>();
  for (const gap of gaps) {
    byKey.set(`${gap.repo}#${gap.number ?? ""}#${gap.reason}`, gap);
  }
  return [...byKey.values()].sort((a, b) => comparePrLabels(a.repo, a.number, b.repo, b.number));
}

function comparePrLabels(repoA: string, numberA: number | undefined, repoB: string, numberB: number | undefined): number {
  return repoA.localeCompare(repoB) || (numberA ?? 0) - (numberB ?? 0);
}

export function extractSection(body: string, heading: string): string | null {
  const pattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "m");
  const match = body.match(pattern);
  if (!match || match.index === undefined) {
    return null;
  }
  const start = match.index + match[0].length;
  const rest = body.slice(start);
  const next = rest.search(/^##\s+/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function formatPrLabel(gap: PrAnalysisGap): string {
  return gap.number === undefined ? gap.repo : `${gap.repo}#${gap.number}`;
}

function sentence(value: string): string {
  return /[.!?]\s*$/.test(value) ? `${value} ` : `${value}. `;
}

function workItemId(repo: string, number: number): string {
  const readable = repo.replaceAll("/", "__").replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
  return `${readable}__${number}__${hashKey(`${repo}#${number}`).slice(0, 12)}`;
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

function eachDateOnly(since: string, until: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${dateOnly(since)}T00:00:00.000Z`);
  const end = new Date(`${dateOnly(until)}T00:00:00.000Z`);
  while (cursor.getTime() <= end.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function clipDelta(value: string): string {
  const limit = 100_000;
  if (value.length <= limit) {
    return value;
  }
  const keep = Math.floor((limit - 80) / 2);
  return `${value.slice(0, keep)}\n\n[${value.length - keep * 2} chars elided]\n\n${value.slice(-keep)}`;
}

function defaultRunner(command: string, args: string[], options: { cwd?: string } = {}): CommandResult {
  const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runText(
  exec: CommandRunner,
  command: string,
  args: string[],
  options?: { cwd?: string },
): string {
  const result = exec(command, args, options);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
