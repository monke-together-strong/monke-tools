import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { errorMessage, MonkeError, ThrownValueSchema } from "./errors.ts";
import {
  branchExists,
  describeSessionBranchMismatch,
  getExpectedWorktreePath,
  listWorktrees,
  resolveRepoContext
} from "./git.ts";
import { createLogger } from "./logger.ts";
import { samePath } from "./path-identity.ts";
import { getMonkeHome, withGlobalLock } from "./runtime.ts";
import { cleanupSessionResources, finalizeSession } from "./session-finalization.ts";
import { sessionRemovalRank } from "./session-lifecycle-progress.ts";
import type { SessionAction, SessionLifecycleObserver } from "./session-lifecycle-progress.ts";
import {
  assertNoOtherStateOwnsSessionRepos,
  inspectSessionRepoRegistration
} from "./session-safety.ts";
import {
  getSessionStateFilePath,
  listSessionStates,
  listSessionStatesRelevantToWorktrees,
  loadSessionState,
  SessionStateStore
} from "./session-state-store.ts";
import { requestShellDirectoryAfterRemoval } from "./shell.ts";
import type { Runtime, SessionRepoState, SessionState } from "./types.ts";
import {
  assertCanonicalSourceCheckout,
  assertWorktreeUnlocked,
  preflightWorktreeRemoval
} from "./worktree-safety.ts";

interface OrdinaryChopTarget {
  kind: "ordinary";
  worktreePath: string;
}

interface SessionChopTarget {
  allStates: SessionState[];
  kind: "session";
  state: SessionState;
}

type ChopTarget = OrdinaryChopTarget | SessionChopTarget;

interface ChopOptions {
  cleanupFromSource?: boolean;
  force: boolean;
}

interface SessionRepoPreflight {
  forceGitRemoval: boolean;
  mode: "gone" | "live" | "stale";
  registeredBranch: string | null | undefined;
  repo: SessionRepoState;
}

interface SessionChopResult {
  kind: "session";
  session: string;
}

/** Remove one selected Session or Ordinary worktree while preserving local branches. */
export function runChop(runtime: Runtime, target: string | undefined, options: ChopOptions) {
  const home = getMonkeHome(runtime);
  const removed = withGlobalLock(home, () => {
    const invocation = resolveRepoContext(runtime, runtime.cwd, null, {
      inferSessionName: false
    });
    const selected = resolveChopTarget(runtime, home, invocation, target);

    if (selected.kind === "session") {
      return teardownSession(runtime, home, invocation.worktreeRoot, selected, options);
    }

    const preflight = inspectOrdinaryWorktree(
      runtime,
      invocation.sourceRoot,
      selected.worktreePath,
      options
    );
    const current = inspectOrdinaryWorktree(
      runtime,
      invocation.sourceRoot,
      selected.worktreePath,
      options
    );
    if (current.worktree.branch !== preflight.worktree.branch) {
      throw new MonkeError(
        `Ordinary worktree branch/HEAD changed from ${preflight.worktree.branch ?? "detached"} to ${current.worktree.branch ?? "detached"} at ${current.worktree.path}`
      );
    }
    removeWorktree(runtime, invocation.sourceRoot, current.worktree.path, {
      force: current.mode === "stale" || current.forceGitRemoval
    });
    return {
      kind: "ordinary" as const,
      removedInvocation: samePath(invocation.worktreeRoot, current.worktree.path),
      sourceRoot: invocation.sourceRoot,
      worktreePath: current.worktree.path
    };
  });

  if (removed.kind === "session") {
    createLogger(runtime).success(`Chopped Session ${removed.session}`);
  } else {
    createLogger(runtime).success(`Chopped Ordinary worktree ${removed.worktreePath}`);
    if (removed.removedInvocation) {
      requestShellDirectoryAfterRemoval(runtime, removed.sourceRoot);
    }
  }
}

function inspectOrdinaryWorktree(
  runtime: Runtime,
  sourceRoot: string,
  worktreePath: string,
  options: ChopOptions
) {
  assertCanonicalSourceCheckout(runtime, sourceRoot);
  if (existsSync(worktreePath)) {
    const checked = preflightWorktreeRemoval(runtime, sourceRoot, worktreePath, options);
    return {
      forceGitRemoval: checked.forceGitRemoval,
      mode: "live",
      worktree: checked.worktree
    };
  }

  const exact = listWorktrees(runtime, sourceRoot).find((entry) =>
    samePath(entry.path, worktreePath)
  );
  if (exact === undefined) {
    throw new MonkeError(`Chop target not found: ${worktreePath}`);
  }
  assertWorktreeUnlocked(exact);
  return {
    forceGitRemoval: false,
    mode: "stale",
    worktree: exact
  };
}

function resolveChopTarget(
  runtime: Runtime,
  home: string,
  invocation: ReturnType<typeof resolveRepoContext>,
  target: string | undefined
): ChopTarget {
  const managedInvocation =
    !invocation.isSourceCheckout && isManagedWorktreePath(home, invocation.worktreeRoot);
  let allStates: SessionState[] = [];
  let invocationOwner: SessionState | null = null;
  if (managedInvocation) {
    allStates = listSessionStatesRelevantToWorktrees(home, [invocation.worktreeRoot]);
    invocationOwner = findSessionOwner(allStates, invocation.worktreeRoot, invocation.sourceRoot);
    if (invocationOwner === null) {
      // Preserve fail-closed behavior when invalid state may be the missing owner.
      listSessionStates(home);
      throw new MonkeError(
        `Managed worktree ${invocation.worktreeRoot} has no valid owning Session state`
      );
    }
    assertInvocationSessionScope(runtime, home, invocation, invocationOwner);
  }

  if (target === undefined) {
    if (invocation.isSourceCheckout) {
      throw new MonkeError("mt chop from a Source checkout requires an explicit target");
    }
    if (invocationOwner !== null) {
      return validateSessionChopTarget(home, invocationOwner);
    }
    return { kind: "ordinary", worktreePath: invocation.worktreeRoot };
  }

  const rootScope = invocationOwner?.rootSourceRoot ?? invocation.sourceRoot;
  const statePath = getSessionStateFilePath(home, rootScope, target);
  if (existsSync(statePath)) {
    const state = loadSessionState(home, rootScope, target);
    assertSessionIdentity(home, state, { rootSourceRoot: rootScope, session: target });
    return validateSessionChopTarget(home, state);
  }
  if (invocation.isSourceCheckout) {
    const retained = findRetainedSessionForSource(
      listSessionStatesRelevantToWorktrees(home, []),
      target,
      invocation.sourceRoot
    );
    if (retained !== null) {
      assertSessionIdentity(home, retained);
      return validateSessionChopTarget(home, retained);
    }
  }

  const ordinaryCandidate = resolveOrdinaryTarget(runtime, invocation, target);
  const managedCandidate = isManagedWorktreePath(home, ordinaryCandidate.path);
  if (allStates.length === 0 && managedCandidate) {
    allStates = listSessionStatesRelevantToWorktrees(home, [ordinaryCandidate.path]);
  }
  const selectedOwner = findSessionOwner(allStates, ordinaryCandidate.path);
  if (selectedOwner !== null) {
    assertSessionIdentity(home, selectedOwner);
    if (!samePath(selectedOwner.rootSourceRoot, rootScope)) {
      throw new MonkeError(
        `Session ${selectedOwner.session} is outside the current Root repo scope ${rootScope}`
      );
    }
    return validateSessionChopTarget(home, selectedOwner);
  }
  if (managedCandidate) {
    // Preserve fail-closed behavior when invalid state may be the missing owner.
    listSessionStates(home);
  }

  assertOutsideManagedWorktrees(home, ordinaryCandidate.path);
  if (!ordinaryCandidate.registered) {
    throw new MonkeError(
      `Chop target not found: No registered worktree in ${invocation.sourceRoot} matches target "${target}"`
    );
  }
  return { kind: "ordinary", worktreePath: ordinaryCandidate.path };
}

function validateSessionChopTarget(home: string, state: SessionState): SessionChopTarget {
  return {
    allStates: listSessionStatesRelevantToWorktrees(
      home,
      state.repos.map((repo) => repo.worktreePath)
    ),
    kind: "session",
    state
  };
}

export function teardownSession(
  runtime: Runtime,
  home: string,
  invocationWorktreePath: string,
  target: SessionChopTarget,
  options: ChopOptions,
  observer: SessionLifecycleObserver = {}
): SessionChopResult {
  observer.beforeStep?.({ sourceRoot: target.state.rootSourceRoot, step: "revalidation" });
  const preflight = preflightSession(
    runtime,
    home,
    target.state,
    target.allStates,
    options,
    observer
  );
  for (const candidate of preflight) {
    warnSessionBranchMismatch(runtime, target.state, candidate);
  }
  const ordered = orderSessionRemovals(
    preflight,
    invocationWorktreePath,
    target.state.rootSourceRoot
  );

  for (const candidate of ordered) {
    observer.revalidateMember?.(candidate.repo);
    if (candidate.mode !== "gone") {
      observer.beforeRemoval?.(candidate.repo);
    }
  }
  const revalidateAll = () => {
    for (const candidate of preflight) {
      observer.beforeStep?.({
        sourceRoot: candidate.repo.sourceRoot,
        step: "revalidation",
        worktreePath: candidate.repo.worktreePath
      });
      const current = inspectSessionRepo(
        runtime,
        home,
        target.state,
        candidate.repo,
        options,
        observer
      );
      assertSessionMemberUnchanged(candidate, current);
      if (candidate.mode !== current.mode) {
        throw new MonkeError(
          `Session worktree presence changed after preflight at ${current.repo.worktreePath}; retry teardown`
        );
      }
      observer.revalidateMember?.(candidate.repo);
    }
  };
  cleanupSessionResources(
    runtime,
    target.state,
    {
      ...observer,
      beforeEffect(action) {
        revalidateAll();
        observer.beforeStep?.(action);
        observer.beforeEffect?.(action);
      }
    },
    options.cleanupFromSource === true
  );
  // Shutdown and cleanup commands can modify any sibling. Recheck the whole Session
  // before removing its first worktree, then recheck each member at removal.
  revalidateAll();

  for (const candidate of ordered) {
    observer.beforeStep?.({
      sourceRoot: candidate.repo.sourceRoot,
      step: "revalidation",
      worktreePath: candidate.repo.worktreePath
    });
    const current = inspectSessionRepo(
      runtime,
      home,
      target.state,
      candidate.repo,
      options,
      observer
    );
    assertSessionMemberUnchanged(candidate, current);
    observer.revalidateMember?.(candidate.repo);
    if (current.mode !== "gone") {
      const action: SessionAction = {
        sourceRoot: current.repo.sourceRoot,
        step: "worktree-removal",
        worktreePath: current.repo.worktreePath
      };
      observer.beforeStep?.(action);
      observer.beforeEffect?.(action);
      removeWorktree(runtime, current.repo.sourceRoot, current.repo.worktreePath, {
        force: current.mode === "stale" || current.forceGitRemoval
      });
      observer.completed?.(action);
    }
    if (samePath(current.repo.worktreePath, invocationWorktreePath)) {
      requestShellDirectoryAfterRemoval(runtime, current.repo.sourceRoot);
    }
  }

  // Reuse the targeted ownership scan; unrelated invalid state must not block this removal.
  finalizeSession(new SessionStateStore(home, target.allStates), target.state, observer);
  return {
    kind: "session",
    session: target.state.session
  };
}

function assertSessionMemberUnchanged(
  candidate: SessionRepoPreflight,
  current: SessionRepoPreflight
) {
  if (candidate.mode === "gone" && current.mode !== "gone") {
    throw new MonkeError(
      `Session worktree reappeared after preflight at ${current.repo.worktreePath}; retry teardown to inspect it before cleanup`
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
  state: SessionState,
  allStates: SessionState[],
  options: ChopOptions,
  observer: SessionLifecycleObserver
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
    } catch (error) {
      failures.push({
        message: errorMessage(ThrownValueSchema.parse(error)),
        sourceRoot: state.rootSourceRoot
      });
    }
  }

  const repos: SessionRepoPreflight[] = [];
  for (const repo of state.repos) {
    try {
      repos.push(inspectSessionRepo(runtime, home, state, repo, options, observer));
    } catch (error) {
      failures.push({
        message: `${repo.worktreePath}: ${errorMessage(ThrownValueSchema.parse(error))}`,
        sourceRoot: repo.sourceRoot
      });
    }
  }

  const [failure] = failures;
  if (failure) {
    observer.beforeStep?.({ sourceRoot: failure.sourceRoot, step: "revalidation" });
    throw new MonkeError(
      `Cannot Chop Session ${state.session}; preflight failed:\n${failures
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
  options: ChopOptions,
  observer: SessionLifecycleObserver
): SessionRepoPreflight {
  const identity = inspectSessionRepoRegistration(runtime, home, state, repo);
  if (identity.mode !== "live") {
    return identity;
  }
  const checked = preflightWorktreeRemoval(
    runtime,
    repo.sourceRoot,
    repo.worktreePath,
    options,
    observer.authorizePreservedWork
      ? () => observer.authorizePreservedWork?.(repo) === true
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
    `Session ${state.session} worktree ${candidate.repo.worktreePath} ${mismatch}; chopping it anyway`
  );
}

function formatWorktreeBranch(branch: string | null) {
  return branch ?? "detached";
}

function assertSessionIdentity(
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

function assertInvocationSessionScope(
  runtime: Runtime,
  home: string,
  invocation: ReturnType<typeof resolveRepoContext>,
  state: SessionState
) {
  assertSessionIdentity(home, state);
  assertCanonicalSourceCheckout(runtime, state.rootSourceRoot);
  const repo = state.repos.find(
    (candidate) =>
      samePath(candidate.sourceRoot, invocation.sourceRoot) &&
      samePath(candidate.worktreePath, invocation.worktreeRoot)
  );
  if (
    repo === undefined ||
    !samePath(repo.worktreePath, getExpectedWorktreePath(home, repo.sourceRoot, state.session))
  ) {
    throw new MonkeError(
      `Managed worktree ${invocation.worktreeRoot} does not match its recorded Session identity`
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

function orderSessionRemovals(
  repos: SessionRepoPreflight[],
  invocationWorktreePath: string,
  rootSourceRoot: string
) {
  return [...repos].toSorted((left, right) => {
    const leftRank = sessionRemovalRank(left.repo, invocationWorktreePath, rootSourceRoot);
    const rightRank = sessionRemovalRank(right.repo, invocationWorktreePath, rootSourceRoot);
    return leftRank - rightRank;
  });
}

function findSessionOwner(states: SessionState[], worktreePath: string, sourceRoot?: string) {
  const matches = states.filter((state) =>
    state.repos.some(
      (repo) =>
        samePath(repo.worktreePath, worktreePath) &&
        (sourceRoot === undefined || samePath(repo.sourceRoot, sourceRoot))
    )
  );
  if (matches.length > 1) {
    throw new MonkeError(`Worktree ${worktreePath} is recorded by multiple Sessions`);
  }
  return matches[0] ?? null;
}

function findRetainedSessionForSource(states: SessionState[], session: string, sourceRoot: string) {
  const matches = states.filter(
    (state) =>
      state.session === session &&
      state.repos.some((repo) => samePath(repo.sourceRoot, sourceRoot)) &&
      state.repos.every((repo) => !existsSync(repo.worktreePath))
  );
  if (matches.length > 1) {
    throw new MonkeError(
      `Session ${session} is ambiguous for Source checkout ${sourceRoot}; retry from its Root repo Source checkout`
    );
  }
  return matches[0] ?? null;
}

function resolveOrdinaryTarget(
  runtime: Runtime,
  invocation: ReturnType<typeof resolveRepoContext>,
  target: string | undefined
) {
  if (target === undefined) {
    return { path: invocation.worktreeRoot, registered: true };
  }

  const worktrees = listWorktrees(runtime, invocation.sourceRoot);
  const branchMatches = worktrees.filter((worktree) => worktree.branch === target);
  const unresolvedTargetPath = path.isAbsolute(target) ? target : path.resolve(runtime.cwd, target);
  // Missing worktrees intentionally stay lexical: stale recovery requires the
  // exact registered path so an alias cannot authorize pruning Git metadata.
  const targetPath = existsSync(unresolvedTargetPath)
    ? realpathSync.native(unresolvedTargetPath)
    : unresolvedTargetPath;
  const pathMatches = worktrees.filter((worktree) => samePath(worktree.path, targetPath));
  const matches = [...new Set([...branchMatches, ...pathMatches])];
  if (matches.length > 1) {
    throw new MonkeError(
      `Chop target "${target}" matches multiple registered worktrees: ${matches
        .map((worktree) => worktree.path)
        .join(", ")}`
    );
  }
  const [match] = matches;
  if (match !== undefined) {
    return { path: match.path, registered: true };
  }
  if (branchExists(runtime, invocation.sourceRoot, target)) {
    throw new MonkeError(
      `Chop target not found: Local branch "${target}" has no registered worktree to Chop`
    );
  }
  return {
    path: targetPath,
    registered: false
  };
}

function assertOutsideManagedWorktrees(home: string, worktreePath: string) {
  if (isManagedWorktreePath(home, worktreePath)) {
    throw new MonkeError(`Cannot Chop managed worktree ${worktreePath} as an Ordinary worktree`);
  }
}

function isManagedWorktreePath(home: string, worktreePath: string) {
  const relative = path.relative(path.join(home, "worktrees"), worktreePath);
  return !(path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`));
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
