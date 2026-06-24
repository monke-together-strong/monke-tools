import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  parseClaudeSession,
  parseCodexSession,
} from "../skills/internal/agent-session-retrospective/scripts/lib/collectors.ts";
import {
  buildBundles,
  decideEligibility,
  runCollect,
  type EligibleSession,
} from "../skills/internal/agent-session-retrospective/scripts/lib/collect.ts";
import {
  buildReport,
  parseFixHeader,
  validateFindings,
} from "../skills/internal/agent-session-retrospective/scripts/lib/commit.ts";
import {
  loadFrozenSession,
  saveFrozenSession,
} from "../skills/internal/agent-session-retrospective/scripts/lib/store.ts";
import { summarizeOutput } from "../skills/internal/agent-session-retrospective/scripts/lib/normalize.ts";
import type {
  CanonicalSession,
  FrozenSessionRecord,
  RepoBundle,
  RepoFindings,
} from "../skills/internal/agent-session-retrospective/scripts/lib/types.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "retro-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function jsonl(lines: unknown[]): string {
  const filePath = path.join(dir, "transcript.jsonl");
  writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  return filePath;
}

describe("normalize", () => {
  test("summarizeOutput keeps head and tail and elides the middle", () => {
    const summary = summarizeOutput("A".repeat(400) + "MIDDLE" + "B".repeat(400));
    expect(summary).toContain("chars elided");
    expect(summary?.startsWith("A")).toBe(true);
    expect(summary?.endsWith("B")).toBe(true);
    expect(summary).not.toContain("MIDDLE");
  });
});

describe("Codex collector", () => {
  test("builds an ordered user/assistant/tool arc with a parsed exit code", () => {
    const filePath = jsonl([
      {
        timestamp: "2026-05-26T10:00:00Z",
        type: "session_meta",
        payload: { id: "sess-1", cwd: dir },
      },
      {
        timestamp: "2026-05-26T10:00:01Z",
        type: "event_msg",
        payload: { type: "user_message", message: "do the thing" },
      },
      {
        timestamp: "2026-05-26T10:00:02Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "on it" },
      },
      {
        timestamp: "2026-05-26T10:00:03Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"ls"}',
          call_id: "c1",
        },
      },
      {
        timestamp: "2026-05-26T10:00:04Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "c1",
          output: "Process exited with code 1\nboom",
        },
      },
    ]);

    const session = parseCodexSession(filePath);
    expect(session?.sessionId).toBe("sess-1");
    expect(session?.turns.map((turn) => turn.kind)).toEqual(["user", "assistant", "tool_call"]);
    expect(session?.turns.map((turn) => turn.ref)).toEqual(["t0", "t1", "t2"]);
    expect(session?.rawUserMessages).toEqual(["do the thing"]);
    const tool = session?.turns[2];
    expect(tool?.kind === "tool_call" && tool.exitCode).toBe(1);
    expect(tool?.kind === "tool_call" && tool.error).toBe("exit 1");
  });
});

describe("Claude collector", () => {
  test("pairs tool_use to tool_result and drops isMeta + tool-result envelopes from prose", () => {
    const filePath = jsonl([
      {
        type: "user",
        sessionId: "cs-1",
        cwd: dir,
        timestamp: "2026-05-26T10:00:00Z",
        message: { role: "user", content: "please fix" },
      },
      {
        type: "assistant",
        sessionId: "cs-1",
        timestamp: "2026-05-26T10:00:01Z",
        message: {
          content: [
            { type: "text", text: "sure" },
            { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
      {
        type: "user",
        sessionId: "cs-1",
        timestamp: "2026-05-26T10:00:02Z",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok", is_error: false }],
        },
      },
      {
        type: "user",
        sessionId: "cs-1",
        isMeta: true,
        timestamp: "2026-05-26T10:00:03Z",
        message: { content: [{ type: "text", text: "<system-reminder>noise" }] },
      },
    ]);

    const session = parseClaudeSession(filePath);
    expect(session?.turns.map((turn) => turn.kind)).toEqual(["user", "assistant", "tool_call"]);
    expect(session?.rawUserMessages).toEqual(["please fix"]);
    const tool = session?.turns[2];
    expect(tool?.kind === "tool_call" && tool.outputHeadTail).toBe("ok");
  });
});

function fakeSession(overrides: Partial<CanonicalSession> = {}): CanonicalSession {
  return {
    agent: "codex",
    sessionId: "s1",
    filePath: "/x.jsonl",
    cwd: "/repo",
    startedAt: "2026-05-26T10:00:00Z",
    lastActivityAt: "2026-05-26T10:00:00Z",
    sourceLineCount: 10,
    contentHash: "hash-v1",
    touchedRoots: [],
    turns: [{ kind: "user", ref: "t0", text: "hi" }],
    rawUserMessages: ["hi"],
    ...overrides,
  };
}

describe("decideEligibility", () => {
  const base = { nowMs: 1000 * 60 * 100, idleMs: 60_000, activityMs: 0 };

  test("never-analyzed idle session is eligible from turn 0", () => {
    expect(decideEligibility(fakeSession(), null, base)).toEqual({
      include: true,
      firstNewTurnIndex: 0,
      priorFindingCount: 0,
    });
  });

  test("too-fresh session is gated", () => {
    const result = decideEligibility(fakeSession(), null, { ...base, activityMs: base.nowMs });
    expect(result).toEqual({ include: false, reason: "not-idle" });
  });

  test("outside the window is skipped", () => {
    const result = decideEligibility(fakeSession(), null, { ...base, sinceMs: base.nowMs });
    expect(result).toEqual({ include: false, reason: "before-window" });
  });

  test("frozen and unchanged is skipped; grown re-qualifies as delta", () => {
    const prior: FrozenSessionRecord = {
      version: 1,
      sessionId: "s1",
      agent: "codex",
      repoKey: "/repo",
      secondary: [],
      lastTurnIndex: 1,
      contentHash: "hash-v1",
      analyzedAt: "x",
      friction: [{ id: "e1", citedTurnRefs: ["t0"], body: "b" }],
      rawUserMessages: [],
    };
    expect(decideEligibility(fakeSession(), prior, base)).toEqual({
      include: false,
      reason: "frozen-unchanged",
    });

    const grown = fakeSession({
      contentHash: "hash-v2",
      turns: [
        { kind: "user", ref: "t0", text: "hi" },
        { kind: "assistant", ref: "t1", text: "more" },
      ],
    });
    expect(decideEligibility(grown, prior, base)).toEqual({
      include: true,
      firstNewTurnIndex: 1,
      priorFindingCount: 1,
    });
  });
});

describe("buildBundles", () => {
  test("a session lands in its primary bundle and each secondary bundle", () => {
    const eligible: EligibleSession = {
      session: fakeSession({ touchedRoots: ["/other"] }),
      primaryRepo: "/repo",
      firstNewTurnIndex: 0,
      priorFindingCount: 0,
    };
    const bundles = buildBundles("ts", [eligible], []);
    const byRepo = Object.fromEntries(bundles.map((bundle) => [bundle.repoKey, bundle]));
    expect(byRepo["/repo"].sessions[0].role).toBe("primary");
    expect(byRepo["/other"].sessions[0].role).toBe("secondary");
  });
});

function bundleWith(refs: string[]): RepoBundle {
  return {
    runTs: "ts",
    repoKey: "/repo",
    repoHash: "rh",
    sessions: [
      {
        agent: "codex",
        sessionId: "s1",
        sessionHash: "sh",
        role: "primary",
        firstNewTurnIndex: 0,
        priorFindingCount: 0,
        contentHash: "ch",
        turns: refs.map((ref) => ({ kind: "user", ref, text: ref })),
        rawUserMessages: [],
      },
    ],
    priorFrictionDigest: [],
  };
}

describe("validateFindings", () => {
  test("drops episodes citing missing turns and fixes citing missing episodes", () => {
    const bundle = bundleWith(["t0", "t1"]);
    const findings: RepoFindings = {
      repoKey: "/repo",
      frictionEpisodes: [
        { id: "e1", sessionId: "s1", citedTurnRefs: ["t0"], body: "good" },
        { id: "e2", sessionId: "s1", citedTurnRefs: ["t9"], body: "bad ref" },
        { id: "e3", sessionId: "ghost", citedTurnRefs: ["t0"], body: "bad session" },
      ],
      durableFixProposals: [
        { citedEpisodeRefs: ["e1"], body: "keeps" },
        { citedEpisodeRefs: ["e2"], body: "drops — e2 was invalid" },
        { citedEpisodeRefs: [], body: "drops — no citation" },
      ],
      repeatedAsks: [],
    };

    const result = validateFindings(findings, bundle);
    expect(result.episodes.map((episode) => episode.id)).toEqual(["e1"]);
    expect(result.fixes.map((fix) => fix.body)).toEqual(["keeps"]);
    expect(result.dropped).toEqual({ episodes: 2, fixes: 2 });
  });

  test("drops episodes authored for a secondary session (friction is primary-only)", () => {
    const bundle = bundleWith(["t0"]);
    bundle.sessions[0].role = "secondary";
    const findings: RepoFindings = {
      repoKey: "/repo",
      frictionEpisodes: [{ id: "e1", sessionId: "s1", citedTurnRefs: ["t0"], body: "secondary" }],
      durableFixProposals: [],
      repeatedAsks: [],
    };
    const result = validateFindings(findings, bundle);
    expect(result.episodes).toHaveLength(0);
    expect(result.dropped.episodes).toBe(1);
  });

  test("filters unknown session ids out of repeated-ask clusters", () => {
    const bundle = bundleWith(["t0"]);
    const findings: RepoFindings = {
      repoKey: "/repo",
      frictionEpisodes: [],
      durableFixProposals: [],
      repeatedAsks: [{ label: "x", exampleSessionIds: ["s1", "ghost"], body: "b" }],
    };
    const result = validateFindings(findings, bundle);
    expect(result.repeatedAsks[0].exampleSessionIds).toEqual(["s1"]);
  });
});

describe("parseFixHeader", () => {
  test("extracts Target and Confidence and returns the remaining prose", () => {
    expect(parseFixHeader("Target: hook\nConfidence: high\n\nthe actual fix")).toEqual({
      target: "hook",
      confidence: "high",
      rest: "the actual fix",
    });
  });
});

describe("buildReport", () => {
  test("leads with global synthesis, then per-repo proposals, then audit", () => {
    const bundle = bundleWith(["t0"]);
    const report = buildReport("ts", "GLOBAL-SYNTHESIS", [
      {
        bundle,
        validated: {
          repoKey: "/repo",
          episodes: [{ id: "e1", sessionId: "s1", citedTurnRefs: ["t0"], body: "episode body" }],
          fixes: [{ citedEpisodeRefs: ["e1"], body: "Target: hook\nConfidence: high\nfix body" }],
          repeatedAsks: [],
          dropped: { episodes: 0, fixes: 0 },
        },
      },
    ]);

    const globalAt = report.indexOf("GLOBAL-SYNTHESIS");
    const perRepoAt = report.indexOf("Per-repo proposals");
    const auditAt = report.indexOf("Audit appendix");
    expect(globalAt).toBeGreaterThan(-1);
    expect(globalAt).toBeLessThan(perRepoAt);
    expect(perRepoAt).toBeLessThan(auditAt);
    expect(report).toContain("fix body");
    // A surviving episode's evidence must always resolve to real turns.
    expect(report).not.toContain("(missing)");
  });

  test("renders Target/Confidence header and a single merged evidence block", () => {
    const bundle = bundleWith(["t0", "t1"]);
    const report = buildReport("ts", "", [
      {
        bundle,
        validated: {
          repoKey: "/repo",
          episodes: [
            { id: "e1", sessionId: "s1", citedTurnRefs: ["t0"], body: "a" },
            { id: "e2", sessionId: "s1", citedTurnRefs: ["t1"], body: "b" },
          ],
          fixes: [
            { citedEpisodeRefs: ["e1", "e2"], body: "Target: skill\nConfidence: medium\nmerge me" },
          ],
          repeatedAsks: [],
          dropped: { episodes: 0, fixes: 0 },
        },
      },
    ]);
    expect(report).toContain("**skill** · _medium_ — merge me");
    expect(report.match(/<summary>evidence<\/summary>/g)).toHaveLength(1);
  });
});

describe("runCollect dedupe", () => {
  test("two files for one session_id collapse to the most-complete copy", () => {
    const codexRoot = path.join(dir, "codex");
    const dayDir = path.join(codexRoot, "sessions", "2026", "05", "26");
    mkdirSync(dayDir, { recursive: true });
    const writeCodex = (name: string, turns: number): void => {
      const lines: unknown[] = [
        {
          timestamp: "2026-05-26T10:00:00Z",
          type: "session_meta",
          payload: { id: "dup-1", cwd: dir },
        },
      ];
      for (let i = 0; i < turns; i += 1) {
        lines.push({
          timestamp: "2026-05-26T10:00:01Z",
          type: "event_msg",
          payload: { type: "user_message", message: `turn ${i}` },
        });
      }
      writeFileSync(path.join(dayDir, name), lines.map((line) => JSON.stringify(line)).join("\n"));
    };
    writeCodex("short.jsonl", 2);
    writeCodex("long.jsonl", 5);

    const result = runCollect({
      retroRoot: path.join(dir, "store"),
      runTs: "ts",
      codexRoot,
      claudeRoot: path.join(dir, "nope"),
      idleMinutes: 0,
      nowMs: Date.parse("2026-06-01T00:00:00Z"),
    });

    const sessions = result.bundles.reduce((sum, bundle) => sum + bundle.sessionCount, 0);
    expect(sessions).toBe(1);
    expect(result.skipped["duplicate-file"]).toBe(1);
  });
});

describe("store freeze roundtrip", () => {
  test("save then load returns the same frozen record", () => {
    const record: FrozenSessionRecord = {
      version: 1,
      sessionId: "s1",
      agent: "claude",
      repoKey: "/repo",
      secondary: ["/other"],
      lastTurnIndex: 5,
      contentHash: "h",
      analyzedAt: "2026-05-26T10:00:00Z",
      friction: [{ id: "ts:e1", citedTurnRefs: ["t0"], body: "b" }],
      rawUserMessages: ["hi"],
    };
    saveFrozenSession(dir, record);
    expect(loadFrozenSession(dir, "claude", "s1")).toEqual(record);
  });
});
