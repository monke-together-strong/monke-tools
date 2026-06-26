/**
 * Canonical model + on-disk record shapes for the agent-session-retrospective skill.
 *
 * The script owns everything deterministic: identity, the canonical normalized
 * session, the per-repo bundle, citation validation, and the frozen record. The
 * LLM only writes free-form finding bodies and picks citations the script verifies.
 */

export type AgentKind = "codex" | "claude";

/** A normalized tool call: name + summarized input + collapsed output. */
export interface CanonicalToolCall {
  kind: "tool_call";
  ref: string;
  name: string;
  inputSummary: string;
  exitCode?: number;
  error?: string;
  outputHeadTail?: string;
}

/** A normalized prose turn (genuine human input or assistant text). */
export interface CanonicalProse {
  kind: "user" | "assistant";
  ref: string;
  text: string;
}

export type CanonicalTurn = CanonicalToolCall | CanonicalProse;

/** A single agent transcript normalized into ordered, citable turns. */
export interface CanonicalSession {
  agent: AgentKind;
  sessionId: string;
  filePath: string;
  /** Working directory the transcript ran in; null when unrecoverable. */
  cwd: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  /** Count of source JSONL lines (informational; the cursor is turn-based). */
  sourceLineCount: number;
  /** Hash of the raw source bytes; detects resume growth. */
  contentHash: string;
  /** sourceRoots the session's tool calls touched, excluding the primary. */
  touchedRoots: string[];
  turns: CanonicalTurn[];
  /** Genuine human turns only (tool-result + injected-context envelopes dropped). */
  rawUserMessages: string[];
}

/** One session as it appears inside a per-repo bundle handed to a subagent. */
export interface BundleSession {
  agent: AgentKind;
  sessionId: string;
  sessionHash: string;
  role: "primary" | "secondary";
  /** Index of the first turn not covered by a prior frozen analysis. */
  firstNewTurnIndex: number;
  priorFindingCount: number;
  /** Real hash of the source transcript bytes; frozen for resume-growth detection. */
  contentHash: string;
  turns: CanonicalTurn[];
  rawUserMessages: string[];
}

/** Per-repo work unit the host fans out over, one subagent each. */
export interface RepoBundle {
  runTs: string;
  repoKey: string;
  repoHash: string;
  sessions: BundleSession[];
  /** One-line summaries of prior frozen friction, for cross-run context. */
  priorFrictionDigest: string[];
}

/** A friction episode the subagent authored; identity/citations script-owned. */
export interface FrictionEpisode {
  /** Within-response id (e.g. "e1") so durable fixes can cite it. */
  id: string;
  sessionId: string;
  citedTurnRefs: string[];
  body: string;
}

export interface DurableFixProposal {
  citedEpisodeRefs: string[];
  body: string;
}

export interface RepeatedAskCluster {
  label: string;
  exampleSessionIds: string[];
  body: string;
}

/** What a per-repo subagent returns; validated by commit. */
export interface RepoFindings {
  repoKey: string;
  frictionEpisodes: FrictionEpisode[];
  durableFixProposals: DurableFixProposal[];
  repeatedAsks: RepeatedAskCluster[];
}

export type RetrospectiveSinceSource = "explicit" | "previous-report" | "first-run-default";
export type RetrospectiveUntilSource = "explicit" | "now";

/** Resolved once by collect, then read by PR analysis and commit. */
export interface RetrospectiveWindow {
  since: string;
  until: string;
  sinceSource: RetrospectiveSinceSource;
  untilSource: RetrospectiveUntilSource;
}

/** FROZEN per-session record — written once, appended on resume, never recomputed. */
export interface FrozenSessionRecord {
  version: 1;
  sessionId: string;
  agent: AgentKind;
  repoKey: string;
  secondary: string[];
  /** Turn-count cursor: turns before this index are already frozen (design `last_line`). */
  lastTurnIndex: number;
  contentHash: string;
  analyzedAt: string;
  friction: FrozenFriction[];
  rawUserMessages: string[];
}

export interface FrozenFriction {
  id: string;
  citedTurnRefs: string[];
  body: string;
}

export interface RepoMeta {
  version: 1;
  repoKey: string;
  firstSeenAt: string;
  lastAnalyzedAt: string;
}
