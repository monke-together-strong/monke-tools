import { existsSync, realpathSync } from "node:fs";

import * as z from "zod";

import { errorMessage } from "./errors.ts";
import { resolveDefaultBranchRef } from "./git.ts";
import type { Runtime } from "./types.ts";

const GithubRepositoryLookupSchema = z.object({
  nameWithOwner: z.string().min(1)
});
const MergedPrInputSchema = z.object({
  baseRefName: z.string().optional(),
  headRefName: z.string().optional(),
  headRefOid: z.union([z.string(), z.null()]).optional(),
  headRepository: z
    .object({
      name: z.string().optional(),
      nameWithOwner: z.string().optional()
    })
    .nullable()
    .optional(),
  headRepositoryOwner: z.object({ login: z.string().optional() }).nullable().optional(),
  isCrossRepository: z.boolean().optional(),
  mergedAt: z.string().optional(),
  number: z.number().optional(),
  url: z.string().optional()
});

/** GitHub metadata used to prove that one Session branch was merged. */
export interface MergedPrMatch {
  /** Pull request base branch name. */
  baseRefName: string;
  /** Pull request head branch name. */
  headRefName: string;
  /** Commit OID of the pull request head at merge time. */
  headRefOid: string | null;
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
  /** Whether GitHub reports that the PR head came from another repository. */
  isCrossRepository?: boolean;
  /** Pull request merged timestamp. */
  mergedAt?: string;
  /** Pull request number. */
  number: number;
  /** Pull request URL. */
  url?: string;
}

/** Inputs that identify one recorded Session worktree cleanup candidate. */
export interface MergedCleanupCandidate {
  /** Session branch name recorded in Session state. */
  session: string;
  /** Source checkout root for the recorded Session repo. */
  sourceRoot: string;
  /** Recorded Session worktree path. */
  worktreePath: string;
}

/** Local and GitHub evidence collected for one merge-cleanable worktree decision. */
export interface MergedCleanupSnapshot {
  /** Branch currently checked out in the worktree, or null for detached HEAD. */
  branch: string | null;
  /** Default branch name used as the required PR base. */
  defaultBranch: string;
  /** Whether the path points at the source checkout rather than a Session worktree. */
  isSourceCheckout: boolean;
  /** Local HEAD OID for the worktree. */
  localHead: string | null;
  /** Safe failure reason from default branch resolution or GitHub lookup. */
  lookupError: string | null;
  /** Matching merged PR metadata returned by GitHub. */
  matchingMergedPrs: MergedPrMatch[];
  /** GitHub owner/repository name for the source checkout. */
  repositoryFullName: string | null;
  /** Whether the worktree belongs to the expected source repository. */
  sameGitRepository: boolean;
  /** Session branch name recorded in Session state. */
  session: string;
  /** Source checkout root for the recorded Session repo. */
  sourceRoot: string;
  /** Failure reason when normal Git status could not prove the worktree clean. */
  statusError: string | null;
  /** Normal Git status lines, including untracked files and excluding ignored files. */
  statusLines: string[];
  /** Whether the recorded worktree path exists on disk. */
  worktreeExists: boolean;
  /** Whether the path is itself the root of a Git worktree. */
  worktreeIsGitRoot: boolean;
  /** Recorded Session worktree path. */
  worktreePath: string;
}

/** Decision for one recorded Session worktree. */
export interface MergedCleanupDecision {
  /** Whether the worktree satisfies the full merge-cleanable predicate. */
  eligible: boolean;
  /** Positive evidence collected for eligible or partially validated candidates. */
  evidence: string[];
  /** Reasons that blocked cleanup when the worktree was not eligible. */
  reasons: string[];
}

type LookupResult = { ok: true; value: string } | { error: string; ok: false };

/** Per-run cache for repo-scoped merged-cleanup lookups. */
export interface MergedCleanupLookupCache {
  defaultBranchBySourceRoot: Map<string, LookupResult>;
  repositoryBySourceRoot: Map<string, LookupResult>;
}

export function createMergedCleanupLookupCache(): MergedCleanupLookupCache {
  return {
    defaultBranchBySourceRoot: new Map(),
    repositoryBySourceRoot: new Map()
  };
}

/** Inspect one recorded Session worktree and decide whether merged cleanup may remove it. */
export function inspectMergedWorktreeCleanup(
  runtime: Runtime,
  candidate: MergedCleanupCandidate,
  options: { cache?: MergedCleanupLookupCache; refreshDefaultBranch?: boolean } = {}
): MergedCleanupDecision {
  let defaultBranch = options.cache?.defaultBranchBySourceRoot.get(candidate.sourceRoot);
  if (!defaultBranch) {
    defaultBranch = getDefaultBranch(runtime, candidate.sourceRoot, {
      refresh: options.refreshDefaultBranch ?? true
    });
    options.cache?.defaultBranchBySourceRoot.set(candidate.sourceRoot, defaultBranch);
  }
  if (!defaultBranch.ok) {
    return {
      eligible: false,
      evidence: [],
      reasons: [defaultBranch.error]
    };
  }

  let repository = options.cache?.repositoryBySourceRoot.get(candidate.sourceRoot);
  if (!repository) {
    repository = getGithubRepositoryFullName(runtime, candidate.sourceRoot);
    options.cache?.repositoryBySourceRoot.set(candidate.sourceRoot, repository);
  }
  const matchingMergedPrs = repository.ok
    ? queryMergedPrs(runtime, {
        defaultBranch: defaultBranch.value,
        repositoryFullName: repository.value,
        session: candidate.session,
        sourceRoot: candidate.sourceRoot
      })
    : { error: repository.error, ok: false as const };

  const snapshot = buildMergedCleanupSnapshot(runtime, {
    ...candidate,
    defaultBranch: defaultBranch.value,
    lookupError: matchingMergedPrs.ok ? null : matchingMergedPrs.error,
    matchingMergedPrs: matchingMergedPrs.ok ? matchingMergedPrs.value : [],
    repositoryFullName: repository.ok ? repository.value : null
  });

  return decideMergedWorktreeCleanup(snapshot);
}

/** Decide whether a collected worktree snapshot satisfies the merge-cleanable predicate. */
export function decideMergedWorktreeCleanup(
  snapshot: MergedCleanupSnapshot
): MergedCleanupDecision {
  const reasons: string[] = [];
  const evidence: string[] = [];

  if (!validateWorktreeIdentity(snapshot, reasons, evidence)) {
    return { eligible: false, evidence, reasons };
  }
  if (!validateSessionBranch(snapshot, reasons, evidence)) {
    return { eligible: false, evidence, reasons };
  }
  validateMergedPr(snapshot, reasons, evidence);
  validateCleanWorktree(snapshot, reasons, evidence);

  return {
    eligible: reasons.length === 0,
    evidence,
    reasons
  };
}

function validateWorktreeIdentity(
  snapshot: MergedCleanupSnapshot,
  reasons: string[],
  evidence: string[]
): boolean {
  if (!snapshot.worktreeExists) {
    reasons.push("session worktree path is missing");
  } else if (!snapshot.worktreeIsGitRoot) {
    reasons.push("session worktree path is not a Git worktree root");
  } else if (snapshot.isSourceCheckout) {
    reasons.push("session worktree path points at the source checkout");
  } else if (snapshot.sameGitRepository) {
    evidence.push("worktree belongs to the expected repository");
  } else {
    reasons.push("session worktree path belongs to a different Git repository");
  }
  return (
    snapshot.worktreeExists &&
    snapshot.worktreeIsGitRoot &&
    !snapshot.isSourceCheckout &&
    snapshot.sameGitRepository
  );
}

function validateSessionBranch(
  snapshot: MergedCleanupSnapshot,
  reasons: string[],
  evidence: string[]
): boolean {
  if (!snapshot.branch) {
    reasons.push("worktree is detached");
  } else if (snapshot.branch === snapshot.session) {
    evidence.push(`branch matches session: ${snapshot.branch}`);
    return true;
  } else {
    reasons.push(`worktree branch ${snapshot.branch} does not match session ${snapshot.session}`);
  }
  return false;
}

function validateMergedPr(
  snapshot: MergedCleanupSnapshot,
  reasons: string[],
  evidence: string[]
): void {
  if (snapshot.lookupError) {
    reasons.push(snapshot.lookupError);
    return;
  }

  const exactMatches = snapshot.matchingMergedPrs.filter(
    (pr) => pr.headRefName === snapshot.session && pr.baseRefName === snapshot.defaultBranch
  );
  const crossRepositoryMatches = exactMatches.filter(
    (pr) => !isSameRepositoryPr(pr, snapshot.repositoryFullName)
  );
  const sameRepositoryMatches = exactMatches.filter((pr) =>
    isSameRepositoryPr(pr, snapshot.repositoryFullName)
  );

  if (crossRepositoryMatches.length > 0) {
    reasons.push("merged PR head repository does not match source repository");
  } else if (sameRepositoryMatches.length === 0) {
    reasons.push("no exact merged PR match for session branch and default branch");
  } else if (sameRepositoryMatches.length > 1) {
    reasons.push(`${sameRepositoryMatches.length} merged PR matches; branch history is ambiguous`);
  } else {
    const [match] = sameRepositoryMatches;
    if (match === undefined) {
      throw new Error("Expected one same-repository merged PR match");
    }
    evidence.push(`exact merged PR: #${match.number} ${match.headRefName} -> ${match.baseRefName}`);
    validateMergedPrHead(snapshot.localHead, match, reasons, evidence);
  }
}

function validateMergedPrHead(
  localHead: string | null,
  match: MergedPrMatch,
  reasons: string[],
  evidence: string[]
): void {
  if (!match.headRefOid) {
    reasons.push("merged PR match did not include headRefOid");
  } else if (!localHead) {
    reasons.push("unable to read local worktree HEAD");
  } else if (localHead === match.headRefOid) {
    evidence.push(`local HEAD matches merged PR head: ${shortSha(localHead)}`);
  } else {
    reasons.push(
      `local HEAD ${shortSha(localHead)} differs from merged PR head ${shortSha(match.headRefOid)}`
    );
  }
}

function validateCleanWorktree(
  snapshot: MergedCleanupSnapshot,
  reasons: string[],
  evidence: string[]
): void {
  if (snapshot.statusError) {
    reasons.push(snapshot.statusError);
  } else if (snapshot.statusLines.length > 0) {
    reasons.push(`worktree has ${snapshot.statusLines.length} dirty/untracked status line(s)`);
  } else {
    evidence.push("worktree is clean according to normal Git status");
  }
}

/** Remove one worktree after its merge-cleanable decision has already passed. */
export function removeMergeCleanableWorktree(
  runtime: Runtime,
  candidate: MergedCleanupCandidate
): void {
  // Plain remove deletes ignored artifacts while still refusing dirty/untracked race additions.
  runtime.exec("git", ["worktree", "remove", candidate.worktreePath], {
    cwd: candidate.sourceRoot
  });
}

function buildMergedCleanupSnapshot(
  runtime: Runtime,
  options: MergedCleanupCandidate & {
    defaultBranch: string;
    lookupError: string | null;
    matchingMergedPrs: MergedPrMatch[];
    repositoryFullName: string | null;
  }
): MergedCleanupSnapshot {
  const worktree = inspectWorktree(runtime, options);

  return {
    ...worktree,
    defaultBranch: options.defaultBranch,
    lookupError: options.lookupError,
    matchingMergedPrs: options.matchingMergedPrs,
    repositoryFullName: options.repositoryFullName,
    session: options.session,
    sourceRoot: options.sourceRoot,
    worktreePath: options.worktreePath
  };
}

function inspectWorktree(
  runtime: Runtime,
  options: MergedCleanupCandidate
): Pick<
  MergedCleanupSnapshot,
  | "branch"
  | "isSourceCheckout"
  | "localHead"
  | "sameGitRepository"
  | "statusError"
  | "statusLines"
  | "worktreeExists"
  | "worktreeIsGitRoot"
> {
  const identity = inspectWorktreeIdentity(runtime, options);
  return {
    ...identity,
    ...inspectWorktreeState(runtime, options.worktreePath, identity.worktreeIsGitRoot)
  };
}

function inspectWorktreeIdentity(
  runtime: Runtime,
  options: MergedCleanupCandidate
): Pick<
  MergedCleanupSnapshot,
  "isSourceCheckout" | "sameGitRepository" | "worktreeExists" | "worktreeIsGitRoot"
> {
  const worktreeExists = existsSync(options.worktreePath);
  const expectedCommonDir = tryGit(runtime, options.sourceRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir"
  ]);
  const actualCommonDir = worktreeExists
    ? tryGit(runtime, options.worktreePath, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir"
      ])
    : null;
  const actualTopLevel = worktreeExists
    ? tryGit(runtime, options.worktreePath, [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel"
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
    actualCommonDir?.ok &&
    expectedCommonDir.ok &&
    realpathOrNull(actualCommonDir.value) === realpathOrNull(expectedCommonDir.value);

  return {
    isSourceCheckout,
    sameGitRepository,
    worktreeExists,
    worktreeIsGitRoot
  };
}

function inspectWorktreeState(
  runtime: Runtime,
  worktreePath: string,
  worktreeIsGitRoot: boolean
): Pick<MergedCleanupSnapshot, "branch" | "localHead" | "statusError" | "statusLines"> {
  const branchResult = worktreeIsGitRoot
    ? tryGit(runtime, worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])
    : null;
  const branch =
    branchResult?.ok === true && branchResult.value !== "HEAD" ? branchResult.value : null;
  const localHeadResult = worktreeIsGitRoot
    ? tryGit(runtime, worktreePath, ["rev-parse", "HEAD"])
    : null;
  const statusResult = worktreeIsGitRoot
    ? tryGit(runtime, worktreePath, ["status", "--porcelain", "--untracked-files=normal"])
    : null;

  return {
    branch,
    localHead: localHeadResult?.ok === true ? localHeadResult.value : null,
    statusError:
      statusResult?.ok === false ? `unable to read normal Git status: ${statusResult.error}` : null,
    statusLines: statusResult?.ok === true ? splitLines(statusResult.value) : []
  };
}

function getDefaultBranch(
  runtime: Runtime,
  sourceRoot: string,
  options: { refresh: boolean }
): { ok: true; value: string } | { error: string; ok: false } {
  try {
    return {
      ok: true,
      value: resolveDefaultBranchRef(runtime, sourceRoot, { refresh: options.refresh }).branch
    };
  } catch (error) {
    return {
      error: `unable to resolve default branch: ${errorMessage(error)}`,
      ok: false
    };
  }
}

function getGithubRepositoryFullName(
  runtime: Runtime,
  sourceRoot: string
): { ok: true; value: string } | { error: string; ok: false } {
  try {
    const result = runtime.exec("gh", ["repo", "view", "--json", "nameWithOwner"], {
      allowFailure: true,
      cwd: sourceRoot
    });
    if (result.exitCode !== 0) {
      return { error: `GitHub repository lookup failed: ${commandDetail(result)}`, ok: false };
    }

    const parsed = GithubRepositoryLookupSchema.safeParse(JSON.parse(result.stdout) as unknown);
    if (!parsed.success) {
      return { error: "GitHub repository lookup did not return nameWithOwner", ok: false };
    }

    return { ok: true, value: parsed.data.nameWithOwner };
  } catch (error) {
    return { error: `GitHub repository lookup failed: ${errorMessage(error)}`, ok: false };
  }
}

function queryMergedPrs(
  runtime: Runtime,
  options: {
    defaultBranch: string;
    repositoryFullName: string;
    session: string;
    sourceRoot: string;
  }
): { ok: true; value: MergedPrMatch[] } | { error: string; ok: false } {
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
        "number,headRefName,baseRefName,headRefOid,mergedAt,url,isCrossRepository,headRepository,headRepositoryOwner"
      ],
      { allowFailure: true, cwd: options.sourceRoot }
    );
    if (result.exitCode !== 0) {
      return { error: `GitHub merged PR lookup failed: ${commandDetail(result)}`, ok: false };
    }

    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) {
      return { error: "GitHub merged PR lookup did not return a list", ok: false };
    }

    return { ok: true, value: parsed.map(normalizeMergedPrMatch) };
  } catch (error) {
    return { error: `GitHub merged PR lookup failed: ${errorMessage(error)}`, ok: false };
  }
}

function normalizeMergedPrMatch(value: unknown): MergedPrMatch {
  const parsed = MergedPrInputSchema.safeParse(value);
  const record = parsed.success ? parsed.data : {};
  return {
    baseRefName: record.baseRefName ?? "",
    headRefName: record.headRefName ?? "",
    headRefOid: record.headRefOid ?? null,
    headRepository: record.headRepository ?? null,
    headRepositoryOwner: record.headRepositoryOwner ?? null,
    isCrossRepository: record.isCrossRepository,
    mergedAt: record.mergedAt,
    number: record.number ?? 0,
    url: record.url
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
  args: string[]
): { ok: true; value: string } | { error: string; ok: false } {
  try {
    const result = runtime.exec("git", args, { allowFailure: true, cwd });
    if (result.exitCode !== 0) {
      return { error: commandDetail(result), ok: false };
    }
    return { ok: true, value: result.stdout.trim() };
  } catch (error) {
    return { error: errorMessage(error), ok: false };
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

function commandDetail(result: { exitCode: number; stderr: string; stdout: string }): string {
  return result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}
