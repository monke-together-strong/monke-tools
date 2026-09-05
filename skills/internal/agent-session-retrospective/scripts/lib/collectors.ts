import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { summarizeInput } from "./normalize.ts";
import { buildCanonicalSession } from "./session-events.ts";
import type { DecodedSession, SessionAdapter, SessionEvent } from "./session-events.ts";
import {
  ClaudeContentBlockSchema,
  ClaudeTranscriptEnvelopeSchema,
  ClaudeTranscriptRecordSchema,
  CodexTranscriptRecordSchema,
  extractClaudeTextBlocks,
  JsonValueSchema,
  TranscriptEnvelopeSchema
} from "./transcript-schemas.ts";
import type {
  ClaudeTranscriptEnvelope,
  ClaudeTranscriptRecord,
  CodexTranscriptRecord,
  JsonValue
} from "./transcript-schemas.ts";
import type { AgentKind } from "./types.ts";

interface DiscoveredFile {
  agent: AgentKind;
  filePath: string;
}

type CodexEventPayload = Extract<CodexTranscriptRecord, { type: "event_msg" }>["payload"];
type CodexMessagePayload = Extract<CodexResponsePayload, { type: "message" }>;
type CodexResponsePayload = Extract<CodexTranscriptRecord, { type: "response_item" }>["payload"];
type CodexSessionMetaPayload = Extract<CodexTranscriptRecord, { type: "session_meta" }>["payload"];
type CodexTurnContextPayload = Extract<CodexTranscriptRecord, { type: "turn_context" }>["payload"];

function readJsonlLines(filePath: string) {
  const raw = readFileSync(filePath, "utf-8");
  const hash = createHash("sha256").update(raw).digest("hex");
  const lines = raw.split("\n");
  const records: JsonValue[] = [];
  let lineCount = 0;
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    lineCount += 1;
    try {
      const value: unknown = JSON.parse(line);
      const parsed = JsonValueSchema.safeParse(value);
      if (parsed.success) {
        records.push(parsed.data);
      }
    } catch {
      // Skip malformed lines; transcripts are occasionally truncated mid-write.
    }
  }
  return { hash, lineCount, records };
}

const EXIT_CODE_PATTERNS = [
  /exited with code (?<exitCode>\d+)/iu,
  /exit code:? (?<exitCode>\d+)/iu,
  /exit status:? (?<exitCode>\d+)/iu,
  /process exited with status (?<exitCode>\d+)/iu
];
const INJECTED_TEXT_PREFIX_LENGTH = 40;

function parseExitCode(output: string) {
  const exitCode = EXIT_CODE_PATTERNS.map(
    (pattern) => output.match(pattern)?.groups?.exitCode
  ).find((value) => value !== undefined && value !== "");
  return exitCode === undefined ? undefined : Number(exitCode);
}

// ---------------------------------------------------------------------------
// Codex: event-stream JSONL (session_meta / response_item / event_msg).
// ---------------------------------------------------------------------------

const codexSessionAdapter: SessionAdapter = {
  agent: "codex",
  decode: decodeCodexSession
};

export function parseCodexSession(filePath: string) {
  return parseSessionWithAdapter(filePath, codexSessionAdapter);
}

function decodeCodexSession(rawRecords: JsonValue[]) {
  const session = createDecodedSession();
  const records = parseCodexTranscript(rawRecords);
  const hasEventProse = records.some((record) => record.type === "event_msg");

  for (const rawRecord of rawRecords) {
    const envelope = TranscriptEnvelopeSchema.safeParse(rawRecord);
    if (envelope.success) {
      noteActivity(session, envelope.data.timestamp);
    }
  }
  for (const record of records) {
    switch (record.type) {
      case "event_msg": {
        const event = decodeCodexEventMessage(record.payload, hasEventProse);
        if (event) {
          session.events.push(event);
        }
        break;
      }
      case "response_item": {
        const event = decodeCodexResponseItem(record.payload, hasEventProse, session.cwd);
        if (event) {
          session.events.push(event);
        }
        break;
      }
      case "session_meta": {
        readCodexSessionMetadata(session, record.payload);
        break;
      }
      case "turn_context": {
        readCodexTurnContext(session, record.payload);
        break;
      }
      default: {
        break;
      }
    }
  }

  return session;
}

function readCodexSessionMetadata(session: DecodedSession, payload: CodexSessionMetaPayload) {
  if (payload.id !== undefined) {
    session.sessionId = payload.id;
  }
  if (payload.cwd !== undefined) {
    session.cwd = payload.cwd;
  }
  if (payload.thread_source !== undefined) {
    session.threadSource = payload.thread_source;
  }
  session.parentSessionId =
    payload.source?.subagent?.thread_spawn?.parent_thread_id ?? payload.parent_thread_id ?? null;
}

function readCodexTurnContext(session: DecodedSession, payload: CodexTurnContextPayload) {
  if ((session.cwd === null || session.cwd === "") && payload.cwd !== undefined) {
    session.cwd = payload.cwd;
  }
}

function decodeCodexEventMessage(
  payload: CodexEventPayload,
  hasEventProse: boolean
): SessionEvent | null {
  if (payload.type === "user_message") {
    return {
      captureRawUserMessage: true,
      kind: "prose",
      role: "user",
      text: payload.message
    };
  }
  return hasEventProse
    ? {
        captureRawUserMessage: false,
        kind: "prose",
        role: "assistant",
        text: payload.message
      }
    : null;
}

function decodeCodexResponseItem(
  payload: CodexResponsePayload,
  hasEventProse: boolean,
  cwd: string | null
): SessionEvent | null {
  if (payload.type === "message") {
    if (hasEventProse) {
      return null;
    }
    const text = extractCodexMessageText(payload.content);
    if (payload.role === "user" && isInjectedUserText(text)) {
      return null;
    }
    return {
      captureRawUserMessage: payload.role === "user" && text.trim() !== "",
      kind: "prose",
      role: payload.role,
      text
    };
  }
  if (payload.type === "function_call") {
    const input = parseCodexArguments(payload.arguments);
    return {
      callId: payload.call_id ?? null,
      cwd,
      inputSummary: summarizeInput(input),
      kind: "tool-call",
      name: payload.name ?? "tool",
      pathCandidates: collectToolPathCandidates(input)
    };
  }

  const output = summarizeInput(payload.output);
  const exitCode = parseExitCode(output);
  const event: SessionEvent & { kind: "tool-result" } = {
    callId: payload.call_id ?? "",
    kind: "tool-result",
    output
  };
  if (exitCode !== undefined) {
    event.exitCode = exitCode;
  }
  return event;
}

function parseCodexTranscript(records: JsonValue[]) {
  const parsedRecords: CodexTranscriptRecord[] = [];
  for (const record of records) {
    const parsed = CodexTranscriptRecordSchema.safeParse(record);
    if (parsed.success) {
      parsedRecords.push(parsed.data);
    }
  }
  return parsedRecords;
}

function parseCodexArguments(value: JsonValue | undefined) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The response schema already validated this recursive JSON value; Codex alone may encode its tool arguments as a JSON string.
  if (value === undefined || typeof value !== "string") {
    return value ?? null;
  }
  try {
    const decoded: unknown = JSON.parse(value);
    const parsed = JsonValueSchema.safeParse(decoded);
    return parsed.success ? parsed.data : value;
  } catch {
    return value;
  }
}

function extractCodexMessageText(content: CodexMessagePayload["content"]) {
  return Array.isArray(content)
    ? content
        .map((block) => block?.text ?? "")
        .filter(Boolean)
        .join("\n")
    : content;
}

function collectToolPathCandidates(input: JsonValue) {
  const candidates: string[] = [];
  const visit = (value: JsonValue) => {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The transcript schema already validated this recursive JSON value; string members are candidate filesystem paths.
    if (typeof value === "string") {
      candidates.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- After JSON validation, this distinguishes the object member from null, booleans, and numbers for keyed traversal.
    if (value === null || typeof value !== "object") {
      return;
    }
    for (const key of ["workdir", "cwd", "path", "file_path", "absolute_path"]) {
      const candidate = value[key];
      if (candidate !== undefined) {
        visit(candidate);
      }
    }
  };
  visit(input);
  return candidates;
}

function isInjectedUserText(text: string) {
  const head = text.trimStart().slice(0, INJECTED_TEXT_PREFIX_LENGTH);
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
  decode: decodeClaudeSession
};

export function parseClaudeSession(filePath: string) {
  return parseSessionWithAdapter(filePath, claudeSessionAdapter);
}

function decodeClaudeSession(rawRecords: JsonValue[]) {
  const session = createDecodedSession();
  const records = parseClaudeTranscript(rawRecords);
  const toolResults = collectClaudeToolResults(records);

  for (const rawRecord of rawRecords) {
    const envelope = ClaudeTranscriptEnvelopeSchema.safeParse(rawRecord);
    if (envelope.success) {
      noteActivity(session, envelope.data.timestamp);
      readClaudeSessionMetadata(session, envelope.data);
    }
  }
  for (const record of records) {
    session.events.push(...decodeClaudeMessage(record, session.cwd, toolResults));
  }

  return session;
}

function collectClaudeToolResults(records: ClaudeTranscriptRecord[]) {
  const results = new Map<string, SessionEvent & { kind: "tool-result" }>();
  for (const record of records) {
    if (!Array.isArray(record.message.content)) {
      continue;
    }
    for (const block of record.message.content) {
      const result = decodeClaudeToolResult(block);
      if (result) {
        results.set(result.callId, result);
      }
    }
  }
  return results;
}

function parseClaudeTranscript(records: JsonValue[]) {
  const parsedRecords: ClaudeTranscriptRecord[] = [];
  for (const record of records) {
    const parsed = ClaudeTranscriptRecordSchema.safeParse(record);
    if (parsed.success) {
      parsedRecords.push(parsed.data);
    }
  }
  return parsedRecords;
}

function readClaudeSessionMetadata(session: DecodedSession, record: ClaudeTranscriptEnvelope) {
  if (session.sessionId === "" && record.sessionId !== undefined) {
    session.sessionId = record.sessionId;
  }
  if (session.cwd === null && record.cwd !== undefined) {
    session.cwd = record.cwd;
  }
}

function decodeClaudeMessage(
  record: ClaudeTranscriptRecord,
  cwd: string | null,
  toolResults: Map<string, SessionEvent & { kind: "tool-result" }>
): SessionEvent[] {
  const { content } = record.message;
  if (!Array.isArray(content)) {
    return record.type === "user" && record.isMeta !== true
      ? [
          {
            captureRawUserMessage: true,
            kind: "prose",
            role: "user",
            text: content
          }
        ]
      : [];
  }

  const events: SessionEvent[] = [];
  for (const block of content) {
    events.push(...decodeClaudeBlock(record, block, cwd, toolResults));
  }
  return events;
}

function decodeClaudeBlock(
  record: ClaudeTranscriptRecord,
  block: JsonValue,
  cwd: string | null,
  toolResults: Map<string, SessionEvent & { kind: "tool-result" }>
): SessionEvent[] {
  const parsed = ClaudeContentBlockSchema.safeParse(block);
  if (!parsed.success) {
    return [];
  }
  const content = parsed.data;
  if (content.type === "tool_result") {
    return [];
  }
  if (record.type === "user" && record.isMeta !== true && content.type === "text") {
    return [
      {
        captureRawUserMessage: true,
        kind: "prose",
        role: "user",
        text: content.text
      }
    ];
  }
  if (record.type !== "assistant") {
    return [];
  }
  if (content.type === "text") {
    return [
      {
        captureRawUserMessage: false,
        kind: "prose",
        role: "assistant",
        text: content.text
      }
    ];
  }
  if (content.type === "tool_use") {
    const input = content.input ?? null;
    const call: SessionEvent = {
      callId: content.id ?? null,
      cwd,
      inputSummary: summarizeInput(input),
      kind: "tool-call",
      name: content.name ?? "tool",
      pathCandidates: collectToolPathCandidates(input)
    };
    const result = call.callId === null ? undefined : toolResults.get(call.callId);
    return result ? [call, result] : [call];
  }
  return [];
}

function decodeClaudeToolResult(block: JsonValue) {
  const parsed = ClaudeContentBlockSchema.safeParse(block);
  if (!parsed.success || parsed.data.type !== "tool_result") {
    return null;
  }
  const content = parsed.data;
  const event: SessionEvent & { kind: "tool-result" } = {
    callId: content.tool_use_id,
    kind: "tool-result",
    output: extractClaudeText(content.content)
  };
  if (content.is_error === true) {
    event.error = "tool error";
  }
  return event;
}

function extractClaudeText(content: JsonValue | undefined) {
  if (content === undefined) {
    return "";
  }
  if (Array.isArray(content)) {
    return extractClaudeTextBlocks(content);
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The block schema already validated this recursive JSON value; only its string member is textual tool output.
  return typeof content === "string" ? content : "";
}

function parseSessionWithAdapter(filePath: string, adapter: SessionAdapter) {
  const { hash, lineCount, records } = readJsonlLines(filePath);
  if (records.length === 0) {
    return null;
  }
  return buildCanonicalSession({
    agent: adapter.agent,
    contentHash: hash,
    filePath,
    sourceLineCount: lineCount,
    ...adapter.decode(records)
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
    threadSource: null
  };
}

function noteActivity(session: DecodedSession, timestamp: string | undefined) {
  if (timestamp === undefined) {
    return;
  }
  session.startedAt ??= timestamp;
  session.lastActivityAt = timestamp;
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
export function discoverSessionFiles(options: DiscoverOptions = {}) {
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

function walkJsonl(dir: string) {
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

export function parseSessionFile(file: DiscoveredFile) {
  return file.agent === "codex"
    ? parseCodexSession(file.filePath)
    : parseClaudeSession(file.filePath);
}
