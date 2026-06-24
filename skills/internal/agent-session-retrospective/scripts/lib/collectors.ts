import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { resolveGitRoot, resolveRepoKey } from "./identity.ts";
import { clipProse, summarizeInput, summarizeOutput } from "./normalize.ts";
import type { AgentKind, CanonicalSession, CanonicalTurn } from "./types.ts";

interface DiscoveredFile {
  agent: AgentKind;
  filePath: string;
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
      kind: "tool_call" as const,
      ref: `t${this.turns.length}`,
      name,
      inputSummary,
    };
    this.turns.push(turn);
    return turn;
  }
}

function readJsonlLines(filePath: string): { records: unknown[]; lineCount: number; hash: string } {
  const raw = readFileSync(filePath, "utf8");
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
  return { records, lineCount, hash };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function collectTouchedRoots(
  rawArgs: unknown,
  primary: string,
  into: Set<string>,
  visitedDirs: Set<string>,
): void {
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.startsWith("/") && value.length > 1 && visitedDirs.size < MAX_TOUCHED_DIRS_PER_SESSION) {
        const dir = existsSync(value) && statSync(value).isDirectory() ? value : path.dirname(value);
        if (!visitedDirs.has(dir) && existsSync(dir)) {
          visitedDirs.add(dir);
          const root = resolveGitRoot(dir);
          if (root && root !== primary) {
            into.add(root);
          }
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = asRecord(value);
    if (record) {
      for (const key of ["workdir", "cwd", "path", "file_path", "absolute_path"]) {
        if (key in record) {
          visit(record[key]);
        }
      }
    }
  };
  visit(rawArgs);
}

const EXIT_CODE_PATTERNS = [
  /exited with code (\d+)/i,
  /exit code:? (\d+)/i,
  /exit status:? (\d+)/i,
  /process exited with status (\d+)/i,
];

function parseExitCode(output: string): number | undefined {
  for (const pattern of EXIT_CODE_PATTERNS) {
    const match = output.match(pattern);
    if (match) {
      return Number(match[1]);
    }
  }
  return undefined;
}

// Cap distinct directory resolutions per session: a session that reads thousands
// of paths must not trigger thousands of `git` calls. Secondary membership is
// best-effort, then frozen once (so it is stable thereafter).
const MAX_TOUCHED_DIRS_PER_SESSION = 64;

// ---------------------------------------------------------------------------
// Codex: event-stream JSONL (session_meta / response_item / event_msg).
// ---------------------------------------------------------------------------

export function parseCodexSession(filePath: string): CanonicalSession | null {
  const { records, lineCount, hash } = readJsonlLines(filePath);
  if (records.length === 0) {
    return null;
  }

  let sessionId = "";
  let cwd: string | null = null;
  let startedAt: string | null = null;
  let lastActivityAt: string | null = null;

  const hasEventProse = records.some((entry) => {
    const record = asRecord(entry);
    const payload = record && asRecord(record.payload);
    const type = payload?.type;
    return record?.type === "event_msg" && (type === "user_message" || type === "agent_message");
  });

  const builder = new TurnBuilder();
  const pendingCalls = new Map<string, CanonicalTurn & { kind: "tool_call" }>();
  const touched = new Set<string>();
  const visitedDirs = new Set<string>();
  const rawUserMessages: string[] = [];

  for (const entry of records) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    if (typeof record.timestamp === "string") {
      startedAt ??= record.timestamp;
      lastActivityAt = record.timestamp;
    }
    const payload = asRecord(record.payload);
    if (!payload) {
      continue;
    }

    if (record.type === "session_meta") {
      sessionId = typeof payload.id === "string" ? payload.id : sessionId;
      cwd = typeof payload.cwd === "string" ? payload.cwd : cwd;
      continue;
    }
    if (record.type === "turn_context" && !cwd && typeof payload.cwd === "string") {
      cwd = payload.cwd;
      continue;
    }

    const primary = cwd ? resolveRepoKey(cwd) : "";

    if (record.type === "event_msg") {
      if (payload.type === "user_message" && typeof payload.message === "string") {
        rawUserMessages.push(payload.message.trim());
        if (hasEventProse) {
          builder.prose("user", payload.message);
        }
      } else if (
        payload.type === "agent_message" &&
        typeof payload.message === "string" &&
        hasEventProse
      ) {
        builder.prose("assistant", payload.message);
      }
      continue;
    }

    if (record.type !== "response_item") {
      continue;
    }

    if (payload.type === "message" && !hasEventProse) {
      const role = payload.role;
      if (role !== "user" && role !== "assistant") {
        continue;
      }
      const text = extractCodexMessageText(payload.content);
      if (role === "user" && isInjectedUserText(text)) {
        continue;
      }
      builder.prose(role, text);
      if (role === "user" && text.trim()) {
        rawUserMessages.push(text.trim());
      }
      continue;
    }

    if (payload.type === "function_call") {
      const name = typeof payload.name === "string" ? payload.name : "tool";
      let parsedArgs: unknown = payload.arguments;
      if (typeof payload.arguments === "string") {
        try {
          parsedArgs = JSON.parse(payload.arguments);
        } catch {
          parsedArgs = payload.arguments;
        }
      }
      collectTouchedRoots(parsedArgs, primary, touched, visitedDirs);
      const turn = builder.toolCall(name, summarizeInput(parsedArgs));
      if (typeof payload.call_id === "string") {
        pendingCalls.set(payload.call_id, turn);
      }
      continue;
    }

    if (payload.type === "function_call_output") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      const turn = pendingCalls.get(callId);
      const output = typeof payload.output === "string" ? payload.output : summarizeInput(payload.output);
      if (turn) {
        turn.outputHeadTail = summarizeOutput(output);
        const exitCode = parseExitCode(output);
        if (exitCode !== undefined) {
          turn.exitCode = exitCode;
          if (exitCode !== 0) {
            turn.error = `exit ${exitCode}`;
          }
        }
      }
    }
  }

  if (!sessionId) {
    return null;
  }

  const primary = cwd ? resolveRepoKey(cwd) : (cwd ?? "");
  return {
    agent: "codex",
    sessionId,
    filePath,
    cwd,
    startedAt,
    lastActivityAt,
    sourceLineCount: lineCount,
    contentHash: hash,
    touchedRoots: [...touched].filter((root) => root !== primary).sort(),
    turns: builder.turns,
    rawUserMessages,
  };
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

export function parseClaudeSession(filePath: string): CanonicalSession | null {
  const { records, lineCount, hash } = readJsonlLines(filePath);
  if (records.length === 0) {
    return null;
  }

  let sessionId = "";
  let cwd: string | null = null;
  let startedAt: string | null = null;
  let lastActivityAt: string | null = null;

  // First pass: pair tool_use ids to their tool_result output.
  const toolResults = new Map<string, { output: string; isError: boolean }>();
  for (const entry of records) {
    const record = asRecord(entry);
    const message = record && asRecord(record.message);
    const content = message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      const blockRecord = asRecord(block);
      if (blockRecord?.type === "tool_result" && typeof blockRecord.tool_use_id === "string") {
        toolResults.set(blockRecord.tool_use_id, {
          output: extractClaudeText(blockRecord.content),
          isError: blockRecord.is_error === true,
        });
      }
    }
  }

  const builder = new TurnBuilder();
  const touched = new Set<string>();
  const visitedDirs = new Set<string>();
  const rawUserMessages: string[] = [];

  for (const entry of records) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    if (typeof record.sessionId === "string") {
      sessionId ||= record.sessionId;
    }
    if (typeof record.cwd === "string") {
      cwd ??= record.cwd;
    }
    if (typeof record.timestamp === "string") {
      startedAt ??= record.timestamp;
      lastActivityAt = record.timestamp;
    }

    const primary = cwd ? resolveRepoKey(cwd) : "";
    const message = asRecord(record.message);
    if (!message) {
      continue;
    }
    const content = message.content;

    if (record.type === "user") {
      if (typeof content === "string") {
        if (record.isMeta !== true) {
          builder.prose("user", content);
          rawUserMessages.push(content.trim());
        }
        continue;
      }
      if (!Array.isArray(content)) {
        continue;
      }
      for (const block of content) {
        const blockRecord = asRecord(block);
        if (blockRecord?.type === "text" && typeof blockRecord.text === "string") {
          if (record.isMeta !== true) {
            builder.prose("user", blockRecord.text);
            rawUserMessages.push(blockRecord.text.trim());
          }
        }
        // tool_result blocks are attached to their tool_use turn, not emitted here.
      }
      continue;
    }

    if (record.type !== "assistant" || !Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      const blockRecord = asRecord(block);
      if (!blockRecord) {
        continue;
      }
      if (blockRecord.type === "text" && typeof blockRecord.text === "string") {
        builder.prose("assistant", blockRecord.text);
      } else if (blockRecord.type === "tool_use") {
        const name = typeof blockRecord.name === "string" ? blockRecord.name : "tool";
        collectTouchedRoots(blockRecord.input, primary, touched, visitedDirs);
        const turn = builder.toolCall(name, summarizeInput(blockRecord.input));
        const result = typeof blockRecord.id === "string" ? toolResults.get(blockRecord.id) : undefined;
        if (result) {
          turn.outputHeadTail = summarizeOutput(result.output);
          if (result.isError) {
            turn.error = "tool error";
          }
        }
      }
    }
  }

  if (!sessionId) {
    return null;
  }

  const primary = cwd ? resolveRepoKey(cwd) : (cwd ?? "");
  return {
    agent: "claude",
    sessionId,
    filePath,
    cwd,
    startedAt,
    lastActivityAt,
    sourceLineCount: lineCount,
    contentHash: hash,
    touchedRoots: [...touched].filter((root) => root !== primary).sort(),
    turns: builder.turns,
    rawUserMessages,
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

// ---------------------------------------------------------------------------
// Discovery.
// ---------------------------------------------------------------------------

export interface DiscoverOptions {
  home?: string;
  codexRoot?: string;
  claudeRoot?: string;
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
