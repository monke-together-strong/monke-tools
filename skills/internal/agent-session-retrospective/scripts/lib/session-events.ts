import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { resolveGitRoot, resolveRepoKey } from "./identity.ts";
import { clipProse, summarizeInput, summarizeOutput } from "./normalize.ts";
import type { AgentKind, CanonicalSession, CanonicalTurn } from "./types.ts";

// Cap distinct directory resolutions per session: a session that reads thousands
// of paths must not trigger thousands of `git` calls. Secondary membership is
// best-effort, then frozen once (so it is stable thereafter).
const MAX_TOUCHED_DIRS_PER_SESSION = 64;

export type SessionEvent =
  | {
      captureRawUserMessage: boolean;
      kind: "prose";
      role: "user" | "assistant";
      text: string;
    }
  | {
      callId: string | null;
      cwd: string | null;
      input: unknown;
      kind: "tool-call";
      name: string;
    }
  | {
      callId: string;
      error?: string;
      exitCode?: number;
      kind: "tool-result";
      output: string;
    };

export interface DecodedSession {
  cwd: string | null;
  events: SessionEvent[];
  lastActivityAt: string | null;
  parentSessionId: string | null;
  sessionId: string;
  startedAt: string | null;
  threadSource: string | null;
}

export interface SessionAdapter {
  readonly agent: AgentKind;
  decode: (records: unknown[]) => DecodedSession;
}

interface BuildCanonicalSessionOptions extends DecodedSession {
  agent: AgentKind;
  contentHash: string;
  filePath: string;
  sourceLineCount: number;
}

/** A turn accumulator that assigns stable `t<index>` refs in arrival order. */
class TurnBuilder {
  readonly turns: CanonicalTurn[] = [];

  prose(kind: "user" | "assistant", text: string): void {
    const trimmed = clipProse(text);
    if (!trimmed) {
      return;
    }
    this.turns.push({ kind, ref: `t${this.turns.length}`, text: trimmed });
  }

  toolCall(name: string, inputSummary: string): CanonicalTurn & { kind: "tool_call" } {
    const turn = {
      inputSummary,
      kind: "tool_call" as const,
      name,
      ref: `t${this.turns.length}`,
    };
    this.turns.push(turn);
    return turn;
  }
}

/** Build one canonical session from agent-independent transcript events. */
export function buildCanonicalSession(
  options: BuildCanonicalSessionOptions,
): CanonicalSession | null {
  if (!isNonEmptyString(options.sessionId)) {
    return null;
  }

  const builder = new TurnBuilder();
  const pendingCalls = new Map<string, CanonicalTurn & { kind: "tool_call" }>();
  const rawUserMessages: string[] = [];
  const touched = new Set<string>();
  const visitedDirs = new Set<string>();
  const primary = isNonEmptyString(options.cwd) ? resolveRepoKey(options.cwd) : "";

  for (const event of options.events) {
    if (event.kind === "prose") {
      if (event.captureRawUserMessage && isHumanPromptSource(options.threadSource)) {
        rawUserMessages.push(event.text.trim());
      }
      builder.prose(event.role, event.text);
      continue;
    }

    if (event.kind === "tool-call") {
      const callPrimary = isNonEmptyString(event.cwd) ? resolveRepoKey(event.cwd) : "";
      collectTouchedRoots(event.input, callPrimary, touched, visitedDirs);
      const turn = builder.toolCall(event.name, summarizeInput(event.input));
      if (event.callId !== null) {
        pendingCalls.set(event.callId, turn);
      }
      continue;
    }

    const turn = pendingCalls.get(event.callId);
    if (turn) {
      applyToolResult(turn, event);
    }
  }

  return {
    agent: options.agent,
    contentHash: options.contentHash,
    cwd: options.cwd,
    filePath: options.filePath,
    lastActivityAt: options.lastActivityAt,
    parentSessionId: options.parentSessionId,
    rawUserMessages,
    sessionId: options.sessionId,
    sourceLineCount: options.sourceLineCount,
    startedAt: options.startedAt,
    threadSource: options.threadSource,
    touchedRoots: [...touched].filter((root) => root !== primary).toSorted(),
    turns: builder.turns,
  };
}

function isHumanPromptSource(threadSource: string | null): boolean {
  return threadSource !== "subagent" && threadSource !== "automation";
}

function applyToolResult(
  turn: CanonicalTurn & { kind: "tool_call" },
  result: SessionEvent & { kind: "tool-result" },
): void {
  turn.outputHeadTail = summarizeOutput(result.output);
  if (result.error !== undefined) {
    turn.error = result.error;
  }
  if (result.exitCode !== undefined) {
    turn.exitCode = result.exitCode;
    if (result.exitCode !== 0) {
      turn.error = `exit ${result.exitCode}`;
    }
  }
}

function collectTouchedRoots(
  rawArgs: unknown,
  primary: string,
  into: Set<string>,
  visitedDirs: Set<string>,
): void {
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      collectTouchedRoot(value, primary, into, visitedDirs);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const key of ["workdir", "cwd", "path", "file_path", "absolute_path"]) {
      if (key in value) {
        visit(value[key]);
      }
    }
  };
  visit(rawArgs);
}

function collectTouchedRoot(
  value: string,
  primary: string,
  into: Set<string>,
  visitedDirs: Set<string>,
): void {
  if (
    !value.startsWith("/") ||
    value.length <= 1 ||
    visitedDirs.size >= MAX_TOUCHED_DIRS_PER_SESSION
  ) {
    return;
  }

  const dir = isDirectory(value) ? value : path.dirname(value);
  if (visitedDirs.has(dir) || !existsSync(dir)) {
    return;
  }

  visitedDirs.add(dir);
  const root = resolveGitRoot(dir);
  if (isNonEmptyString(root) && root !== primary) {
    into.add(root);
  }
}

function isDirectory(value: string): boolean {
  try {
    return statSync(value, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}
