import { existsSync, readFileSync } from "node:fs";

import { isNonEmptyString } from "./normalize.ts";
import {
  cleanRunDir,
  listBundleHashes,
  loadFrozenSession,
  loadRepoMeta,
  readPrAnalysis,
  readBundle,
  readFindings,
  readRunWindow,
  retroHome,
  saveFrozenSession,
  saveRepoMeta,
  writeReport,
  writeReportArtifact,
} from "./store.ts";
import { readPrManifest } from './pr-analysis.ts';
import type { PrAnalysisManifest, PrWorkItemSummary } from './pr-analysis.ts';
import type {
  BundleSession,
  CanonicalTurn,
  DurableFixProposal,
  FrictionEpisode,
  FrozenSessionRecord,
  RepeatedAskCluster,
  RepoBundle,
  RepoFindings,
  RetrospectiveWindow,
} from "./types.ts";

export interface ValidatedFindings {
  repoKey: string;
  episodes: FrictionEpisode[];
  fixes: DurableFixProposal[];
  repeatedAsks: RepeatedAskCluster[];
  dropped: { episodes: number; fixes: number };
}

/**
 * Validate the LLM's citations against the bundle the script handed it: every
 * cited turn ref must exist in its session; every cited episode ref must name a
 * surviving episode. Offending items are dropped and counted (commit stays the
 * deterministic gate; a hallucinated ref never reaches the frozen record).
 */
export function validateFindings(findings: RepoFindings, bundle: RepoBundle): ValidatedFindings {
  // A session's friction is authored once, by its PRIMARY repo's subagent. Refs
  // are validated against that same session's turns, so a surviving episode can
  // never render as a missing citation.
  const refsByPrimarySession = new Map<string, Set<string>>();
  for (const session of bundle.sessions) {
    if (session.role === "primary") {
      refsByPrimarySession.set(session.sessionId, new Set(session.turns.map((turn) => turn.ref)));
    }
  }

  const seenIds = new Set<string>();
  const episodes: FrictionEpisode[] = [];
  let droppedEpisodes = 0;
  for (const episode of findings.frictionEpisodes ?? []) {
    const refs = refsByPrimarySession.get(episode.sessionId);
    const citedTurnRefs = episode.citedTurnRefs ?? [];
    const refsValid = refs !== undefined && citedTurnRefs.every((ref) => refs.has(ref));
    if (!isNonEmptyString(episode.id) || seenIds.has(episode.id) || !refsValid) {
      droppedEpisodes += 1;
      continue;
    }
    seenIds.add(episode.id);
    episodes.push(episode);
  }

  const fixes: DurableFixProposal[] = [];
  let droppedFixes = 0;
  for (const fix of findings.durableFixProposals ?? []) {
    const citedEpisodeRefs = fix.citedEpisodeRefs ?? [];
    if (citedEpisodeRefs.length > 0 && citedEpisodeRefs.every((ref) => seenIds.has(ref))) {
      fixes.push(fix);
    } else {
      droppedFixes += 1;
    }
  }

  const bundleSessionIds = new Set(bundle.sessions.map((session) => session.sessionId));
  const repeatedAsks = (findings.repeatedAsks ?? []).map((cluster) => ({
    ...cluster,
    exampleSessionIds: (cluster.exampleSessionIds ?? []).filter((id) => bundleSessionIds.has(id)),
  }));

  return {
    dropped: { episodes: droppedEpisodes, fixes: droppedFixes },
    episodes,
    fixes,
    repeatedAsks,
    repoKey: findings.repoKey,
  };
}

interface RepoSlice {
  bundle: RepoBundle;
  validated: ValidatedFindings;
}

export interface RunCommitOptions {
  retroRoot?: string;
  home?: string;
  runTs: string;
  synthesisPath?: string;
  nowIso: string;
}

export interface CommitResult {
  reportPath: string;
  sourcePaths: {
    session: string;
    pr: string;
  };
  frozenSessions: number;
  appendedSessions: number;
  dropped: { episodes: number; fixes: number };
  prAnalysis: { present: boolean; warnings: string[] };
}

export function runCommit(options: RunCommitOptions): CommitResult {
  const root = options.retroRoot ?? retroHome(options.home);
  const slices: RepoSlice[] = [];
  for (const repoHash of listBundleHashes(root, options.runTs)) {
    const bundle = readBundle(root, options.runTs, repoHash);
    const findings = readFindings(root, options.runTs, repoHash);
    if (!findings) {
      continue;
    }
    slices.push({ bundle, validated: validateFindings(findings, bundle) });
  }

  const dropped = { episodes: 0, fixes: 0 };
  for (const slice of slices) {
    dropped.episodes += slice.validated.dropped.episodes;
    dropped.fixes += slice.validated.dropped.fixes;
  }

  const prAnalysis = readPrAnalysis(root, options.runTs);
  if (!isNonEmptyString(prAnalysis?.trim())) {
    throw new Error(`commit requires runs/${options.runTs}/pr-analysis.md from the required PR analysis lane`);
  }
  const prAnalysisValidation = validatePrAnalysis(prAnalysis, readPrManifest(root, options.runTs));

  // Freeze each session from its PRIMARY repo's analysis (analyze-once).
  let frozenSessions = 0;
  let appendedSessions = 0;
  for (const slice of slices) {
    for (const session of slice.bundle.sessions) {
      if (session.role !== "primary") {
        continue;
      }
      const prior = loadFrozenSession(root, session.agent, session.sessionId);
      const newFriction = slice.validated.episodes
        .filter((episode) => episode.sessionId === session.sessionId)
        .map((episode) => ({
          body: episode.body,
          citedTurnRefs: episode.citedTurnRefs,
          id: `${options.runTs}:${episode.id}`,
        }));
      const record: FrozenSessionRecord = {
        agent: session.agent,
        analyzedAt: options.nowIso,
        contentHash: session.contentHash,
        friction: [...(prior?.friction ?? []), ...newFriction],
        lastTurnIndex: session.turns.length,
        rawUserMessages: session.rawUserMessages,
        repoKey: slice.bundle.repoKey,
        secondary: secondaryRootsOf(session, slices),
        sessionId: session.sessionId,
        version: 1,
      };
      saveFrozenSession(root, record);
      const repoMeta = loadRepoMeta(root, slice.bundle.repoKey);
      saveRepoMeta(root, {
        firstSeenAt: repoMeta?.firstSeenAt ?? options.nowIso,
        lastAnalyzedAt: options.nowIso,
        repoKey: slice.bundle.repoKey,
        version: 1,
      });
      if (prior) {
        appendedSessions += 1;
      } else {
        frozenSessions += 1;
      }
    }
  }

  const synthesis =
    isNonEmptyString(options.synthesisPath) && existsSync(options.synthesisPath)
      ? readFileSync(options.synthesisPath, "utf-8").trim()
      : "";
  const artifacts = buildReportArtifacts(options.runTs, synthesis, slices, {
    prAnalysis,
    prAnalysisWarnings: prAnalysisValidation.warnings,
    window: readRunWindow(root, options.runTs),
  });
  const reportPath = writeReport(root, options.runTs, artifacts.report);
  const sessionSourcePath = writeReportArtifact(root, options.runTs, "session-sources", artifacts.sessionSources);
  const prSourcePath = writeReportArtifact(root, options.runTs, "pr-sources", artifacts.prSources);
  cleanRunDir(root, options.runTs);

  return {
    appendedSessions,
    dropped,
    frozenSessions,
    prAnalysis: {
      present: Boolean(prAnalysis?.trim()),
      warnings: prAnalysisValidation.warnings,
    },
    reportPath,
    sourcePaths: {
      pr: prSourcePath,
      session: sessionSourcePath,
    },
  };
}

function secondaryRootsOf(session: BundleSession, slices: RepoSlice[]): string[] {
  const roots = new Set<string>();
  for (const slice of slices) {
    if (
      slice.bundle.sessions.some(
        (candidate) => candidate.sessionId === session.sessionId && candidate.role === "secondary",
      )
    ) {
      roots.add(slice.bundle.repoKey);
    }
  }
  return [...roots].toSorted();
}

// --- report (action-first, design decision 16) -------------------------------

interface ReportContext {
  window?: RetrospectiveWindow | null;
  prAnalysis?: string | null;
  prAnalysisWarnings?: string[];
}

export function buildReport(
  runTs: string,
  synthesis: string,
  slices: RepoSlice[],
  context: ReportContext = {},
): string {
  return buildReportArtifacts(runTs, synthesis, slices, context).report;
}

export function buildReportArtifacts(
  runTs: string,
  synthesis: string,
  slices: RepoSlice[],
  context: ReportContext = {},
): { report: string; sessionSources: string; prSources: string } {
  const out: string[] = [
    `# Agent session retrospective — ${runTs}`,
    "",
    formatWindowLine(context.window, runTs),
    "",
    `Sources: [session sources](${sourceFileName(runTs, "session")}) · [PR sources](${sourceFileName(runTs, "pr")})`,
    "",
    "## Session Actions",
    "",
    synthesis || "_No cross-repo synthesis provided for this run._",
    "",
    "## PR Repeated Corrective Patterns",
    "",
  ];
  const prAnalysis = context.prAnalysis?.trim();
  if (isNonEmptyString(prAnalysis)) {
    out.push(extractPrRepeatedPatterns(prAnalysis), "");
  } else {
    out.push(
      `_PR analysis missing: no \`runs/${runTs}/pr-analysis.md\` was available at commit time. Transcript-only synthesis is degraded._`,
     "");
  }

  return {
    prSources: buildPrSources(runTs, prAnalysis, context),
    report: out.join("\n"),
    sessionSources: buildSessionSources(runTs, slices, context.window),
  };
}

function buildSessionSources(
  runTs: string,
  slices: RepoSlice[],
  window: RetrospectiveWindow | null | undefined,
): string {
  const out: string[] = [
    `# Session sources — ${runTs}`,
    "",
    formatWindowLine(window, runTs),
    "",
    `Main report: [${runTs}-retrospective.md](${runTs}-retrospective.md)`,
    "",
    "## Per-repo proposals",
    "",
  ];
  const reposWithSignal = slices.filter(
    (slice) => slice.validated.fixes.length > 0 || slice.validated.repeatedAsks.length > 0,
  );
  if (reposWithSignal.length === 0) {
    out.push("_No per-repo proposals this run._", "");
  }
  for (const slice of reposWithSignal) {
    out.push(`### ${slice.validated.repoKey}`, "");
    for (const fix of slice.validated.fixes) {
      const { target, confidence, rest } = parseFixHeader(fix.body);
      out.push(`- Target: ${target}; Confidence: ${confidence} — ${indentBody(rest)}`);
      const evidence = episodesFor(fix, slice.validated.episodes).flatMap((episode) =>
        renderEvidence(episode, slice.bundle),
      );
      if (evidence.length > 0) {
        out.push(
          "  <details><summary>evidence</summary>",
          "",
          evidence.map((line) => `  ${line}`).join("\n"),
          "",
          "  </details>",
        );
      }
    }
    if (slice.validated.repeatedAsks.length > 0) {
      out.push("", "**Repeated asks**");
      for (const cluster of slice.validated.repeatedAsks) {
        out.push(`- **${cluster.label}** — ${firstLine(cluster.body)}`);
      }
    }
    out.push("");
  }

  out.push("## Audit appendix — friction episodes", "");
  const seenEpisodes = new Set<string>();
  for (const slice of slices) {
    for (const episode of slice.validated.episodes) {
      const dedupeKey = `${episode.sessionId}|${[...episode.citedTurnRefs].toSorted().join(",")}`;
      if (seenEpisodes.has(dedupeKey)) {
        continue;
      }
      seenEpisodes.add(dedupeKey);
      out.push(
        `- \`${slice.validated.repoKey}\` · ${episode.sessionId.slice(0, 8)} · refs ${episode.citedTurnRefs.join(", ")}`,
       `  ${firstLine(episode.body)}`);
    }
  }
  out.push("");

  return out.join("\n");
}

function buildPrSources(runTs: string, prAnalysis: string | null | undefined, context: ReportContext): string {
  const out: string[] = [
    `# PR sources — ${runTs}`,
    "",
    formatWindowLine(context.window, runTs),
    "",
    `Main report: [${runTs}-retrospective.md](${runTs}-retrospective.md)`,
    "",
  ];

  if (isNonEmptyString(prAnalysis?.trim())) {
    out.push(prAnalysis.trim(), "");
    const warnings = context.prAnalysisWarnings ?? [];
    if (warnings.length > 0) {
      out.push("## Validation warnings", "");
      for (const warning of warnings) {
        out.push(`- ${warning}`);
      }
      out.push("");
    }
  } else {
    out.push("_No PR analysis source was available._", "");
  }

  return out.join("\n");
}

const REQUIRED_PR_HEADINGS = [
  "Opening Snapshot",
  "Post-Opening Delta",
  "Corrective Patterns",
  "Ignored Feature Scope",
  "Commit Message Reference",
];

export function validatePrAnalysis(
  content: string | null | undefined,
  manifest?: PrAnalysisManifest | null,
): { warnings: string[] } {
  const text = content?.trim();
  if (!isNonEmptyString(text)) {
    return { warnings: [] };
  }

  if (manifest) {
    return validateManifestBackedPrAnalysis(text, manifest);
  }

  const counts = REQUIRED_PR_HEADINGS.map((heading) => ({
    count: countHeading(text, heading),
    heading,
  }));
  const perPrHeadingSeen = counts.some((entry) => entry.count > 0);
  if (!perPrHeadingSeen) {
    return { warnings: [] };
  }

  const expectedCount = Math.max(...counts.map((entry) => entry.count));
  const warnings = counts
    .filter((entry) => entry.count !== expectedCount)
    .map(
      (entry) =>
        `PR analysis heading \`## ${entry.heading}\` appears ${entry.count} time(s), expected ${expectedCount}.`,
    );
  return { warnings };
}

function validateManifestBackedPrAnalysis(
  text: string,
  manifest: PrAnalysisManifest,
): { warnings: string[] } {
  const warnings: string[] = [];
  for (const item of manifest.workItems) {
    const section = findPrAnalysisSection(text, item);
    const gap = text.includes(`\`${item.repo}#${item.number}\``);
    if (!isNonEmptyString(section)) {
      if (!gap) {
        warnings.push(`Expected PR \`${item.repo}#${item.number}\` is missing from PR analysis.`);
      }
      continue;
    }

    for (const heading of REQUIRED_PR_HEADINGS) {
      if (countHeading(section, heading) === 0) {
        warnings.push(`PR \`${item.repo}#${item.number}\` is missing \`## ${heading}\`.`);
      }
    }

    if (
      isNonEmptyString(item.openingSnapshot.ref) &&
      !containsRef(section, item.openingSnapshot.ref)
    ) {
      warnings.push(`PR \`${item.repo}#${item.number}\` omits known opening ref ${item.openingSnapshot.ref}.`);
    }
    if (isNonEmptyString(item.finalHeadSha) && !containsRef(section, item.finalHeadSha)) {
      warnings.push(`PR \`${item.repo}#${item.number}\` omits known final head ${item.finalHeadSha}.`);
    }

    const allowedShas = new Set(
      [item.openingSnapshot.ref, item.finalHeadSha, item.mergeCommitSha, ...item.commitShas].filter(
        (sha): sha is string => Boolean(sha),
      ),
    );
    for (const citedSha of citedShas(section)) {
      if (![...allowedShas].some((allowed) => allowed.startsWith(citedSha) || citedSha.startsWith(allowed))) {
        warnings.push(`PR \`${item.repo}#${item.number}\` cites unknown commit SHA ${citedSha}.`);
      }
    }
  }
  return { warnings };
}

function findPrAnalysisSection(text: string, item: PrWorkItemSummary): string | null {
  const heading = `${item.repo}#${item.number}`;
  const match = new RegExp(`^###\\s+${escapeRegExp(heading)}\\s*$`, "mu").exec(text);
  if (!match || match.index === undefined) {
    return null;
  }
  const start = match.index;
  const rest = text.slice(start);
  const next = rest.slice(match[0].length).search(/^###\s+/mu);
  return next === -1 ? rest : rest.slice(0, match[0].length + next);
}

function countHeading(text: string, heading: string): number {
  return [...text.matchAll(new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "gmu"))].length;
}

function containsRef(text: string, ref: string): boolean {
  if (text.includes(ref)) {
    return true;
  }
  for (let length = Math.min(ref.length, 40); length >= 7; length -= 1) {
    if (text.includes(ref.slice(0, length))) {
      return true;
    }
  }
  return false;
}

function citedShas(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/\b(?<sha>[0-9a-f]{7,40})\b/giu)) {
    if (isNonEmptyString(match.groups?.sha)) {
      out.add(match.groups.sha);
    }
  }
  return [...out];
}

function formatWindowLine(window: RetrospectiveWindow | null | undefined, runTs: string): string {
  if (!window) {
    return `Window: _missing \`runs/${runTs}/window.json\`_`;
  }
  return `Window: ${window.since} to ${window.until} (${window.sinceSource} to ${window.untilSource})`;
}

function sourceFileName(runTs: string, kind: "session" | "pr"): string {
  return `${runTs}-${kind}-sources.md`;
}

function extractPrRepeatedPatterns(prAnalysis: string): string {
  const section = extractMarkdownSection(prAnalysis, "Recurring Corrective Patterns");
  return section ?? "_No recurring corrective-change patterns were extracted from per-PR analyses._";
}

function extractMarkdownSection(markdown: string, heading: string): string | null {
  const pattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "mu");
  const match = markdown.match(pattern);
  if (!match || match.index === undefined) {
    return null;
  }
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const next = rest.search(/^##\s+/mu);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/** Pull the leading `Target:` / `Confidence:` lines out of a free-form fix body. */
export function parseFixHeader(body: string): { target: string; confidence: string; rest: string } {
  let target = "unspecified";
  let confidence = "unspecified";
  const kept: string[] = [];
  for (const line of body.trim().split("\n")) {
    const targetMatch = /^\s*Target:\s*(?<target>.+)$/iu.exec(line);
    const confidenceMatch = /^\s*Confidence:\s*(?<confidence>.+)$/iu.exec(line);
    if (isNonEmptyString(targetMatch?.groups?.target)) {
      target = targetMatch.groups.target.trim();
    } else if (isNonEmptyString(confidenceMatch?.groups?.confidence)) {
      confidence = confidenceMatch.groups.confidence.trim();
    } else if (line.trim() !== "") {
      kept.push(line.trim());
    }
  }
  return { confidence, rest: kept.join(" "), target };
}

function episodesFor(fix: DurableFixProposal, episodes: FrictionEpisode[]): FrictionEpisode[] {
  return episodes.filter((episode) => fix.citedEpisodeRefs.includes(episode.id));
}

function renderEvidence(episode: FrictionEpisode, bundle: RepoBundle): string[] {
  const session = bundle.sessions.find((candidate) => candidate.sessionId === episode.sessionId);
  if (!session) {
    return ["(session not in bundle)"];
  }
  const byRef = new Map(session.turns.map((turn) => [turn.ref, turn]));
  return episode.citedTurnRefs.map((ref) => {
    const turn = byRef.get(ref);
    return turn ? `- ${ref}: ${renderTurn(turn)}` : `- ${ref}: (missing)`;
  });
}

function renderTurn(turn: CanonicalTurn): string {
  if (turn.kind === "tool_call") {
    const status = isNonEmptyString(turn.error) ? ` [${turn.error}]` : "";
    return `\`${turn.name}\` ${turn.inputSummary}${status}`;
  }
  return `**${turn.kind}:** ${firstLine(turn.text)}`;
}

function indentBody(body: string): string {
  return body.trim().split("\n").join("\n  ");
}

function firstLine(text: string): string {
  const line = text.split("\n").find((entry) => entry.trim()) ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
