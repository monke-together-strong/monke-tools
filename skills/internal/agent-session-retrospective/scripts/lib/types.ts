/**
 * Canonical model + on-disk record shapes for the agent-session-retrospective skill.
 *
 * The script owns everything deterministic: identity, the canonical normalized
 * session, the per-repo bundle, citation validation, and the frozen record. The
 * LLM only writes free-form finding bodies and picks citations the script verifies.
 */

import type * as Schemas from "./schemas.ts";

export type {
  AgentKind,
  BundleSession,
  CanonicalTurn,
  CanonicalProse,
  CanonicalToolCall,
  DurableFixProposal,
  FrictionEpisode,
  FrozenFriction,
  FrozenSessionRecord,
  RepeatedAskCluster,
  RepoBundle,
  RepoFindings,
  RepoMeta,
  RetrospectiveSinceSource,
  RetrospectiveUntilSource,
  RetrospectiveWindow,
} from "./schemas.ts";

/** A single agent transcript normalized into ordered, citable turns. */
export interface CanonicalSession {
  agent: Schemas.AgentKind;
  /** Hash of the raw source bytes; detects resume growth. */
  contentHash: string;
  /** Working directory the transcript ran in; null when unrecoverable. */
  cwd: string | null;
  filePath: string;
  lastActivityAt: string | null;
  /** Native parent transcript id when this transcript was delegated by another agent. */
  parentSessionId: string | null;
  /** Genuine human turns only (tool-result + injected-context envelopes dropped). */
  rawUserMessages: string[];
  sessionId: string;
  /** Count of source JSONL lines (informational; the cursor is turn-based). */
  sourceLineCount: number;
  startedAt: string | null;
  /** Native origin category, such as user, subagent, or automation. */
  threadSource: string | null;
  /** sourceRoots the session's tool calls touched, excluding the primary. */
  touchedRoots: string[];
  turns: Schemas.CanonicalTurn[];
}
