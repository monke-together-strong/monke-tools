import { existsSync } from "node:fs";
import path from "node:path";

import { MonkeError } from "./errors.ts";
import { createLogger } from "./logger.ts";
import type { Runtime } from "./types.ts";

export interface WorktreeEntry {
  branch: string | null;
  /** Null when unlocked; otherwise the optional Git worktree lock reason. */
  locked: string | null;
  path: string;
  prunable: boolean;
}

export function describeSessionBranchMismatch(session: string, branch: string | null) {
  if (branch === session) {
    return null;
  }

  return branch === null ? "is detached" : `is on branch ${branch} instead of ${session}`;
}

/** A resolved default branch candidate for one source repo. */
export interface DefaultBranchRef {
  branch: "main" | "master";
  /** Full Git ref, such as `refs/remotes/origin/main`. */
  ref: string;
  /** Whether the selected ref is remote-tracking or local. */
  source: "origin" | "local";
}

/** A checkout supplying commits and edits, distinct from canonical repository identity. */
export interface CheckoutSource {
  checkoutRoot: string;
  headCommit: string;
  headRef?: string;
}

export function resolveCheckoutSource(runtime: Runtime, checkoutRoot: string): CheckoutSource {
  const ref = runtime.exec("git", ["symbolic-ref", "--quiet", "HEAD"], {
    allowFailure: true,
    cwd: checkoutRoot
  });

  return {
    checkoutRoot,
    headCommit: runGit(runtime, checkoutRoot, ["rev-parse", "HEAD"]).trim(),
    headRef: ref.exitCode === 0 ? ref.stdout.trim() : undefined
  };
}

interface ResolveRepoContextOptions {
  allowExternalSessionWorktree?: boolean;
  allowSessionBranchMismatch?: boolean;
  inferSessionName?: boolean;
}

export function resolveRepoContext(
  runtime: Runtime,
  cwd: string = runtime.cwd,
  home?: string | null,
  options: ResolveRepoContextOptions = {}
) {
  const worktreeRoot = runGit(runtime, cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel"
  ]).trim();

  const gitCommonDir = runGit(runtime, cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir"
  ]).trim();

  const currentBranch = runGit(runtime, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const sourceRoot = path.dirname(gitCommonDir);
  const isSourceCheckout = path.normalize(worktreeRoot) === path.normalize(sourceRoot);
  const shouldInferSessionName = options.inferSessionName ?? true;
  let sessionName: string | null = null;

  if (!isSourceCheckout && shouldInferSessionName) {
    if (!home) {
      throw new MonkeError("Unable to infer the current session without a Monke home");
    }

    sessionName = inferSessionNameForContext(
      runtime,
      home,
      sourceRoot,
      worktreeRoot,
      currentBranch,
      {
        allowExternalSessionWorktree: options.allowExternalSessionWorktree ?? false,
        allowSessionBranchMismatch: options.allowSessionBranchMismatch ?? false
      }
    );
  }

  return {
    currentBranch,
    cwd,
    gitCommonDir,
    isSourceCheckout,
    sessionName,
    sourceRoot,
    worktreeRoot
  };
}

function inferSessionNameForContext(
  runtime: Runtime,
  home: string,
  sourceRoot: string,
  worktreeRoot: string,
  branch: string,
  options: {
    allowExternalSessionWorktree: boolean;
    allowSessionBranchMismatch: boolean;
  }
) {
  const expectedRoot = getExpectedSessionRoot(home, sourceRoot);
  const relativeSessionPath = path.relative(expectedRoot, worktreeRoot);

  if (isOutsideExpectedRoot(relativeSessionPath)) {
    if (!options.allowExternalSessionWorktree) {
      throw new MonkeError(
        `Expected linked worktree ${worktreeRoot} to live under ${expectedRoot}`
      );
    }

    createLogger(runtime).warning(
      `Linked worktree ${worktreeRoot} is outside ${expectedRoot}; using current branch "${branch}" as the Swing target`
    );

    return branch;
  }

  return inferSessionName(home, sourceRoot, worktreeRoot, branch, {
    allowBranchMismatch: options.allowSessionBranchMismatch
  });
}

/** Infer a Session name from a linked worktree path under Monke home. */
export function inferSessionName(
  home: string,
  sourceRoot: string,
  worktreeRoot: string,
  branch: string,
  options: { allowBranchMismatch?: boolean } = {}
) {
  const expectedRoot = getExpectedSessionRoot(home, sourceRoot);
  const relativeSessionPath = path.relative(expectedRoot, worktreeRoot);
  const sessionName = toSessionPath(relativeSessionPath);

  if (isOutsideExpectedRoot(relativeSessionPath)) {
    throw new MonkeError(`Expected linked worktree ${worktreeRoot} to live under ${expectedRoot}`);
  }

  if (sessionName !== branch && options.allowBranchMismatch !== true) {
    throw new MonkeError(
      `Expected linked worktree session "${sessionName}" to match current branch "${branch}"`
    );
  }

  return sessionName;
}

function getExpectedSessionRoot(home: string, sourceRoot: string) {
  return path.join(home, "worktrees", path.basename(sourceRoot));
}

function isOutsideExpectedRoot(relativeSessionPath: string) {
  return (
    !relativeSessionPath ||
    relativeSessionPath.startsWith("..") ||
    path.isAbsolute(relativeSessionPath)
  );
}

export function resolveGitRepoRoot(runtime: Runtime, checkoutPath: string) {
  return runGit(runtime, checkoutPath, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel"
  ]).trim();
}

export function listWorktrees(runtime: Runtime, sourceRoot: string) {
  const output = runGit(runtime, sourceRoot, ["worktree", "list", "--porcelain"]);
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};

  for (const line of output.split("\n")) {
    if (!line.trim()) {
      appendWorktreeEntry(entries, current);
      current = {};
      continue;
    }

    if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length);
      continue;
    }

    if (line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
      continue;
    }

    if (line.startsWith("prunable")) {
      current.prunable = true;
      continue;
    }

    if (line === "locked" || line.startsWith("locked ")) {
      current.locked = line.slice("locked".length).trim();
    }
  }

  appendWorktreeEntry(entries, current);

  return entries;
}

function appendWorktreeEntry(entries: WorktreeEntry[], current: Partial<WorktreeEntry>) {
  if (!current.path) {
    return;
  }

  entries.push({
    branch: current.branch ?? null,
    locked: current.locked ?? null,
    path: current.path,
    prunable: current.prunable ?? false
  });
}

export function branchExists(runtime: Runtime, sourceRoot: string, branch: string) {
  const result = runtime.exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    allowFailure: true,
    cwd: sourceRoot
  });

  return result.exitCode === 0;
}

/**
 * Resolve main or master for one source repo, preferring origin's refs. With refresh, a failed
 * fetch falls back to local branches only.
 */
export function resolveDefaultBranchRef(
  runtime: Runtime,
  sourceRoot: string,
  options: { refresh?: boolean } = {}
) {
  const shouldRefresh = options.refresh ?? true;

  const localCandidates: DefaultBranchRef[] = [
    { branch: "main", ref: "refs/heads/main", source: "local" },
    { branch: "master", ref: "refs/heads/master", source: "local" }
  ];

  const originCandidates: DefaultBranchRef[] = [
    { branch: "main", ref: "refs/remotes/origin/main", source: "origin" },
    { branch: "master", ref: "refs/remotes/origin/master", source: "origin" }
  ];

  let candidates = localCandidates;

  if (shouldRefresh) {
    const fetchResult = runtime.exec("git", ["fetch", "--prune", "origin"], {
      allowFailure: true,
      cwd: sourceRoot
    });

    if (fetchResult.exitCode === 0) {
      candidates = [...originCandidates, ...localCandidates];
    }
  } else {
    candidates = [...originCandidates, ...localCandidates];
  }

  for (const candidate of candidates) {
    if (refExists(runtime, sourceRoot, candidate.ref)) {
      return candidate;
    }
  }

  throw new MonkeError(`Could not resolve a default branch ref for ${sourceRoot}`);
}

/** A Spawn start point: the ref recorded as the Diff base and the commit it resolved to. */
export interface PinnedStartRef {
  /** Commit the Session branch starts from. */
  pinnedRef: string;
  /** Full name of a shared ref that resolves to `pinnedRef`; otherwise `pinnedRef` itself. */
  ref: string;
}

/** Shared refs that resolve the same way inside every worktree of the repository. */
const SHARED_REF_PATTERN = /^refs\/(?:heads|remotes|tags)\//u;

/**
 * Fixed scratch ref for a targeted start-ref fetch. A fixed name is safe because Spawn runs under
 * the Monke global lock.
 */
const START_REF_FETCH_REF = "refs/monke/spawn-start";

/**
 * Resolve a Spawn start point after refreshing origin. A local name wins over a same-named origin
 * branch. Refs the default fetch skips, such as tags on commits outside origin's branches, are
 * fetched directly. Throws when nothing resolves.
 */
export function resolveStartRef(
  runtime: Runtime,
  sourceRoot: string,
  name: string
): PinnedStartRef {
  if (name.startsWith("-")) {
    throw new MonkeError(`--from ref "${name}" must not begin with "-"`);
  }

  runtime.exec("git", ["fetch", "--prune", "origin"], { allowFailure: true, cwd: sourceRoot });

  for (const candidate of [name, `refs/remotes/origin/${name}`]) {
    const pinnedRef = resolveCommit(runtime, sourceRoot, candidate);

    if (pinnedRef !== undefined) {
      const fullName = runtime.exec("git", ["rev-parse", "--symbolic-full-name", candidate], {
        allowFailure: true,
        cwd: sourceRoot
      });

      const ref = fullName.stdout.trim();

      // Record the name only if every worktree shares it and it still resolves to the pinned
      // commit. HEAD and refs/bisect/* are per-worktree, and a branch named like another
      // commit's full SHA resolves elsewhere.
      const portable =
        SHARED_REF_PATTERN.test(ref) && resolveCommit(runtime, sourceRoot, ref) === pinnedRef;

      return { pinnedRef, ref: portable ? ref : pinnedRef };
    }
  }

  const pinnedRef = fetchStartCommit(runtime, sourceRoot, name);

  if (pinnedRef === undefined) {
    throw new MonkeError(
      `Could not resolve --from ref "${name}" locally or on origin for ${sourceRoot}`
    );
  }

  return { pinnedRef, ref: pinnedRef };
}

function fetchStartCommit(runtime: Runtime, sourceRoot: string, name: string) {
  const fetched = runtime.exec(
    "git",
    [
      "fetch",
      "--no-tags",
      "origin",
      "--end-of-options",
      // Fetch origin/<branch> as origin's refs/heads/<branch> so a same-named tag cannot match.
      `+${name.replace(/^(?:refs\/remotes\/)?origin\//u, "refs/heads/")}:${START_REF_FETCH_REF}`
    ],
    { allowFailure: true, cwd: sourceRoot }
  );

  try {
    return fetched.exitCode === 0
      ? resolveCommit(runtime, sourceRoot, START_REF_FETCH_REF)
      : undefined;
  } finally {
    runtime.exec("git", ["update-ref", "-d", START_REF_FETCH_REF], {
      allowFailure: true,
      cwd: sourceRoot
    });
  }
}

function resolveCommit(runtime: Runtime, sourceRoot: string, revision: string) {
  const commit = runtime.exec(
    "git",
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`],
    { allowFailure: true, cwd: sourceRoot }
  );

  return commit.exitCode === 0 ? commit.stdout.trim() : undefined;
}

/** Return the canonical Session worktree path for one repo under Monke home. */
export function getExpectedWorktreePath(home: string, sourceRoot: string, session: string) {
  return path.join(home, "worktrees", path.basename(sourceRoot), session);
}

/** Validate that a worktree is the expected Session worktree for one repo. */
export function validateWorktreeForSession(
  runtime: Runtime,
  home: string,
  sourceRoot: string,
  worktreePath: string,
  session: string,
  options: { allowBranchMismatch?: boolean } = {}
) {
  const expectedPath = getExpectedWorktreePath(home, sourceRoot, session);

  if (path.normalize(worktreePath) !== path.normalize(expectedPath)) {
    throw new MonkeError(
      `Expected session "${session}" worktree at ${expectedPath}, found ${worktreePath}`
    );
  }

  if (!existsSync(worktreePath)) {
    throw new MonkeError(`Expected worktree to exist at ${worktreePath}`);
  }

  const context = resolveRepoContext(runtime, worktreePath, home, { inferSessionName: false });

  if (context.isSourceCheckout) {
    throw new MonkeError(`Expected ${worktreePath} to be a linked session worktree`);
  }

  if (path.normalize(context.sourceRoot) !== path.normalize(sourceRoot)) {
    throw new MonkeError(
      `Expected worktree ${worktreePath} to belong to ${sourceRoot}, found ${context.sourceRoot}`
    );
  }

  if (context.currentBranch !== session && options.allowBranchMismatch !== true) {
    throw new MonkeError(
      `Expected worktree ${worktreePath} to be on branch ${session}, found ${context.currentBranch}`
    );
  }

  return context;
}

export function runGit(runtime: Runtime, cwd: string, args: string[]) {
  return runtime.exec("git", args, { cwd }).stdout;
}

function refExists(runtime: Runtime, sourceRoot: string, ref: string) {
  const result = runtime.exec("git", ["show-ref", "--verify", "--quiet", ref], {
    allowFailure: true,
    cwd: sourceRoot
  });

  return result.exitCode === 0;
}

function toSessionPath(targetPath: string) {
  return targetPath.split(path.sep).join("/");
}
