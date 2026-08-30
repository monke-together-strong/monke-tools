import * as z from "zod";

import type {
  BundleSession,
  CanonicalTurn,
  FrozenSessionRecord,
  RepoBundle,
  RepoFindings,
  RepoMeta,
  RetrospectiveWindow,
} from "./types.ts";

const AgentKindSchema = z.enum(["codex", "claude"]);
const CanonicalTurnSchema = z.toZod<CanonicalTurn>()(z.union([
  z.strictObject({
    error: z.string().optional(),
    exitCode: z.number().optional(),
    inputSummary: z.string(),
    kind: z.literal("tool_call"),
    name: z.string(),
    outputHeadTail: z.string().optional(),
    ref: z.string(),
  }),
  z.strictObject({
    kind: z.enum(["user", "assistant"]),
    ref: z.string(),
    text: z.string(),
  }),
  ]));

const BundleSessionSchema = z.toZod<BundleSession>()(z.strictObject({
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
  turns: z.array(CanonicalTurnSchema),
}));

export const RepoBundleSchema = z.toZod<RepoBundle>()(z.strictObject({
  priorFrictionDigest: z.array(z.string()),
  repoHash: z.string(),
  repoKey: z.string(),
  runTs: z.string(),
  sessions: z.array(BundleSessionSchema),
}));

export const RepoFindingsSchema = z.toZod<RepoFindings>()(z.object({
  durableFixProposals: z.array(
    z.object({
      body: z.string(),
      citedEpisodeRefs: z.array(z.string()).default([]),
    }),
  ).default([]),
  frictionEpisodes: z.array(
    z.object({
      body: z.string(),
      citedTurnRefs: z.array(z.string()).default([]),
      id: z.string(),
      sessionId: z.string(),
    }),
  ).default([]),
  repeatedAsks: z.array(
    z.object({
      body: z.string(),
      exampleSessionIds: z.array(z.string()).default([]),
      label: z.string(),
    }),
  ).default([]),
  repoKey: z.string(),
}));

export const RetrospectiveWindowSchema = z.toZod<RetrospectiveWindow>()(z.strictObject({
  since: z.string(),
  sinceSource: z.enum(["explicit", "previous-report", "first-run-default"]),
  until: z.string(),
  untilSource: z.enum(["explicit", "now"]),
}));

export const FrozenSessionRecordSchema = z.toZod<FrozenSessionRecord>()(z.strictObject({
  agent: AgentKindSchema,
  analyzedAt: z.string(),
  contentHash: z.string(),
  friction: z.array(
    z.strictObject({
      body: z.string(),
      citedTurnRefs: z.array(z.string()),
      id: z.string(),
    }),
  ),
  lastTurnIndex: z.number(),
  rawUserMessages: z.array(z.string()),
  repoKey: z.string(),
  secondary: z.array(z.string()),
  sessionId: z.string(),
  version: z.literal(1),
}));

export const RepoMetaSchema = z.toZod<RepoMeta>()(z.strictObject({
  firstSeenAt: z.string(),
  lastAnalyzedAt: z.string(),
  repoKey: z.string(),
  version: z.literal(1),
}));

export const RetroLockMetadataSchema = z.strictObject({
  acquiredAt: z.number().optional(),
  pid: z.number().optional(),
});
