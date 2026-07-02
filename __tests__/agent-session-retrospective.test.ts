import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  buildReportArtifacts,
  parseFixHeader,
  runCommit,
  validatePrAnalysis,
  validateFindings,
} from "../skills/internal/agent-session-retrospective/scripts/lib/commit.ts";
import {
  runPrAggregate,
  runPrCollect,
  type CommandRunner,
  type PrAnalysisManifest,
} from "../skills/internal/agent-session-retrospective/scripts/lib/pr-analysis.ts";
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
    expect(byRepo["/repo"]?.sessions[0]?.role).toBe("primary");
    expect(byRepo["/other"]?.sessions[0]?.role).toBe("secondary");
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

describe("runCollect window", () => {
  test("resolves the first-run default window and writes it to the run directory", () => {
    const root = path.join(dir, "store");
    const result = runCollect({
      retroRoot: root,
      runTs: "ts",
      codexRoot: path.join(dir, "no-codex"),
      claudeRoot: path.join(dir, "no-claude"),
      idleMinutes: 0,
      nowMs: Date.parse("2026-06-01T00:00:00Z"),
    });

    expect(result.window).toEqual({
      since: "2026-05-18T00:00:00.000Z",
      until: "2026-06-01T00:00:00.000Z",
      sinceSource: "first-run-default",
      untilSource: "now",
    });
    expect(JSON.parse(readFileSync(path.join(root, "runs", "ts", "window.json"), "utf8"))).toEqual(
      result.window,
    );
  });

  test("uses the newest completed report as the default since cursor", () => {
    const root = path.join(dir, "store");
    const reportsDir = path.join(root, "reports");
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(
      path.join(reportsDir, "2026-05-01T00-00-00-000Z-retrospective.md"),
      "Window: 2026-04-17T00:00:00.000Z to 2026-05-01T00:00:00.000Z (first-run-default to now)\n",
      "utf8",
    );
    writeFileSync(
      path.join(reportsDir, "2026-05-20T00-00-00-000Z-retrospective.md"),
      "Window: 2026-05-01T00:00:00.000Z to 2026-05-20T12:00:00.000Z (previous-report to now)\n",
      "utf8",
    );

    const result = runCollect({
      retroRoot: root,
      runTs: "ts",
      codexRoot: path.join(dir, "no-codex"),
      claudeRoot: path.join(dir, "no-claude"),
      idleMinutes: 0,
      nowMs: Date.parse("2026-06-01T00:00:00Z"),
    });

    expect(result.window).toEqual({
      since: "2026-05-20T12:00:00.000Z",
      until: "2026-06-01T00:00:00.000Z",
      sinceSource: "previous-report",
      untilSource: "now",
    });
  });
});

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
    const session = bundle.sessions[0];
    if (!session) {
      throw new Error("expected bundleWith to create one session");
    }
    session.role = "secondary";
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
    expect(result.repeatedAsks[0]?.exampleSessionIds).toEqual(["s1"]);
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
  test("keeps the main report action-focused and moves evidence to session sources", () => {
    const bundle = bundleWith(["t0"]);
    const artifacts = buildReportArtifacts(
      "ts",
      "GLOBAL-SYNTHESIS",
      [
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
      ],
      {
        prAnalysis:
          "## Recurring Corrective Patterns\n\n- Tightened verification before merge.\n\n## PR Analysis Gaps\n\n- `repo#1` — missing diff. Impact: degraded.",
        prAnalysisWarnings: ["PR `repo#1` omits known final head abc123."],
      },
    );
    const report = artifacts.report;

    const globalAt = report.indexOf("GLOBAL-SYNTHESIS");
    const prAt = report.indexOf("PR Repeated Corrective Patterns");
    expect(globalAt).toBeGreaterThan(-1);
    expect(globalAt).toBeLessThan(prAt);
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
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      path.join(runDir, "window.json"),
      JSON.stringify(
        {
          since: "2026-05-18T00:00:00.000Z",
          until: "2026-06-01T00:00:00.000Z",
          sinceSource: "first-run-default",
          untilSource: "now",
        },
        null,
        2,
      ),
      "utf8",
    );
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
        "body",
      ].join("\n"),
      "utf8",
    );
    const bundle = bundleWith(["t0"]);
    bundle.runTs = runTs;
    writeFileSync(
      path.join(runDir, `${bundle.repoHash}.json`),
      JSON.stringify(bundle, null, 2),
      "utf8",
    );
    const findings: RepoFindings = {
      repoKey: "/repo",
      frictionEpisodes: [
        { id: "e1", sessionId: "s1", citedTurnRefs: ["t0"], body: "episode body" },
      ],
      durableFixProposals: [
        { citedEpisodeRefs: ["e1"], body: "Target: hook\nConfidence: high\nfix body" },
      ],
      repeatedAsks: [],
    };
    writeFileSync(
      path.join(runDir, `${bundle.repoHash}.findings.json`),
      JSON.stringify(findings, null, 2),
      "utf8",
    );
    const synthesisPath = path.join(dir, "synthesis.md");
    writeFileSync(synthesisPath, "Target: preflight\nConfidence: medium\nGLOBAL", "utf8");

    const result = runCommit({
      retroRoot: root,
      runTs,
      synthesisPath,
      nowIso: "2026-06-01T00:00:00.000Z",
    });
    const report = readFileSync(result.reportPath, "utf8");
    const sessionSources = readFileSync(result.sourcePaths.session, "utf8");
    const prSources = readFileSync(result.sourcePaths.pr, "utf8");

    expect(report).toContain(
      "Window: 2026-05-18T00:00:00.000Z to 2026-06-01T00:00:00.000Z (first-run-default to now)",
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
    expect(existsSync(runDir)).toBe(false);
  });

  test("commit requires PR trajectory analysis before freezing and cleaning the run", () => {
    const root = path.join(dir, "store");
    const runTs = "2026-06-01T00-00-00-000Z";
    const runDir = path.join(root, "runs", runTs);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      path.join(runDir, "window.json"),
      JSON.stringify(
        {
          since: "2026-05-18T00:00:00.000Z",
          until: "2026-06-01T00:00:00.000Z",
          sinceSource: "first-run-default",
          untilSource: "now",
        },
        null,
        2,
      ),
      "utf8",
    );
    const bundle = bundleWith(["t0"]);
    bundle.runTs = runTs;
    writeFileSync(
      path.join(runDir, `${bundle.repoHash}.json`),
      JSON.stringify(bundle, null, 2),
      "utf8",
    );
    const findings: RepoFindings = {
      repoKey: "/repo",
      frictionEpisodes: [
        { id: "e1", sessionId: "s1", citedTurnRefs: ["t0"], body: "episode body" },
      ],
      durableFixProposals: [
        { citedEpisodeRefs: ["e1"], body: "Target: hook\nConfidence: high\nfix body" },
      ],
      repeatedAsks: [],
    };
    writeFileSync(
      path.join(runDir, `${bundle.repoHash}.findings.json`),
      JSON.stringify(findings, null, 2),
      "utf8",
    );

    expect(() =>
      runCommit({
        retroRoot: root,
        runTs,
        nowIso: "2026-06-01T00:00:00.000Z",
      }),
    ).toThrow("commit requires runs/2026-06-01T00-00-00-000Z/pr-analysis.md");
    expect(existsSync(runDir)).toBe(true);
    expect(loadFrozenSession(root, "codex", "s1")).toBeNull();
  });

  test("renders Target/Confidence header and a single merged evidence block in session sources", () => {
    const bundle = bundleWith(["t0", "t1"]);
    const artifacts = buildReportArtifacts("ts", "", [
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
    expect(artifacts.sessionSources).toContain("Target: skill; Confidence: medium — merge me");
    expect(artifacts.sessionSources.match(/<summary>evidence<\/summary>/g)).toHaveLength(1);
    expect(artifacts.report).not.toContain("<summary>evidence</summary>");
  });
});

describe("PR trajectory analysis", () => {
  function writeWindow(root: string, runTs = "ts"): void {
    const runDir = path.join(root, "runs", runTs);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      path.join(runDir, "window.json"),
      JSON.stringify(
        {
          since: "2026-05-18T00:00:00.000Z",
          until: "2026-06-01T00:00:00.000Z",
          sinceSource: "first-run-default",
          untilSource: "now",
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  test("collect writes PR work items from the resolved window and aggregate writes pr-analysis.md", () => {
    const root = path.join(dir, "store");
    writeWindow(root);
    const calls: string[] = [];
    const exec: CommandRunner = (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "gh" && args.join(" ") === "api user --jq .login") {
        return { status: 0, stdout: "hoangbn\n", stderr: "" };
      }
      if (command === "gh" && args.slice(0, 3).join(" ") === "repo list monke-together-strong") {
        return {
          status: 0,
          stdout: JSON.stringify([
            { nameWithOwner: "monke-together-strong/alpha", isArchived: false, isPrivate: true },
            { nameWithOwner: "monke-together-strong/old", isArchived: true, isPrivate: false },
          ]),
          stderr: "",
        };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        expect(args.at(-1)).toBe("number,url,title,createdAt,mergedAt");
        const search = args[args.indexOf("--search") + 1] ?? "";
        const byDay: Record<string, unknown[]> = {
          "merged:2026-05-21..2026-05-21": [
            {
              number: 7,
              url: "https://github.com/monke-together-strong/alpha/pull/7",
              title: "Tighten setup",
              createdAt: "2026-05-20T10:00:00Z",
              mergedAt: "2026-05-21T10:00:00Z",
            },
          ],
          "merged:2026-05-22..2026-05-22": [
            {
              number: 9,
              url: "https://github.com/monke-together-strong/alpha/pull/9",
              title: "Missing refs",
              createdAt: "2026-05-22T10:00:00Z",
              mergedAt: "2026-05-22T11:00:00Z",
            },
          ],
          "merged:2026-05-23..2026-05-23": [
            {
              number: 10,
              url: "https://github.com/monke-together-strong/alpha/pull/10",
              title: "Tighten docs",
              createdAt: "2026-05-23T10:00:00Z",
              mergedAt: "2026-05-23T11:00:00Z",
            },
          ],
          "merged:2026-05-24..2026-05-24": [
            {
              number: 8,
              url: "https://github.com/monke-together-strong/alpha/pull/8",
              title: "Too late",
              createdAt: "2026-06-02T10:00:00Z",
              mergedAt: "2026-06-02T11:00:00Z",
            },
          ],
        };
        return { status: 0, stdout: JSON.stringify(byDay[search] ?? []), stderr: "" };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "view") {
        const number = args[2] ?? "";
        const fields = args.at(-1);
        if (fields === "files") {
          const filesByNumber: Record<string, unknown> = {
            "7": { files: [{ path: "setup.ts" }] },
            "9": { files: [] },
            "10": { files: [{ path: "docs.md" }] },
          };
          return { status: 0, stdout: JSON.stringify(filesByNumber[number]), stderr: "" };
        }
        expect(fields).toBe(
          "number,url,title,createdAt,mergedAt,baseRefName,headRefName,headRefOid,mergeCommit,commits",
        );
        const detailsByNumber: Record<string, unknown> = {
          "7": {
            number: 7,
            url: "https://github.com/monke-together-strong/alpha/pull/7",
            title: "Tighten setup",
            createdAt: "2026-05-20T10:00:00Z",
            mergedAt: "2026-05-21T10:00:00Z",
            baseRefName: "main",
            headRefName: "feature/setup",
            headRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            mergeCommit: { oid: "cccccccccccccccccccccccccccccccccccccccc" },
            commits: [
              {
                oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                committedDate: "2026-05-20T09:00:00Z",
                messageHeadline: "Initial implementation",
              },
              {
                oid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                committedDate: "2026-05-20T11:00:00Z",
                messageHeadline: "Add verification",
              },
            ],
          },
          "9": {
            number: 9,
            url: "https://github.com/monke-together-strong/alpha/pull/9",
            title: "Missing refs",
            createdAt: "2026-05-22T10:00:00Z",
            mergedAt: "2026-05-22T11:00:00Z",
            commits: [],
          },
          "10": {
            number: 10,
            url: "https://github.com/monke-together-strong/alpha/pull/10",
            title: "Tighten docs",
            createdAt: "2026-05-23T10:00:00Z",
            mergedAt: "2026-05-23T11:00:00Z",
            baseRefName: "main",
            headRefName: "feature/docs",
            headRefOid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            mergeCommit: { oid: "ffffffffffffffffffffffffffffffffffffffff" },
            commits: [
              {
                oid: "dddddddddddddddddddddddddddddddddddddddd",
                committedDate: "2026-05-23T09:00:00Z",
                messageHeadline: "Initial docs",
              },
              {
                oid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                committedDate: "2026-05-23T10:30:00Z",
                messageHeadline: "Add verification",
              },
            ],
          },
        };
        return { status: 0, stdout: JSON.stringify(detailsByNumber[number]), stderr: "" };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "diff") {
        return {
          status: 0,
          stdout: "diff --git a/setup.ts b/setup.ts\n",
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: `unexpected command: ${command} ${args.join(" ")}` };
    };

    const manifest = runPrCollect({ retroRoot: root, runTs: "ts", exec });
    expect(manifest.author).toBe("hoangbn");
    expect(manifest.workItems).toHaveLength(3);
    expect(calls.some((call) => call.includes("pr list") && call.includes("commits"))).toBe(false);
    expect(calls.some((call) => call.includes("pr list") && call.includes("files"))).toBe(false);
    expect(calls).toContain(
      "gh pr view 7 --repo monke-together-strong/alpha --json number,url,title,createdAt,mergedAt,baseRefName,headRefName,headRefOid,mergeCommit,commits",
    );
    expect(calls).toContain("gh pr view 7 --repo monke-together-strong/alpha --json files");
    expect(calls).toContain("gh pr diff 9 --repo monke-together-strong/alpha --patch");
    const analyzedItem = manifest.workItems.find((item) => item.number === 7)!;
    const missingRefItem = manifest.workItems.find((item) => item.number === 9)!;
    const secondAnalyzedItem = manifest.workItems.find((item) => item.number === 10)!;
    expect(analyzedItem.openingSnapshot).toEqual({
      confidence: "inferred",
      ref: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      reason: "Latest PR commit whose commit date is at or before the PR creation time.",
    });
    expect(
      JSON.parse(readFileSync(analyzedItem.workItemPath, "utf8")).postOpeningDelta,
    ).toMatchObject({
      source: "github-pr-diff-fallback",
      confidence: "lower",
    });
    expect(
      JSON.parse(readFileSync(missingRefItem.workItemPath, "utf8")).postOpeningDelta,
    ).toMatchObject({
      source: "github-pr-diff-fallback",
      confidence: "lower",
    });
    expect(secondAnalyzedItem.openingSnapshot).toEqual({
      confidence: "inferred",
      ref: "dddddddddddddddddddddddddddddddddddddddd",
      reason: "Latest PR commit whose commit date is at or before the PR creation time.",
    });
    expect(manifest.gaps).toEqual([]);

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
        "`bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` Add verification.",
      ].join("\n"),
      "utf8",
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
        "`eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` Add verification.",
      ].join("\n"),
      "utf8",
    );

    const aggregate = runPrAggregate({ retroRoot: root, runTs: "ts" });
    const report = readFileSync(aggregate.path, "utf8");
    expect(report).toContain("## Recurring Corrective Patterns");
    expect(report).toContain(
      "Added missing verification before merge. (2 PRs: monke-together-strong/alpha#7, monke-together-strong/alpha#10)",
    );
    expect(report).not.toContain("post-opening delta unavailable");
    expect(report).toContain("### monke-together-strong/alpha#7");
  });

  test("manifest-backed PR validation checks headings, refs, and cited SHAs", () => {
    const manifest: PrAnalysisManifest = {
      version: 1,
      runTs: "ts",
      window: {
        since: "2026-05-18T00:00:00.000Z",
        until: "2026-06-01T00:00:00.000Z",
        sinceSource: "first-run-default",
        untilSource: "now",
      },
      org: "monke-together-strong",
      author: "hoangbn",
      generatedAt: "2026-06-01T00:00:00.000Z",
      gaps: [],
      workItems: [
        {
          repo: "monke-together-strong/alpha",
          number: 7,
          url: "https://github.com/monke-together-strong/alpha/pull/7",
          title: "Tighten setup",
          createdAt: "2026-05-20T10:00:00Z",
          mergedAt: "2026-05-21T10:00:00Z",
          workItemPath: "/tmp/work.json",
          analysisPath: "/tmp/work.analysis.md",
          openingSnapshot: {
            confidence: "inferred",
            ref: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            reason: "test",
          },
          finalHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          mergeCommitSha: "cccccccccccccccccccccccccccccccccccccccc",
          commitShas: [
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          ],
        },
      ],
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
        "none",
      ].join("\n"),
      manifest,
    );

    expect(result.warnings).toContain(
      "PR `monke-together-strong/alpha#7` is missing `## Commit Message Reference`.",
    );
    expect(result.warnings).toContain(
      "PR `monke-together-strong/alpha#7` omits known final head bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.",
    );
    expect(result.warnings).toContain(
      "PR `monke-together-strong/alpha#7` cites unknown commit SHA ddddddd.",
    );
  });

  test("manifest-backed PR validation uses exact PR headings and accepts short SHA prefixes", () => {
    const manifest: PrAnalysisManifest = {
      version: 1,
      runTs: "ts",
      window: {
        since: "2026-05-18T00:00:00.000Z",
        until: "2026-06-01T00:00:00.000Z",
        sinceSource: "first-run-default",
        untilSource: "now",
      },
      org: "monke-together-strong",
      author: "hoangbn",
      generatedAt: "2026-06-01T00:00:00.000Z",
      gaps: [],
      workItems: [
        {
          repo: "repo",
          number: 1,
          url: "https://github.com/repo/pull/1",
          title: "One",
          createdAt: "2026-05-20T10:00:00Z",
          mergedAt: "2026-05-21T10:00:00Z",
          workItemPath: "/tmp/work-1.json",
          analysisPath: "/tmp/work-1.analysis.md",
          openingSnapshot: {
            confidence: "inferred",
            ref: "1111111111111111111111111111111111111111",
            reason: "test",
          },
          finalHeadSha: "2222222222222222222222222222222222222222",
          commitShas: [
            "1111111111111111111111111111111111111111",
            "2222222222222222222222222222222222222222",
          ],
        },
        {
          repo: "repo",
          number: 10,
          url: "https://github.com/repo/pull/10",
          title: "Ten",
          createdAt: "2026-05-20T10:00:00Z",
          mergedAt: "2026-05-21T10:00:00Z",
          workItemPath: "/tmp/work-10.json",
          analysisPath: "/tmp/work-10.analysis.md",
          openingSnapshot: {
            confidence: "inferred",
            ref: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            reason: "test",
          },
          finalHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          commitShas: [
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          ],
        },
      ],
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
        "`bbbbbbb` Add verification.",
      ].join("\n"),
      manifest,
    );

    expect(result.warnings).toContain("Expected PR `repo#1` is missing from PR analysis.");
    expect(result.warnings).not.toContain(
      "PR `repo#10` omits known opening ref aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.",
    );
    expect(result.warnings).not.toContain(
      "PR `repo#10` omits known final head bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.",
    );
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
    // The most-complete copy (long.jsonl, 5 turns) must be the one retained.
    const bundlePath = result.bundles[0]?.path;
    if (!bundlePath) {
      throw new Error("expected one bundle to be written");
    }
    const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as RepoBundle;
    expect(bundle.sessions[0]?.turns).toHaveLength(5);
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
