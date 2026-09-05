import * as z from "zod";

const AgentKindSchema = z.enum(["codex", "claude"]);
export type AgentKind = z.output<typeof AgentKindSchema>;

/** A normalized tool call: name + summarized input + collapsed output. */
const CanonicalToolCallSchema = z.strictObject({
  error: z.string().optional(),
  exitCode: z.number().optional(),
  inputSummary: z.string(),
  kind: z.literal("tool_call"),
  name: z.string(),
  outputHeadTail: z.string().optional(),
  ref: z.string()
});

/** A normalized prose turn (genuine human input or assistant text). */
const CanonicalProseSchema = z.strictObject({
  kind: z.enum(["user", "assistant"]),
  ref: z.string(),
  text: z.string()
});

const CanonicalTurnSchema = z.union([CanonicalToolCallSchema, CanonicalProseSchema]);
export type CanonicalTurn = z.output<typeof CanonicalTurnSchema>;

/** One session as it appears inside a per-repo bundle handed to a subagent. */
const BundleSessionSchema = z.strictObject({
  agent: AgentKindSchema,
  contentHash: z.string(),
  firstNewTurnIndex: z.number(),
  parentSessionId: z.string().nullable(),
  priorFindingCount: z.number(),
  rawUserMessages: z.array(z.string()),
  role: z.enum(["primary", "secondary"]),
  sessionHash: z.string(),
  sessionId: z.string(),
  threadSource: z.string().nullable(),
  turns: z.array(CanonicalTurnSchema)
});
export type BundleSession = z.output<typeof BundleSessionSchema>;

/** Per-repo work unit the host fans out over, one subagent each. */
export const RepoBundleSchema = z.strictObject({
  /** One-line summaries of prior frozen friction, for cross-run context. */
  priorFrictionDigest: z.array(z.string()),
  repoHash: z.string(),
  repoKey: z.string(),
  runTs: z.string(),
  sessions: z.array(BundleSessionSchema)
});
export type RepoBundle = z.output<typeof RepoBundleSchema>;

/** A friction episode the subagent authored; identity/citations script-owned. */
const FrictionEpisodeSchema = z.object({
  body: z.string(),
  citedTurnRefs: z.array(z.string()).default([]),
  /** Within-response id (e.g. "e1") so durable fixes can cite it. */
  id: z.string(),
  sessionId: z.string()
});
export type FrictionEpisode = z.output<typeof FrictionEpisodeSchema>;

const DurableFixProposalSchema = z.object({
  body: z.string(),
  citedEpisodeRefs: z.array(z.string()).default([])
});
export type DurableFixProposal = z.output<typeof DurableFixProposalSchema>;

const RepeatedAskClusterSchema = z.object({
  body: z.string(),
  exampleSessionIds: z.array(z.string()).default([]),
  label: z.string()
});
export type RepeatedAskCluster = z.output<typeof RepeatedAskClusterSchema>;

/** What a per-repo subagent returns; validated by commit. */
export const RepoFindingsSchema = z.object({
  durableFixProposals: z.array(DurableFixProposalSchema).default([]),
  frictionEpisodes: z.array(FrictionEpisodeSchema).default([]),
  repeatedAsks: z.array(RepeatedAskClusterSchema).default([]),
  repoKey: z.string()
});
export type RepoFindings = z.output<typeof RepoFindingsSchema>;

const RetrospectiveSinceSourceSchema = z.enum(["explicit", "previous-report", "first-run-default"]);

const RetrospectiveUntilSourceSchema = z.enum(["explicit", "now"]);

/** Resolved once by collect, then read by PR analysis and commit. */
export const RetrospectiveWindowSchema = z.strictObject({
  since: z.string(),
  sinceSource: RetrospectiveSinceSourceSchema,
  until: z.string(),
  untilSource: RetrospectiveUntilSourceSchema
});
export type RetrospectiveWindow = z.output<typeof RetrospectiveWindowSchema>;

const FrozenFrictionSchema = z.strictObject({
  body: z.string(),
  citedTurnRefs: z.array(z.string()),
  id: z.string()
});

/** FROZEN per-session record — written once, appended on resume, never recomputed. */
export const FrozenSessionRecordSchema = z.strictObject({
  agent: AgentKindSchema,
  analyzedAt: z.string(),
  contentHash: z.string(),
  friction: z.array(FrozenFrictionSchema),
  /** Turn-count cursor: turns before this index are already frozen (design `last_line`). */
  lastTurnIndex: z.number(),
  rawUserMessages: z.array(z.string()),
  repoKey: z.string(),
  secondary: z.array(z.string()),
  sessionId: z.string(),
  version: z.literal(1)
});
export type FrozenSessionRecord = z.output<typeof FrozenSessionRecordSchema>;

export const RepoMetaSchema = z.strictObject({
  firstSeenAt: z.string(),
  lastAnalyzedAt: z.string(),
  repoKey: z.string(),
  version: z.literal(1)
});
export type RepoMeta = z.output<typeof RepoMetaSchema>;
