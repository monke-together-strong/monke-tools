import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { MonkeError } from "./errors.ts";
import { branchExists, listWorktrees, resolveRepoContext } from "./git.ts";
import { createLogger } from "./logger.ts";
import { containsPath, samePath } from "./path-identity.ts";
import { getMonkeHome, withGlobalLock } from "./runtime.ts";
import { assertSessionIdentity, removeSession } from "./session-removal.ts";
import {
  findSessionOwner,
  getSessionStateFilePath,
  listSessionStates,
  listSessionStatesRelevantToWorktrees,
  loadSessionState
} from "./session-state-store.ts";
import { requestShellDirectoryAfterRemoval } from "./shell.ts";
import type { Runtime, SessionState } from "./types.ts";
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
  recoveryCommand?: string;
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
      const result = removeSession(runtime, home, selected, {
        ...options,
        invocationPath: invocation.worktreeRoot
      });

      if (result.outcome !== "removed") {
        throw result.cause;
      }

      return { kind: "session" as const, session: selected.state.session };
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
  let invocationOwner: SessionState | null = null;

  // Session state decides ownership, so an adopted worktree outside Monke home selects its Session.
  if (!invocation.isSourceCheckout) {
    invocationOwner = findSessionOwner(
      listSessionStatesRelevantToWorktrees(home, [invocation.worktreeRoot]),
      invocation.worktreeRoot,
      invocation.sourceRoot
    );

    if (invocationOwner === null && isManagedWorktreePath(home, invocation.worktreeRoot)) {
      // Preserve fail-closed behavior when invalid state may be the missing owner.
      listSessionStates(home);
      throw new MonkeError(
        `Managed worktree ${invocation.worktreeRoot} has no valid owning Session state`
      );
    }

    if (invocationOwner !== null) {
      assertInvocationSessionScope(runtime, home, invocation, invocationOwner);
    }
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

  const selectedOwner = findSessionOwner(
    listSessionStatesRelevantToWorktrees(home, [ordinaryCandidate.path]),
    ordinaryCandidate.path
  );

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

  if (repo === undefined) {
    throw new MonkeError(
      `Managed worktree ${invocation.worktreeRoot} does not match its recorded Session identity`
    );
  }
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
  return containsPath(path.join(home, "worktrees"), worktreePath);
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
