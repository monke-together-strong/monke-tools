import { existsSync } from "node:fs";
import path from "node:path";

import pLimit from "p-limit";

import {
  collectCleanupEvidence,
  createCleanupEvidenceCache,
  decideCleanupEligibility,
  memoizeRepoStructure,
  readOnlyCleanupRuntime,
  revalidateCleanupEvidence
} from "./cleanup-eligibility.ts";
import type { CleanupCode, CleanupDecision, CleanupEvidence } from "./cleanup-eligibility.ts";
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
  worktreePath: string;
}

/** A point-in-time report. It does not authorize effects or verify resource teardown. */
export interface SessionCleanupEvidence {
  blockers: SessionCleanupBlocker[];
  filePath: string;
  members: SessionCleanupMember[];
  problems?: SessionCleanupProblem[];
  rootSourceRoot: string | null;
  session: string | null;
}

export interface UnownedWorktree {
  branch: string | null;
  eligible: false;
  sourceRoot: string;
  worktreePath: string;
}

/** Unowned-worktree discovery from an earlier pass; re-inspection reuses it instead of rescanning. */
export interface SessionCleanupDiscovery {
  unavailableSources: string[];
  unownedWorktrees: UnownedWorktree[];
}

export interface SessionCleanupDecision {
  eligible: boolean;
  kind: "live" | "recovery" | "finalization" | "blocked";
  reasons: SessionCleanupReason[];
  status: CleanupDecision["status"];
}

/**
 * Blockers that are facts about the Session, not missing evidence. They skip, never fail,
 * inspection.
 */
export const SETTLED_BLOCKERS: ReadonlySet<SessionCleanupBlocker> = new Set([
  "held",
  "source-missing"
]);

export function eligibleForSessionCleanup(snapshot: SessionCleanupEvidence) {
  return decideSessionCleanupEligibility(snapshot).eligible;
}

/** All recorded members must pass together; missing proof always returns false. */
export function decideSessionCleanupEligibility(
  snapshot: SessionCleanupEvidence
): SessionCleanupDecision {
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
  const decisions = snapshot.members.map((member) =>
    decideSessionCleanupMember(snapshot.rootSourceRoot, member)
  );
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
      sourceRoot: member.sourceRoot,
      worktreePath: member.worktreePath
    }
  });
}

/** Discover retained Sessions globally without acquiring a lock or changing Git/state. */
export async function inspectSessionCleanup(
  runtime: Runtime,
  home: string,
  knownSourceRoots: string[] = [],
  options: {
    discovered?: SessionCleanupDiscovery;
    operationLock?: OperationLock;
    sessionFile?: string;
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
      .filter((record) => !options.sessionFile || record.filePath === options.sessionFile)
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
        } catch (error) {
          snapshot.blockers.push("ownership-conflict");
          snapshot.problems?.push({
            code: "ownership-conflict",
            message: errorMessage(ThrownValueSchema.parse(error))
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
                member.mode = registration.mode;
                member.registeredBranch = registration.registeredBranch;
              } catch (error) {
                snapshot.blockers.push("member-identity-unverified");
                snapshot.problems?.push({
                  code: "member-identity-unverified",
                  message: errorMessage(ThrownValueSchema.parse(error)),
                  worktreePath: repo.worktreePath
                });
                return member;
              }
              if (member.mode === "live") {
                member.evidence = await collectCleanupEvidence(
                  collector,
                  {
                    role: samePath(repo.sourceRoot, state.rootSourceRoot) ? "root" : "dependency",
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
      } catch (error) {
        snapshot.blockers.push("member-changed-during-inspection");
        snapshot.problems?.push({
          code: "member-changed-during-inspection",
          message: errorMessage(ThrownValueSchema.parse(error)),
          worktreePath: repo.worktreePath
        });
      }
    }
  }
  const { unavailableSources, unownedWorktrees } =
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
    sessions: snapshots.map((snapshot) => ({
      decision: decideSessionCleanupEligibility(snapshot),
      snapshot: {
        ...snapshot,
        members: snapshot.members.map((member) => ({
          ...member,
          evidence: member.evidence
            ? {
                ...member.evidence,
                repository: member.evidence.repository
                  ? {
                      ...member.evidence.repository,
                      pullRequests: member.evidence.repository.pullRequests.filter(
                        (pr) => pr.head.ref === member.evidence?.branch
                      )
                    }
                  : null
              }
            : null
        }))
      },
      state:
        states.find(
          (state) =>
            state.session === snapshot.session && state.rootSourceRoot === snapshot.rootSourceRoot
        ) ?? null
    })),
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
  const unavailableSources: string[] = [];
  const sources = new Set(
    [
      ...knownSourceRoots,
      ...states.flatMap((state) => state.repos.map((repo) => repo.sourceRoot))
    ].map((source) => path.normalize(source))
  );
  for (const sourceRoot of sources) {
    if (!existsSync(sourceRoot)) {
      // Nothing to discover; the owning Sessions report source-missing themselves.
      continue;
    }
    try {
      assertCanonicalSourceCheckout(runtime, sourceRoot);
      for (const worktree of listWorktrees(runtime, sourceRoot)) {
        if (
          !samePath(worktree.path, sourceRoot) &&
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
    } catch {
      unavailableSources.push(sourceRoot);
    }
  }
  return { unavailableSources, unownedWorktrees };
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
