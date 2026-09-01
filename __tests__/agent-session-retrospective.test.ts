import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import {
  buildBundles,
  decideEligibility,
  resolveSessionMembership,
  runCollect
} from "../skills/internal/agent-session-retrospective/scripts/lib/collect.ts";
import type { EligibleSession } from "../skills/internal/agent-session-retrospective/scripts/lib/collect.ts";
import {
  parseClaudeSession,
  parseCodexSession
} from "../skills/internal/agent-session-retrospective/scripts/lib/collectors.ts";
import {
  buildReportArtifacts,
  parseFixHeader,
  runCommit,
  validatePrAnalysis,
  validateFindings,
  validateSynthesis
} from "../skills/internal/agent-session-retrospective/scripts/lib/commit.ts";
import { summarizeOutput } from "../skills/internal/agent-session-retrospective/scripts/lib/normalize.ts";
import {
  prManifestPath,
  readPrManifest,
  runPrAggregate,
  runPrCollect
} from "../skills/internal/agent-session-retrospective/scripts/lib/pr-analysis.ts";
import type {
  CommandRunner,
  PrAnalysisManifest
} from "../skills/internal/agent-session-retrospective/scripts/lib/pr-analysis.ts";
import {
  findingsPath,
  listFrozenSessions,
  loadFrozenSession,
  readBundle,
  readFindings,
  saveFrozenSession
} from "../skills/internal/agent-session-retrospective/scripts/lib/store.ts";
import type {
  CanonicalSession,
  FrozenSessionRecord,
  RepoBundle,
  RepoFindings
} from "../skills/internal/agent-session-retrospective/scripts/lib/types.ts";

let dir: string;

function fakeSession(overrides: Partial<CanonicalSession> = {}): CanonicalSession {
  return {
    agent: "codex",
    contentHash: "hash-v1",
    cwd: "/repo",
    filePath: "/x.jsonl",
    lastActivityAt: "2026-05-26T10:00:00Z",
    parentSessionId: null,
    rawUserMessages: ["hi"],
    sessionId: "s1",
    sourceLineCount: 10,
    startedAt: "2026-05-26T10:00:00Z",
    threadSource: "user",
    touchedRoots: [],
    turns: [{ kind: "user", ref: "t0", text: "hi" }],
    ...overrides
  };
}

function bundleWith(refs: string[]): RepoBundle {
  return {
    priorFrictionDigest: [],
    repoHash: "rh",
    repoKey: "/repo",
    runTs: "ts",
    sessions: [
      {
        agent: "codex",
        contentHash: "ch",
        firstNewTurnIndex: 0,
        parentSessionId: null,
        priorFindingCount: 0,
        rawUserMessages: [],
        role: "primary",
        sessionHash: "sh",
        sessionId: "s1",
        threadSource: "user",
        turns: refs.map((ref) => ({ kind: "user", ref, text: ref }))
      }
    ]
  };
}

function writeWindow(root: string, runTs = "ts") {
  const runDir = path.join(root, "runs", runTs);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    path.join(runDir, "window.json"),
    JSON.stringify(
      {
        since: "2026-05-18T00:00:00.000Z",
        sinceSource: "first-run-default",
        until: "2026-06-01T00:00:00.000Z",
        untilSource: "now"
      },
      null,
      2
    ),
    "utf-8"
  );
}

describe("agent session retrospective", () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "retro-"));
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  function jsonl(lines: unknown[]) {
    const filePath = path.join(dir, "transcript.jsonl");
    writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join("\n"), "utf-8");
    return filePath;
  }

  describe("normalize", () => {
    test("summarizeOutput keeps head and tail and elides the middle", () => {
      const summary = summarizeOutput(`${"A".repeat(400)}MIDDLE${"B".repeat(400)}`);
      expect(summary).toContain("chars elided");
      expect(summary?.startsWith("A")).toBeTruthy();
      expect(summary?.endsWith("B")).toBeTruthy();
      expect(summary).not.toContain("MIDDLE");
    });
  });

  describe("Codex collector", () => {
    test("builds an ordered user/assistant/tool arc with a parsed exit code", () => {
      const filePath = jsonl([
        {
          payload: { cwd: dir, id: "sess-1" },
          timestamp: "2026-05-26T10:00:00Z",
          type: "session_meta"
        },
        {
          payload: {
            content: [{ text: "duplicate user envelope", type: "input_text" }],
            role: "user",
            type: "message"
          },
          timestamp: "2026-05-26T10:00:00Z",
          type: "response_item"
        },
        {
          payload: {
            content: [{ text: "duplicate assistant envelope", type: "output_text" }],
            role: "assistant",
            type: "message"
          },
          timestamp: "2026-05-26T10:00:00Z",
          type: "response_item"
        },
        {
          payload: { message: "do the thing", type: "user_message" },
          timestamp: "2026-05-26T10:00:01Z",
          type: "event_msg"
        },
        {
          payload: { message: "on it", type: "agent_message" },
          timestamp: "2026-05-26T10:00:02Z",
          type: "event_msg"
        },
        {
          payload: {
            arguments: '{"cmd":"ls"}',
            call_id: "c1",
            name: "exec_command",
            type: "function_call"
          },
          timestamp: "2026-05-26T10:00:03Z",
          type: "response_item"
        },
        {
          payload: {
            call_id: "c1",
            output: "Process exited with code 1\nboom",
            type: "function_call_output"
          },
          timestamp: "2026-05-26T10:00:04Z",
          type: "response_item"
        }
      ]);

      const session = parseCodexSession(filePath);
      expect(session?.sessionId).toBe("sess-1");
      expect(session?.turns.map((turn) => turn.kind)).toStrictEqual([
        "user",
        "assistant",
        "tool_call"
      ]);
      expect(session?.turns.map((turn) => turn.ref)).toStrictEqual(["t0", "t1", "t2"]);
      expect(session?.rawUserMessages).toStrictEqual(["do the thing"]);
      const tool = session?.turns[2];
      expect(tool?.kind === "tool_call" && tool.exitCode).toBe(1);
      expect(tool?.kind === "tool_call" && tool.error).toBe("exit 1");
    });

    test("drops a tool result that appears before its matching call", () => {
      const filePath = jsonl([
        {
          payload: { cwd: dir, id: "sess-out-of-order" },
          timestamp: "2026-05-26T10:00:00Z",
          type: "session_meta"
        },
        {
          payload: {
            call_id: "c1",
            output: "premature",
            type: "function_call_output"
          },
          timestamp: "2026-05-26T10:00:01Z",
          type: "response_item"
        },
        {
          payload: {
            arguments: "{}",
            call_id: "c1",
            name: "exec_command",
            type: "function_call"
          },
          timestamp: "2026-05-26T10:00:02Z",
          type: "response_item"
        }
      ]);

      const tool = parseCodexSession(filePath)?.turns[0];
      expect(tool?.kind).toBe("tool_call");
      expect(tool?.kind === "tool_call" && tool.outputHeadTail).toBeUndefined();
    });

    test("retains subagent lineage and excludes its delegated prompt from human asks", () => {
      const filePath = jsonl([
        {
          payload: {
            cwd: dir,
            id: "child-session",
            source: {
              subagent: {
                thread_spawn: { parent_thread_id: "parent-session" }
              }
            },
            thread_source: "subagent"
          },
          timestamp: "2026-05-26T10:00:00Z",
          type: "session_meta"
        },
        {
          payload: { message: "delegated task", type: "user_message" },
          timestamp: "2026-05-26T10:00:01Z",
          type: "event_msg"
        }
      ]);

      const session = parseCodexSession(filePath);
      expect(session?.threadSource).toBe("subagent");
      expect(session?.parentSessionId).toBe("parent-session");
      expect(session?.turns[0]).toMatchObject({ kind: "user", text: "delegated task" });
      expect(session?.rawUserMessages).toStrictEqual([]);
    });

    test("keeps an older unlinked subagent explicit instead of guessing a parent", () => {
      const filePath = jsonl([
        {
          payload: {
            cwd: dir,
            id: "unlinked-child",
            source: "vscode",
            thread_source: "subagent"
          },
          timestamp: "2026-05-26T10:00:00Z",
          type: "session_meta"
        }
      ]);

      const session = parseCodexSession(filePath);
      expect(session?.threadSource).toBe("subagent");
      expect(session?.parentSessionId).toBeNull();
    });

    test("keeps activity from unknown record kinds", () => {
      const filePath = jsonl([
        {
          payload: { cwd: dir, id: "session-with-unknown-activity" },
          timestamp: "2026-05-26T10:00:00Z",
          type: "session_meta"
        },
        {
          payload: { type: "context_compacted" },
          timestamp: "2026-05-26T10:05:00Z",
          type: "event_msg"
        }
      ]);

      const session = parseCodexSession(filePath);
      expect(session?.lastActivityAt).toBe("2026-05-26T10:05:00Z");
    });
  });

  describe("Claude collector", () => {
    test("pairs tool_use to tool_result and drops isMeta + tool-result envelopes from prose", () => {
      const filePath = jsonl([
        {
          cwd: dir,
          message: { content: "please fix", role: "user" },
          sessionId: "cs-1",
          timestamp: "2026-05-26T10:00:00Z",
          type: "user"
        },
        {
          message: {
            content: [
              { text: "sure", type: "text" },
              { id: "tu1", input: { command: "ls" }, name: "Bash", type: "tool_use" }
            ]
          },
          sessionId: "cs-1",
          timestamp: "2026-05-26T10:00:01Z",
          type: "assistant"
        },
        {
          message: {
            content: [{ content: "ok", is_error: false, tool_use_id: "tu1", type: "tool_result" }]
          },
          sessionId: "cs-1",
          timestamp: "2026-05-26T10:00:02Z",
          type: "user"
        },
        {
          isMeta: true,
          message: { content: [{ text: "<system-reminder>noise", type: "text" }] },
          sessionId: "cs-1",
          timestamp: "2026-05-26T10:00:03Z",
          type: "user"
        }
      ]);

      const session = parseClaudeSession(filePath);
      expect(session?.turns.map((turn) => turn.kind)).toStrictEqual([
        "user",
        "assistant",
        "tool_call"
      ]);
      expect(session?.rawUserMessages).toStrictEqual(["please fix"]);
      const tool = session?.turns[2];
      expect(tool?.kind === "tool_call" && tool.outputHeadTail).toBe("ok");
    });

    test("pairs a tool result even when it appears before its matching call", () => {
      const filePath = jsonl([
        {
          cwd: dir,
          message: {
            content: [
              {
                content: "already finished",
                is_error: false,
                tool_use_id: "tu1",
                type: "tool_result"
              }
            ]
          },
          sessionId: "cs-out-of-order",
          timestamp: "2026-05-26T10:00:00Z",
          type: "user"
        },
        {
          message: {
            content: [{ id: "tu1", input: {}, name: "Bash", type: "tool_use" }]
          },
          sessionId: "cs-out-of-order",
          timestamp: "2026-05-26T10:00:01Z",
          type: "assistant"
        }
      ]);

      const tool = parseClaudeSession(filePath)?.turns[0];
      expect(tool?.kind).toBe("tool_call");
      expect(tool?.kind === "tool_call" && tool.outputHeadTail).toBe("already finished");
    });

    test("keeps metadata and activity from unknown record kinds", () => {
      const filePath = jsonl([
        {
          cwd: dir,
          sessionId: "claude-metadata-envelope",
          timestamp: "2026-05-26T10:00:00Z",
          type: "progress"
        },
        {
          message: { content: [{ text: "continuing", type: "text" }] },
          timestamp: "2026-05-26T10:05:00Z",
          type: "assistant"
        }
      ]);

      const session = parseClaudeSession(filePath);
      expect(session?.sessionId).toBe("claude-metadata-envelope");
      expect(session?.cwd).toBe(dir);
      expect(session?.lastActivityAt).toBe("2026-05-26T10:05:00Z");
    });
  });

  test("Codex and Claude adapters normalize equivalent transcripts into the same turns", () => {
    const codexFile = jsonl([
      {
        payload: { cwd: dir, id: "codex-session" },
        timestamp: "2026-05-26T10:00:00Z",
        type: "session_meta"
      },
      {
        payload: { message: "inspect", type: "user_message" },
        timestamp: "2026-05-26T10:00:01Z",
        type: "event_msg"
      },
      {
        payload: { message: "checking", type: "agent_message" },
        timestamp: "2026-05-26T10:00:02Z",
        type: "event_msg"
      },
      {
        payload: {
          arguments: '{"command":"ls"}',
          call_id: "codex-tool",
          name: "shell",
          type: "function_call"
        },
        timestamp: "2026-05-26T10:00:03Z",
        type: "response_item"
      },
      {
        payload: {
          call_id: "codex-tool",
          output: "ok",
          type: "function_call_output"
        },
        timestamp: "2026-05-26T10:00:04Z",
        type: "response_item"
      }
    ]);
    const codexSession = parseCodexSession(codexFile);

    const claudeFile = jsonl([
      {
        cwd: dir,
        message: { content: "inspect", role: "user" },
        sessionId: "claude-session",
        timestamp: "2026-05-26T10:00:00Z",
        type: "user"
      },
      {
        message: {
          content: [
            { text: "checking", type: "text" },
            {
              id: "claude-tool",
              input: { command: "ls" },
              name: "shell",
              type: "tool_use"
            }
          ]
        },
        sessionId: "claude-session",
        timestamp: "2026-05-26T10:00:01Z",
        type: "assistant"
      },
      {
        message: {
          content: [
            {
              content: "ok",
              is_error: false,
              tool_use_id: "claude-tool",
              type: "tool_result"
            }
          ]
        },
        sessionId: "claude-session",
        timestamp: "2026-05-26T10:00:02Z",
        type: "user"
      }
    ]);
    const claudeSession = parseClaudeSession(claudeFile);

    expect(claudeSession?.turns).toStrictEqual(codexSession?.turns);
    expect(claudeSession?.rawUserMessages).toStrictEqual(codexSession?.rawUserMessages);
  });

  describe(decideEligibility, () => {
    const base = { activityMs: 0, idleMs: 60_000, nowMs: 1000 * 60 * 100 };

    test("never-analyzed idle session is eligible from turn 0", () => {
      expect(decideEligibility(fakeSession(), null, base)).toStrictEqual({
        firstNewTurnIndex: 0,
        include: true,
        priorFindingCount: 0
      });
    });

    test("too-fresh session is gated", () => {
      const result = decideEligibility(fakeSession(), null, { ...base, activityMs: base.nowMs });
      expect(result).toStrictEqual({ include: false, reason: "not-idle" });
    });

    test("outside the window is skipped", () => {
      const result = decideEligibility(fakeSession(), null, { ...base, sinceMs: base.nowMs });
      expect(result).toStrictEqual({ include: false, reason: "before-window" });
    });

    test("frozen and unchanged is skipped; grown re-qualifies as delta", () => {
      const prior: FrozenSessionRecord = {
        agent: "codex",
        analyzedAt: "x",
        contentHash: "hash-v1",
        friction: [{ body: "b", citedTurnRefs: ["t0"], id: "e1" }],
        lastTurnIndex: 1,
        rawUserMessages: [],
        repoKey: "/repo",
        secondary: [],
        sessionId: "s1",
        version: 1
      };
      expect(decideEligibility(fakeSession(), prior, base)).toStrictEqual({
        include: false,
        reason: "frozen-unchanged"
      });

      const grown = fakeSession({
        contentHash: "hash-v2",
        turns: [
          { kind: "user", ref: "t0", text: "hi" },
          { kind: "assistant", ref: "t1", text: "more" }
        ]
      });
      expect(decideEligibility(grown, prior, base)).toStrictEqual({
        firstNewTurnIndex: 1,
        include: true,
        priorFindingCount: 1
      });
    });
  });

  describe(buildBundles, () => {
    test("a session lands in its primary bundle and each secondary bundle", () => {
      const eligible: EligibleSession = {
        firstNewTurnIndex: 0,
        primaryRepo: "/repo",
        priorFindingCount: 0,
        secondaryRepos: ["/other"],
        session: fakeSession({ touchedRoots: ["/other"] })
      };
      const bundles = buildBundles("ts", [eligible], []);
      const byRepo = Object.fromEntries(bundles.map((bundle) => [bundle.repoKey, bundle]));
      expect(byRepo["/repo"]?.sessions[0]?.role).toBe("primary");
      expect(byRepo["/other"]?.sessions[0]?.role).toBe("secondary");
    });

    test("a child inherits parent repo membership without losing its own primary", () => {
      const parent = fakeSession({
        cwd: "/parent",
        sessionId: "parent",
        touchedRoots: ["/shared"]
      });
      const child = fakeSession({
        cwd: "/child",
        parentSessionId: "parent",
        sessionId: "child",
        threadSource: "subagent",
        touchedRoots: ["/child-secondary"]
      });

      expect(resolveSessionMembership([parent, child]).get("codex\u0000child")).toStrictEqual({
        primaryRepo: "/child",
        secondaryRepos: ["/child-secondary", "/parent", "/shared"]
      });
    });

    test("a child with no cwd inherits its parent's primary repo", () => {
      const parent = fakeSession({ cwd: "/parent", sessionId: "parent" });
      const child = fakeSession({
        cwd: null,
        parentSessionId: "parent",
        sessionId: "child",
        threadSource: "subagent"
      });

      expect(resolveSessionMembership([parent, child]).get("codex\u0000child")).toStrictEqual({
        primaryRepo: "/parent",
        secondaryRepos: []
      });
    });
  });

  describe("runCollect window", () => {
    test("resolves the first-run default window and writes it to the run directory", () => {
      const root = path.join(dir, "store");
      const result = runCollect({
        claudeRoot: path.join(dir, "no-claude"),
        codexRoot: path.join(dir, "no-codex"),
        idleMinutes: 0,
        nowMs: Date.parse("2026-06-01T00:00:00Z"),
        retroRoot: root,
        runTs: "ts"
      });

      expect(result.window).toStrictEqual({
        since: "2026-05-18T00:00:00.000Z",
        sinceSource: "first-run-default",
        until: "2026-06-01T00:00:00.000Z",
        untilSource: "now"
      });
      expect(
        JSON.parse(readFileSync(path.join(root, "runs", "ts", "window.json"), "utf-8"))
      ).toStrictEqual(result.window);
    });

    test("uses the newest completed report as the default since cursor", () => {
      const root = path.join(dir, "store");
      const reportsDir = path.join(root, "reports");
      mkdirSync(reportsDir, { recursive: true });
      writeFileSync(
        path.join(reportsDir, "2026-05-01T00-00-00-000Z-retrospective.md"),
        "Window: 2026-04-17T00:00:00.000Z to 2026-05-01T00:00:00.000Z (first-run-default to now)\n",
        "utf-8"
      );
      writeFileSync(
        path.join(reportsDir, "2026-05-20T00-00-00-000Z-retrospective.md"),
        "Window: 2026-05-01T00:00:00.000Z to 2026-05-20T12:00:00.000Z (previous-report to now)\n",
        "utf-8"
      );

      const result = runCollect({
        claudeRoot: path.join(dir, "no-claude"),
        codexRoot: path.join(dir, "no-codex"),
        idleMinutes: 0,
        nowMs: Date.parse("2026-06-01T00:00:00Z"),
        retroRoot: root,
        runTs: "ts"
      });

      expect(result.window).toStrictEqual({
        since: "2026-05-20T12:00:00.000Z",
        sinceSource: "previous-report",
        until: "2026-06-01T00:00:00.000Z",
        untilSource: "now"
      });
    });
  });

  describe(validateFindings, () => {
    test("drops episodes citing missing turns and fixes citing missing episodes", () => {
      const bundle = bundleWith(["t0", "t1"]);
      const findings: RepoFindings = {
        durableFixProposals: [
          { body: "keeps", citedEpisodeRefs: ["e1"] },
          { body: "drops — e2 was invalid", citedEpisodeRefs: ["e2"] },
          { body: "drops — no citation", citedEpisodeRefs: [] }
        ],
        frictionEpisodes: [
          { body: "good", citedTurnRefs: ["t0"], id: "e1", sessionId: "s1" },
          { body: "bad ref", citedTurnRefs: ["t9"], id: "e2", sessionId: "s1" },
          { body: "bad session", citedTurnRefs: ["t0"], id: "e3", sessionId: "ghost" }
        ],
        repeatedAsks: [],
        repoKey: "/repo"
      };

      const result = validateFindings(findings, bundle);
      expect(result.episodes.map((episode) => episode.id)).toStrictEqual(["e1"]);
      expect(result.fixes.map((fix) => fix.body)).toStrictEqual(["keeps"]);
      expect(result.dropped).toStrictEqual({ episodes: 2, fixes: 2 });
    });

    test("drops episodes authored for a secondary session (friction is primary-only)", () => {
      const bundle = bundleWith(["t0"]);
      const [session] = bundle.sessions;
      if (!session) {
        throw new Error("expected bundleWith to create one session");
      }
      session.role = "secondary";
      const findings: RepoFindings = {
        durableFixProposals: [],
        frictionEpisodes: [{ body: "secondary", citedTurnRefs: ["t0"], id: "e1", sessionId: "s1" }],
        repeatedAsks: [],
        repoKey: "/repo"
      };
      const result = validateFindings(findings, bundle);
      expect(result.episodes).toHaveLength(0);
      expect(result.dropped.episodes).toBe(1);
    });

    test("filters unknown session ids out of repeated-ask clusters", () => {
      const bundle = bundleWith(["t0"]);
      const findings: RepoFindings = {
        durableFixProposals: [],
        frictionEpisodes: [],
        repeatedAsks: [{ body: "b", exampleSessionIds: ["s1", "ghost"], label: "x" }],
        repoKey: "/repo"
      };
      const result = validateFindings(findings, bundle);
      expect(result.repeatedAsks[0]?.exampleSessionIds).toStrictEqual(["s1"]);
    });
  });

  describe(parseFixHeader, () => {
    test("extracts Target and Confidence and returns the remaining prose", () => {
      expect(parseFixHeader("Target: hook\nConfidence: high\n\nthe actual fix")).toStrictEqual({
        confidence: "high",
        rest: "the actual fix",
        target: "hook"
      });
    });
  });

  describe(validateSynthesis, () => {
    test("requires each synthesis section exactly once", () => {
      const valid = [
        "### Active Actions",
        "",
        "_No active actions._",
        "",
        "### Standards Opportunities",
        "",
        "_No standards opportunities._",
        "",
        "### Skill & Workflow Opportunities",
        "",
        "_No skill or workflow opportunities._",
        "",
        "### Resolved or Superseded",
        "",
        "_No resolved or superseded candidates._"
      ].join("\n");
      expect(validateSynthesis(valid)).toStrictEqual([]);
      expect(validateSynthesis("### Active Actions")).toStrictEqual([
        "Heading `### Standards Opportunities` appears 0 time(s), expected 1.",
        "Heading `### Skill & Workflow Opportunities` appears 0 time(s), expected 1.",
        "Heading `### Resolved or Superseded` appears 0 time(s), expected 1."
      ]);
      expect(
        validateSynthesis(
          [
            "### Resolved or Superseded",
            "### Active Actions",
            "### Standards Opportunities",
            "### Skill & Workflow Opportunities"
          ].join("\n")
        )
      ).toStrictEqual(["Required synthesis headings are out of order."]);
    });

    test("requires active actions to explain the problem before metadata and evidence", () => {
      const synthesis = [
        "### Active Actions",
        "",
        "#### A1 — Reviews can approve the wrong tree",
        "Problem: Review approval can describe different code than the delivered commit.",
        "Impact: Unreviewed changes can ship despite a passing verdict.",
        "Cause: The workflows do not share an immutable pre-commit snapshot.",
        "Proposed fix: Review one fingerprinted Git tree and verify the final commit matches it.",
        "",
        "Target: agent-skill",
        "Confidence: high",
        "Resolution: unresolved",
        "Checked-at: 2026-08-10T00:00:00Z",
        "Checked-against: current skill sources",
        "Current-state evidence: Each workflow still identifies candidates differently.",
        "Remaining gap: No shared snapshot or final identity check exists.",
        "Session evidence: repo e1",
        "",
        "### Standards Opportunities",
        "",
        "#### A1 — Immutable review identity is not a coding standard",
        "Disposition: not-a-standard",
        "Standards checked: Global instructions, Team baseline, and repo guidance.",
        "Evidence: A1 concerns workflow identity rather than how code is written.",
        "Rationale: A workflow guard is the authoritative prevention surface.",
        "Proposed wording: n/a",
        "",
        "### Skill & Workflow Opportunities",
        "",
        "_No skill or workflow opportunities._",
        "",
        "### Resolved or Superseded",
        "",
        "_No resolved or superseded candidates._"
      ].join("\n");

      expect(validateSynthesis(synthesis)).toStrictEqual([]);
      expect(
        validateSynthesis(
          synthesis.replace(
            "Problem: Review approval can describe different code than the delivered commit.\n",
            ""
          )
        )
      ).toContain(
        "Active action `A1 — Reviews can approve the wrong tree` must start with `Problem:`."
      );
    });
  });

  describe("buildReport", () => {
    test("keeps the main report problem-focused and moves evidence to session sources", () => {
      const bundle = bundleWith(["t0"]);
      const synthesis = [
        "### Active Actions",
        "",
        "GLOBAL-SYNTHESIS",
        "",
        "### Standards Opportunities",
        "",
        "_No standards opportunities._",
        "",
        "### Skill & Workflow Opportunities",
        "",
        "_No skill or workflow opportunities._",
        "",
        "### Resolved or Superseded",
        "",
        "_No resolved or superseded candidates._"
      ].join("\n");
      const artifacts = buildReportArtifacts(
        "ts",
        synthesis,
        [
          {
            bundle,
            validated: {
              dropped: { episodes: 0, fixes: 0 },
              episodes: [
                { body: "episode body", citedTurnRefs: ["t0"], id: "e1", sessionId: "s1" }
              ],
              fixes: [
                { body: "Target: hook\nConfidence: high\nfix body", citedEpisodeRefs: ["e1"] }
              ],
              repeatedAsks: [],
              repoKey: "/repo"
            }
          }
        ],
        {
          prAnalysis:
            "## Recurring Corrective Patterns\n\n- Tightened verification before merge.\n\n## PR Analysis Gaps\n\n- `repo#1` — missing diff. Impact: degraded.",
          prAnalysisWarnings: ["PR `repo#1` omits known final head abc123."]
        }
      );
      const { report } = artifacts;

      const globalAt = report.indexOf("GLOBAL-SYNTHESIS");
      const prAt = report.indexOf("PR Repeated Corrective Patterns");
      expect(globalAt).toBeGreaterThan(-1);
      expect(globalAt).toBeLessThan(prAt);
      expect(report).toContain("### Standards Opportunities");
      expect(report).toContain("[session sources](ts-session-sources.md)");
      expect(report).toContain("[PR sources](ts-pr-sources.md)");
      expect(report).not.toContain("Per-repo proposals");
      expect(report).not.toContain("Audit appendix");
      expect(report).not.toContain("evidence");
      expect(report).not.toContain("PR validation recorded");
      expect(report).not.toContain("PR analysis recorded");
      expect(report).not.toContain("missing diff");
      expect(report).not.toContain("omits known final head");
      expect(artifacts.sessionSources).toContain("## Per-repo proposals");
      expect(artifacts.sessionSources).toContain("## Audit appendix");
      expect(artifacts.prSources).toContain("omits known final head");
      expect(artifacts.sessionSources).toContain("fix body");
      // A surviving episode's evidence must always resolve to real turns in the source file.
      expect(artifacts.sessionSources).not.toContain("(missing)");
    });

    test("commit writes compact report plus linked PR and session source files", () => {
      const root = path.join(dir, "store");
      const runTs = "2026-06-01T00-00-00-000Z";
      const runDir = path.join(root, "runs", runTs);
      writeWindow(root, runTs);
      writeFileSync(
        path.join(runDir, "pr-analysis.md"),
        [
          "# PR trajectory analysis",
          "",
          "## Recurring Corrective Patterns",
          "",
          "- PRs often needed verification commits after opening. (2 PRs: repo#1, repo#2)",
          "",
          "## PR Analysis Gaps",
          "",
          "_No PR analysis gaps._",
          "",
          "## Per-PR Analyses",
          "",
          "### repo#1",
          "",
          "body"
        ].join("\n"),
        "utf-8"
      );
      const bundle = bundleWith(["t0"]);
      bundle.runTs = runTs;
      writeFileSync(
        path.join(runDir, `${bundle.repoHash}.json`),
        JSON.stringify(bundle, null, 2),
        "utf-8"
      );
      const findings: RepoFindings = {
        durableFixProposals: [
          { body: "Target: hook\nConfidence: high\nfix body", citedEpisodeRefs: ["e1"] }
        ],
        frictionEpisodes: [
          { body: "episode body", citedTurnRefs: ["t0"], id: "e1", sessionId: "s1" }
        ],
        repeatedAsks: [],
        repoKey: "/repo"
      };
      writeFileSync(
        path.join(runDir, `${bundle.repoHash}.findings.json`),
        JSON.stringify(findings, null, 2),
        "utf-8"
      );
      const synthesisPath = path.join(dir, "synthesis.md");
      writeFileSync(
        synthesisPath,
        [
          "### Active Actions",
          "",
          "#### A1 — A global problem",
          "Problem: The global workflow has a problem.",
          "Impact: The problem affects delivery.",
          "Cause: The workflow lacks a durable guard.",
          "Proposed fix: Add the durable guard.",
          "",
          "Target: preflight",
          "Confidence: medium",
          "Resolution: unresolved",
          "Checked-at: 2026-06-01T00:00:00.000Z",
          "Checked-against: current workflow",
          "Current-state evidence: The guard is absent.",
          "Remaining gap: The workflow remains unguarded.",
          "Session evidence: repo e1",
          "",
          "### Standards Opportunities",
          "",
          "#### A1 — Workflow guards do not belong in coding standards",
          "Disposition: not-a-standard",
          "Standards checked: Global instructions, Team baseline, and repo guidance.",
          "Evidence: A1 concerns workflow enforcement rather than code-writing guidance.",
          "Rationale: The preflight is the authoritative prevention surface.",
          "Proposed wording: n/a",
          "",
          "### Skill & Workflow Opportunities",
          "",
          "_No skill or workflow opportunities._",
          "",
          "### Resolved or Superseded",
          "",
          "_No resolved or superseded candidates._"
        ].join("\n"),
        "utf-8"
      );

      const result = runCommit({
        nowIso: "2026-06-01T00:00:00.000Z",
        retroRoot: root,
        runTs,
        synthesisPath
      });
      const report = readFileSync(result.reportPath, "utf-8");
      const sessionSources = readFileSync(result.sourcePaths.session, "utf-8");
      const prSources = readFileSync(result.sourcePaths.pr, "utf-8");

      expect(report).toContain(
        "Window: 2026-05-18T00:00:00.000Z to 2026-06-01T00:00:00.000Z (first-run-default to now)"
      );
      const globalAt = report.indexOf("## Session Actions");
      const prAt = report.indexOf("## PR Repeated Corrective Patterns");
      expect(globalAt).toBeGreaterThan(-1);
      expect(globalAt).toBeLessThan(prAt);
      expect(report).toContain("PRs often needed verification commits after opening.");
      expect(report).not.toContain("### repo#1");
      expect(sessionSources).toContain("## Per-repo proposals");
      expect(sessionSources).toContain("fix body");
      expect(prSources).toContain("## Per-PR Analyses");
      expect(prSources).toContain("### repo#1");
      expect(existsSync(runDir)).toBeFalsy();
    });

    test("commit requires PR trajectory analysis before freezing and cleaning the run", () => {
      const root = path.join(dir, "store");
      const runTs = "2026-06-01T00-00-00-000Z";
      const runDir = path.join(root, "runs", runTs);
      writeWindow(root, runTs);
      const bundle = bundleWith(["t0"]);
      bundle.runTs = runTs;
      writeFileSync(
        path.join(runDir, `${bundle.repoHash}.json`),
        JSON.stringify(bundle, null, 2),
        "utf-8"
      );
      const findings: RepoFindings = {
        durableFixProposals: [
          { body: "Target: hook\nConfidence: high\nfix body", citedEpisodeRefs: ["e1"] }
        ],
        frictionEpisodes: [
          { body: "episode body", citedTurnRefs: ["t0"], id: "e1", sessionId: "s1" }
        ],
        repeatedAsks: [],
        repoKey: "/repo"
      };
      writeFileSync(
        path.join(runDir, `${bundle.repoHash}.findings.json`),
        JSON.stringify(findings, null, 2),
        "utf-8"
      );

      expect(() =>
        runCommit({
          nowIso: "2026-06-01T00:00:00.000Z",
          retroRoot: root,
          runTs
        })
      ).toThrow("commit requires runs/2026-06-01T00-00-00-000Z/pr-analysis.md");
      expect(existsSync(runDir)).toBeTruthy();
      expect(loadFrozenSession(root, "codex", "s1")).toBeNull();
    });

    test("commit rejects incomplete synthesis before freezing and cleaning the run", () => {
      const root = path.join(dir, "store");
      const runTs = "2026-06-01T00-00-00-000Z";
      const runDir = path.join(root, "runs", runTs);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        path.join(runDir, "pr-analysis.md"),
        "## Recurring Corrective Patterns\n\n_No recurring corrective patterns._\n",
        "utf-8"
      );
      const bundle = bundleWith(["t0"]);
      bundle.runTs = runTs;
      writeFileSync(path.join(runDir, `${bundle.repoHash}.json`), JSON.stringify(bundle), "utf-8");
      const findings: RepoFindings = {
        durableFixProposals: [],
        frictionEpisodes: [],
        repeatedAsks: [],
        repoKey: "/repo"
      };
      writeFileSync(
        path.join(runDir, `${bundle.repoHash}.findings.json`),
        JSON.stringify(findings),
        "utf-8"
      );
      const synthesisPath = path.join(dir, "synthesis.md");
      writeFileSync(synthesisPath, "### Active Actions\n\n_No active actions._\n", "utf-8");

      expect(() =>
        runCommit({
          nowIso: "2026-06-01T00:00:00.000Z",
          retroRoot: root,
          runTs,
          synthesisPath
        })
      ).toThrow("invalid synthesis");
      expect(existsSync(runDir)).toBeTruthy();
      expect(loadFrozenSession(root, "codex", "s1")).toBeNull();
    });

    test("renders Target/Confidence header and a single merged evidence block in session sources", () => {
      const bundle = bundleWith(["t0", "t1"]);
      const artifacts = buildReportArtifacts("ts", "", [
        {
          bundle,
          validated: {
            dropped: { episodes: 0, fixes: 0 },
            episodes: [
              { body: "a", citedTurnRefs: ["t0"], id: "e1", sessionId: "s1" },
              { body: "b", citedTurnRefs: ["t1"], id: "e2", sessionId: "s1" }
            ],
            fixes: [
              {
                body: "Target: skill\nConfidence: medium\nmerge me",
                citedEpisodeRefs: ["e1", "e2"]
              }
            ],
            repeatedAsks: [],
            repoKey: "/repo"
          }
        }
      ]);
      expect(artifacts.sessionSources).toContain("Target: skill; Confidence: medium — merge me");
      expect(artifacts.sessionSources.match(/<summary>evidence<\/summary>/gu)).toHaveLength(1);
      expect(artifacts.report).not.toContain("<summary>evidence</summary>");
    });
  });

  describe("PR trajectory analysis", () => {
    test("collect writes PR work items from the resolved window and aggregate writes pr-analysis.md", () => {
      const root = path.join(dir, "store");
      writeWindow(root);
      const calls: string[] = [];
      const exec: CommandRunner = (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "gh" && args.join(" ") === "api user --jq .login") {
          return { status: 0, stderr: "", stdout: "hoangbn\n" };
        }
        if (command === "gh" && args.slice(0, 3).join(" ") === "repo list monke-together-strong") {
          return {
            status: 0,
            stderr: "",
            stdout: JSON.stringify([
              { isArchived: false, isPrivate: true, nameWithOwner: "monke-together-strong/alpha" },
              { isArchived: true, isPrivate: false, nameWithOwner: "monke-together-strong/old" }
            ])
          };
        }
        if (command === "gh" && args[0] === "pr" && args[1] === "list") {
          if (args.at(-1) !== "number,url,title,createdAt,mergedAt") {
            throw new Error(`unexpected pr list fields: ${args.at(-1)}`);
          }
          const search = args[args.indexOf("--search") + 1] ?? "";
          const byDay = {
            "merged:2026-05-21..2026-05-21": [
              {
                createdAt: "2026-05-20T10:00:00Z",
                mergedAt: "2026-05-21T10:00:00Z",
                number: 7,
                title: "Tighten setup",
                url: "https://github.com/monke-together-strong/alpha/pull/7"
              }
            ],
            "merged:2026-05-22..2026-05-22": [
              {
                createdAt: "2026-05-22T10:00:00Z",
                mergedAt: "2026-05-22T11:00:00Z",
                number: 9,
                title: "Missing refs",
                url: "https://github.com/monke-together-strong/alpha/pull/9"
              }
            ],
            "merged:2026-05-23..2026-05-23": [
              {
                createdAt: "2026-05-23T10:00:00Z",
                mergedAt: "2026-05-23T11:00:00Z",
                number: 10,
                title: "Tighten docs",
                url: "https://github.com/monke-together-strong/alpha/pull/10"
              }
            ],
            "merged:2026-05-24..2026-05-24": [
              {
                createdAt: "2026-06-02T10:00:00Z",
                mergedAt: "2026-06-02T11:00:00Z",
                number: 8,
                title: "Too late",
                url: "https://github.com/monke-together-strong/alpha/pull/8"
              }
            ]
          };
          const response = Object.entries(byDay).find(([key]) => key === search)?.[1] ?? [];
          return { status: 0, stderr: "", stdout: JSON.stringify(response) };
        }
        if (command === "gh" && args[0] === "pr" && args[1] === "view") {
          const number = args[2] ?? "";
          const fields = args.at(-1);
          if (fields === "files") {
            const filesByNumber = {
              "10": { files: [{ path: "docs.md" }] },
              "7": { files: [{ path: "setup.ts" }] },
              "9": { files: [] }
            };
            const response = Object.entries(filesByNumber).find(([key]) => key === number)?.[1];
            return { status: 0, stderr: "", stdout: JSON.stringify(response) };
          }
          if (
            fields !==
            "number,url,title,createdAt,mergedAt,baseRefName,headRefName,headRefOid,mergeCommit,commits"
          ) {
            throw new Error(`unexpected pr view fields: ${fields}`);
          }
          const detailsByNumber = {
            "10": {
              baseRefName: "main",
              commits: [
                {
                  committedDate: "2026-05-23T09:00:00Z",
                  messageHeadline: "Initial docs",
                  oid: "dddddddddddddddddddddddddddddddddddddddd"
                },
                {
                  committedDate: "2026-05-23T10:30:00Z",
                  messageHeadline: "Add verification",
                  oid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
                }
              ],
              createdAt: "2026-05-23T10:00:00Z",
              headRefName: "feature/docs",
              headRefOid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
              mergeCommit: { oid: "ffffffffffffffffffffffffffffffffffffffff" },
              mergedAt: "2026-05-23T11:00:00Z",
              number: 10,
              title: "Tighten docs",
              url: "https://github.com/monke-together-strong/alpha/pull/10"
            },
            "7": {
              baseRefName: "main",
              commits: [
                {
                  committedDate: "2026-05-20T09:00:00Z",
                  messageHeadline: "Initial implementation",
                  oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                },
                {
                  committedDate: "2026-05-20T11:00:00Z",
                  messageHeadline: "Add verification",
                  oid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                }
              ],
              createdAt: "2026-05-20T10:00:00Z",
              headRefName: "feature/setup",
              headRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              mergeCommit: { oid: "cccccccccccccccccccccccccccccccccccccccc" },
              mergedAt: "2026-05-21T10:00:00Z",
              number: 7,
              title: "Tighten setup",
              url: "https://github.com/monke-together-strong/alpha/pull/7"
            },
            "9": {
              commits: [],
              createdAt: "2026-05-22T10:00:00Z",
              mergedAt: "2026-05-22T11:00:00Z",
              number: 9,
              title: "Missing refs",
              url: "https://github.com/monke-together-strong/alpha/pull/9"
            }
          };
          const response = Object.entries(detailsByNumber).find(([key]) => key === number)?.[1];
          return { status: 0, stderr: "", stdout: JSON.stringify(response) };
        }
        if (command === "gh" && args[0] === "pr" && args[1] === "diff") {
          return {
            status: 0,
            stderr: "",
            stdout: "diff --git a/setup.ts b/setup.ts\n"
          };
        }
        return {
          status: 1,
          stderr: `unexpected command: ${command} ${args.join(" ")}`,
          stdout: ""
        };
      };

      const manifest = runPrCollect({ exec, retroRoot: root, runTs: "ts" });
      expect(manifest.author).toBe("hoangbn");
      expect(manifest.workItems).toHaveLength(3);
      expect(
        calls.some((call) => call.includes("pr list") && call.includes("commits"))
      ).toBeFalsy();
      expect(calls.some((call) => call.includes("pr list") && call.includes("files"))).toBeFalsy();
      expect(calls).toContain(
        "gh pr view 7 --repo monke-together-strong/alpha --json number,url,title,createdAt,mergedAt,baseRefName,headRefName,headRefOid,mergeCommit,commits"
      );
      expect(calls).toContain("gh pr view 7 --repo monke-together-strong/alpha --json files");
      expect(calls).toContain("gh pr diff 9 --repo monke-together-strong/alpha --patch");
      const analyzedItem = manifest.workItems.find((item) => item.number === 7);
      const missingRefItem = manifest.workItems.find((item) => item.number === 9);
      const secondAnalyzedItem = manifest.workItems.find((item) => item.number === 10);
      if (
        analyzedItem === undefined ||
        missingRefItem === undefined ||
        secondAnalyzedItem === undefined
      ) {
        throw new Error("expected work items for PRs 7, 9, and 10");
      }
      expect(analyzedItem.openingSnapshot).toStrictEqual({
        confidence: "inferred",
        reason: "Latest PR commit whose commit date is at or before the PR creation time.",
        ref: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      });
      expect(JSON.parse(readFileSync(analyzedItem.workItemPath, "utf-8"))).toMatchObject({
        postOpeningDelta: {
          confidence: "lower",
          source: "github-pr-diff-fallback"
        }
      });
      expect(JSON.parse(readFileSync(missingRefItem.workItemPath, "utf-8"))).toMatchObject({
        postOpeningDelta: {
          confidence: "lower",
          source: "github-pr-diff-fallback"
        }
      });
      expect(secondAnalyzedItem.openingSnapshot).toStrictEqual({
        confidence: "inferred",
        reason: "Latest PR commit whose commit date is at or before the PR creation time.",
        ref: "dddddddddddddddddddddddddddddddddddddddd"
      });
      expect(manifest.gaps).toStrictEqual([]);

      writeFileSync(
        analyzedItem.analysisPath,
        [
          "## Opening Snapshot",
          "Opened with `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.",
          "## Post-Opening Delta",
          "Final head `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` added verification.",
          "## Corrective Patterns",
          "- Added missing verification before merge.",
          "## Ignored Feature Scope",
          "_None._",
          "## Commit Message Reference",
          "`bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` Add verification."
        ].join("\n"),
        "utf-8"
      );
      writeFileSync(
        secondAnalyzedItem.analysisPath,
        [
          "## Opening Snapshot",
          "Opened with `dddddddddddddddddddddddddddddddddddddddd`.",
          "## Post-Opening Delta",
          "Final head `eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` added verification.",
          "## Corrective Patterns",
          "- Added missing verification before merge.",
          "## Ignored Feature Scope",
          "_None._",
          "## Commit Message Reference",
          "`eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` Add verification."
        ].join("\n"),
        "utf-8"
      );

      const aggregate = runPrAggregate({ retroRoot: root, runTs: "ts" });
      const report = readFileSync(aggregate.path, "utf-8");
      expect(report).toContain("## Recurring Corrective Patterns");
      expect(report).toContain(
        "Added missing verification before merge. (2 PRs: monke-together-strong/alpha#7, monke-together-strong/alpha#10)"
      );
      expect(report).not.toContain("post-opening delta unavailable");
      expect(report).toContain("### monke-together-strong/alpha#7");
    });

    test("manifest-backed PR validation checks headings, refs, and cited SHAs", () => {
      const manifest: PrAnalysisManifest = {
        author: "hoangbn",
        gaps: [],
        generatedAt: "2026-06-01T00:00:00.000Z",
        org: "monke-together-strong",
        runTs: "ts",
        version: 1,
        window: {
          since: "2026-05-18T00:00:00.000Z",
          sinceSource: "first-run-default",
          until: "2026-06-01T00:00:00.000Z",
          untilSource: "now"
        },
        workItems: [
          {
            analysisPath: "/tmp/work.analysis.md",
            commitShas: [
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            ],
            createdAt: "2026-05-20T10:00:00Z",
            finalHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            mergeCommitSha: "cccccccccccccccccccccccccccccccccccccccc",
            mergedAt: "2026-05-21T10:00:00Z",
            number: 7,
            openingSnapshot: {
              confidence: "inferred",
              reason: "test",
              ref: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            },
            repo: "monke-together-strong/alpha",
            title: "Tighten setup",
            url: "https://github.com/monke-together-strong/alpha/pull/7",
            workItemPath: "/tmp/work.json"
          }
        ]
      };

      const result = validatePrAnalysis(
        [
          "### monke-together-strong/alpha#7",
          "Opening snapshot: inferred aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "## Opening Snapshot",
          "ok aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "## Post-Opening Delta",
          "mentions ddddddd",
          "## Corrective Patterns",
          "fix",
          "## Ignored Feature Scope",
          "none"
        ].join("\n"),
        manifest
      );

      expect(result.warnings).toContain(
        "PR `monke-together-strong/alpha#7` is missing `## Commit Message Reference`."
      );
      expect(result.warnings).toContain(
        "PR `monke-together-strong/alpha#7` omits known final head bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb."
      );
      expect(result.warnings).toContain(
        "PR `monke-together-strong/alpha#7` cites unknown commit SHA ddddddd."
      );
    });

    test("manifest-backed PR validation uses exact PR headings and accepts short SHA prefixes", () => {
      const manifest: PrAnalysisManifest = {
        author: "hoangbn",
        gaps: [],
        generatedAt: "2026-06-01T00:00:00.000Z",
        org: "monke-together-strong",
        runTs: "ts",
        version: 1,
        window: {
          since: "2026-05-18T00:00:00.000Z",
          sinceSource: "first-run-default",
          until: "2026-06-01T00:00:00.000Z",
          untilSource: "now"
        },
        workItems: [
          {
            analysisPath: "/tmp/work-1.analysis.md",
            commitShas: [
              "1111111111111111111111111111111111111111",
              "2222222222222222222222222222222222222222"
            ],
            createdAt: "2026-05-20T10:00:00Z",
            finalHeadSha: "2222222222222222222222222222222222222222",
            mergedAt: "2026-05-21T10:00:00Z",
            number: 1,
            openingSnapshot: {
              confidence: "inferred",
              reason: "test",
              ref: "1111111111111111111111111111111111111111"
            },
            repo: "repo",
            title: "One",
            url: "https://github.com/repo/pull/1",
            workItemPath: "/tmp/work-1.json"
          },
          {
            analysisPath: "/tmp/work-10.analysis.md",
            commitShas: [
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            ],
            createdAt: "2026-05-20T10:00:00Z",
            finalHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            mergedAt: "2026-05-21T10:00:00Z",
            number: 10,
            openingSnapshot: {
              confidence: "inferred",
              reason: "test",
              ref: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            },
            repo: "repo",
            title: "Ten",
            url: "https://github.com/repo/pull/10",
            workItemPath: "/tmp/work-10.json"
          }
        ]
      };

      const result = validatePrAnalysis(
        [
          "### repo#10",
          "## Opening Snapshot",
          "Opened with `aaaaaaa`.",
          "## Post-Opening Delta",
          "Final head `bbbbbbb` added verification.",
          "## Corrective Patterns",
          "fix",
          "## Ignored Feature Scope",
          "none",
          "## Commit Message Reference",
          "`bbbbbbb` Add verification."
        ].join("\n"),
        manifest
      );

      expect(result.warnings).toContain("Expected PR `repo#1` is missing from PR analysis.");
      expect(result.warnings).not.toContain(
        "PR `repo#10` omits known opening ref aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa."
      );
      expect(result.warnings).not.toContain(
        "PR `repo#10` omits known final head bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb."
      );
    });
  });

  describe("runCollect dedupe", () => {
    test("two files for one session_id collapse to the most-complete copy", () => {
      const codexRoot = path.join(dir, "codex");
      const dayDir = path.join(codexRoot, "sessions", "2026", "05", "26");
      mkdirSync(dayDir, { recursive: true });
      const writeCodex = (name: string, turns: number) => {
        const lines: unknown[] = [
          {
            payload: { cwd: dir, id: "dup-1" },
            timestamp: "2026-05-26T10:00:00Z",
            type: "session_meta"
          }
        ];
        for (let i = 0; i < turns; i += 1) {
          lines.push({
            payload: { message: `turn ${i}`, type: "user_message" },
            timestamp: "2026-05-26T10:00:01Z",
            type: "event_msg"
          });
        }
        writeFileSync(
          path.join(dayDir, name),
          lines.map((line) => JSON.stringify(line)).join("\n")
        );
      };
      writeCodex("short.jsonl", 2);
      writeCodex("long.jsonl", 5);

      const result = runCollect({
        claudeRoot: path.join(dir, "nope"),
        codexRoot,
        idleMinutes: 0,
        nowMs: Date.parse("2026-06-01T00:00:00Z"),
        retroRoot: path.join(dir, "store"),
        runTs: "ts"
      });

      const sessions = result.bundles.reduce((sum, bundle) => sum + bundle.sessionCount, 0);
      expect(sessions).toBe(1);
      expect(result.skipped["duplicate-file"]).toBe(1);
      // The most-complete copy (long.jsonl, 5 turns) must be the one retained.
      const bundlePath = result.bundles[0]?.path;
      if (!bundlePath) {
        throw new Error("expected one bundle to be written");
      }
      const bundle = readBundle(path.join(dir, "store"), "ts", path.basename(bundlePath, ".json"));
      expect(bundle.sessions[0]?.turns).toHaveLength(5);
    });
  });

  describe("store freeze roundtrip", () => {
    test("save then load returns the same frozen record", () => {
      const record: FrozenSessionRecord = {
        agent: "claude",
        analyzedAt: "2026-05-26T10:00:00Z",
        contentHash: "h",
        friction: [{ body: "b", citedTurnRefs: ["t0"], id: "ts:e1" }],
        lastTurnIndex: 5,
        rawUserMessages: ["hi"],
        repoKey: "/repo",
        secondary: ["/other"],
        sessionId: "s1",
        version: 1
      };
      saveFrozenSession(dir, record);
      expect(loadFrozenSession(dir, "claude", "s1")).toStrictEqual(record);
    });

    test("list skips invalid frozen records while preserving valid records", () => {
      const valid: FrozenSessionRecord = {
        agent: "codex",
        analyzedAt: "2026-05-26T10:00:00Z",
        contentHash: "h",
        friction: [],
        lastTurnIndex: 1,
        rawUserMessages: ["hi"],
        repoKey: "/repo",
        secondary: [],
        sessionId: "valid",
        version: 1
      };
      saveFrozenSession(dir, valid);
      writeFileSync(path.join(dir, "sessions", "invalid.yml"), "version: nope\n", "utf-8");

      expect(listFrozenSessions(dir)).toStrictEqual([valid]);
    });

    test("findings default omitted arrays and ignore forward-compatible keys", () => {
      const filePath = findingsPath(dir, "ts", "repo");
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(
        filePath,
        JSON.stringify({
          durableFixProposals: [{ body: "fix", future: true }],
          future: true,
          repoKey: "/repo"
        }),
        "utf-8"
      );

      expect(readFindings(dir, "ts", "repo")).toStrictEqual({
        durableFixProposals: [{ body: "fix", citedEpisodeRefs: [] }],
        frictionEpisodes: [],
        repeatedAsks: [],
        repoKey: "/repo"
      });
    });

    test("invalid PR manifests degrade to missing state", () => {
      const filePath = prManifestPath(dir, "ts");
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, '{"version":2}', "utf-8");

      expect(readPrManifest(dir, "ts")).toBeNull();
    });
  });
});
