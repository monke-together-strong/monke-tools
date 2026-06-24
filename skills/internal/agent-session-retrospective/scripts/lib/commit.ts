import { existsSync, readFileSync } from "node:fs";

import {
  cleanRunDir,
  listBundleHashes,
  loadFrozenSession,
  loadRepoMeta,
  readBundle,
  readFindings,
  retroHome,
  saveFrozenSession,
  saveRepoMeta,
  writeReport,
} from "./store.ts";
import type {
  BundleSession,
  CanonicalTurn,
  DurableFixProposal,
  FrictionEpisode,
  FrozenSessionRecord,
  RepeatedAskCluster,
  RepoBundle,
  RepoFindings,
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
    const refsValid = refs && episode.citedTurnRefs.every((ref) => refs.has(ref));
    if (!episode.id || seenIds.has(episode.id) || !refsValid) {
      droppedEpisodes += 1;
      continue;
    }
    seenIds.add(episode.id);
    episodes.push(episode);
  }

  const fixes: DurableFixProposal[] = [];
  let droppedFixes = 0;
  for (const fix of findings.durableFixProposals ?? []) {
    if (fix.citedEpisodeRefs.length > 0 && fix.citedEpisodeRefs.every((ref) => seenIds.has(ref))) {
      fixes.push(fix);
    } else {
      droppedFixes += 1;
    }
  }

  const bundleSessionIds = new Set(bundle.sessions.map((session) => session.sessionId));
  const repeatedAsks = (findings.repeatedAsks ?? []).map((cluster) => ({
    ...cluster,
    exampleSessionIds: cluster.exampleSessionIds.filter((id) => bundleSessionIds.has(id)),
  }));

  return {
    repoKey: findings.repoKey,
    episodes,
    fixes,
    repeatedAsks,
    dropped: { episodes: droppedEpisodes, fixes: droppedFixes },
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
  frozenSessions: number;
  appendedSessions: number;
  dropped: { episodes: number; fixes: number };
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
          id: `${options.runTs}:${episode.id}`,
          citedTurnRefs: episode.citedTurnRefs,
          body: episode.body,
        }));
      const record: FrozenSessionRecord = {
        version: 1,
        sessionId: session.sessionId,
        agent: session.agent,
        repoKey: slice.bundle.repoKey,
        secondary: secondaryRootsOf(session, slices),
        lastTurnIndex: session.turns.length,
        contentHash: session.contentHash,
        analyzedAt: options.nowIso,
        friction: [...(prior?.friction ?? []), ...newFriction],
        rawUserMessages: session.rawUserMessages,
      };
      saveFrozenSession(root, record);
      const repoMeta = loadRepoMeta(root, slice.bundle.repoKey);
      saveRepoMeta(root, {
        version: 1,
        repoKey: slice.bundle.repoKey,
        firstSeenAt: repoMeta?.firstSeenAt ?? options.nowIso,
        lastAnalyzedAt: options.nowIso,
      });
      if (prior) {
        appendedSessions += 1;
      } else {
        frozenSessions += 1;
      }
    }
  }

  const synthesis =
    options.synthesisPath && existsSync(options.synthesisPath)
      ? readFileSync(options.synthesisPath, "utf8").trim()
      : "";
  const report = buildReport(options.runTs, synthesis, slices);
  const reportPath = writeReport(root, options.runTs, report);
  cleanRunDir(root, options.runTs);

  return { reportPath, frozenSessions, appendedSessions, dropped };
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
  return [...roots].sort();
}

// --- report (action-first, design decision 16) -------------------------------

export function buildReport(runTs: string, synthesis: string, slices: RepoSlice[]): string {
  const out: string[] = [];
  out.push(`# Agent session retrospective — ${runTs}`);
  out.push("");

  out.push("## Global cross-repo proposals");
  out.push("");
  out.push(synthesis || "_No cross-repo synthesis provided for this run._");
  out.push("");

  out.push("## Per-repo proposals");
  out.push("");
  const reposWithSignal = slices.filter(
    (slice) => slice.validated.fixes.length > 0 || slice.validated.repeatedAsks.length > 0,
  );
  if (reposWithSignal.length === 0) {
    out.push("_No per-repo proposals this run._");
    out.push("");
  }
  for (const slice of reposWithSignal) {
    out.push(`### ${slice.validated.repoKey}`);
    out.push("");
    for (const fix of slice.validated.fixes) {
      const { target, confidence, rest } = parseFixHeader(fix.body);
      out.push(`- **${target}** · _${confidence}_ — ${indentBody(rest)}`);
      const evidence = episodesFor(fix, slice.validated.episodes).flatMap((episode) =>
        renderEvidence(episode, slice.bundle),
      );
      if (evidence.length > 0) {
        out.push("  <details><summary>evidence</summary>");
        out.push("");
        out.push(evidence.map((line) => `  ${line}`).join("\n"));
        out.push("");
        out.push("  </details>");
      }
    }
    if (slice.validated.repeatedAsks.length > 0) {
      out.push("");
      out.push("**Repeated asks**");
      for (const cluster of slice.validated.repeatedAsks) {
        out.push(`- **${cluster.label}** — ${firstLine(cluster.body)}`);
      }
    }
    out.push("");
  }

  out.push("## Audit appendix — friction episodes");
  out.push("");
  const seenEpisodes = new Set<string>();
  for (const slice of slices) {
    for (const episode of slice.validated.episodes) {
      const dedupeKey = `${episode.sessionId}|${[...episode.citedTurnRefs].sort().join(",")}`;
      if (seenEpisodes.has(dedupeKey)) {
        continue;
      }
      seenEpisodes.add(dedupeKey);
      out.push(
        `- \`${slice.validated.repoKey}\` · ${episode.sessionId.slice(0, 8)} · refs ${episode.citedTurnRefs.join(", ")}`,
      );
      out.push(`  ${firstLine(episode.body)}`);
    }
  }
  out.push("");

  return out.join("\n");
}

/** Pull the leading `Target:` / `Confidence:` lines out of a free-form fix body. */
export function parseFixHeader(body: string): { target: string; confidence: string; rest: string } {
  let target = "unspecified";
  let confidence = "unspecified";
  const kept: string[] = [];
  for (const line of body.trim().split("\n")) {
    const targetMatch = line.match(/^\s*Target:\s*(.+)$/i);
    const confidenceMatch = line.match(/^\s*Confidence:\s*(.+)$/i);
    if (targetMatch) {
      target = targetMatch[1].trim();
    } else if (confidenceMatch) {
      confidence = confidenceMatch[1].trim();
    } else if (line.trim()) {
      kept.push(line.trim());
    }
  }
  return { target, confidence, rest: kept.join(" ") };
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
    const status = turn.error ? ` [${turn.error}]` : "";
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
