import { existsSync, realpathSync } from "node:fs";

import { resolveDefaultBranchRef } from "./git.ts";
import type { Runtime } from "./types.ts";

/** GitHub metadata used to prove that one Session branch was merged. */
export interface MergedPrMatch {
  /** Pull request number. */
  number: number;
  /** Pull request head branch name. */
  headRefName: string;
  /** Pull request base branch name. */
  baseRefName: string;
  /** Commit OID of the pull request head at merge time. */
  headRefOid: string | null;
  /** Pull request merged timestamp. */
  mergedAt?: string;
  /** Pull request URL. */
  url?: string;
  /** Whether GitHub reports that the PR head came from another repository. */
  isCrossRepository?: boolean;
  /** GitHub head repository metadata. */
  headRepository?: {
    /** Repository name without owner. */
    name?: string;
    /** Repository name including owner, when returned by GitHub. */
    nameWithOwner?: string;
  } | null;
  /** GitHub head repository owner metadata. */
  headRepositoryOwner?: {
    /** Repository owner login. */
    login?: string;
  } | null;
}

/** Inputs that identify one recorded Session worktree cleanup candidate. */
export interface MergedCleanupCandidate {
  /** Source checkout root for the recorded Session repo. */
  sourceRoot: string;
  /** Session branch name recorded in Session state. */
  session: string;
  /** Recorded Session worktree path. */
  worktreePath: string;
}

/** Local and GitHub evidence collected for one merge-cleanable worktree decision. */
export interface MergedCleanupSnapshot {
  /** Session branch name recorded in Session state. */
  session: string;
  /** Default branch name used as the required PR base. */
  defaultBranch: string;
  /** Source checkout root for the recorded Session repo. */
  sourceRoot: string;
  /** GitHub owner/repository name for the source checkout. */
  repositoryFullName: string | null;
  /** Recorded Session worktree path. */
  worktreePath: string;
  /** Whether the recorded worktree path exists on disk. */
  worktreeExists: boolean;
  /** Whether the path is itself the root of a Git worktree. */
  worktreeIsGitRoot: boolean;
  /** Whether the path points at the source checkout rather than a Session worktree. */
  isSourceCheckout: boolean;
  /** Whether the worktree belongs to the expected source repository. */
  sameGitRepository: boolean;
  /** Branch currently checked out in the worktree, or null for detached HEAD. */
  branch: string | null;
  /** Local HEAD OID for the worktree. */
  localHead: string | null;
  /** Normal Git status lines, including untracked files and excluding ignored files. */
  statusLines: string[];
  /** Failure reason when normal Git status could not prove the worktree clean. */
  statusError: string | null;
  /** Matching merged PR metadata returned by GitHub. */
  matchingMergedPrs: MergedPrMatch[];
  /** Safe failure reason from default branch resolution or GitHub lookup. */
  lookupError: string | null;
}

/** Decision for one recorded Session worktree. */
export interface MergedCleanupDecision {
  /** Whether the worktree satisfies the full merge-cleanable predicate. */
  eligible: boolean;
  /** Reasons that blocked cleanup when the worktree was not eligible. */
  reasons: string[];
  /** Positive evidence collected for eligible or partially validated candidates. */
  evidence: string[];
}

/** Inspect one recorded Session worktree and decide whether merged cleanup may remove it. */
export function inspectMergedWorktreeCleanup(
  runtime: Runtime,
  candidate: MergedCleanupCandidate,
  options: { refreshDefaultBranch?: boolean } = {},
): MergedCleanupDecision {
  const defaultBranch = getDefaultBranch(runtime, candidate.sourceRoot, {
    refresh: options.refreshDefaultBranch ?? true,
  });
  if (!defaultBranch.ok) {
    return {
      eligible: false,
      reasons: [defaultBranch.error],
      evidence: [],
    };
  }

  const repository = getGithubRepositoryFullName(runtime, candidate.sourceRoot);
  const matchingMergedPrs = repository.ok
    ? queryMergedPrs(runtime, {
        sourceRoot: candidate.sourceRoot,
        repositoryFullName: repository.value,
        session: candidate.session,
        defaultBranch: defaultBranch.value,
      })
    : { ok: false as const, error: repository.error };

  const snapshot = buildMergedCleanupSnapshot(runtime, {
    ...candidate,
    defaultBranch: defaultBranch.value,
    repositoryFullName: repository.ok ? repository.value : null,
    matchingMergedPrs: matchingMergedPrs.ok ? matchingMergedPrs.value : [],
    lookupError: matchingMergedPrs.ok ? null : matchingMergedPrs.error,
  });

  return decideMergedWorktreeCleanup(snapshot);
}

/** Decide whether a collected worktree snapshot satisfies the merge-cleanable predicate. */
export function decideMergedWorktreeCleanup(
  snapshot: MergedCleanupSnapshot,
): MergedCleanupDecision {
  const reasons: string[] = [];
  const evidence: string[] = [];

  if (!snapshot.worktreeExists) {
    reasons.push("session worktree path is missing");
  } else if (!snapshot.worktreeIsGitRoot) {
    reasons.push("session worktree path is not a Git worktree root");
  } else if (snapshot.isSourceCheckout) {
    reasons.push("session worktree path points at the source checkout");
  } else if (!snapshot.sameGitRepository) {
    reasons.push("session worktree path belongs to a different Git repository");
  } else {
    evidence.push("worktree belongs to the expected repository");
  }

  const hasValidWorktreeIdentity =
    snapshot.worktreeExists &&
    snapshot.worktreeIsGitRoot &&
    !snapshot.isSourceCheckout &&
    snapshot.sameGitRepository;
  let branchMatchesSession = false;

  if (!hasValidWorktreeIdentity) {
    return {
      eligible: false,
      reasons,
      evidence,
    };
  }

  if (!snapshot.branch) {
    reasons.push("worktree is detached");
  } else if (snapshot.branch !== snapshot.session) {
    reasons.push(`worktree branch ${snapshot.branch} does not match session ${snapshot.session}`);
  } else {
    branchMatchesSession = true;
    evidence.push(`branch matches session: ${snapshot.branch}`);
  }

  if (!branchMatchesSession) {
    return {
      eligible: false,
      reasons,
      evidence,
    };
  }

  if (snapshot.lookupError) {
    reasons.push(snapshot.lookupError);
  } else {
    const exactMatches = snapshot.matchingMergedPrs.filter(
      (pr) => pr.headRefName === snapshot.session && pr.baseRefName === snapshot.defaultBranch,
    );
    const crossRepositoryMatches = exactMatches.filter(
      (pr) => !isSameRepositoryPr(pr, snapshot.repositoryFullName),
    );
    const sameRepositoryMatches = exactMatches.filter((pr) =>
      isSameRepositoryPr(pr, snapshot.repositoryFullName),
    );

    if (crossRepositoryMatches.length > 0) {
      reasons.push("merged PR head repository does not match source repository");
    } else if (sameRepositoryMatches.length === 0) {
      reasons.push("no exact merged PR match for session branch and default branch");
    } else if (sameRepositoryMatches.length > 1) {
      reasons.push(
        `${sameRepositoryMatches.length} merged PR matches; branch history is ambiguous`,
      );
    } else {
      const match = sameRepositoryMatches[0]!;
      evidence.push(
        `exact merged PR: #${match.number} ${match.headRefName} -> ${match.baseRefName}`,
      );

      if (!match.headRefOid) {
        reasons.push("merged PR match did not include headRefOid");
      } else if (!snapshot.localHead) {
        reasons.push("unable to read local worktree HEAD");
      } else if (snapshot.localHead !== match.headRefOid) {
        reasons.push(
          `local HEAD ${shortSha(snapshot.localHead)} differs from merged PR head ${shortSha(
            match.headRefOid,
          )}`,
        );
      } else {
        evidence.push(`local HEAD matches merged PR head: ${shortSha(snapshot.localHead)}`);
      }
    }
  }

  if (snapshot.statusError) {
    reasons.push(snapshot.statusError);
  } else if (snapshot.statusLines.length > 0) {
    reasons.push(`worktree has ${snapshot.statusLines.length} dirty/untracked status line(s)`);
  } else {
    evidence.push("worktree is clean according to normal Git status");
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    evidence,
  };
}

/** Remove one worktree after its merge-cleanable decision has already passed. */
export function removeMergeCleanableWorktree(
  runtime: Runtime,
  candidate: MergedCleanupCandidate,
): void {
  // Plain remove deletes ignored artifacts while still refusing dirty/untracked race additions.
  runtime.exec("git", ["worktree", "remove", candidate.worktreePath], {
    cwd: candidate.sourceRoot,
  });
}

function buildMergedCleanupSnapshot(
  runtime: Runtime,
  options: MergedCleanupCandidate & {
    defaultBranch: string;
    repositoryFullName: string | null;
    matchingMergedPrs: MergedPrMatch[];
    lookupError: string | null;
  },
): MergedCleanupSnapshot {
  const worktreeExists = existsSync(options.worktreePath);
  const expectedCommonDir = tryGit(runtime, options.sourceRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const actualCommonDir = worktreeExists
    ? tryGit(runtime, options.worktreePath, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])
    : null;
  const actualTopLevel = worktreeExists
    ? tryGit(runtime, options.worktreePath, [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
      ])
    : null;
  const worktreeIsGitRoot =
    actualCommonDir?.ok === true &&
    actualTopLevel?.ok === true &&
    realpathOrNull(actualTopLevel.value) === realpathOrNull(options.worktreePath);
  const isSourceCheckout =
    worktreeIsGitRoot &&
    realpathOrNull(options.worktreePath) === realpathOrNull(options.sourceRoot);
  const sameGitRepository =
    worktreeIsGitRoot &&
    actualCommonDir?.ok === true &&
    expectedCommonDir.ok &&
    realpathOrNull(actualCommonDir.value) === realpathOrNull(expectedCommonDir.value);
  const branchResult = worktreeIsGitRoot
    ? tryGit(runtime, options.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])
    : null;
  const branch =
    branchResult?.ok === true && branchResult.value !== "HEAD" ? branchResult.value : null;
  const localHeadResult = worktreeIsGitRoot
    ? tryGit(runtime, options.worktreePath, ["rev-parse", "HEAD"])
    : null;
  const statusResult = worktreeIsGitRoot
    ? tryGit(runtime, options.worktreePath, ["status", "--porcelain", "--untracked-files=normal"])
    : null;

  return {
    session: options.session,
    defaultBranch: options.defaultBranch,
    sourceRoot: options.sourceRoot,
    repositoryFullName: options.repositoryFullName,
    worktreePath: options.worktreePath,
    worktreeExists,
    worktreeIsGitRoot,
    isSourceCheckout,
    sameGitRepository,
    branch,
    localHead: localHeadResult?.ok === true ? localHeadResult.value : null,
    statusLines: statusResult?.ok === true ? splitLines(statusResult.value) : [],
    statusError:
      statusResult?.ok === false ? `unable to read normal Git status: ${statusResult.error}` : null,
    matchingMergedPrs: options.matchingMergedPrs,
    lookupError: options.lookupError,
  };
}

function getDefaultBranch(
  runtime: Runtime,
  sourceRoot: string,
  options: { refresh: boolean },
): { ok: true; value: string } | { ok: false; error: string } {
  try {
    return {
      ok: true,
      value: resolveDefaultBranchRef(runtime, sourceRoot, { refresh: options.refresh }).branch,
    };
  } catch (error) {
    return {
      ok: false,
      error: `unable to resolve default branch: ${errorMessage(error)}`,
    };
  }
}

function getGithubRepositoryFullName(
  runtime: Runtime,
  sourceRoot: string,
): { ok: true; value: string } | { ok: false; error: string } {
  try {
    const result = runtime.exec("gh", ["repo", "view", "--json", "nameWithOwner"], {
      cwd: sourceRoot,
      allowFailure: true,
    });
    if (result.exitCode !== 0) {
      return { ok: false, error: `GitHub repository lookup failed: ${commandDetail(result)}` };
    }

    const parsed = JSON.parse(result.stdout) as { nameWithOwner?: unknown };
    if (typeof parsed.nameWithOwner !== "string" || parsed.nameWithOwner.length === 0) {
      return { ok: false, error: "GitHub repository lookup did not return nameWithOwner" };
    }

    return { ok: true, value: parsed.nameWithOwner };
  } catch (error) {
    return { ok: false, error: `GitHub repository lookup failed: ${errorMessage(error)}` };
  }
}

function queryMergedPrs(
  runtime: Runtime,
  options: {
    sourceRoot: string;
    repositoryFullName: string;
    session: string;
    defaultBranch: string;
  },
): { ok: true; value: MergedPrMatch[] } | { ok: false; error: string } {
  try {
    const result = runtime.exec(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        options.repositoryFullName,
        "--state",
        "merged",
        "--head",
        options.session,
        "--base",
        options.defaultBranch,
        "--limit",
        "100",
        "--json",
        "number,headRefName,baseRefName,headRefOid,mergedAt,url,isCrossRepository,headRepository,headRepositoryOwner",
      ],
      { cwd: options.sourceRoot, allowFailure: true },
    );
    if (result.exitCode !== 0) {
      return { ok: false, error: `GitHub merged PR lookup failed: ${commandDetail(result)}` };
    }

    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) {
      return { ok: false, error: "GitHub merged PR lookup did not return a list" };
    }

    return { ok: true, value: parsed.map(normalizeMergedPrMatch) };
  } catch (error) {
    return { ok: false, error: `GitHub merged PR lookup failed: ${errorMessage(error)}` };
  }
}

function normalizeMergedPrMatch(value: unknown): MergedPrMatch {
  const record = isRecord(value) ? value : {};
  return {
    number: typeof record.number === "number" ? record.number : 0,
    headRefName: typeof record.headRefName === "string" ? record.headRefName : "",
    baseRefName: typeof record.baseRefName === "string" ? record.baseRefName : "",
    headRefOid:
      typeof record.headRefOid === "string" || record.headRefOid === null
        ? record.headRefOid
        : null,
    mergedAt: typeof record.mergedAt === "string" ? record.mergedAt : undefined,
    url: typeof record.url === "string" ? record.url : undefined,
    isCrossRepository:
      typeof record.isCrossRepository === "boolean" ? record.isCrossRepository : undefined,
    headRepository: isRecord(record.headRepository)
      ? {
          name:
            typeof record.headRepository.name === "string" ? record.headRepository.name : undefined,
          nameWithOwner:
            typeof record.headRepository.nameWithOwner === "string"
              ? record.headRepository.nameWithOwner
              : undefined,
        }
      : null,
    headRepositoryOwner: isRecord(record.headRepositoryOwner)
      ? {
          login:
            typeof record.headRepositoryOwner.login === "string"
              ? record.headRepositoryOwner.login
              : undefined,
        }
      : null,
  };
}

function isSameRepositoryPr(match: MergedPrMatch, repositoryFullName: string | null): boolean {
  if (!repositoryFullName) {
    return false;
  }

  if (match.isCrossRepository === true) {
    return false;
  }

  if (match.headRepository?.nameWithOwner) {
    return match.headRepository.nameWithOwner === repositoryFullName;
  }

  if (match.headRepositoryOwner?.login && match.headRepository?.name) {
    return `${match.headRepositoryOwner.login}/${match.headRepository.name}` === repositoryFullName;
  }

  return match.isCrossRepository === false;
}

function tryGit(
  runtime: Runtime,
  cwd: string,
  args: string[],
): { ok: true; value: string } | { ok: false; error: string } {
  try {
    const result = runtime.exec("git", args, { cwd, allowFailure: true });
    if (result.exitCode !== 0) {
      return { ok: false, error: commandDetail(result) };
    }
    return { ok: true, value: result.stdout.trim() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function realpathOrNull(targetPath: string): string | null {
  try {
    return realpathSync(targetPath);
  } catch {
    return null;
  }
}

function commandDetail(result: { stdout: string; stderr: string; exitCode: number }): string {
  return result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
