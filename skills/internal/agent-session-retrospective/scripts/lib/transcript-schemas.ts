import {
  array,
  boolean,
  discriminatedUnion,
  enum as enumSchema,
  json,
  literal,
  object,
  string,
  union,
} from "zod";
import type { output } from "zod";

export const JsonValueSchema = json();
export type JsonValue = output<typeof JsonValueSchema>;

const CodexMessageContentBlockSchema = union([
  discriminatedUnion("type", [
    object({
      text: string(),
      type: literal("input_text"),
    }),
    object({
      text: string(),
      type: literal("output_text"),
    }),
  ]),
  JsonValueSchema.transform(() => null),
]);

const ClaudeToolResultTextBlockSchema = object({
  text: string(),
  type: literal("text").optional(),
});

export const TranscriptEnvelopeSchema = object({
  timestamp: string().optional(),
});

const CodexSourceSchema = object({
  subagent: object({
    thread_spawn: object({
      parent_thread_id: string().optional(),
    }).optional(),
  }).optional(),
});

const CodexSessionMetaRecordSchema = object({
  payload: object({
    cwd: string().optional(),
    id: string().optional(),
    parent_thread_id: string().optional(),
    source: CodexSourceSchema.optional().catch(undefined),
    thread_source: string().optional(),
  }),
  timestamp: string().optional(),
  type: literal("session_meta"),
});

const CodexTurnContextRecordSchema = object({
  payload: object({
    cwd: string().optional(),
  }),
  timestamp: string().optional(),
  type: literal("turn_context"),
});

const CodexEventMessageRecordSchema = object({
  payload: discriminatedUnion("type", [
    object({
      message: string(),
      type: literal("user_message"),
    }),
    object({
      message: string(),
      type: literal("agent_message"),
    }),
  ]),
  timestamp: string().optional(),
  type: literal("event_msg"),
});

const CodexResponseItemRecordSchema = object({
  payload: discriminatedUnion("type", [
    object({
      content: union([string(), array(CodexMessageContentBlockSchema)]),
      role: enumSchema(["user", "assistant"]),
      type: literal("message"),
    }),
    object({
      arguments: JsonValueSchema.optional(),
      call_id: string().optional(),
      name: string().optional(),
      type: literal("function_call"),
    }),
    object({
      call_id: string().optional(),
      output: JsonValueSchema.optional(),
      type: literal("function_call_output"),
    }),
  ]),
  timestamp: string().optional(),
  type: literal("response_item"),
});

export const CodexTranscriptRecordSchema = discriminatedUnion("type", [
  CodexSessionMetaRecordSchema,
  CodexTurnContextRecordSchema,
  CodexEventMessageRecordSchema,
  CodexResponseItemRecordSchema,
]);
export type CodexTranscriptRecord = output<typeof CodexTranscriptRecordSchema>;

const ClaudeMessageSchema = object({
  content: union([string(), array(JsonValueSchema)]),
});

export const ClaudeTranscriptRecordSchema = object({
  cwd: string().optional(),
  isMeta: boolean().optional(),
  message: ClaudeMessageSchema,
  sessionId: string().optional(),
  timestamp: string().optional(),
  type: enumSchema(["user", "assistant"]),
});
export type ClaudeTranscriptRecord = output<typeof ClaudeTranscriptRecordSchema>;

export const ClaudeTranscriptEnvelopeSchema = TranscriptEnvelopeSchema.extend({
  cwd: string().optional(),
  sessionId: string().optional(),
});
export type ClaudeTranscriptEnvelope = output<typeof ClaudeTranscriptEnvelopeSchema>;

export const ClaudeContentBlockSchema = discriminatedUnion("type", [
  object({
    text: string(),
    type: literal("text"),
  }),
  object({
    id: string().optional(),
    input: JsonValueSchema.optional(),
    name: string().optional(),
    type: literal("tool_use"),
  }),
  object({
    content: JsonValueSchema.optional(),
    is_error: boolean().optional(),
    tool_use_id: string(),
    type: literal("tool_result"),
  }),
]);

export function extractClaudeTextBlocks(content: JsonValue[]): string {
  return content
    .map((block) => {
      const parsed = ClaudeToolResultTextBlockSchema.safeParse(block);
      return parsed.success ? parsed.data.text : "";
    })
    .filter(Boolean)
    .join("\n");
}
