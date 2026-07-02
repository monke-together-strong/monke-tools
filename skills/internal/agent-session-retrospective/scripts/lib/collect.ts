import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { discoverSessionFiles, parseSessionFile, type DiscoverOptions } from "./collectors.ts";
import { hashKey, resolveRepoKey, sessionHashKey } from "./identity.ts";
import {
  listReportPaths,
  listFrozenSessions,
  loadFrozenSession,
  retroHome,
  writeBundle,
  writeRunWindow,
} from "./store.ts";
import type {
  BundleSession,
  CanonicalSession,
  FrozenSessionRecord,
  RepoBundle,
  RetrospectiveWindow,
} from "./types.ts";

export interface EligibilityInput {
  nowMs: number;
  idleMs: number;
  activityMs: number;
  sinceMs?: number;
  untilMs?: number;
}

export type Eligibility =
  | { include: false; reason: string }
  | { include: true; firstNewTurnIndex: number; priorFindingCount: number };

/**
 * Decide whether a session is eligible for analysis this run: inside the window,
 * idle long enough, and either never analyzed or grown since it was frozen.
 */
export function decideEligibility(
  session: CanonicalSession,
  prior: FrozenSessionRecord | null,
  input: EligibilityInput,
): Eligibility {
  if (session.turns.length === 0) {
    return { include: false, reason: "empty" };
  }
  if (input.sinceMs !== undefined && input.activityMs < input.sinceMs) {
    return { include: false, reason: "before-window" };
  }
  if (input.untilMs !== undefined && input.activityMs > input.untilMs) {
    return { include: false, reason: "after-window" };
  }
  if (input.nowMs - input.activityMs < input.idleMs) {
    return { include: false, reason: "not-idle" };
  }
  if (prior) {
    if (prior.contentHash === session.contentHash || prior.lastTurnIndex >= session.turns.length) {
      return { include: false, reason: "frozen-unchanged" };
    }
    return {
      include: true,
      firstNewTurnIndex: prior.lastTurnIndex,
      priorFindingCount: prior.friction.length,
    };
  }
  return { include: true, firstNewTurnIndex: 0, priorFindingCount: 0 };
}

export interface EligibleSession {
  session: CanonicalSession;
  primaryRepo: string;
  firstNewTurnIndex: number;
  priorFindingCount: number;
}

const PRIOR_DIGEST_LIMIT = 20;

/** Group eligible sessions into one bundle per repo (primary + secondary). */
export function buildBundles(
  runTs: string,
  eligibles: EligibleSession[],
  frozen: FrozenSessionRecord[],
): RepoBundle[] {
  const byRepo = new Map<string, RepoBundle>();

  const bundleFor = (repoKey: string): RepoBundle => {
    let bundle = byRepo.get(repoKey);
    if (!bundle) {
      bundle = {
        runTs,
        repoKey,
        repoHash: hashKey(repoKey),
        sessions: [],
        priorFrictionDigest: digestFor(repoKey, frozen),
      };
      byRepo.set(repoKey, bundle);
    }
    return bundle;
  };

  for (const eligible of eligibles) {
    const { session } = eligible;
    const base: Omit<BundleSession, "role"> = {
      agent: session.agent,
      sessionId: session.sessionId,
      sessionHash: sessionHashKey(session.agent, session.sessionId),
      firstNewTurnIndex: eligible.firstNewTurnIndex,
      priorFindingCount: eligible.priorFindingCount,
      contentHash: session.contentHash,
      turns: session.turns,
      rawUserMessages: session.rawUserMessages,
    };
    bundleFor(eligible.primaryRepo).sessions.push({ ...base, role: "primary" });
    for (const secondary of session.touchedRoots) {
      if (secondary !== eligible.primaryRepo) {
        bundleFor(secondary).sessions.push({ ...base, role: "secondary" });
      }
    }
  }

  return [...byRepo.values()].sort((a, b) => a.repoKey.localeCompare(b.repoKey));
}

function digestFor(repoKey: string, frozen: FrozenSessionRecord[]): string[] {
  const lines: string[] = [];
  for (const record of frozen) {
    if (record.repoKey !== repoKey) {
      continue;
    }
    for (const friction of record.friction) {
      lines.push(`${record.sessionId.slice(0, 8)}: ${firstLine(friction.body)}`);
    }
  }
  return lines.slice(-PRIOR_DIGEST_LIMIT);
}

function firstLine(text: string): string {
  const line = text.split("\n").find((entry) => entry.trim()) ?? "";
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

export interface RunCollectOptions extends DiscoverOptions {
  retroRoot?: string;
  nowMs?: number;
  idleMinutes?: number;
  sinceMs?: number;
  untilMs?: number;
  runTs: string;
}

export interface CollectResult {
  runTs: string;
  window: RetrospectiveWindow;
  bundles: { repoKey: string; repoHash: string; sessionCount: number; path: string }[];
  skipped: Record<string, number>;
}

interface ResolvedWindow {
  window: RetrospectiveWindow;
  sinceMs: number;
  untilMs: number;
}

const FIRST_RUN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export function resolveRetrospectiveWindow(
  root: string,
  input: { nowMs: number; sinceMs?: number; untilMs?: number },
): ResolvedWindow {
  const untilMs = input.untilMs ?? input.nowMs;
  const untilSource = input.untilMs === undefined ? "now" : "explicit";
  let sinceMs: number;
  let sinceSource: RetrospectiveWindow["sinceSource"];

  if (input.sinceMs !== undefined) {
    sinceMs = input.sinceMs;
    sinceSource = "explicit";
  } else {
    const previousReportMs = newestReportCursorMs(root);
    if (previousReportMs !== undefined) {
      sinceMs = previousReportMs;
      sinceSource = "previous-report";
    } else {
      sinceMs = untilMs - FIRST_RUN_WINDOW_MS;
      sinceSource = "first-run-default";
    }
  }

  if (sinceMs > untilMs) {
    throw new Error(
      `Invalid retrospective window: since ${new Date(sinceMs).toISOString()} is after until ${new Date(
        untilMs,
      ).toISOString()}`,
    );
  }

  return {
    sinceMs,
    untilMs,
    window: {
      since: new Date(sinceMs).toISOString(),
      until: new Date(untilMs).toISOString(),
      sinceSource,
      untilSource,
    },
  };
}

function newestReportCursorMs(root: string): number | undefined {
  const reports = listReportPaths(root).sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
  for (const reportPath of reports) {
    const fromWindow = parseReportWindowUntilMs(reportPath);
    if (fromWindow !== undefined) {
      return fromWindow;
    }
    const basename = path.basename(reportPath, "-retrospective.md");
    const fromName = parseRunTimestampMs(basename);
    if (fromName !== undefined) {
      return fromName;
    }
  }
  return undefined;
}

function parseReportWindowUntilMs(reportPath: string): number | undefined {
  let content: string;
  try {
    content = readFileSync(reportPath, "utf8");
  } catch {
    return undefined;
  }
  const match = content.match(/^Window:\s+\S+\s+to\s+(\S+)/m);
  if (!match) {
    return undefined;
  }
  const until = match[1];
  if (!until) {
    return undefined;
  }
  const parsed = Date.parse(until);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseRunTimestampMs(value: string): number | undefined {
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) {
    return direct;
  }
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z$/);
  if (!match) {
    return undefined;
  }
  const iso = `${match[1]}${match[2]}:${match[3]}:${match[4]}.${match[5] ?? "000"}Z`;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Disk-driven collect: discover, normalize, gate, group, write bundles. */
export function runCollect(options: RunCollectOptions): CollectResult {
  const root = options.retroRoot ?? retroHome(options.home);
  const nowMs = options.nowMs ?? Date.now();
  const idleMs = (options.idleMinutes ?? 45) * 60_000;
  const resolvedWindow = resolveRetrospectiveWindow(root, {
    nowMs,
    sinceMs: options.sinceMs,
    untilMs: options.untilMs,
  });
  const skipped: Record<string, number> = {};
  const bump = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  // Dedupe by (agent, session_id): a resumed/archived transcript can exist as
  // several files for one session. Keep the most complete copy so the session is
  // analyzed and frozen exactly once.
  const bySession = new Map<string, CanonicalSession>();
  for (const file of discoverSessionFiles(options)) {
    let session: CanonicalSession | null;
    try {
      session = parseSessionFile(file);
    } catch {
      bump("parse-error");
      continue;
    }
    if (!session) {
      bump("unparseable");
      continue;
    }
    const key = `${session.agent}\u0000${session.sessionId}`;
    const existing = bySession.get(key);
    if (!existing) {
      bySession.set(key, session);
    } else if (session.turns.length > existing.turns.length) {
      bump("duplicate-file");
      bySession.set(key, session);
    } else {
      bump("duplicate-file");
    }
  }

  const eligibles: EligibleSession[] = [];
  for (const session of bySession.values()) {
    const activityMs = sessionActivityMs(session);
    const prior = loadFrozenSession(root, session.agent, session.sessionId);
    const decision = decideEligibility(session, prior, {
      nowMs,
      idleMs,
      activityMs,
      sinceMs: resolvedWindow.sinceMs,
      untilMs: resolvedWindow.untilMs,
    });
    if (!decision.include) {
      bump(decision.reason);
      continue;
    }
    eligibles.push({
      session,
      primaryRepo: session.cwd ? resolveRepoKey(session.cwd) : (session.cwd ?? "unknown"),
      firstNewTurnIndex: decision.firstNewTurnIndex,
      priorFindingCount: decision.priorFindingCount,
    });
  }

  const bundles = buildBundles(options.runTs, eligibles, listFrozenSessions(root));
  writeRunWindow(root, options.runTs, resolvedWindow.window);
  return {
    runTs: options.runTs,
    window: resolvedWindow.window,
    bundles: bundles.map((bundle) => ({
      repoKey: bundle.repoKey,
      repoHash: bundle.repoHash,
      sessionCount: bundle.sessions.length,
      path: writeBundle(root, bundle),
    })),
    skipped,
  };
}

function sessionActivityMs(session: CanonicalSession): number {
  if (session.lastActivityAt) {
    const parsed = Date.parse(session.lastActivityAt);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  try {
    return statSync(session.filePath).mtimeMs;
  } catch {
    return 0;
  }
}
