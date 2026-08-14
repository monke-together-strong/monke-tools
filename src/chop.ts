import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { errorMessage, MonkeError } from "./errors.ts";
import {
  branchExists,
  describeSessionBranchMismatch,
  getExpectedWorktreePath,
  listWorktrees,
  resolveRepoContext
} from "./git.ts";
import { createLogger } from "./logger.ts";
import {
  getSessionStateFilePath,
  listSessionStates,
  listSessionStatesRelevantToWorktrees,
  loadSessionState
} from "./registry.ts";
import { getMonkeHome, withGlobalLock } from "./runtime.ts";
import { finalizeSession } from "./session-finalization.ts";
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
  force: boolean;
}

interface SessionRepoPreflight {
  forceGitRemoval: boolean;
  mode: "gone" | "live" | "stale";
  registeredBranch: string | null | undefined;
  repo: SessionRepoState;
}

interface OrdinaryChopResult {
  kind: "ordinary";
  removedInvocation: boolean;
  sourceRoot: string;
  worktreePath: string;
}

interface SessionChopResult {
  kind: "session";
  session: string;
}

type ChopResult = OrdinaryChopResult | SessionChopResult;

/** Remove one selected Session or Ordinary worktree while preserving local branches. */
export function runChop(runtime: Runtime, target: string | undefined, options: ChopOptions) {
  const home = getMonkeHome(runtime);
  const removed = withGlobalLock(home, () => {
    const invocation = resolveRepoContext(runtime, runtime.cwd, null, {
      inferSessionName: false
    });
    const selected = resolveChopTarget(runtime, home, invocation, target);

    if (selected.kind === "session") {
      return chopSession(runtime, home, invocation.worktreeRoot, selected, options);
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
      removedInvocation:
        path.normalize(invocation.worktreeRoot) === path.normalize(current.worktree.path),
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
    if (path.normalize(selectedOwner.rootSourceRoot) !== path.normalize(rootScope)) {
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

function chopSession(
  runtime: Runtime,
  home: string,
  invocationWorktreePath: string,
  target: SessionChopTarget,
  options: ChopOptions
): ChopResult {
  const preflight = preflightSession(runtime, home, target.state, target.allStates, options);
  for (const candidate of preflight) {
    warnSessionBranchMismatch(runtime, target.state, candidate);
  }
  const ordered = orderSessionRemovals(
    preflight,
    invocationWorktreePath,
    target.state.rootSourceRoot
  );

  for (const candidate of ordered) {
    const current = inspectSessionRepo(runtime, home, target.state, candidate.repo, options);
    if (
      candidate.registeredBranch !== undefined &&
      current.registeredBranch !== undefined &&
      current.registeredBranch !== candidate.registeredBranch
    ) {
      throw new MonkeError(
        `Session worktree branch/HEAD changed from ${formatWorktreeBranch(candidate.registeredBranch)} to ${formatWorktreeBranch(current.registeredBranch)} at ${current.repo.worktreePath}`
      );
    }
    if (current.mode !== "gone") {
      removeWorktree(runtime, current.repo.sourceRoot, current.repo.worktreePath, {
        force: current.mode === "stale" || current.forceGitRemoval
      });
    }
    if (samePath(current.repo.worktreePath, invocationWorktreePath)) {
      requestShellDirectoryAfterRemoval(runtime, current.repo.sourceRoot);
    }
  }

  finalizeSession(runtime, home, target.state);
  return {
    kind: "session",
    session: target.state.session
  };
}

function preflightSession(
  runtime: Runtime,
  home: string,
  state: SessionState,
  allStates: SessionState[],
  options: ChopOptions
) {
  const failures: string[] = [];
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
      failures.push(errorMessage(error));
    }
  }

  const repos: SessionRepoPreflight[] = [];
  for (const repo of state.repos) {
    try {
      repos.push(inspectSessionRepo(runtime, home, state, repo, options));
    } catch (error) {
      failures.push(`${repo.worktreePath}: ${errorMessage(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new MonkeError(
      `Cannot Chop Session ${state.session}; preflight failed:\n${failures
        .map((failure) => `- ${failure}`)
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
  options: ChopOptions
): SessionRepoPreflight {
  assertCanonicalSourceCheckout(runtime, repo.sourceRoot);
  const expectedPath = getExpectedWorktreePath(home, repo.sourceRoot, state.session);
  if (!samePath(repo.worktreePath, expectedPath) || !path.isAbsolute(repo.worktreePath)) {
    throw new MonkeError(
      `Recorded Session worktree path is not canonical; expected ${expectedPath}`
    );
  }

  const worktrees = listWorktrees(runtime, repo.sourceRoot);
  const exact = worktrees.find((entry) => samePath(entry.path, repo.worktreePath));
  const conflicts = worktrees.filter(
    (entry) => entry.branch === state.session && !samePath(entry.path, repo.worktreePath)
  );
  if (conflicts.length > 0) {
    throw new MonkeError(
      `Session branch ${state.session} is registered at unexpected path${conflicts.length === 1 ? "" : "s"} ${conflicts
        .map((entry) => entry.path)
        .join(", ")}`
    );
  }

  if (!existsSync(repo.worktreePath)) {
    if (exact !== undefined) {
      assertWorktreeUnlocked(exact);
    }
    return {
      forceGitRemoval: false,
      mode: exact === undefined ? "gone" : "stale",
      registeredBranch: exact?.branch,
      repo
    };
  }

  if (exact === undefined) {
    throw new MonkeError(`Session worktree exists but is not registered`);
  }
  const checked = preflightWorktreeRemoval(runtime, repo.sourceRoot, repo.worktreePath, options);
  return {
    forceGitRemoval: checked.forceGitRemoval,
    mode: "live",
    registeredBranch: exact.branch,
    repo
  };
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

function assertNoOtherStateOwnsSessionRepos(state: SessionState, allStates: SessionState[]) {
  const paths = new Set(state.repos.map((repo) => path.normalize(repo.worktreePath)));
  for (const other of allStates) {
    if (
      other === state ||
      (samePath(other.rootSourceRoot, state.rootSourceRoot) && other.session === state.session)
    ) {
      continue;
    }
    const collision = other.repos.find((repo) => paths.has(path.normalize(repo.worktreePath)));
    if (collision !== undefined) {
      throw new MonkeError(
        `Session worktree ${collision.worktreePath} is also recorded by Session ${other.session}`
      );
    }
  }
}

function orderSessionRemovals(
  repos: SessionRepoPreflight[],
  invocationWorktreePath: string,
  rootSourceRoot: string
) {
  return [...repos].toSorted((left, right) => {
    const leftRank = removalRank(left.repo, invocationWorktreePath, rootSourceRoot);
    const rightRank = removalRank(right.repo, invocationWorktreePath, rootSourceRoot);
    return leftRank - rightRank;
  });
}

function removalRank(
  repo: SessionRepoState,
  invocationWorktreePath: string,
  rootSourceRoot: string
) {
  if (samePath(repo.worktreePath, invocationWorktreePath)) {
    return 2;
  }
  if (samePath(repo.sourceRoot, rootSourceRoot)) {
    return 1;
  }
  return 0;
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
  const pathMatches = worktrees.filter(
    (worktree) => path.normalize(worktree.path) === path.normalize(targetPath)
  );
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

function samePath(left: string, right: string) {
  return path.normalize(left) === path.normalize(right);
}
