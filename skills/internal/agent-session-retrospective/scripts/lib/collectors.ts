import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { summarizeInput } from "./normalize.ts";
import { buildCanonicalSession } from "./session-events.ts";
import type { DecodedSession, SessionAdapter, SessionEvent } from "./session-events.ts";
import type { AgentKind, CanonicalSession } from "./types.ts";

interface DiscoveredFile {
  agent: AgentKind;
  filePath: string;
}

function readJsonlLines(filePath: string): { hash: string; lineCount: number; records: unknown[]; } {
  const raw = readFileSync(filePath, "utf-8");
  const hash = createHash("sha256").update(raw).digest("hex");
  const lines = raw.split("\n");
  const records: unknown[] = [];
  let lineCount = 0;
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    lineCount += 1;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Skip malformed lines; transcripts are occasionally truncated mid-write.
    }
  }
  return { hash, lineCount, records };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const EXIT_CODE_PATTERNS = [
  /exited with code (?<exitCode>\d+)/iu,
  /exit code:? (?<exitCode>\d+)/iu,
  /exit status:? (?<exitCode>\d+)/iu,
  /process exited with status (?<exitCode>\d+)/iu,
];

function parseExitCode(output: string): number | undefined {
  for (const pattern of EXIT_CODE_PATTERNS) {
    const match = output.match(pattern);
    if (match?.groups?.exitCode !== undefined && match.groups.exitCode !== "") {
      return Number(match.groups.exitCode);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Codex: event-stream JSONL (session_meta / response_item / event_msg).
// ---------------------------------------------------------------------------

const codexSessionAdapter: SessionAdapter = {
  agent: "codex",
  decode: decodeCodexSession,
};

export function parseCodexSession(filePath: string): CanonicalSession | null {
  return parseSessionWithAdapter(filePath, codexSessionAdapter);
}

function decodeCodexSession(records: unknown[]): DecodedSession {
  const session = createDecodedSession();
  const hasEventProse = records.some(hasCodexEventProse);

  for (const entry of records) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    noteActivity(session, record);
    const payload = asRecord(record.payload);
    if (!payload) {
      continue;
    }

    if (record.type === "session_meta") {
      readCodexSessionMetadata(session, payload);
      continue;
    }
    if (record.type === "turn_context") {
      readCodexTurnContext(session, payload);
      continue;
    }

    session.events.push(...decodeCodexPayload(record.type, payload, hasEventProse, session.cwd));
  }

  return session;
}

function hasCodexEventProse(entry: unknown): boolean {
  const record = asRecord(entry);
  const payload = record && asRecord(record.payload);
  const type = payload?.type;
  return record?.type === "event_msg" && (type === "user_message" || type === "agent_message");
}

function readCodexSessionMetadata(session: DecodedSession, payload: Record<string, unknown>): void {
  if (typeof payload.id === "string") {
    session.sessionId = payload.id;
  }
  if (typeof payload.cwd === "string") {
    session.cwd = payload.cwd;
  }
  if (typeof payload.thread_source === "string") {
    session.threadSource = payload.thread_source;
  }
  session.parentSessionId = readCodexParentSessionId(payload);
}

function readCodexParentSessionId(payload: Record<string, unknown>): string | null {
  const source = asRecord(payload.source);
  const subagent = source && asRecord(source.subagent);
  const threadSpawn = subagent && asRecord(subagent.thread_spawn);
  if (typeof threadSpawn?.parent_thread_id === "string") {
    return threadSpawn.parent_thread_id;
  }
  return typeof payload.parent_thread_id === "string" ? payload.parent_thread_id : null;
}

function readCodexTurnContext(session: DecodedSession, payload: Record<string, unknown>): void {
  if ((session.cwd === null || session.cwd === "") && typeof payload.cwd === "string") {
    session.cwd = payload.cwd;
  }
}

function decodeCodexPayload(
  recordType: unknown,
  payload: Record<string, unknown>,
  hasEventProse: boolean,
  cwd: string | null,
): SessionEvent[] {
  if (recordType === "event_msg") {
    const event = decodeCodexEventMessage(payload, hasEventProse);
    return event ? [event] : [];
  }
  if (recordType === "response_item") {
    const event = decodeCodexResponseItem(payload, hasEventProse, cwd);
    return event ? [event] : [];
  }
  return [];
}

function decodeCodexEventMessage(
  payload: Record<string, unknown>,
  hasEventProse: boolean,
): SessionEvent | null {
  if (typeof payload.message !== "string") {
    return null;
  }
  if (payload.type === "user_message") {
    return {
      captureRawUserMessage: true,
      kind: "prose",
      role: "user",
      text: payload.message,
    };
  }
  if (payload.type === "agent_message" && hasEventProse) {
    return {
      captureRawUserMessage: false,
      kind: "prose",
      role: "assistant",
      text: payload.message,
    };
  }
  return null;
}

function decodeCodexResponseItem(
  payload: Record<string, unknown>,
  hasEventProse: boolean,
  cwd: string | null,
): SessionEvent | null {
  if (payload.type === "message" && !hasEventProse) {
    return decodeCodexResponseMessage(payload);
  }
  if (payload.type === "function_call") {
    return decodeCodexFunctionCall(payload, cwd);
  }
  if (payload.type === "function_call_output") {
    return decodeCodexFunctionResult(payload);
  }
  return null;
}

function decodeCodexResponseMessage(payload: Record<string, unknown>): SessionEvent | null {
  const { role } = payload;
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const text = extractCodexMessageText(payload.content);
  if (role === "user" && isInjectedUserText(text)) {
    return null;
  }
  return {
    captureRawUserMessage: role === "user" && text.trim() !== "",
    kind: "prose",
    role,
    text,
  };
}

function decodeCodexFunctionCall(
  payload: Record<string, unknown>,
  cwd: string | null,
): SessionEvent {
  return {
    callId: typeof payload.call_id === "string" ? payload.call_id : null,
    cwd,
    input: parseCodexArguments(payload.arguments),
    kind: "tool-call",
    name: typeof payload.name === "string" ? payload.name : "tool",
  };
}

function decodeCodexFunctionResult(payload: Record<string, unknown>): SessionEvent {
  const output =
    typeof payload.output === "string" ? payload.output : summarizeInput(payload.output);
  const exitCode = parseExitCode(output);
  return {
    callId: typeof payload.call_id === "string" ? payload.call_id : "",
    ...(exitCode === undefined ? {} : { exitCode }),
    kind: "tool-result",
    output,
  };
}

function parseCodexArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function extractCodexMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      const record = asRecord(block);
      return record && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function isInjectedUserText(text: string): boolean {
  const head = text.trimStart().slice(0, 40);
  return (
    head.startsWith("# AGENTS.md") ||
    head.startsWith("<INSTRUCTIONS>") ||
    head.startsWith("<user_instructions>") ||
    head.startsWith("<permissions") ||
    head.startsWith("<environment_context>")
  );
}

// ---------------------------------------------------------------------------
// Claude: tree JSONL (user / assistant entries, content blocks).
// ---------------------------------------------------------------------------

const claudeSessionAdapter: SessionAdapter = {
  agent: "claude",
  decode: decodeClaudeSession,
};

export function parseClaudeSession(filePath: string): CanonicalSession | null {
  return parseSessionWithAdapter(filePath, claudeSessionAdapter);
}

function decodeClaudeSession(records: unknown[]): DecodedSession {
  const session = createDecodedSession();
  const toolResults = collectClaudeToolResults(records);

  for (const entry of records) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    noteActivity(session, record);
    readClaudeSessionMetadata(session, record);
    const message = asRecord(record.message);
    if (message) {
      session.events.push(...decodeClaudeMessage(record, message, session.cwd, toolResults));
    }
  }

  return session;
}

function collectClaudeToolResults(
  records: unknown[],
): Map<string, SessionEvent & { kind: "tool-result" }> {
  const results = new Map<string, SessionEvent & { kind: "tool-result" }>();
  for (const entry of records) {
    const record = asRecord(entry);
    const message = record && asRecord(record.message);
    if (!Array.isArray(message?.content)) {
      continue;
    }
    for (const block of message.content) {
      const result = decodeClaudeToolResult(block);
      if (result) {
        results.set(result.callId, result);
      }
    }
  }
  return results;
}

function readClaudeSessionMetadata(session: DecodedSession, record: Record<string, unknown>): void {
  if (session.sessionId === "" && typeof record.sessionId === "string") {
    session.sessionId = record.sessionId;
  }
  if (session.cwd === null && typeof record.cwd === "string") {
    session.cwd = record.cwd;
  }
}

function decodeClaudeMessage(
  record: Record<string, unknown>,
  message: Record<string, unknown>,
  cwd: string | null,
  toolResults: Map<string, SessionEvent & { kind: "tool-result" }>,
): SessionEvent[] {
  const { content } = message;
  if (typeof content === "string") {
    return record.type === "user" && record.isMeta !== true
      ? [
          {
            captureRawUserMessage: true,
            kind: "prose",
            role: "user",
            text: content,
          },
        ]
      : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const events: SessionEvent[] = [];
  for (const block of content) {
    events.push(...decodeClaudeBlock(record, block, cwd, toolResults));
  }
  return events;
}

function decodeClaudeBlock(
  record: Record<string, unknown>,
  block: unknown,
  cwd: string | null,
  toolResults: Map<string, SessionEvent & { kind: "tool-result" }>,
): SessionEvent[] {
  const content = asRecord(block);
  if (!content) {
    return [];
  }
  if (content.type === "tool_result") {
    return [];
  }
  if (
    record.type === "user" &&
    record.isMeta !== true &&
    content.type === "text" &&
    typeof content.text === "string"
  ) {
    return [
      {
        captureRawUserMessage: true,
        kind: "prose",
        role: "user",
        text: content.text,
      },
    ];
  }
  if (record.type !== "assistant") {
    return [];
  }
  if (content.type === "text" && typeof content.text === "string") {
    return [
      {
        captureRawUserMessage: false,
        kind: "prose",
        role: "assistant",
        text: content.text,
      },
    ];
  }
  if (content.type === "tool_use") {
    const call: SessionEvent = {
      callId: typeof content.id === "string" ? content.id : null,
      cwd,
      input: content.input,
      kind: "tool-call",
      name: typeof content.name === "string" ? content.name : "tool",
    };
    const result = call.callId === null ? undefined : toolResults.get(call.callId);
    return result ? [call, result] : [call];
  }
  return [];
}

function decodeClaudeToolResult(
  block: unknown,
): (SessionEvent & { kind: "tool-result" }) | null {
  const content = asRecord(block);
  if (content?.type !== "tool_result" || typeof content.tool_use_id !== "string") {
    return null;
  }
  return {
    callId: content.tool_use_id,
    ...(content.is_error === true ? { error: "tool error" } : {}),
    kind: "tool-result",
    output: extractClaudeText(content.content),
  };
}

function extractClaudeText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      const record = asRecord(block);
      if (record && typeof record.text === "string") {
        return record.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseSessionWithAdapter(
  filePath: string,
  adapter: SessionAdapter,
): CanonicalSession | null {
  const { hash, lineCount, records } = readJsonlLines(filePath);
  if (records.length === 0) {
    return null;
  }
  return buildCanonicalSession({
    agent: adapter.agent,
    contentHash: hash,
    filePath,
    sourceLineCount: lineCount,
    ...adapter.decode(records),
  });
}

function createDecodedSession(): DecodedSession {
  return {
    cwd: null,
    events: [],
    lastActivityAt: null,
    parentSessionId: null,
    sessionId: "",
    startedAt: null,
    threadSource: null,
  };
}

function noteActivity(session: DecodedSession, record: Record<string, unknown>): void {
  if (typeof record.timestamp !== "string") {
    return;
  }
  session.startedAt ??= record.timestamp;
  session.lastActivityAt = record.timestamp;
}

// ---------------------------------------------------------------------------
// Discovery.
// ---------------------------------------------------------------------------

export interface DiscoverOptions {
  claudeRoot?: string;
  codexRoot?: string;
  home?: string;
}

/** Enumerate Codex + Claude transcript files on disk. */
export function discoverSessionFiles(options: DiscoverOptions = {}): DiscoveredFile[] {
  const home = options.home ?? homedir();
  const codexRoot = options.codexRoot ?? path.join(home, ".codex");
  const claudeRoot = options.claudeRoot ?? path.join(home, ".claude", "projects");
  const files: DiscoveredFile[] = [];

  for (const dir of [path.join(codexRoot, "sessions"), path.join(codexRoot, "archived_sessions")]) {
    for (const filePath of walkJsonl(dir)) {
      files.push({ agent: "codex", filePath });
    }
  }
  for (const filePath of walkJsonl(claudeRoot)) {
    files.push({ agent: "claude", filePath });
  }
  return files;
}

function walkJsonl(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkJsonl(full));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

export function parseSessionFile(file: DiscoveredFile): CanonicalSession | null {
  return file.agent === "codex" ? parseCodexSession(file.filePath) : parseClaudeSession(file.filePath);
}
