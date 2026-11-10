import { existsSync } from "node:fs";
import path from "node:path";

import pLimit from "p-limit";

import {
  collectCleanupEvidence,
  createCleanupEvidenceCache,
  decideCleanupEligibility,
  memoizeRepoStructure,
  readOnlyCleanupRuntime,
  relevantPullRequests,
  revalidateCleanupEvidence
} from "./cleanup-eligibility.ts";
import type { CleanupCode, CleanupDecision, CleanupEvidence } from "./cleanup-eligibility.ts";
import { inspectCleanupObligations } from "./cleanup-obligations.ts";
import { inspectStaleRegistration } from "./cleanup-stale-registration.ts";
import { errorMessage, ThrownValueSchema } from "./errors.ts";
import { listWorktrees } from "./git.ts";
import { containsPath, samePath, worktreePathsOverlap } from "./path-identity.ts";
import type { OperationLock } from "./runtime.ts";
import {
  assertNoOtherStateOwnsSessionRepos,
  inspectSessionRepoRegistration
} from "./session-safety.ts";
import { scanSessionStates } from "./session-state-store.ts";
import type { Runtime, SessionState } from "./types.ts";
import { assertCanonicalSourceCheckout } from "./worktree-safety.ts";

export type SessionCleanupBlocker =
  | "invalid-state"
  | "invalid-state-overlap"
  | "ownership-conflict"
  | "member-identity-unverified"
  | "resource-recovery-required"
  | "resource-state-unverified"
  | "source-missing"
  | "held"
  | "operation-lock-present"
  | "state-changed-during-inspection"
  | "member-changed-during-inspection";

export type SessionCleanupReason =
  | CleanupCode
  | SessionCleanupBlocker
  | "owned-worktree-gone"
  | "owned-worktrees-gone"
  | "member-missing-or-unverified";

export interface SessionCleanupProblem {
  code: SessionCleanupBlocker;
  message: string;
  worktreePath?: string;
}

export interface SessionCleanupMemberDecision {
  code: SessionCleanupReason;
  eligible: boolean;
  evidence: string[];
  status: CleanupDecision["status"];
}

export interface SessionCleanupMember {
  evidence: CleanupEvidence | null;
  mode: "live" | "gone" | "stale" | "unverified";
  registeredBranch?: string | null;
  sourceRoot: string;
  staleRegistration?: string;
  worktreePath: string;
}

/** A point-in-time report. It does not authorize effects or verify resource teardown. */
export interface SessionCleanupEvidence {
  blockers: SessionCleanupBlocker[];
  filePath: string;
  members: SessionCleanupMember[];
  obligations?: ReturnType<typeof inspectCleanupObligations>;
  problems?: SessionCleanupProblem[];
  rootSourceRoot: string | null;
  session: string | null;
}

export interface UnownedWorktree {
  branch: string | null;
  details?: string[];
  eligible: boolean;
  inspectionFailed?: boolean;
  outcome?: "skipped" | "would-clean" | "cleaned" | "failed";
  reason?: string;
  sourceRoot: string;
  worktreePath: string;
}

export interface CleanupSourceInspection {
  message?: string;
  sourceRoot: string;
  status: "inspected" | "missing" | "unavailable";
  /** Registered linked worktrees, including stale registrations, excluding the Source. */
  worktreeCount: number | null;
}

/** Unowned-worktree discovery from an earlier pass; re-inspection reuses it instead of rescanning. */
export interface SessionCleanupDiscovery {
  sourceRoots: string[];
  sources: CleanupSourceInspection[];
  unavailableSources: string[];
  unownedWorktrees: UnownedWorktree[];
}

export interface SessionCleanupDecision {
  eligible: boolean;
  kind: "live" | "recovery" | "finalization" | "blocked";
  /** One decision per snapshot member, in the same order. */
  members: SessionCleanupMemberDecision[];
  /** Whether Cleanup can proceed now, needs archival or resource recovery first, or is blocked. */
  readiness: "ready" | "archive-required" | "resource-recovery-required" | "blocked";
  reasons: SessionCleanupReason[];
  status: CleanupDecision["status"];
}

/** A Session snapshot with the decision made from exactly that snapshot. */
export interface SessionCleanupInspection {
  decision: SessionCleanupDecision;
  snapshot: SessionCleanupEvidence;
}

/**
 * Blockers that are facts about the Session, not missing evidence. They skip, never fail,
 * inspection.
 */
export const SETTLED_BLOCKERS: ReadonlySet<SessionCleanupBlocker> = new Set([
  "held",
  "source-missing",
  "resource-recovery-required"
]);

/** All recorded members must pass together; missing proof always returns false. */
export function decideSessionCleanupEligibility(
  snapshot: SessionCleanupEvidence
): SessionCleanupDecision {
  const members = snapshot.members.map((member) =>
    decideSessionCleanupMember(snapshot.rootSourceRoot, member)
  );

  const session = decideSession(snapshot, members);

  return { ...session, members, readiness: cleanupReadiness(snapshot, members, session.eligible) };
}

function cleanupReadiness(
  snapshot: SessionCleanupEvidence,
  members: SessionCleanupMemberDecision[],
  eligible: boolean
): SessionCleanupDecision["readiness"] {
  const membersReady = members.every(
    (decision, index) =>
      decision.eligible ||
      (decision.code === "dirty-worktree" &&
        snapshot.members[index]?.evidence?.archiveReadiness?.eligible === true)
  );

  if (!membersReady || snapshot.blockers.some((code) => code !== "resource-recovery-required")) {
    return "blocked";
  }

  if (snapshot.blockers.includes("resource-recovery-required")) {
    return "resource-recovery-required";
  }

  if (
    snapshot.members.some(
      (member) =>
        member.evidence?.pendingWork?.kind === "untracked-archive" ||
        member.evidence?.archiveReadiness?.eligible === true
    )
  ) {
    return "archive-required";
  }

  return eligible ? "ready" : "blocked";
}

function decideSession(
  snapshot: SessionCleanupEvidence,
  decisions: SessionCleanupMemberDecision[]
): Omit<SessionCleanupDecision, "members" | "readiness"> {
  if (snapshot.blockers.length > 0) {
    return {
      eligible: false,
      kind: "blocked",
      reasons: snapshot.blockers,
      status: snapshot.blockers.some((blocker) => SETTLED_BLOCKERS.has(blocker))
        ? "ineligible"
        : "unknown"
    };
  }

  if (
    !snapshot.session ||
    !snapshot.rootSourceRoot ||
    snapshot.members.length === 0 ||
    !snapshot.members.some((member) => samePath(member.sourceRoot, snapshot.rootSourceRoot ?? ""))
  ) {
    return { eligible: false, kind: "blocked", reasons: ["invalid-state"], status: "unknown" };
  }

  if (snapshot.members.every((member) => member.mode === "gone" || member.mode === "stale")) {
    return {
      eligible: true,
      kind: "finalization",
      reasons: ["owned-worktrees-gone"],
      status: "eligible"
    };
  }

  const blocked = decisions.filter((decision) => !decision.eligible);

  return {
    eligible: blocked.length === 0,
    kind:
      blocked.length > 0
        ? "blocked"
        : snapshot.members.some((member) => member.mode !== "live")
          ? "recovery"
          : "live",
    reasons: [
      ...new Set((blocked.length > 0 ? blocked : decisions).map((decision) => decision.code))
    ],
    status:
      blocked.length === 0
        ? "eligible"
        : blocked.some((decision) => decision.status === "ineligible")
          ? "ineligible"
          : "unknown"
  };
}

/** Preserve the Session's role assignment when reporting an individual member. */
export function decideSessionCleanupMember(
  rootSourceRoot: string | null,
  member: SessionCleanupMember
): SessionCleanupMemberDecision {
  if (member.mode === "gone" || member.mode === "stale") {
    return { code: "owned-worktree-gone", eligible: true, evidence: [], status: "eligible" };
  }

  if (
    member.mode !== "live" ||
    !member.evidence ||
    !samePath(member.evidence.candidate.sourceRoot, member.sourceRoot) ||
    !samePath(member.evidence.candidate.worktreePath, member.worktreePath)
  ) {
    return {
      code: "member-missing-or-unverified",
      eligible: false,
      evidence: [],
      status: "unknown"
    };
  }

  // Roles come from this Session, never a caller's worktree/path-name assumption.
  return decideCleanupEligibility({
    ...member.evidence,
    candidate: {
      role: samePath(member.sourceRoot, rootSourceRoot ?? "") ? "root" : "dependency",
      sessionBranch: member.evidence.candidate.sessionBranch,
      sourceRoot: member.sourceRoot,
      worktreePath: member.worktreePath
    }
  });
}

function withRelevantPullRequests(snapshot: SessionCleanupEvidence): SessionCleanupEvidence {
  return {
    ...snapshot,
    members: snapshot.members.map((member) => {
      const { evidence } = member;

      return {
        ...member,
        evidence: evidence
          ? {
              ...evidence,
              repository: evidence.repository
                ? {
                    ...evidence.repository,
                    pullRequests: relevantPullRequests(evidence, evidence.repository)
                  }
                : null
            }
          : null
      };
    })
  };
}

/** Discover retained Sessions globally without acquiring a lock or changing Git/state. */
export async function inspectSessionCleanup(
  runtime: Runtime,
  home: string,
  knownSourceRoots: string[] = [],
  options: {
    archiveUntracked?: boolean;
    discovered?: SessionCleanupDiscovery;
    operationLock?: OperationLock;
    recoveryCommand?: string;
    sessionFile?: string;
    targets?: string[];
  } = {}
) {
  const readOnly = readOnlyCleanupRuntime(runtime);
  // Collection memoizes per-Source structure; revalidation and discovery below read fresh.
  const collector = memoizeRepoStructure(runtime);
  const collectorReadOnly = readOnlyCleanupRuntime(collector);
  const scan = scanSessionStates(home);
  const states = scan.records.flatMap((record) => (record.state ? [record.state] : []));
  const cache = createCleanupEvidenceCache();
  const limit = pLimit(4);

  const lockPresent = () => {
    if (options.operationLock) {
      return (
        !samePath(options.operationLock.path, path.join(home, "lock")) ||
        !options.operationLock.isHeld()
      );
    }

    return existsSync(path.join(home, "lock")) || existsSync(path.join(home, "lock.reclaim"));
  };

  const operationAtStart = lockPresent();

  const snapshots = await Promise.all(
    scan.records
      .filter(
        (record) =>
          (!options.sessionFile || samePath(record.filePath, options.sessionFile)) &&
          ((options.targets?.length ?? 0) === 0 ||
            options.targets?.some(
              (target) =>
                samePath(target, record.filePath) ||
                record.state?.repos.some((repo) => samePath(target, repo.worktreePath))
            ))
      )
      .map(async (record) => {
        const { state } = record;

        const snapshot: SessionCleanupEvidence = {
          blockers: [],
          filePath: record.filePath,
          members: [],
          problems: [],
          rootSourceRoot: state?.rootSourceRoot ?? null,
          session: state?.session ?? null
        };

        if (!state) {
          snapshot.blockers.push("invalid-state");

          return snapshot;
        }

        if (state.cleanupHold) {
          snapshot.blockers.push("held");
        }

        if (scan.records.some((other) => !other.state && invalidRecordMayOverlap(other, state))) {
          snapshot.blockers.push("invalid-state-overlap");
        }

        try {
          assertNoOtherStateOwnsSessionRepos(state, states);
        } catch (cause) {
          snapshot.blockers.push("ownership-conflict");
          snapshot.problems?.push({
            code: "ownership-conflict",
            message: errorMessage(ThrownValueSchema.parse(cause))
          });
        }

        snapshot.members = await Promise.all(
          state.repos.map((repo) =>
            limit(async () => {
              const member: SessionCleanupMember = {
                evidence: null,
                mode: "unverified",
                sourceRoot: repo.sourceRoot,
                worktreePath: repo.worktreePath
              };

              // A Source that no longer exists is a settled fact, not missing evidence.
              if (!existsSync(repo.sourceRoot)) {
                snapshot.blockers.push("source-missing");
                snapshot.problems?.push({
                  code: "source-missing",
                  message: `Recorded Source checkout does not exist at ${repo.sourceRoot}`,
                  worktreePath: repo.worktreePath
                });

                return member;
              }

              try {
                const registration = inspectSessionRepoRegistration(
                  collectorReadOnly,
                  home,
                  state,
                  repo
                );

                if (registration.mode === "stale") {
                  const stale = inspectStaleRegistration(
                    collectorReadOnly,
                    repo.sourceRoot,
                    repo.worktreePath
                  );

                  if (!stale) {
                    throw new Error("Stale worktree reappeared during inspection");
                  }

                  member.staleRegistration = stale;
                }

                member.mode = registration.mode;
                member.registeredBranch = registration.registeredBranch;
              } catch (cause) {
                snapshot.blockers.push("member-identity-unverified");
                snapshot.problems?.push({
                  code: "member-identity-unverified",
                  message: errorMessage(ThrownValueSchema.parse(cause)),
                  worktreePath: repo.worktreePath
                });

                return member;
              }

              if (member.mode === "live") {
                member.evidence = await collectCleanupEvidence(
                  collector,
                  {
                    archiveUntracked: options.archiveUntracked,
                    role: samePath(repo.sourceRoot, state.rootSourceRoot) ? "root" : "dependency",
                    sessionBranch: state.session,
                    sourceRoot: repo.sourceRoot,
                    worktreePath: repo.worktreePath
                  },
                  cache
                );
              }

              return member;
            })
          )
        );

        return snapshot;
      })
  );

  // A dependency can change while a later member waits for GitHub. Recheck all
  // members synchronously after provider reads; do not yield between members.
  // This pass never yields, so one structure read per Source is as fresh as many.
  const recheck = memoizeRepoStructure(runtime);
  const recheckReadOnly = readOnlyCleanupRuntime(recheck);

  for (const snapshot of snapshots) {
    const state = states.find(
      (candidate) =>
        candidate.session === snapshot.session &&
        candidate.rootSourceRoot === snapshot.rootSourceRoot
    );

    if (!state) {
      continue;
    }

    for (const [index, repo] of state.repos.entries()) {
      const member = snapshot.members[index];

      if (!member || member.mode === "unverified") {
        continue;
      }

      try {
        revalidateSessionMember(recheck, recheckReadOnly, home, state, repo, member);
      } catch (cause) {
        snapshot.blockers.push("member-changed-during-inspection");
        snapshot.problems?.push({
          code: "member-changed-during-inspection",
          message: errorMessage(ThrownValueSchema.parse(cause)),
          worktreePath: repo.worktreePath
        });
      }
    }

    try {
      snapshot.obligations = inspectCleanupObligations(home, state, options);

      if (snapshot.obligations.recoveryRequired.length > 0) {
        snapshot.blockers.push("resource-recovery-required");
      }
    } catch (cause) {
      snapshot.blockers.push("resource-state-unverified");
      snapshot.problems?.push({
        code: "resource-state-unverified",
        message: errorMessage(ThrownValueSchema.parse(cause))
      });
    }
  }

  const { sourceRoots, sources, unavailableSources, unownedWorktrees } =
    options.discovered ?? discoverUnownedWorktrees(readOnly, states, knownSourceRoots);

  blockUnownedOverlaps(snapshots, unownedWorktrees);
  const changed = scanSessionStates(home).fingerprint !== scan.fingerprint;
  const operationPresent = operationAtStart || lockPresent();

  for (const snapshot of snapshots) {
    if (changed) {
      snapshot.blockers.push("state-changed-during-inspection");
    }

    if (operationPresent) {
      snapshot.blockers.push("operation-lock-present");
    }

    snapshot.blockers = [...new Set(snapshot.blockers)].toSorted();
  }

  return {
    inspectedAt: new Date().toISOString(),
    sessions: snapshots.map((collected) => {
      const snapshot = withRelevantPullRequests(collected);

      return {
        decision: decideSessionCleanupEligibility(snapshot),
        snapshot,
        state:
          states.find(
            (state) =>
              state.session === snapshot.session && state.rootSourceRoot === snapshot.rootSourceRoot
          ) ?? null
      };
    }),
    sourceRoots,
    sources,
    stateFingerprint: scan.fingerprint,
    unavailableSources,
    unboundedOwnership: scan.records.some(
      (record) => !record.state && record.references.length === 0
    ),
    unownedWorktrees
  };
}

/** List registered worktrees that no retained Session records, per available Source. */
function discoverUnownedWorktrees(
  runtime: Runtime,
  states: SessionState[],
  knownSourceRoots: string[]
): SessionCleanupDiscovery {
  const unownedWorktrees: UnownedWorktree[] = [];
  const sources: CleanupSourceInspection[] = [];

  const sourceRoots = new Set(
    [
      ...knownSourceRoots,
      ...states.flatMap((state) => state.repos.map((repo) => repo.sourceRoot))
    ].map((source) => path.normalize(source))
  );

  for (const sourceRoot of sourceRoots) {
    if (!existsSync(sourceRoot)) {
      sources.push({ sourceRoot, status: "missing", worktreeCount: null });
      continue;
    }

    try {
      assertCanonicalSourceCheckout(runtime, sourceRoot);

      const worktrees = listWorktrees(runtime, sourceRoot).filter(
        (worktree) => !samePath(worktree.path, sourceRoot)
      );

      sources.push({ sourceRoot, status: "inspected", worktreeCount: worktrees.length });

      for (const worktree of worktrees) {
        if (
          !states.some((state) =>
            state.repos.some((repo) => samePath(repo.worktreePath, worktree.path))
          )
        ) {
          unownedWorktrees.push({
            branch: worktree.branch,
            eligible: false,
            sourceRoot,
            worktreePath: worktree.path
          });
        }
      }
    } catch (cause) {
      sources.push({
        message: errorMessage(ThrownValueSchema.parse(cause)),
        sourceRoot,
        status: "unavailable",
        worktreeCount: null
      });
    }
  }

  return {
    sourceRoots: sources
      .filter((source) => source.status === "inspected")
      .map((source) => source.sourceRoot),
    sources,
    unavailableSources: sources
      .filter((source) => source.status === "unavailable")
      .map((source) => source.sourceRoot),
    unownedWorktrees
  };
}

function blockUnownedOverlaps(
  snapshots: SessionCleanupEvidence[],
  unownedWorktrees: { worktreePath: string }[]
) {
  for (const snapshot of snapshots) {
    for (const member of snapshot.members) {
      const overlap = unownedWorktrees.find((worktree) =>
        worktreePathsOverlap(worktree.worktreePath, member.worktreePath)
      );

      if (overlap) {
        snapshot.blockers.push("ownership-conflict");
        snapshot.problems?.push({
          code: "ownership-conflict",
          message: `Worktree ${member.worktreePath} overlaps unowned registered worktree ${overlap.worktreePath}`,
          worktreePath: member.worktreePath
        });
      }
    }
  }
}

export function revalidateSessionMember(
  runtime: Runtime,
  readOnly: Runtime,
  home: string,
  state: SessionState,
  repo: SessionState["repos"][number],
  member: SessionCleanupMember
) {
  const current = inspectSessionRepoRegistration(readOnly, home, state, repo);

  if (current.mode !== member.mode || current.registeredBranch !== member.registeredBranch) {
    throw new Error("Member presence or registered branch changed");
  }

  if (
    current.mode === "stale" &&
    inspectStaleRegistration(readOnly, repo.sourceRoot, repo.worktreePath) !==
      member.staleRegistration
  ) {
    throw new Error("Stale registration changed after inspection");
  }

  if (member.evidence) {
    const invalidation = revalidateCleanupEvidence(runtime, member.evidence);

    if (invalidation) {
      member.evidence.localBlock = invalidation;
      throw new Error(`Member evidence changed: ${invalidation.code}`);
    }
  }
}

function invalidRecordMayOverlap(
  record: { filePath: string; references: string[] },
  state: SessionState
) {
  if (record.references.length === 0) {
    return true;
  }

  const paths = [
    state.rootSourceRoot,
    ...state.repos.flatMap((repo) => [repo.sourceRoot, repo.worktreePath])
  ];

  return record.references.some((reference) =>
    paths.some(
      (candidate) =>
        samePath(reference, candidate) ||
        containsPath(reference, candidate) ||
        containsPath(candidate, reference)
    )
  );
}
