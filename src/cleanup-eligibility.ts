import { existsSync, statSync } from "node:fs";
import path from "node:path";

import * as z from "zod";

import { samePath } from "./path-identity.ts";
import type { ExecResult, Runtime } from "./types.ts";
import {
  assertCanonicalSourceCheckout,
  hasHiddenWorktreeIndexEntries,
  validateRegisteredWorktreeForRemoval
} from "./worktree-safety.ts";

const OidSchema = z.string().regex(/^[\da-f]{40}$/u);
const RepositorySchema = z.object({
  default_branch: z.string().min(1),
  full_name: z.string().min(1)
});
const RefSchema = z.object({ object: z.object({ sha: OidSchema }) });
const PrRepositorySchema = z.object({ full_name: z.string().min(1) }).nullable();
const PullRequestSchema = z.object({
  base: z.object({ ref: z.string(), repo: PrRepositorySchema }),
  head: z.object({ ref: z.string(), repo: PrRepositorySchema, sha: OidSchema }),
  html_url: z.string(),
  merged_at: z.iso.datetime().nullable(),
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"])
});
const CommitPullRequestSchema = PullRequestSchema.extend({
  merge_commit_sha: OidSchema.nullable()
});
const ComparisonSchema = z.object({
  behind_by: z.number().int().nonnegative(),
  merge_base_commit: z.object({ sha: OidSchema }),
  status: z.enum(["ahead", "behind", "diverged", "identical"])
});

/** A member-level Git check. A dependency pass still requires whole-Session preflight. */
export interface CleanupCandidate {
  /** Set only when retained Session membership proves this is a dependency. */
  role?: "root" | "dependency";
  sourceRoot: string;
  worktreePath: string;
}

export const CleanupCodeSchema = z.enum([
  "source-checkout",
  "missing-worktree",
  "identity-unverified",
  "detached-head",
  "dirty-worktree",
  "local-evidence-unavailable",
  "hidden-index-entries",
  "repository-unavailable",
  "default-branch",
  "open-pr",
  "closed-unmerged-pr",
  "ambiguous-pr",
  "head-mismatch",
  "no-merged-pr",
  "commit-pr-unavailable",
  "recent-worktree",
  "ancestry-unavailable",
  "changed-during-inspection",
  "repository-changed-during-inspection",
  "exact-merged-pr",
  "merged-pr-head",
  "unchanged-branch"
]);

export type CleanupCode = z.output<typeof CleanupCodeSchema>;

export interface CleanupDecision {
  code: CleanupCode;
  eligible: boolean;
  evidence: string[];
  status: "eligible" | "ineligible" | "unknown";
}

/** Collected facts, kept separate from the boolean policy for replay and reporting. */
export interface CleanupEvidence {
  ancestorOfDefault: boolean | null;
  branch: string | null;
  candidate: CleanupCandidate;
  /** Exact HEAD matches from commit-associated PRs; null means the lookup failed. */
  commitPullRequests?: CommitPullRequestEvidence[] | null;
  /** Absent only in older saved evidence; absence is not proof a check ran. */
  committedWorkAttempted?: boolean;
  head: string | null;
  localBlock: CleanupDecision | null;
  repository: CleanupRepositoryEvidence | null;
  /** Milliseconds since the worktree was created; null when unknown. Absent in older saved evidence. */
  worktreeAgeMs?: number | null;
}

export interface CommitPullRequestEvidence {
  ancestorOfDefault: boolean | null;
  pullRequest: z.output<typeof CommitPullRequestSchema>;
}

export const CleanupRepositoryEvidenceSchema = z.object({
  defaultBranch: z.string(),
  defaultHead: OidSchema,
  name: z.string(),
  pullRequests: z.array(PullRequestSchema)
});

export type CleanupRepositoryEvidence = z.output<typeof CleanupRepositoryEvidenceSchema>;

/**
 * Ancestry and cross-branch PR proof wait so a just-spawned Session is not removed before work
 * starts.
 */
export const RECENT_WORKTREE_MS = 24 * 60 * 60 * 1000;

/** One audit's remote snapshots; never cache local identity, HEAD, or cleanliness. */
export function createCleanupEvidenceCache() {
  return {
    commitPullRequests: new Map<string, Promise<CommitPullRequestEvidence[] | null>>(),
    repositories: new Map<string, Promise<CleanupRepositoryEvidence | null>>()
  };
}

export type CleanupEvidenceCache = ReturnType<typeof createCleanupEvidenceCache>;

/** True only for positively proven committed work and a clean, registered linked worktree. */
export function eligibleForCleanup(evidence: CleanupEvidence): boolean {
  return decideCleanupEligibility(evidence).eligible;
}

/** Missing proof remains unknown; both unknown and ineligible map to false. */
export function decideCleanupEligibility(snapshot: CleanupEvidence): CleanupDecision {
  if (snapshot.localBlock) {
    return snapshot.localBlock;
  }
  const { branch, head, repository } = snapshot;
  if (!branch || !head) {
    return decision("unknown", "local-evidence-unavailable");
  }
  if (!repository) {
    return decision("unknown", "repository-unavailable");
  }
  if (branch === repository.defaultBranch) {
    return decision("ineligible", "default-branch");
  }
  const branchPrs = repository.pullRequests.filter(
    (pr) => pr.head.ref === branch && pr.head.repo?.full_name === repository.name
  );
  if (branchPrs.some((pr) => pr.state === "open")) {
    return decision("ineligible", "open-pr");
  }
  const merged = branchPrs.filter(
    (pr) =>
      pr.merged_at !== null &&
      pr.state === "closed" &&
      pr.base.ref === repository.defaultBranch &&
      pr.base.repo?.full_name === repository.name
  );
  const exact = merged.filter((pr) => pr.head.sha === head);
  if (exact.length > 1) {
    return decision("unknown", "ambiguous-pr");
  }
  const [match] = exact;
  if (match) {
    return decision("eligible", "exact-merged-pr", [
      "registered linked worktree; clean including submodules and untracked files",
      `${repository.name}#${match.number}: ${branch} -> ${repository.defaultBranch}`,
      `HEAD equals merged PR head: ${head}`
    ]);
  }
  // A clean worktree whose HEAD is already inside the verified default branch
  // holds no unique work, whatever its role or PR history. The local check
  // above already rejected any uncommitted change. A freshly spawned Session
  // looks the same, so this proof alone waits a day.
  if (snapshot.ancestorOfDefault) {
    if (snapshot.worktreeAgeMs === undefined || snapshot.worktreeAgeMs === null) {
      return decision("unknown", "recent-worktree");
    }
    if (snapshot.worktreeAgeMs < RECENT_WORKTREE_MS) {
      return decision("ineligible", "recent-worktree");
    }
    return decision("eligible", "unchanged-branch", [
      "registered linked worktree; clean including submodules and untracked files",
      `${head} is an ancestor of verified ${repository.name}:${repository.defaultBranch} at ${repository.defaultHead}`,
      `worktree created ${Math.floor(snapshot.worktreeAgeMs / RECENT_WORKTREE_MS)} day(s) ago`,
      "member proof only; whole-Session eligibility is still required"
    ]);
  }
  const commitDecision = decideCommitPullRequests(snapshot, repository, head);
  if (commitDecision) {
    return commitDecision;
  }
  if (branchPrs.some((pr) => !pr.merged_at && pr.head.sha === head)) {
    return decision("ineligible", "closed-unmerged-pr");
  }
  if (merged.length > 0) {
    return decision("ineligible", "head-mismatch");
  }
  if (snapshot.ancestorOfDefault === null) {
    return decision("unknown", "ancestry-unavailable");
  }
  // Both answers came back; unique commits without a merged PR is a settled fact.
  return decision("ineligible", "no-merged-pr");
}

function decideCommitPullRequests(
  snapshot: CleanupEvidence,
  repository: CleanupRepositoryEvidence,
  head: string
): CleanupDecision | null {
  if (snapshot.commitPullRequests === null) {
    return decision("unknown", "commit-pr-unavailable");
  }
  const matches =
    snapshot.commitPullRequests?.filter(({ pullRequest: pr }) =>
      isExactMergedHead(pr, repository, head)
    ) ?? [];
  if (matches.length > 1) {
    return decision("unknown", "ambiguous-pr");
  }
  const [match] = matches;
  if (!match || match.ancestorOfDefault === false) {
    return null;
  }
  if (match.ancestorOfDefault === null) {
    return decision("unknown", "ancestry-unavailable");
  }
  if (snapshot.worktreeAgeMs === undefined || snapshot.worktreeAgeMs === null) {
    return decision("unknown", "recent-worktree");
  }
  if (snapshot.worktreeAgeMs < RECENT_WORKTREE_MS) {
    return decision("ineligible", "recent-worktree");
  }
  const pr = match.pullRequest;
  return decision("eligible", "merged-pr-head", [
    "registered linked worktree; clean including submodules and untracked files",
    `${repository.name}#${pr.number}: ${pr.head.ref} -> ${repository.defaultBranch}`,
    `HEAD equals merged PR head: ${head}`,
    `merge commit ${pr.merge_commit_sha} is an ancestor of verified default HEAD ${repository.defaultHead}`,
    `worktree created ${Math.floor(snapshot.worktreeAgeMs / RECENT_WORKTREE_MS)} day(s) ago`,
    "member proof only; whole-Session eligibility is still required"
  ]);
}

function isExactMergedHead(
  pr: z.output<typeof CommitPullRequestSchema>,
  repository: CleanupRepositoryEvidence,
  head: string
) {
  return (
    pr.head.sha === head &&
    pr.head.repo?.full_name === repository.name &&
    pr.state === "closed" &&
    pr.merged_at !== null &&
    pr.merge_commit_sha !== null &&
    pr.base.ref === repository.defaultBranch &&
    pr.base.repo?.full_name === repository.name
  );
}

/**
 * A linked worktree's `.git` file is written once at creation and never rewritten. Take the earlier
 * of birth and modification time: copies and restores can reset birth time forward, and an mtime in
 * the past is never newer than creation.
 */
function worktreeAge(worktreePath: string): number | null {
  try {
    const stat = statSync(path.join(worktreePath, ".git"));
    const created = stat.birthtimeMs > 0 ? Math.min(stat.birthtimeMs, stat.mtimeMs) : stat.mtimeMs;
    return Math.max(0, Date.now() - created);
  } catch {
    return null;
  }
}

/** Read-only collection: no fetch, optional Git writes, write lock, or teardown. */
export async function collectCleanupEvidence(
  runtime: Runtime,
  candidate: CleanupCandidate,
  cache: CleanupEvidenceCache = createCleanupEvidenceCache()
): Promise<CleanupEvidence> {
  const readOnly = readOnlyCleanupRuntime(runtime);
  const local = inspectLocal(readOnly, candidate);
  const snapshot: CleanupEvidence = {
    ...local,
    ancestorOfDefault: null,
    candidate,
    committedWorkAttempted: false,
    repository: null,
    worktreeAgeMs: worktreeAge(candidate.worktreePath)
  };
  if (local.localBlock) {
    return snapshot;
  }
  snapshot.committedWorkAttempted = true;
  const repositoryName = readRepositoryName(readOnly, candidate.sourceRoot);
  if (!repositoryName) {
    return snapshot;
  }
  const cacheKey = `${candidate.sourceRoot}\0${repositoryName.toLowerCase()}`;
  let repository = cache.repositories.get(cacheKey);
  if (!repository) {
    repository = inspectRepository(readOnly, candidate.sourceRoot, repositoryName);
    cache.repositories.set(cacheKey, repository);
  }
  snapshot.repository = await repository;
  if (snapshot.repository && snapshot.head) {
    snapshot.ancestorOfDefault = await inspectAncestry(
      readOnly,
      candidate.sourceRoot,
      snapshot.head,
      snapshot.repository
    );
    const currentDecision = decideCleanupEligibility(snapshot);
    if (
      ["no-merged-pr", "head-mismatch", "closed-unmerged-pr", "ancestry-unavailable"].includes(
        currentDecision.code
      )
    ) {
      const commitKey = `${cacheKey}\0${snapshot.head}\0${snapshot.repository.defaultHead}`;
      let commitPullRequests = cache.commitPullRequests.get(commitKey);
      if (!commitPullRequests) {
        commitPullRequests = inspectCommitPullRequests(
          readOnly,
          candidate.sourceRoot,
          snapshot.head,
          snapshot.repository
        );
        cache.commitPullRequests.set(commitKey, commitPullRequests);
      }
      snapshot.commitPullRequests = await commitPullRequests;
    }
  }
  // Provider lookups can take seconds. Never attach old proof to a changed checkout.
  const current = inspectLocal(readOnly, candidate);
  snapshot.localBlock =
    current.localBlock ??
    (current.head === local.head && current.branch === local.branch
      ? null
      : decision("unknown", "changed-during-inspection"));
  if (
    readRepositoryName(readOnly, candidate.sourceRoot)?.toLowerCase() !==
    repositoryName.toLowerCase()
  ) {
    snapshot.localBlock ??= decision("unknown", "repository-changed-during-inspection");
  }
  return snapshot;
}

/** Recheck local proof synchronously after all members finish provider reads. */
export function revalidateCleanupEvidence(
  runtime: Runtime,
  snapshot: CleanupEvidence
): CleanupDecision | null {
  const readOnly = readOnlyCleanupRuntime(runtime);
  const current = inspectLocal(readOnly, snapshot.candidate);
  if (
    current.head !== snapshot.head ||
    current.branch !== snapshot.branch ||
    current.localBlock?.code !== snapshot.localBlock?.code
  ) {
    return current.localBlock ?? decision("unknown", "changed-during-inspection");
  }
  // An unchanged local blocker still explains a skipped member. No remote
  // identity was established for that member, so do not invent a remote change.
  if (snapshot.localBlock) {
    return null;
  }
  if (
    snapshot.repository &&
    readRepositoryName(readOnly, snapshot.candidate.sourceRoot)?.toLowerCase() !==
      snapshot.repository.name.toLowerCase()
  ) {
    return decision("unknown", "repository-changed-during-inspection");
  }
  return null;
}

function inspectLocal(runtime: Runtime, candidate: CleanupCandidate) {
  const local: Pick<CleanupEvidence, "branch" | "head" | "localBlock"> = {
    branch: null,
    head: null,
    localBlock: null
  };
  if (samePath(candidate.sourceRoot, candidate.worktreePath)) {
    local.localBlock = decision("ineligible", "source-checkout");
    return local;
  }
  if (!existsSync(candidate.worktreePath)) {
    local.localBlock = decision("unknown", "missing-worktree");
    return local;
  }
  try {
    assertCanonicalSourceCheckout(runtime, candidate.sourceRoot);
    validateRegisteredWorktreeForRemoval(runtime, candidate.sourceRoot, candidate.worktreePath);
  } catch {
    local.localBlock = decision("unknown", "identity-unverified");
    return local;
  }
  try {
    const git = (args: string[]) =>
      runtime.exec("git", args, { cwd: candidate.worktreePath }).stdout.trim();
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    local.branch = branch === "HEAD" ? null : branch;
    local.head = OidSchema.parse(git(["rev-parse", "HEAD"]));
    if (!local.branch) {
      local.localBlock = decision("ineligible", "detached-head");
    } else {
      // Keep leading status columns; trimming would corrupt " M path" entries.
      const changes = runtime
        .exec(
          "git",
          ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
          { cwd: candidate.worktreePath }
        )
        .stdout.split("\n")
        .filter(Boolean);
      if (changes.length > 0) {
        local.localBlock = decision("ineligible", "dirty-worktree", summarizeChanges(changes));
      } else if (hasHiddenWorktreeIndexEntries(runtime, candidate.worktreePath)) {
        local.localBlock = decision("unknown", "hidden-index-entries");
      }
    }
  } catch {
    local.localBlock = decision("unknown", "local-evidence-unavailable");
  }
  return local;
}

const DIRTY_PATH_LIMIT = 5;

function summarizeChanges(lines: string[]) {
  const shown = lines.slice(0, DIRTY_PATH_LIMIT);
  return lines.length > shown.length
    ? [...shown, `and ${lines.length - shown.length} more`]
    : shown;
}

type StructureMemo = { ok: true; result: ExecResult } | { error: unknown; ok: false };

/**
 * Cache repository-structure reads (worktree listings, top-level and common-dir lookups) for one
 * collection pass. Branch, HEAD, status, and index reads stay live, and callers must revalidate
 * with an unmemoized runtime before acting.
 */
export function memoizeRepoStructure(runtime: Runtime): Runtime {
  const cache = new Map<string, StructureMemo>();
  return {
    ...runtime,
    exec(command, args, options) {
      const structural =
        command === "git" &&
        args !== undefined &&
        (args.includes("--show-toplevel") ||
          args.includes("--git-common-dir") ||
          (args.includes("worktree") && args.includes("list")));
      if (!structural) {
        return runtime.exec(command, args, options);
      }
      const key = JSON.stringify([args, options?.cwd]);
      let memo = cache.get(key);
      if (!memo) {
        try {
          memo = { ok: true, result: runtime.exec(command, args, options) };
        } catch (error) {
          memo = { error, ok: false };
        }
        cache.set(key, memo);
      }
      if (!memo.ok) {
        throw memo.error;
      }
      return memo.result;
    }
  };
}

export function readOnlyCleanupRuntime(runtime: Runtime): Runtime {
  return {
    ...runtime,
    exec(command, args, options) {
      return runtime.exec(
        command,
        command === "git"
          ? ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...(args ?? [])]
          : args,
        {
          ...options,
          env: { ...options?.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
          timeoutSeconds: 30
        }
      );
    }
  };
}

class GitHubNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubNotFoundError";
  }
}

async function github(runtime: Runtime, sourceRoot: string, endpoint: string, paginate = false) {
  const result = await runtime.execAsync(
    "gh",
    ["api", endpoint, "--hostname", "github.com", ...(paginate ? ["--paginate", "--slurp"] : [])],
    { allowFailure: true, cwd: sourceRoot, timeoutSeconds: 30 }
  );
  if (result.exitCode !== 0) {
    const commit = /\/commits\/(?<sha>[\da-f]{40})\/pulls(?:\?|$)/u.exec(endpoint)?.groups?.sha;
    if (
      /\bHTTP 404\b/u.test(result.stderr) ||
      (commit !== undefined &&
        /\bHTTP 422\b/u.test(result.stderr) &&
        result.stderr.includes(`No commit found for SHA: ${commit}`))
    ) {
      throw new GitHubNotFoundError("GitHub resource not found");
    }
    throw new Error("GitHub evidence unavailable");
  }
  const parsed: unknown = JSON.parse(result.stdout);
  return parsed;
}

function readRepositoryName(runtime: Runtime, sourceRoot: string) {
  try {
    const remote = runtime
      .exec("git", ["remote", "get-url", "origin"], { cwd: sourceRoot })
      .stdout.trim();
    // Bind API calls to this checkout's remote, never gh's default repo or GH_REPO.
    const match =
      /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(?<repository>[\w.-]+\/[\w.-]+?)(?:\.git)?$/u.exec(
        remote
      );
    return match?.groups?.repository ?? null;
  } catch {
    return null;
  }
}

async function inspectRepository(runtime: Runtime, sourceRoot: string, name: string) {
  try {
    const metadata = RepositorySchema.parse(await github(runtime, sourceRoot, `repos/${name}`));
    if (metadata.full_name.toLowerCase() !== name.toLowerCase()) {
      return null;
    }
    const [ref, pages] = await Promise.all([
      github(
        runtime,
        sourceRoot,
        `repos/${name}/git/ref/heads/${encodeURIComponent(metadata.default_branch)}`
      ),
      github(runtime, sourceRoot, `repos/${name}/pulls?state=all&per_page=100`, true)
    ]);
    return {
      defaultBranch: metadata.default_branch,
      defaultHead: RefSchema.parse(ref).object.sha,
      name: metadata.full_name,
      pullRequests: z.array(z.array(PullRequestSchema)).parse(pages).flat()
    };
  } catch {
    return null;
  }
}

async function inspectAncestry(
  runtime: Runtime,
  sourceRoot: string,
  head: string,
  repository: CleanupRepositoryEvidence
): Promise<boolean | null> {
  try {
    const result = runtime.exec(
      "git",
      ["merge-base", "--is-ancestor", head, repository.defaultHead],
      {
        allowFailure: true,
        cwd: sourceRoot
      }
    );
    if (result.exitCode === 0) {
      return true;
    }
    // Exit 1 means both commits are present and unrelated. Trust it unless history is
    // shallow, where a cut-off could hide the ancestry.
    if (
      result.exitCode === 1 &&
      runtime
        .exec("git", ["rev-parse", "--is-shallow-repository"], { cwd: sourceRoot })
        .stdout.trim() === "false"
    ) {
      return false;
    }
    // Remote comparison handles a missing default commit or shallow history without fetching.
    try {
      const comparison = ComparisonSchema.parse(
        await github(
          runtime,
          sourceRoot,
          `repos/${repository.name}/compare/${head}...${repository.defaultHead}`
        )
      );
      return comparison.behind_by === 0 && comparison.merge_base_commit.sha === head;
    } catch (error) {
      // defaultHead was just resolved on GitHub, so a 404 means GitHub has never
      // seen head. A commit absent from the remote cannot be inside its default branch.
      if (error instanceof GitHubNotFoundError) {
        return false;
      }
      throw error;
    }
  } catch {
    return null;
  }
}

async function inspectCommitPullRequests(
  runtime: Runtime,
  sourceRoot: string,
  head: string,
  repository: CleanupRepositoryEvidence
): Promise<CommitPullRequestEvidence[] | null> {
  try {
    const pages = await github(
      runtime,
      sourceRoot,
      `repos/${repository.name}/commits/${head}/pulls?per_page=100`,
      true
    );
    const matches = z
      .array(z.array(CommitPullRequestSchema))
      .parse(pages)
      .flat()
      .filter((pr) => isExactMergedHead(pr, repository, head));
    return await Promise.all(
      matches.map(async (pr) => ({
        ancestorOfDefault:
          pr.merge_commit_sha === null
            ? null
            : await inspectAncestry(runtime, sourceRoot, pr.merge_commit_sha, repository),
        pullRequest: pr
      }))
    );
  } catch (error) {
    // The repository was verified above; an unpushed commit has no associated PRs.
    return error instanceof GitHubNotFoundError ? [] : null;
  }
}

function decision(
  status: CleanupDecision["status"],
  code: CleanupCode,
  evidence: string[] = []
): CleanupDecision {
  return { code, eligible: status === "eligible", evidence, status };
}
