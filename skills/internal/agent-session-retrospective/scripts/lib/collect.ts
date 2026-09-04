import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { isNonEmptyString } from "@sindresorhus/is";

import { discoverSessionFiles, parseSessionFile } from './collectors.ts';
import type { DiscoverOptions } from './collectors.ts';
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
  activityMs: number;
  idleMs: number;
  nowMs: number;
  sinceMs?: number;
  untilMs?: number;
}

export type Eligibility =
  | { include: false; reason: string }
  | { firstNewTurnIndex: number; include: true; priorFindingCount: number };

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
      firstNewTurnIndex: prior.lastTurnIndex,
      include: true,
      priorFindingCount: prior.friction.length,
    };
  }
  return { firstNewTurnIndex: 0, include: true, priorFindingCount: 0 };
}

export interface EligibleSession {
  firstNewTurnIndex: number;
  primaryRepo: string;
  priorFindingCount: number;
  secondaryRepos: string[];
  session: CanonicalSession;
}

export interface SessionMembership {
  primaryRepo: string;
  secondaryRepos: string[];
}

const PRIOR_DIGEST_LIMIT = 20;
const SESSION_ID_PREFIX_LENGTH = 8;
const DIGEST_LINE_MAX_LENGTH = 140;
const DEFAULT_IDLE_MINUTES = 45;
const MILLISECONDS_PER_MINUTE = 60_000;

/** Group eligible sessions into one bundle per repo (primary + secondary). */
export function buildBundles(
  runTs: string,
  eligibles: EligibleSession[],
  frozen: FrozenSessionRecord[],
) {
  const byRepo = new Map<string, RepoBundle>();

  const bundleFor = (repoKey: string) => {
    let bundle = byRepo.get(repoKey);
    if (!bundle) {
      bundle = {
        priorFrictionDigest: digestFor(repoKey, frozen),
        repoHash: hashKey(repoKey),
        repoKey,
        runTs,
        sessions: [],
      };
      byRepo.set(repoKey, bundle);
    }
    return bundle;
  };

  for (const eligible of eligibles) {
    const { session } = eligible;
    const base: Omit<BundleSession, "role"> = {
      agent: session.agent,
      contentHash: session.contentHash,
      firstNewTurnIndex: eligible.firstNewTurnIndex,
      parentSessionId: session.parentSessionId,
      priorFindingCount: eligible.priorFindingCount,
      rawUserMessages: session.rawUserMessages,
      sessionHash: sessionHashKey(session.agent, session.sessionId),
      sessionId: session.sessionId,
      threadSource: session.threadSource,
      turns: session.turns,
    };
    bundleFor(eligible.primaryRepo).sessions.push({ ...base, role: "primary" });
    for (const secondary of eligible.secondaryRepos) {
      if (secondary !== eligible.primaryRepo) {
        bundleFor(secondary).sessions.push({ ...base, role: "secondary" });
      }
    }
  }

  return [...byRepo.values()].toSorted((a, b) => a.repoKey.localeCompare(b.repoKey));
}

/** Resolve each transcript's repo membership, including inherited parent membership. */
export function resolveSessionMembership(
  sessions: CanonicalSession[],
) {
  const bySession = new Map(sessions.map((session) => [sessionKey(session), session]));
  const resolved = new Map<string, SessionMembership>();
  const resolving = new Set<string>();

  const resolve = (session: CanonicalSession) => {
    const key = sessionKey(session);
    const existing = resolved.get(key);
    if (existing) {
      return existing;
    }

    const ownPrimary = isNonEmptyString(session.cwd) ? resolveRepoKey(session.cwd) : "unknown";
    let primaryRepo = ownPrimary;
    const secondaryRepos = new Set(session.touchedRoots);
    if (!resolving.has(key) && isNonEmptyString(session.parentSessionId)) {
      resolving.add(key);
      const parent = bySession.get(`${session.agent}\u0000${session.parentSessionId}`);
      if (parent) {
        const parentMembership = resolve(parent);
        const {
          primaryRepo: parentPrimaryRepo,
          secondaryRepos: parentSecondaryRepos,
        } = parentMembership;
        if (primaryRepo === "unknown") {
          primaryRepo = parentPrimaryRepo;
        } else if (parentPrimaryRepo !== "unknown") {
          secondaryRepos.add(parentPrimaryRepo);
        }
        for (const repo of parentSecondaryRepos) {
          secondaryRepos.add(repo);
        }
      }
      resolving.delete(key);
    }

    secondaryRepos.delete(primaryRepo);
    secondaryRepos.delete("unknown");
    const membership = { primaryRepo, secondaryRepos: [...secondaryRepos].toSorted() };
    resolved.set(key, membership);
    return membership;
  };

  for (const session of sessions) {
    resolve(session);
  }
  return resolved;
}

function sessionKey(session: Pick<CanonicalSession, "agent" | "sessionId">) {
  return `${session.agent}\u0000${session.sessionId}`;
}

function digestFor(repoKey: string, frozen: FrozenSessionRecord[]) {
  const lines: string[] = [];
  for (const record of frozen) {
    if (record.repoKey !== repoKey) {
      continue;
    }
    for (const friction of record.friction) {
      lines.push(
        `${record.sessionId.slice(0, SESSION_ID_PREFIX_LENGTH)}: ${firstLine(friction.body)}`,
      );
    }
  }
  return lines.slice(-PRIOR_DIGEST_LIMIT);
}

function firstLine(text: string) {
  const line = text.split("\n").find((entry) => entry.trim()) ?? "";
  return line.length > DIGEST_LINE_MAX_LENGTH
    ? `${line.slice(0, DIGEST_LINE_MAX_LENGTH)}…`
    : line;
}

export interface RunCollectOptions extends DiscoverOptions {
  idleMinutes?: number;
  nowMs?: number;
  retroRoot?: string;
  runTs: string;
  sinceMs?: number;
  untilMs?: number;
}

interface ResolvedWindow {
  sinceMs: number;
  untilMs: number;
  window: RetrospectiveWindow;
}

const FIRST_RUN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export function resolveRetrospectiveWindow(
  root: string,
  input: { nowMs: number; sinceMs?: number; untilMs?: number },
): ResolvedWindow {
  const { sinceMs: inputSinceMs } = input;
  const untilMs = input.untilMs ?? input.nowMs;
  const untilSource = input.untilMs === undefined ? "now" : "explicit";
  let sinceMs: number;
  let sinceSource: RetrospectiveWindow["sinceSource"];

  if (inputSinceMs === undefined) {
    const previousReportMs = newestReportCursorMs(root);
    if (previousReportMs === undefined) {
      sinceMs = untilMs - FIRST_RUN_WINDOW_MS;
      sinceSource = "first-run-default";
    } else {
      sinceMs = previousReportMs;
      sinceSource = "previous-report";
    }
  } else {
    sinceMs = inputSinceMs;
    sinceSource = "explicit";
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
      sinceSource,
      until: new Date(untilMs).toISOString(),
      untilSource,
    },
  };
}

function newestReportCursorMs(root: string) {
  const reports = listReportPaths(root).toSorted((a, b) => path.basename(b).localeCompare(path.basename(a)));
  return reports
    .map((reportPath) => {
      const fromWindow = parseReportWindowUntilMs(reportPath);
      return fromWindow ?? parseRunTimestampMs(path.basename(reportPath, "-retrospective.md"));
    })
    .find((candidate) => candidate !== undefined);
}

function parseReportWindowUntilMs(reportPath: string) {
  let content: string;
  try {
    content = readFileSync(reportPath, "utf-8");
  } catch {
    return;
  }
  const match = /^Window:\s+\S+\s+to\s+(?<until>\S+)/mu.exec(content);
  if (!match?.groups) {
    return;
  }
  const { until } = match.groups;
  if (!isNonEmptyString(until)) {
    return;
  }
  const parsed = Date.parse(until);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseRunTimestampMs(value: string) {
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) {
    return direct;
  }
  const match =
    /^(?<date>\d{4}-\d{2}-\d{2}T)(?<hour>\d{2})-(?<minute>\d{2})-(?<second>\d{2})(?:-(?<millisecond>\d{3}))?Z$/u.exec(
      value,
    );
  if (!match?.groups) {
    return;
  }
  const { date, hour, millisecond = "000", minute, second } = match.groups;
  const iso = `${date}${hour}:${minute}:${second}.${millisecond}Z`;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Disk-driven collect: discover, normalize, gate, group, write bundles. */
export function runCollect(options: RunCollectOptions) {
  const root = options.retroRoot ?? retroHome(options.home);
  const nowMs = options.nowMs ?? Date.now();
  const idleMs =
    (options.idleMinutes ?? DEFAULT_IDLE_MINUTES) * MILLISECONDS_PER_MINUTE;
  const resolvedWindow = resolveRetrospectiveWindow(root, {
    nowMs,
    sinceMs: options.sinceMs,
    untilMs: options.untilMs,
  });
  const skipped: Record<string, number> = {};
  const bump = (reason: string) => {
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

  const memberships = resolveSessionMembership([...bySession.values()]);
  const eligibles: EligibleSession[] = [];
  for (const session of bySession.values()) {
    const activityMs = sessionActivityMs(session);
    const prior = loadFrozenSession(root, session.agent, session.sessionId);
    const decision = decideEligibility(session, prior, {
      activityMs,
      idleMs,
      nowMs,
      sinceMs: resolvedWindow.sinceMs,
      untilMs: resolvedWindow.untilMs,
    });
    if (!decision.include) {
      bump(decision.reason);
      continue;
    }
    const membership = memberships.get(sessionKey(session));
    if (!membership) {
      bump("missing-membership");
      continue;
    }
    eligibles.push({
      firstNewTurnIndex: decision.firstNewTurnIndex,
      primaryRepo: membership.primaryRepo,
      priorFindingCount: decision.priorFindingCount,
      secondaryRepos: membership.secondaryRepos,
      session,
    });
  }

  const bundles = buildBundles(options.runTs, eligibles, listFrozenSessions(root));
  writeRunWindow(root, options.runTs, resolvedWindow.window);
  return {
    bundles: bundles.map((bundle) => ({
      path: writeBundle(root, bundle),
      repoHash: bundle.repoHash,
      repoKey: bundle.repoKey,
      sessionCount: bundle.sessions.length,
    })),
    runTs: options.runTs,
    skipped,
    window: resolvedWindow.window,
  };
}

function sessionActivityMs(session: CanonicalSession) {
  if (isNonEmptyString(session.lastActivityAt)) {
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
