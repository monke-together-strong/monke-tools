import { existsSync } from "node:fs";
import path from "node:path";

import { CheckoutResourceStore, resourceOwner } from "./checkout-resource-store.ts";
import { archiveCleanupFiles, assertCleanupArchive } from "./cleanup-archive.ts";
import type { CleanupEvidence } from "./cleanup-eligibility.ts";
import { inspectRepoCleanupObligations, inspectCleanupObligations } from "./cleanup-obligations.ts";
import {
  assertRetainedHead,
  preserveDetachedHead,
  retainedHeadAction
} from "./cleanup-retained-head.ts";
import { errorMessage, MonkeError, ThrownValueSchema } from "./errors.ts";
import { describeSessionBranchMismatch } from "./git.ts";
import { createLogger } from "./logger.ts";
import { containsPath, samePath } from "./path-identity.ts";
import { releaseCheckoutResources } from "./resource-lifecycle.ts";
import { acquireCheckoutResourceLock } from "./runtime.ts";
import type { SessionCleanupMember } from "./session-cleanup-eligibility.ts";
import {
  assertNoOtherStateOwnsSessionRepos,
  inspectSessionRepoRegistration
} from "./session-safety.ts";
import { getSessionStateFilePath, SessionStateStore } from "./session-state-store.ts";
import { requestShellDirectoryAfterRemoval } from "./shell.ts";
import type { Runtime, SessionRepoState, SessionState } from "./types.ts";
import { assertCanonicalSourceCheckout, preflightWorktreeRemoval } from "./worktree-safety.ts";

const CLEANUP_COMMAND_TIMEOUT_SECONDS = 60;

export interface SessionAction {
  archivePath?: string;
  command?: string;
  recoveryCommand?: string;
  resources?: { name: string; run?: string }[];
  retainedRef?: string;
  sourceRoot: string;
  step:
    | "revalidation"
    | "file-archive"
    | "head-preservation"
    | "process-stop"
    | "worktree-removal"
    | "resource-release"
    | "cleanup-command"
    | "state-removal";
  worktreePath?: string;
}

export interface SessionRemovalTarget {
  /** Session states that may claim this Session's worktrees. */
  allStates: SessionState[];
  state: SessionState;
}

export interface SessionRemovalOptions {
  cleanupFromSource?: boolean;
  force: boolean;
  /** The worktree the command runs in. It is removed last, and the shell leaves it. */
  invocationPath: string;
  /**
   * Cleanup's inspected members. Removal archives their untracked files, retains their detached
   * HEADs, and accepts their preserved pending work. Chop supplies none.
   */
  members?: readonly SessionCleanupMember[];
  recoveryCommand?: string;
}

/** Tracks the current step, the action whose effect may have happened, and completed actions. */
export class SessionRemovalProgress {
  attempted: SessionAction | undefined;
  readonly completed: SessionAction[] = [];
  current: SessionAction;
  /** Set once preflight passes; a failure derives the remaining actions from it. */
  planned: SessionAction[] | undefined;
  started = false;

  constructor(initial: SessionAction) {
    this.current = initial;
  }

  /** Make `action` the step a failure is reported against; nothing is attempted yet. */
  step(action: SessionAction) {
    this.current = action;
    this.attempted = undefined;
  }

  /** From here on, the current action's effect may have happened. */
  attempt(action: SessionAction = this.current) {
    this.started = true;
    this.attempted = action;
  }

  complete(action: SessionAction) {
    this.completed.push(action);
    this.attempted = undefined;
  }
}

/** Caller checks at fixed points of Session removal. Chop supplies none. */
export interface SessionRemovalChecks {
  /** Runs once the action is the current step; throwing stops removal before its effect. */
  beforeEffect?: (action: SessionAction, progress: SessionRemovalProgress) => void;
  /** Runs after the checkout resource locks are held, before preflight or any effect. */
  beforeStart?: (progress: SessionRemovalProgress) => void;
  /**
   * Runs for each member still registered with Git (live or stale), in removal order, after its
   * detached HEAD is retained and before Cleanup obligations. Effects must be reported through
   * `progress`.
   */
  prepareMember?: (repo: SessionRepoState, progress: SessionRemovalProgress) => void;
  /** Rechecks the caller's own evidence each time removal revalidates a member. */
  revalidateMember?: (repo: SessionRepoState) => void;
}

export type SessionRemovalResult =
  | { completed: SessionAction[]; outcome: "removed" }
  | {
      /** The action whose effect may have happened when removal stopped. */
      attempted: SessionAction | undefined;
      cause: unknown;
      completed: SessionAction[];
      /** The step removal was on when it stopped. */
      current: SessionAction;
      /** "not-started" means no effect was attempted. */
      outcome: "failed" | "not-started";
      /** What a retry still has to do; undefined before planning or when retry inspection failed. */
      remaining: SessionAction[] | undefined;
      retryInspectionFailure?: string;
      /** Cleanup obligations a retry runs again. */
      retryObligations: SessionAction[] | undefined;
    };

type MemberMode = "gone" | "live" | "stale" | "unverified";

interface PlannedMember {
  mode: MemberMode;
  proof?: SessionCleanupMember;
  repo: SessionRepoState;
}

interface SessionRepoPreflight {
  forceGitRemoval: boolean;
  mode: "gone" | "live" | "stale";
  registeredBranch: string | null | undefined;
  repo: SessionRepoState;
}

/** Keep the invoking member last, otherwise keep the Root member last. */
function sessionRemovalRank(
  repo: Pick<SessionRepoState, "sourceRoot" | "worktreePath">,
  invocationPath: string,
  rootSourceRoot: string
) {
  if (containsPath(repo.worktreePath, invocationPath)) {
    return 2;
  }

  return samePath(repo.sourceRoot, rootSourceRoot) ? 1 : 0;
}

function inRemovalOrder<T extends { repo: SessionRepoState }>(
  members: readonly T[],
  invocationPath: string,
  rootSourceRoot: string
) {
  return members.toSorted(
    (left, right) =>
      sessionRemovalRank(left.repo, invocationPath, rootSourceRoot) -
      sessionRemovalRank(right.repo, invocationPath, rootSourceRoot)
  );
}

function memberProof(members: readonly SessionCleanupMember[] | undefined, repo: SessionRepoState) {
  return members?.find((member) => samePath(member.worktreePath, repo.worktreePath));
}

function archiveEvidence(member: PlannedMember): CleanupEvidence | undefined {
  const evidence = member.proof?.evidence;

  return evidence?.pendingWork?.kind === "untracked-archive" ? evidence : undefined;
}

function detachedHead(member: PlannedMember) {
  const evidence = member.proof?.evidence;

  return member.mode !== "gone" && member.proof?.mode === "live" && evidence?.branch === null
    ? evidence.head
    : null;
}

function worktreeRemoval(repo: SessionRepoState): SessionAction {
  return { sourceRoot: repo.sourceRoot, step: "worktree-removal", worktreePath: repo.worktreePath };
}

/**
 * The ordered effects of removing one Session: archives, retained detached HEADs, Cleanup
 * obligations, worktree removals, then state. Execution applies the same per-member rules, so a
 * Cleanup preview lists what execution does, except conditional process stops.
 */
function planActions(
  state: SessionState,
  members: readonly PlannedMember[],
  obligations: readonly SessionAction[],
  invocationPath: string
): SessionAction[] {
  const ordered = inRemovalOrder(members, invocationPath, state.rootSourceRoot);

  return [
    ...members
      .filter((member) => archiveEvidence(member))
      .map((member) => fileArchive(member.repo)),
    ...ordered.flatMap((member) => {
      const head = detachedHead(member);

      return head
        ? [retainedHeadAction(member.repo.sourceRoot, member.repo.worktreePath, head)]
        : [];
    }),
    ...obligations,
    ...ordered
      .filter((member) => member.mode === "live" || member.mode === "stale")
      .map((member) => worktreeRemoval(member.repo)),
    { sourceRoot: state.rootSourceRoot, step: "state-removal" }
  ];
}

/** Preview Session removal from Cleanup's inspected members, without effects. */
export function planSessionRemoval(
  state: SessionState,
  members: readonly SessionCleanupMember[],
  obligations: readonly SessionAction[],
  invocationPath: string
) {
  return planActions(
    state,
    state.repos.map((repo) => {
      const proof = memberProof(members, repo);

      return { mode: proof?.mode ?? "unverified", proof, repo };
    }),
    obligations,
    invocationPath
  );
}

/**
 * Perform Session removal while preserving local branches, including recorded resource releases and
 * Cleanup commands. A failure is returned, not thrown, with how far removal got so the caller can
 * explain and retry.
 */
export function removeSession(
  runtime: Runtime,
  home: string,
  target: SessionRemovalTarget,
  options: SessionRemovalOptions,
  checks: SessionRemovalChecks = {}
): SessionRemovalResult {
  const progress = new SessionRemovalProgress({
    sourceRoot: target.state.rootSourceRoot,
    step: "revalidation"
  });

  const unlocks: (() => void)[] = [];

  try {
    for (const repo of target.state.repos) {
      unlocks.push(acquireCheckoutResourceLock(home, repo.worktreePath));
    }

    removeLocked(runtime, home, target, options, checks, progress);

    return { completed: progress.completed, outcome: "removed" };
  } catch (cause) {
    return failure(home, target.state, options, progress, cause);
  } finally {
    for (const unlock of unlocks.toReversed()) {
      unlock();
    }
  }
}

function failure(
  home: string,
  state: SessionState,
  options: SessionRemovalOptions,
  progress: SessionRemovalProgress,
  cause: unknown
): SessionRemovalResult {
  const { planned } = progress;
  let retryObligations: SessionAction[] | undefined;
  let retryInspectionFailure: string | undefined;

  try {
    retryObligations = inspectCleanupObligations(home, state, options).actions;
  } catch (inspectionCause) {
    retryInspectionFailure = errorMessage(ThrownValueSchema.parse(inspectionCause));
  }

  // Recorded Cleanup obligations run again on retry, even after an earlier success.
  const remaining =
    planned && retryObligations
      ? planned.flatMap((action) => {
          if (action.step === "resource-release" || action.step === "cleanup-command") {
            return (retryObligations ?? []).filter(
              (next) => next.step === action.step && next.sourceRoot === action.sourceRoot
            );
          }

          return progress.completed.some(
            (done) => done.step === action.step && done.sourceRoot === action.sourceRoot
          )
            ? []
            : [action];
        })
      : undefined;

  return {
    attempted: progress.attempted,
    cause,
    completed: progress.completed,
    current: progress.current,
    outcome: progress.started ? "failed" : "not-started",
    remaining,
    retryInspectionFailure,
    retryObligations
  };
}

function removeLocked(
  runtime: Runtime,
  home: string,
  target: SessionRemovalTarget,
  options: SessionRemovalOptions,
  checks: SessionRemovalChecks,
  progress: SessionRemovalProgress
) {
  const { state } = target;
  checks.beforeStart?.(progress);
  progress.step({ sourceRoot: state.rootSourceRoot, step: "revalidation" });
  const preflight = preflightSession(runtime, home, target, options, checks, progress);

  for (const candidate of preflight) {
    warnSessionBranchMismatch(runtime, state, candidate);
  }

  const members = preflight.map((candidate) => ({
    ...candidate,
    proof: memberProof(options.members, candidate.repo)
  }));

  progress.planned = planActions(
    state,
    members,
    inspectCleanupObligations(home, state, options).actions,
    options.invocationPath
  );

  const ordered = inRemovalOrder(members, options.invocationPath, state.rootSourceRoot);
  const archives = new Map<string, string>();

  const effect: Effect = (action, run, before) => {
    progress.step(action);
    checks.beforeEffect?.(action, progress);
    before?.();
    progress.attempt(action);
    run();
    progress.complete(action);
  };

  for (const member of members) {
    const evidence = archiveEvidence(member);

    if (evidence) {
      const action = fileArchive(member.repo);

      effect(
        action,
        () => {
          action.archivePath = archiveCleanupFiles(runtime, home, evidence);
          archives.set(member.repo.worktreePath, action.archivePath);
        },
        () => checks.revalidateMember?.(member.repo)
      );
    }
  }

  for (const member of ordered) {
    checks.revalidateMember?.(member.repo);

    if (member.mode === "gone") {
      continue;
    }

    const head = detachedHead(member);

    if (head) {
      const action = retainedHeadAction(member.repo.sourceRoot, member.repo.worktreePath, head);

      effect(
        action,
        () => {
          preserveDetachedHead(runtime, member.repo.sourceRoot, member.repo.worktreePath, head);
        },
        () => checks.revalidateMember?.(member.repo)
      );
    }

    checks.prepareMember?.(member.repo, progress);
  }

  const revalidateAll = () => {
    for (const candidate of preflight) {
      progress.step(memberRevalidation(candidate.repo));
      const current = inspectSessionRepo(runtime, home, state, candidate.repo, options, checks);
      assertSessionMemberUnchanged(candidate, current);

      if (candidate.mode !== current.mode) {
        throw new MonkeError(
          `Session worktree presence changed after preflight at ${current.repo.worktreePath}; rerun to inspect the Session again`
        );
      }

      checks.revalidateMember?.(candidate.repo);
    }
  };

  runCleanupObligations(runtime, home, state, options, progress, (action, run) => {
    revalidateAll();
    effect(action, run);
  });

  // Process stops and Cleanup commands can modify any sibling. Recheck the whole Session
  // before removing its first worktree, then recheck each member at removal.
  revalidateAll();

  for (const member of ordered) {
    progress.step(memberRevalidation(member.repo));
    const current = inspectSessionRepo(runtime, home, state, member.repo, options, checks);
    assertSessionMemberUnchanged(member, current);
    checks.revalidateMember?.(member.repo);

    if (current.mode !== "gone") {
      effect(
        worktreeRemoval(current.repo),
        () => {
          removeWorktree(runtime, current.repo.sourceRoot, current.repo.worktreePath, {
            force: current.mode === "stale" || current.forceGitRemoval
          });
        },
        () => {
          checks.revalidateMember?.(current.repo);
          assertPreservedWorkKept(runtime, member, archives);
        }
      );
    }

    if (samePath(current.repo.worktreePath, options.invocationPath)) {
      requestShellDirectoryAfterRemoval(runtime, current.repo.sourceRoot);
    }
  }

  // Reuse the targeted ownership scan; unrelated invalid state must not block this removal.
  finalizeSession(new SessionStateStore(home, target.allStates), state, effect);
}

function fileArchive(repo: SessionRepoState): SessionAction {
  return { sourceRoot: repo.sourceRoot, step: "file-archive", worktreePath: repo.worktreePath };
}

function memberRevalidation(repo: SessionRepoState): SessionAction {
  return { sourceRoot: repo.sourceRoot, step: "revalidation", worktreePath: repo.worktreePath };
}

/** Archived files and retained HEADs must still exist when their worktree is removed. */
function assertPreservedWorkKept(
  runtime: Runtime,
  member: PlannedMember,
  archives: ReadonlyMap<string, string>
) {
  const evidence = archiveEvidence(member);

  if (evidence) {
    const archive = archives.get(member.repo.worktreePath);

    if (!archive) {
      throw new MonkeError("Missing required file archive");
    }

    assertCleanupArchive(runtime, archive, evidence);
  }

  const head = detachedHead(member);

  if (head) {
    assertRetainedHead(runtime, member.repo.sourceRoot, member.repo.worktreePath, head);
  }
}

/** Report `run` as `action`: `before` checks run first, and only then may `run` take effect. */
type Effect = (action: SessionAction, run: () => void, before?: () => void) => void;

/** Run recorded Cleanup obligations while Session worktrees are still available. */
function runCleanupObligations(
  runtime: Runtime,
  home: string,
  state: SessionState,
  options: SessionRemovalOptions,
  progress: SessionRemovalProgress,
  effect: Effect
) {
  const store = new CheckoutResourceStore(home, [state]);

  for (const repo of state.repos) {
    progress.step(memberRevalidation(repo));
    assertCanonicalSourceCheckout(runtime, repo.sourceRoot);
    assertCleanupWorktree(inspectRepoCleanupObligations(store, state, repo, options));
  }

  for (const repo of state.repos.toReversed()) {
    // Read the canonical record under the locks before executing this repo.
    const pending = inspectRepoCleanupObligations(store, state, repo, options);
    assertCleanupWorktree(pending);
    const { cleanupAction, cleanupCommand, cleanupCwd, record, releaseAction } = pending;
    store.save(record);

    if (releaseAction) {
      effect(releaseAction, () => {
        try {
          releaseCheckoutResources(runtime, store, record, cleanupCwd);
        } catch (cause) {
          throw new MonkeError(
            `Resource release failed for session ${state.session} repo ${repo.sourceRoot}\n${errorMessage(ThrownValueSchema.parse(cause))}`,
            { cause }
          );
        }
      });
    }

    if (!cleanupAction || !cleanupCommand) {
      continue;
    }

    const resourceEnv = Object.fromEntries(
      record.resourceValues.map((resource) => [resource.env, resource.value])
    );

    const resourceCommandEnv = Object.fromEntries(
      record.resourceCommandOutputs.flatMap((command) =>
        command.outputs.map((resource) => [resource.env, resource.value])
      )
    );

    effect(cleanupAction, () => {
      try {
        runtime.exec("sh", ["-c", cleanupCommand], {
          cwd: cleanupCwd,
          env: {
            ...resourceEnv,
            ...resourceCommandEnv,
            MONKE_RESOURCE_OUTPUTS: JSON.stringify(resourceCommandEnv),
            MONKE_SESSION: state.session,
            MONKE_SOURCE_ROOT: repo.sourceRoot,
            MONKE_WORKTREE_PATH: repo.worktreePath
          },
          timeoutSeconds: CLEANUP_COMMAND_TIMEOUT_SECONDS
        });
      } catch (cause) {
        throw new MonkeError(
          `Cleanup command failed for session ${state.session} repo ${repo.sourceRoot}: ${cleanupCommand}\n${errorMessage(ThrownValueSchema.parse(cause))}`,
          { cause }
        );
      }

      if (options.recoveryCommand) {
        record.resourceCommandOutputs = [];
        delete record.legacyCleanupCommand;
        record.releasedLegacyCleanup = options.recoveryCommand;
        store.save(record);
      }
    });
  }
}

function assertCleanupWorktree(pending: ReturnType<typeof inspectRepoCleanupObligations>) {
  if (pending.recoveryRequired) {
    throw new MonkeError(
      `Cannot satisfy Cleanup obligations: Session worktree is missing: ${pending.record.owner.checkoutPath}. ` +
        `Restore the worktree and retry. To recover without it, run mt chop <session> --cleanup-from-source ` +
        `when the recorded commands are safe from the Source checkout, or mt cleanup <worktree> ` +
        `--recover-with <command>. Session state is retained.`
    );
  }
}

/** Remove state only after every recorded worktree is gone. */
function finalizeSession(store: SessionStateStore, state: SessionState, effect: Effect) {
  const liveRepo = state.repos.find((repo) => existsSync(repo.worktreePath));

  if (liveRepo !== undefined) {
    throw new MonkeError(
      `Cannot finalize session ${state.session} while worktree ${liveRepo.worktreePath} exists`
    );
  }

  effect({ sourceRoot: state.rootSourceRoot, step: "state-removal" }, () => {
    store.remove(state);
    const resources = new CheckoutResourceStore(store.home);

    for (const repo of state.repos) {
      resources.remove(resourceOwner(repo.sourceRoot, repo.worktreePath, state.session));
    }
  });
}

function assertSessionMemberUnchanged(
  candidate: SessionRepoPreflight,
  current: SessionRepoPreflight
) {
  if (candidate.mode === "gone" && current.mode !== "gone") {
    throw new MonkeError(
      `Session worktree reappeared after preflight at ${current.repo.worktreePath}; rerun to inspect it before removal`
    );
  }

  if (
    candidate.registeredBranch !== undefined &&
    current.registeredBranch !== undefined &&
    current.registeredBranch !== candidate.registeredBranch
  ) {
    throw new MonkeError(
      `Session worktree branch/HEAD changed from ${formatWorktreeBranch(candidate.registeredBranch)} to ${formatWorktreeBranch(current.registeredBranch)} at ${current.repo.worktreePath}`
    );
  }
}

function preflightSession(
  runtime: Runtime,
  home: string,
  { allStates, state }: SessionRemovalTarget,
  options: SessionRemovalOptions,
  checks: SessionRemovalChecks,
  progress: SessionRemovalProgress
) {
  const failures: { message: string; sourceRoot: string }[] = [];

  const sessionChecks = [
    () => {
      assertSessionIdentity(home, state);
    },
    () => {
      assertCanonicalSourceCheckout(runtime, state.rootSourceRoot);
    },
    () => {
      assertUniqueSessionRecords(state);
    },
    () => {
      assertSessionMaterializationOrder(state);
    },
    () => {
      assertNoOtherStateOwnsSessionRepos(state, allStates);
    }
  ];

  for (const check of sessionChecks) {
    try {
      check();
    } catch (cause) {
      failures.push({
        message: errorMessage(ThrownValueSchema.parse(cause)),
        sourceRoot: state.rootSourceRoot
      });
    }
  }

  const repos: SessionRepoPreflight[] = [];

  for (const repo of state.repos) {
    try {
      repos.push(inspectSessionRepo(runtime, home, state, repo, options, checks));
    } catch (cause) {
      failures.push({
        message: `${repo.worktreePath}: ${errorMessage(ThrownValueSchema.parse(cause))}`,
        sourceRoot: repo.sourceRoot
      });
    }
  }

  const [failed] = failures;

  if (failed) {
    progress.step({ sourceRoot: failed.sourceRoot, step: "revalidation" });
    throw new MonkeError(
      `Cannot remove Session ${state.session}; preflight failed:\n${failures
        .map((problem) => `- ${problem.message}`)
        .join("\n")}`
    );
  }

  return repos;
}

function inspectSessionRepo(
  runtime: Runtime,
  home: string,
  state: SessionState,
  repo: SessionRepoState,
  options: SessionRemovalOptions,
  checks: SessionRemovalChecks
): SessionRepoPreflight {
  const identity = inspectSessionRepoRegistration(runtime, home, state, repo);

  if (identity.mode !== "live") {
    return identity;
  }

  const proof = memberProof(options.members, repo);

  const checked = preflightWorktreeRemoval(
    runtime,
    repo.sourceRoot,
    repo.worktreePath,
    options,
    proof
      ? () => {
          checks.revalidateMember?.(repo);

          return proof.evidence?.pendingWork !== undefined;
        }
      : undefined
  );

  return { ...identity, forceGitRemoval: checked.forceGitRemoval };
}

function warnSessionBranchMismatch(
  runtime: Runtime,
  state: SessionState,
  candidate: SessionRepoPreflight
) {
  if (candidate.registeredBranch === undefined) {
    return;
  }

  const mismatch = describeSessionBranchMismatch(state.session, candidate.registeredBranch);

  if (mismatch === null) {
    return;
  }

  createLogger(runtime).warning(
    `Session ${state.session} worktree ${candidate.repo.worktreePath} ${mismatch}; removing it anyway`
  );
}

function formatWorktreeBranch(branch: string | null) {
  return branch ?? "detached";
}

export function assertSessionIdentity(
  home: string,
  state: SessionState,
  expected: { rootSourceRoot: string; session: string } = state
) {
  if (
    !samePath(state.rootSourceRoot, expected.rootSourceRoot) ||
    state.session !== expected.session ||
    !existsSync(getSessionStateFilePath(home, state.rootSourceRoot, state.session))
  ) {
    throw new MonkeError(`Session state identity is inconsistent for ${expected.session}`);
  }
}

function assertSessionMaterializationOrder(state: SessionState) {
  const rootIndex = state.repos.findIndex((repo) =>
    samePath(repo.sourceRoot, state.rootSourceRoot)
  );

  if (rootIndex !== -1 && rootIndex !== state.repos.length - 1) {
    throw new MonkeError(
      `Session state records Root repo ${state.rootSourceRoot} before its dependencies`
    );
  }
}

function assertUniqueSessionRecords(state: SessionState) {
  const sourceRoots = new Set<string>();
  const worktreePaths = new Set<string>();

  for (const repo of state.repos) {
    const sourceRoot = path.normalize(repo.sourceRoot);
    const worktreePath = path.normalize(repo.worktreePath);

    if (sourceRoots.has(sourceRoot)) {
      throw new MonkeError(
        `Session state records Source checkout ${repo.sourceRoot} more than once`
      );
    }

    if (worktreePaths.has(worktreePath)) {
      throw new MonkeError(
        `Session state records worktree path ${repo.worktreePath} more than once`
      );
    }

    sourceRoots.add(sourceRoot);
    worktreePaths.add(worktreePath);
  }
}

function removeWorktree(
  runtime: Runtime,
  sourceRoot: string,
  worktreePath: string,
  options: { force: boolean }
) {
  runtime.exec("git", ["worktree", "remove", ...(options.force ? ["--force"] : []), worktreePath], {
    cwd: sourceRoot
  });
}
