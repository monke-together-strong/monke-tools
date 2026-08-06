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
  error?: string;
  exitCode?: number;
  inputSummary: string;
  kind: "tool_call";
  name: string;
  outputHeadTail?: string;
  ref: string;
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
  /** Hash of the raw source bytes; detects resume growth. */
  contentHash: string;
  /** Working directory the transcript ran in; null when unrecoverable. */
  cwd: string | null;
  filePath: string;
  lastActivityAt: string | null;
  /** Genuine human turns only (tool-result + injected-context envelopes dropped). */
  rawUserMessages: string[];
  sessionId: string;
  /** Count of source JSONL lines (informational; the cursor is turn-based). */
  sourceLineCount: number;
  startedAt: string | null;
  /** sourceRoots the session's tool calls touched, excluding the primary. */
  touchedRoots: string[];
  turns: CanonicalTurn[];
}

/** One session as it appears inside a per-repo bundle handed to a subagent. */
export interface BundleSession {
  agent: AgentKind;
  /** Real hash of the source transcript bytes; frozen for resume-growth detection. */
  contentHash: string;
  /** Index of the first turn not covered by a prior frozen analysis. */
  firstNewTurnIndex: number;
  priorFindingCount: number;
  rawUserMessages: string[];
  role: "primary" | "secondary";
  sessionHash: string;
  sessionId: string;
  turns: CanonicalTurn[];
}

/** Per-repo work unit the host fans out over, one subagent each. */
export interface RepoBundle {
  /** One-line summaries of prior frozen friction, for cross-run context. */
  priorFrictionDigest: string[];
  repoHash: string;
  repoKey: string;
  runTs: string;
  sessions: BundleSession[];
}

/** A friction episode the subagent authored; identity/citations script-owned. */
export interface FrictionEpisode {
  body: string;
  citedTurnRefs: string[];
  /** Within-response id (e.g. "e1") so durable fixes can cite it. */
  id: string;
  sessionId: string;
}

export interface DurableFixProposal {
  body: string;
  citedEpisodeRefs: string[];
}

export interface RepeatedAskCluster {
  body: string;
  exampleSessionIds: string[];
  label: string;
}

/** What a per-repo subagent returns; validated by commit. */
export interface RepoFindings {
  durableFixProposals: DurableFixProposal[];
  frictionEpisodes: FrictionEpisode[];
  repeatedAsks: RepeatedAskCluster[];
  repoKey: string;
}

export type RetrospectiveSinceSource = "explicit" | "previous-report" | "first-run-default";
export type RetrospectiveUntilSource = "explicit" | "now";

/** Resolved once by collect, then read by PR analysis and commit. */
export interface RetrospectiveWindow {
  since: string;
  sinceSource: RetrospectiveSinceSource;
  until: string;
  untilSource: RetrospectiveUntilSource;
}

/** FROZEN per-session record — written once, appended on resume, never recomputed. */
export interface FrozenSessionRecord {
  agent: AgentKind;
  analyzedAt: string;
  contentHash: string;
  friction: FrozenFriction[];
  /** Turn-count cursor: turns before this index are already frozen (design `last_line`). */
  lastTurnIndex: number;
  rawUserMessages: string[];
  repoKey: string;
  secondary: string[];
  sessionId: string;
  version: 1;
}

export interface FrozenFriction {
  body: string;
  citedTurnRefs: string[];
  id: string;
}

export interface RepoMeta {
  firstSeenAt: string;
  lastAnalyzedAt: string;
  repoKey: string;
  version: 1;
}
