import { existsSync } from "node:fs";

import * as z from "zod";

import { samePath } from "./path-identity.ts";
import type { Runtime } from "./types.ts";
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
  "unique-dependency-commits",
  "ancestry-unavailable",
  "changed-during-inspection",
  "repository-changed-during-inspection",
  "exact-merged-pr",
  "unchanged-dependency"
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
  /** Absent only in older saved evidence; absence is not proof a check ran. */
  committedWorkAttempted?: boolean;
  head: string | null;
  localBlock: CleanupDecision | null;
  repository: CleanupRepositoryEvidence | null;
}

export const CleanupRepositoryEvidenceSchema = z.object({
  defaultBranch: z.string(),
  defaultHead: OidSchema,
  name: z.string(),
  pullRequests: z.array(PullRequestSchema)
});

export type CleanupRepositoryEvidence = z.output<typeof CleanupRepositoryEvidenceSchema>;

/** One audit's remote snapshots; never cache local identity, HEAD, or cleanliness. */
export function createCleanupEvidenceCache() {
  return new Map<string, Promise<CleanupRepositoryEvidence | null>>();
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
  if (branchPrs.some((pr) => !pr.merged_at && pr.head.sha === head)) {
    return decision("ineligible", "closed-unmerged-pr");
  }
  if (merged.length > 0) {
    return decision("ineligible", "head-mismatch");
  }
  if (snapshot.candidate.role !== "dependency") {
    return decision("unknown", "no-merged-pr");
  }
  if (snapshot.ancestorOfDefault === null) {
    return decision("unknown", "ancestry-unavailable");
  }
  return snapshot.ancestorOfDefault
    ? decision("eligible", "unchanged-dependency", [
        "registered linked worktree; clean including submodules and untracked files",
        `${head} is an ancestor of verified ${repository.name}:${repository.defaultBranch} at ${repository.defaultHead}`,
        "dependency proof only; whole-Session eligibility is still required"
      ])
    : decision("ineligible", "unique-dependency-commits");
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
    repository: null
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
  let repository = cache.get(cacheKey);
  if (!repository) {
    repository = inspectRepository(readOnly, candidate.sourceRoot, repositoryName);
    cache.set(cacheKey, repository);
  }
  snapshot.repository = await repository;
  if (candidate.role === "dependency" && snapshot.repository && snapshot.head) {
    snapshot.ancestorOfDefault = await inspectAncestry(
      readOnly,
      candidate.sourceRoot,
      snapshot.head,
      snapshot.repository
    );
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
    } else if (
      git(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])
    ) {
      local.localBlock = decision("ineligible", "dirty-worktree");
    } else if (hasHiddenWorktreeIndexEntries(runtime, candidate.worktreePath)) {
      local.localBlock = decision("unknown", "hidden-index-entries");
    }
  } catch {
    local.localBlock = decision("unknown", "local-evidence-unavailable");
  }
  return local;
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

async function github(runtime: Runtime, sourceRoot: string, endpoint: string, paginate = false) {
  const result = await runtime.execAsync(
    "gh",
    ["api", endpoint, "--hostname", "github.com", ...(paginate ? ["--paginate", "--slurp"] : [])],
    { cwd: sourceRoot, timeoutSeconds: 30 }
  );
  if (result.exitCode !== 0) {
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
    // Remote comparison also handles a missing default commit or shallow history without fetching.
    const comparison = ComparisonSchema.parse(
      await github(
        runtime,
        sourceRoot,
        `repos/${repository.name}/compare/${head}...${repository.defaultHead}`
      )
    );
    return comparison.behind_by === 0 && comparison.merge_base_commit.sha === head;
  } catch {
    return null;
  }
}

function decision(
  status: CleanupDecision["status"],
  code: CleanupCode,
  evidence: string[] = []
): CleanupDecision {
  return { code, eligible: status === "eligible", evidence, status };
}
