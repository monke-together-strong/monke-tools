import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { MonkeError } from "./errors.ts";
import type { RepoContext, Runtime } from "./types.ts";

export interface WorktreeEntry {
  path: string;
  branch: string | null;
}

export function resolveRepoContext(runtime: Runtime, cwd: string = runtime.cwd): RepoContext {
  const worktreeRoot = trim(
    runGit(runtime, cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"]),
  );
  const gitCommonDir = trim(
    runGit(runtime, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );
  const currentBranch = trim(runGit(runtime, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]));
  const sourceRoot = path.dirname(gitCommonDir);
  const isSourceCheckout = normalize(worktreeRoot) === normalize(sourceRoot);
  const sessionName = isSourceCheckout
    ? null
    : inferSessionName(sourceRoot, worktreeRoot, currentBranch);

  return {
    cwd,
    worktreeRoot,
    sourceRoot,
    gitCommonDir,
    currentBranch,
    isSourceCheckout,
    sessionName,
  };
}

export function inferSessionName(sourceRoot: string, worktreeRoot: string, branch: string): string {
  const expectedRoot = path.join(
    path.dirname(sourceRoot),
    ".monke-worktrees",
    path.basename(sourceRoot),
  );
  const relativeSessionPath = path.relative(expectedRoot, worktreeRoot);
  const sessionName = toSessionPath(relativeSessionPath);

  if (
    !relativeSessionPath ||
    relativeSessionPath.startsWith("..") ||
    path.isAbsolute(relativeSessionPath)
  ) {
    throw new MonkeError(`Expected linked worktree ${worktreeRoot} to live under ${expectedRoot}`);
  }

  if (sessionName !== branch) {
    throw new MonkeError(
      `Expected linked worktree session "${sessionName}" to match current branch "${branch}"`,
    );
  }
  return sessionName;
}

export function resolveGitRepoRoot(runtime: Runtime, checkoutPath: string): string {
  return trim(
    runGit(runtime, checkoutPath, ["rev-parse", "--path-format=absolute", "--show-toplevel"]),
  );
}

export function listWorktrees(runtime: Runtime, sourceRoot: string): WorktreeEntry[] {
  const output = runGit(runtime, sourceRoot, ["worktree", "list", "--porcelain"]);
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};

  for (const line of output.split("\n")) {
    if (!line.trim()) {
      if (current.path) {
        entries.push({
          path: current.path,
          branch: current.branch ?? null,
        });
      }
      current = {};
      continue;
    }

    if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length);
      continue;
    }

    if (line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }

  if (current.path) {
    entries.push({
      path: current.path,
      branch: current.branch ?? null,
    });
  }

  return entries;
}

export function branchExists(runtime: Runtime, sourceRoot: string, branch: string): boolean {
  const result = runtime.exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: sourceRoot,
    allowFailure: true,
  });
  return result.exitCode === 0;
}

export function ensureCleanCheckout(runtime: Runtime, sourceRoot: string): void {
  const status = trim(
    runGit(runtime, sourceRoot, ["status", "--porcelain", "--untracked-files=normal"]),
  );
  if (status) {
    throw new MonkeError(`Source checkout is dirty: ${sourceRoot}`);
  }
}

export function getExpectedWorktreePath(sourceRoot: string, session: string): string {
  return path.join(
    path.dirname(sourceRoot),
    ".monke-worktrees",
    path.basename(sourceRoot),
    session,
  );
}

export function ensureSessionWorktree(
  runtime: Runtime,
  sourceRoot: string,
  session: string,
): { path: string; created: boolean } {
  const expectedPath = getExpectedWorktreePath(sourceRoot, session);
  const worktrees = listWorktrees(runtime, sourceRoot);

  const branchMatch = worktrees.find((entry) => entry.branch === session);
  const pathMatch = worktrees.find((entry) => normalize(entry.path) === normalize(expectedPath));

  if (branchMatch && normalize(branchMatch.path) !== normalize(expectedPath)) {
    throw new MonkeError(
      `Session "${session}" already exists at unexpected path ${branchMatch.path}; expected ${expectedPath}`,
    );
  }

  if (pathMatch && pathMatch.branch !== session) {
    throw new MonkeError(
      `Worktree ${expectedPath} exists but is on branch ${pathMatch.branch ?? "detached"} instead of ${session}`,
    );
  }

  if (branchMatch && pathMatch) {
    return { path: expectedPath, created: false };
  }

  if (existsSync(expectedPath) && !pathMatch) {
    throw new MonkeError(
      `Expected worktree path ${expectedPath} already exists and is not registered`,
    );
  }

  const sourceContext = resolveRepoContext(runtime, sourceRoot);
  if (sourceContext.currentBranch === session && !branchMatch) {
    throw new MonkeError(
      `Cannot create session "${session}" because the source checkout is already on that branch`,
    );
  }

  if (!branchExists(runtime, sourceRoot, session)) {
    ensureCleanCheckout(runtime, sourceRoot);
    runGit(runtime, sourceRoot, ["branch", session, "HEAD"]);
  }

  mkdirSync(path.dirname(expectedPath), { recursive: true });
  runGit(runtime, sourceRoot, ["worktree", "add", expectedPath, session]);
  return { path: expectedPath, created: true };
}

export function validateWorktreeForSession(
  runtime: Runtime,
  sourceRoot: string,
  worktreePath: string,
  session: string,
): void {
  const expectedPath = getExpectedWorktreePath(sourceRoot, session);
  if (normalize(worktreePath) !== normalize(expectedPath)) {
    throw new MonkeError(
      `Expected session "${session}" worktree at ${expectedPath}, found ${worktreePath}`,
    );
  }

  if (!existsSync(worktreePath)) {
    throw new MonkeError(`Expected worktree to exist at ${worktreePath}`);
  }

  const context = resolveRepoContext(runtime, worktreePath);
  if (context.isSourceCheckout) {
    throw new MonkeError(`Expected ${worktreePath} to be a linked session worktree`);
  }

  if (normalize(context.sourceRoot) !== normalize(sourceRoot)) {
    throw new MonkeError(
      `Expected worktree ${worktreePath} to belong to ${sourceRoot}, found ${context.sourceRoot}`,
    );
  }

  if (context.currentBranch !== session) {
    throw new MonkeError(
      `Expected worktree ${worktreePath} to be on branch ${session}, found ${context.currentBranch}`,
    );
  }
}

function runGit(runtime: Runtime, cwd: string, args: string[]): string {
  return runtime.exec("git", args, { cwd }).stdout;
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
