import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { MonkeError } from "./errors.ts";
import { createLogger } from "./logger.ts";
import type { RepoContext, Runtime } from "./types.ts";

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  /** Null when unlocked; otherwise the optional Git worktree lock reason. */
  locked: string | null;
  prunable: boolean;
}

export function describeSessionBranchMismatch(
  session: string,
  branch: string | null
): string | null {
  if (branch === session) {
    return null;
  }
  return branch === null ? "is detached" : `is on branch ${branch} instead of ${session}`;
}

/** A resolved default branch candidate for one source repo. */
export interface DefaultBranchRef {
  /** Branch name selected as the repo's default branch candidate. */
  branch: "main" | "master";
  /** Full git ref used as the Session branch start point. */
  ref: string;
  /** Whether the selected ref is remote-tracking or local. */
  source: "origin" | "local";
}

interface ResolveRepoContextOptions {
  inferSessionName?: boolean;
  allowExternalSessionWorktree?: boolean;
  allowSessionBranchMismatch?: boolean;
}

export function resolveRepoContext(
  runtime: Runtime,
  cwd: string = runtime.cwd,
  home?: string | null,
  options: ResolveRepoContextOptions = {}
): RepoContext {
  const worktreeRoot = trim(
    runGit(runtime, cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"])
  );
  const gitCommonDir = trim(
    runGit(runtime, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  );
  const currentBranch = trim(runGit(runtime, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]));
  const sourceRoot = path.dirname(gitCommonDir);
  const isSourceCheckout = normalize(worktreeRoot) === normalize(sourceRoot);
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
): string {
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
): string {
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

function getExpectedSessionRoot(home: string, sourceRoot: string): string {
  return path.join(home, "worktrees", path.basename(sourceRoot));
}

function isOutsideExpectedRoot(relativeSessionPath: string): boolean {
  return (
    !relativeSessionPath ||
    relativeSessionPath.startsWith("..") ||
    path.isAbsolute(relativeSessionPath)
  );
}

export function resolveGitRepoRoot(runtime: Runtime, checkoutPath: string): string {
  return trim(
    runGit(runtime, checkoutPath, ["rev-parse", "--path-format=absolute", "--show-toplevel"])
  );
}

export function listWorktrees(runtime: Runtime, sourceRoot: string): WorktreeEntry[] {
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

function appendWorktreeEntry(entries: WorktreeEntry[], current: Partial<WorktreeEntry>): void {
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

export function branchExists(runtime: Runtime, sourceRoot: string, branch: string): boolean {
  const result = runtime.exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    allowFailure: true,
    cwd: sourceRoot
  });
  return result.exitCode === 0;
}

/** Resolve the default branch ref for one source repo, optionally refreshing origin first. */
export function resolveDefaultBranchRef(
  runtime: Runtime,
  sourceRoot: string,
  options: { refresh?: boolean } = {}
): DefaultBranchRef {
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

export function ensureCleanCheckout(runtime: Runtime, sourceRoot: string): void {
  const status = trim(
    runGit(runtime, sourceRoot, ["status", "--porcelain", "--untracked-files=normal"])
  );
  if (status) {
    throw new MonkeError(
      `Source checkout is dirty: ${sourceRoot}. Commit or stash the changes, or drop --no-dirty to carry them into the new Session worktree.`
    );
  }
}

/** Assert current-head spawn can branch from this source checkout if needed. */
export function assertCleanCheckoutForSessionBranchCreation(
  runtime: Runtime,
  sourceRoot: string,
  session: string
): void {
  validateSessionBranchName(runtime, sourceRoot, session);
  if (!branchExists(runtime, sourceRoot, session)) {
    ensureCleanCheckout(runtime, sourceRoot);
  }
}

/** Return the canonical Session worktree path for one repo under Monke home. */
export function getExpectedWorktreePath(home: string, sourceRoot: string, session: string): string {
  return path.join(home, "worktrees", path.basename(sourceRoot), session);
}

/** Ensure the ordinary reusable Session worktree exists under Monke home. */
export function ensureSessionWorktree(
  runtime: Runtime,
  home: string,
  sourceRoot: string,
  session: string,
  options: { skipCleanCheck?: boolean } = {}
): { path: string; created: boolean } {
  validateSessionBranchName(runtime, sourceRoot, session);

  const expectedPath = getExpectedWorktreePath(home, sourceRoot, session);
  const worktrees = listWorktreesAfterPruningSession(runtime, sourceRoot, session, expectedPath);

  const branchMatch = worktrees.find(
    (entry) => entry.branch === session && !entry.prunable && existsSync(entry.path)
  );
  const pathMatch = worktrees.find(
    (entry) =>
      normalize(entry.path) === normalize(expectedPath) && !entry.prunable && existsSync(entry.path)
  );

  if (branchMatch && normalize(branchMatch.path) !== normalize(expectedPath)) {
    throw new MonkeError(
      `Session "${session}" already exists at unexpected path ${branchMatch.path}; expected ${expectedPath}`
    );
  }

  if (pathMatch && pathMatch.branch !== session) {
    throw new MonkeError(
      `Worktree ${expectedPath} exists but is on branch ${pathMatch.branch ?? "detached"} instead of ${session}`
    );
  }

  if (branchMatch && pathMatch) {
    return { created: false, path: expectedPath };
  }

  if (existsSync(expectedPath) && !pathMatch) {
    throw new MonkeError(
      `Expected worktree path ${expectedPath} already exists and is not registered. Remove or move that directory (a previous spawn may have left it behind), then re-run mt spawn.`
    );
  }

  const sourceContext = resolveRepoContext(runtime, sourceRoot, home);
  if (sourceContext.currentBranch === session && !branchMatch) {
    throw new MonkeError(
      `Cannot spawn session "${session}" because the source checkout is already on that branch`
    );
  }

  if (!branchExists(runtime, sourceRoot, session)) {
    if (options.skipCleanCheck !== true) {
      ensureCleanCheckout(runtime, sourceRoot);
    }
    runGit(runtime, sourceRoot, ["branch", session, "HEAD"]);
  }

  mkdirSync(path.dirname(expectedPath), { recursive: true });
  runGit(runtime, sourceRoot, ["worktree", "add", expectedPath, session]);
  return { created: true, path: expectedPath };
}

/** Spawn a fresh Session worktree branch from a resolved git ref. */
export function ensureFreshSessionWorktreeFromRef(
  runtime: Runtime,
  home: string,
  sourceRoot: string,
  session: string,
  startRef: string
): { path: string; created: boolean } {
  assertFreshSessionWorktreeAvailable(runtime, home, sourceRoot, session);
  const expectedPath = getExpectedWorktreePath(home, sourceRoot, session);

  mkdirSync(path.dirname(expectedPath), { recursive: true });
  runGit(runtime, sourceRoot, ["worktree", "add", "-b", session, expectedPath, startRef]);
  return { created: true, path: expectedPath };
}

/** Best-effort removal for a fresh Session worktree and branch created by this process. */
export function removeSessionWorktreeAndBranch(
  runtime: Runtime,
  sourceRoot: string,
  worktreePath: string,
  session: string,
  onWarning: (message: string) => void
): boolean {
  let removed = true;
  const removeWorktree = runtime.exec("git", ["worktree", "remove", "--force", worktreePath], {
    allowFailure: true,
    cwd: sourceRoot
  });
  if (removeWorktree.exitCode !== 0 && existsSync(worktreePath)) {
    onWarning(
      `Failed to remove rolled-back worktree ${worktreePath}${formatCommandDetail(removeWorktree)}`
    );
    removed = false;
  }

  const removeBranch = runtime.exec("git", ["branch", "-D", session], {
    allowFailure: true,
    cwd: sourceRoot
  });
  if (removeBranch.exitCode !== 0 && branchExists(runtime, sourceRoot, session)) {
    onWarning(
      `Failed to remove rolled-back branch ${session} in ${sourceRoot}${formatCommandDetail(removeBranch)}`
    );
    removed = false;
  }

  return removed;
}

/** Assert that default branch spawn mode can spawn a fresh Session worktree. */
export function assertFreshSessionWorktreeAvailable(
  runtime: Runtime,
  home: string,
  sourceRoot: string,
  session: string
): void {
  validateSessionBranchName(runtime, sourceRoot, session);

  const expectedPath = getExpectedWorktreePath(home, sourceRoot, session);
  const worktrees = listWorktreesAfterPruningSession(runtime, sourceRoot, session, expectedPath);

  if (branchExists(runtime, sourceRoot, session)) {
    throw new MonkeError(
      `Session branch "${session}" already exists for ${sourceRoot}; default branch spawn mode requires a fresh Session branch`
    );
  }

  const branchMatch = worktrees.find(
    (entry) => entry.branch === session && !entry.prunable && existsSync(entry.path)
  );
  if (branchMatch) {
    throw new MonkeError(
      `Session "${session}" already has a worktree at ${branchMatch.path}; default branch spawn mode requires a fresh Session worktree`
    );
  }

  const pathMatch = worktrees.find(
    (entry) =>
      normalize(entry.path) === normalize(expectedPath) && !entry.prunable && existsSync(entry.path)
  );
  if (pathMatch || existsSync(expectedPath)) {
    throw new MonkeError(
      `Session worktree path collision at ${expectedPath}; default branch spawn mode requires an unused ${path.basename(sourceRoot)}/${session} path`
    );
  }
}

/** Validate that a worktree is the expected Session worktree for one repo. */
export function validateWorktreeForSession(
  runtime: Runtime,
  home: string,
  sourceRoot: string,
  worktreePath: string,
  session: string,
  options: { allowBranchMismatch?: boolean } = {}
): RepoContext {
  const expectedPath = getExpectedWorktreePath(home, sourceRoot, session);
  if (normalize(worktreePath) !== normalize(expectedPath)) {
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

  if (normalize(context.sourceRoot) !== normalize(sourceRoot)) {
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

function runGit(runtime: Runtime, cwd: string, args: string[]): string {
  return runtime.exec("git", args, { cwd }).stdout;
}

function validateSessionBranchName(runtime: Runtime, sourceRoot: string, session: string): void {
  const result = runtime.exec("git", ["check-ref-format", "--branch", session], {
    allowFailure: true,
    cwd: sourceRoot
  });
  if (result.exitCode !== 0) {
    throw new MonkeError(`Invalid session name "${session}": must be a valid git branch name`);
  }
}

function listWorktreesAfterPruningSession(
  runtime: Runtime,
  sourceRoot: string,
  session: string,
  expectedPath: string
): WorktreeEntry[] {
  let worktrees = listWorktrees(runtime, sourceRoot);

  const shouldPruneCachedEntries = worktrees.some(
    (entry) =>
      (entry.branch === session || normalize(entry.path) === normalize(expectedPath)) &&
      (entry.prunable || !existsSync(entry.path))
  );
  if (shouldPruneCachedEntries) {
    runGit(runtime, sourceRoot, ["worktree", "prune"]);
    worktrees = listWorktrees(runtime, sourceRoot);
  }

  return worktrees;
}

function refExists(runtime: Runtime, sourceRoot: string, ref: string): boolean {
  const result = runtime.exec("git", ["show-ref", "--verify", "--quiet", ref], {
    allowFailure: true,
    cwd: sourceRoot
  });
  return result.exitCode === 0;
}

function formatCommandDetail(result: { stdout: string; stderr: string }): string {
  const detail = (result.stderr || result.stdout).trim();
  return detail ? `: ${detail}` : "";
}

function normalize(targetPath: string): string {
  return path.normalize(targetPath);
}

function toSessionPath(targetPath: string): string {
  return targetPath.split(path.sep).join("/");
}

function trim(value: string): string {
  return value.trim();
}
