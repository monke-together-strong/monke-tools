import * as z from "zod";

export const JsonValueSchema = z.json();
export type JsonValue = z.output<typeof JsonValueSchema>;

const TranscriptTextBlockSchema = z.object({
  text: z.string(),
});

const CodexSourceSchema = z.object({
  subagent: z
    .object({
      thread_spawn: z
        .object({
          parent_thread_id: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

const CodexSessionMetaRecordSchema = z.object({
  payload: z.object({
    cwd: z.string().optional(),
    id: z.string().optional(),
    parent_thread_id: z.string().optional(),
    source: CodexSourceSchema.optional().catch(undefined),
    thread_source: z.string().optional(),
  }),
  timestamp: z.string().optional(),
  type: z.literal("session_meta"),
});

const CodexTurnContextRecordSchema = z.object({
  payload: z.object({
    cwd: z.string().optional(),
  }),
  timestamp: z.string().optional(),
  type: z.literal("turn_context"),
});

const CodexEventMessageRecordSchema = z.object({
  payload: z.discriminatedUnion("type", [
    z.object({
      message: z.string(),
      type: z.literal("user_message"),
    }),
    z.object({
      message: z.string(),
      type: z.literal("agent_message"),
    }),
  ]),
  timestamp: z.string().optional(),
  type: z.literal("event_msg"),
});

const CodexResponseItemRecordSchema = z.object({
  payload: z.discriminatedUnion("type", [
    z.object({
      content: z.union([z.string(), z.array(JsonValueSchema)]),
      role: z.enum(["user", "assistant"]),
      type: z.literal("message"),
    }),
    z.object({
      arguments: JsonValueSchema.optional(),
      call_id: z.string().optional(),
      name: z.string().optional(),
      type: z.literal("function_call"),
    }),
    z.object({
      call_id: z.string().optional(),
      output: JsonValueSchema.optional(),
      type: z.literal("function_call_output"),
    }),
  ]),
  timestamp: z.string().optional(),
  type: z.literal("response_item"),
});

export const CodexTranscriptRecordSchema = z.discriminatedUnion("type", [
  CodexSessionMetaRecordSchema,
  CodexTurnContextRecordSchema,
  CodexEventMessageRecordSchema,
  CodexResponseItemRecordSchema,
]);
export type CodexTranscriptRecord = z.output<typeof CodexTranscriptRecordSchema>;

const ClaudeMessageSchema = z.object({
  content: z.union([z.string(), z.array(JsonValueSchema)]),
});

export const ClaudeTranscriptRecordSchema = z.object({
  cwd: z.string().optional(),
  isMeta: z.boolean().optional(),
  message: ClaudeMessageSchema,
  sessionId: z.string().optional(),
  timestamp: z.string().optional(),
  type: z.enum(["user", "assistant"]),
});
export type ClaudeTranscriptRecord = z.output<typeof ClaudeTranscriptRecordSchema>;

export const ClaudeContentBlockSchema = z.discriminatedUnion("type", [
  z.object({
    text: z.string(),
    type: z.literal("text"),
  }),
  z.object({
    id: z.string().optional(),
    input: JsonValueSchema.optional(),
    name: z.string().optional(),
    type: z.literal("tool_use"),
  }),
  z.object({
    content: JsonValueSchema.optional(),
    is_error: z.boolean().optional(),
    tool_use_id: z.string(),
    type: z.literal("tool_result"),
  }),
]);

export function extractTextBlocks(content: JsonValue[]): string {
  return content
    .map((block) => {
      const parsed = TranscriptTextBlockSchema.safeParse(block);
      return parsed.success ? parsed.data.text : "";
    })
    .filter(Boolean)
    .join("\n");
}
