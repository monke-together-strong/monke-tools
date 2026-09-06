import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  collectCleanupEvidence,
  createCleanupEvidenceCache,
  decideCleanupEligibility,
  eligibleForCleanup
} from "../src/cleanup-eligibility.ts";
import type { CleanupEvidence, CleanupRepositoryEvidence } from "../src/cleanup-eligibility.ts";
import { inspectMergedWorktreeCleanup } from "../src/cleanup-merged.ts";
import type { Runtime } from "../src/types.ts";
import { assertCleanWorktree } from "../src/worktree-safety.ts";
import { createRepo, git, write } from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const BRANCH = "feature/finished";
const REPOSITORY = "owner/repo";
const sandboxes: string[] = [];

function mergedPr() {
  return {
    base: { ref: "develop", repo: { full_name: REPOSITORY } },
    head: { ref: BRANCH, repo: { full_name: REPOSITORY }, sha: HEAD },
    html_url: "https://github.com/owner/repo/pull/1",
    merged_at: "2026-09-06T00:00:00Z",
    number: 1,
    state: "closed" as const
  };
}

function evidence(patch: Partial<CleanupEvidence> = {}): CleanupEvidence {
  return {
    ancestorOfDefault: null,
    branch: BRANCH,
    candidate: { sourceRoot: "/source", worktreePath: "/worktrees/session-name" },
    head: HEAD,
    localBlock: null,
    repository: {
      defaultBranch: "develop",
      defaultHead: OTHER_HEAD,
      name: REPOSITORY,
      pullRequests: [mergedPr()]
    },
    ...patch
  };
}

describe("cleanup committed-work policy", () => {
  test.each([
    { code: "open-pr", label: "open", merged_at: null, state: "open" },
    { code: "closed-unmerged-pr", label: "closed unmerged", merged_at: null, state: "closed" }
  ] as const)("rejects an $label PR", ({ code, merged_at, state }) => {
    const snapshot = withPrs([{ ...mergedPr(), merged_at, state }]);
    expect(decideCleanupEligibility(snapshot)).toMatchObject({ code, eligible: false });
  });

  test("rejects a clean worktree with commits after merge, even for a dependency", () => {
    const snapshot = evidence({
      ancestorOfDefault: true,
      candidate: { role: "dependency", sourceRoot: "/source", worktreePath: "/worktree" },
      head: OTHER_HEAD
    });
    expect(decideCleanupEligibility(snapshot)).toMatchObject({
      code: "head-mismatch",
      eligible: false
    });
  });

  test("uses the exact head to distinguish older uses of the same branch", () => {
    const snapshot = withPrs([
      mergedPr(),
      { ...mergedPr(), head: { ...mergedPr().head, sha: OTHER_HEAD }, number: 2 }
    ]);
    expect(eligibleForCleanup(snapshot)).toBeTruthy();
  });

  test("a new open PR on a reused branch blocks an older exact merged match", () => {
    const snapshot = withPrs([
      mergedPr(),
      { ...mergedPr(), merged_at: null, number: 2, state: "open" }
    ]);
    expect(decideCleanupEligibility(snapshot).code).toBe("open-pr");
  });

  test("ambiguous exact merged matches remain unknown", () => {
    const snapshot = withPrs([mergedPr(), { ...mergedPr(), number: 2 }]);
    expect(decideCleanupEligibility(snapshot)).toMatchObject({
      eligible: false,
      status: "unknown"
    });
  });

  test("a fork's matching branch and commit do not prove this repo's PR", () => {
    const snapshot = withPrs([
      { ...mergedPr(), head: { ...mergedPr().head, repo: { full_name: "fork/repo" } } }
    ]);
    expect(eligibleForCleanup(snapshot)).toBeFalsy();
  });

  test("a PR merged to a non-default base does not prove completion", () => {
    const snapshot = withPrs([{ ...mergedPr(), base: { ...mergedPr().base, ref: "release" } }]);
    expect(eligibleForCleanup(snapshot)).toBeFalsy();
  });

  test.each([
    { ancestor: true, expected: true, role: "dependency" },
    { ancestor: false, expected: false, role: "dependency" },
    { ancestor: null, expected: false, role: "dependency" },
    { ancestor: true, expected: false, role: "root" }
  ] as const)(
    "ancestry=$ancestor, role=$role gives $expected without a PR",
    ({ ancestor, expected, role }) => {
      const snapshot = withPrs([]);
      snapshot.ancestorOfDefault = ancestor;
      snapshot.candidate.role = role;
      expect(eligibleForCleanup(snapshot)).toBe(expected);
    }
  );
});

describe("cleanup evidence from real Git worktrees", () => {
  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) {
      rmSync(sandbox, { force: true, recursive: true });
    }
  });

  test.each(["ordinary", "squash", "rebase"])(
    "proves a real %s merge from the PR head",
    async (strategy) => {
      const fixture = createFixture();
      const { sourceRoot, worktreePath } = fixture.candidate;
      write(worktreePath, "feature.txt", "feature work\n");
      git(worktreePath, ["add", "."]);
      git(worktreePath, ["commit", "-m", "feature"]);
      fixture.pr.head.sha = git(worktreePath, ["rev-parse", "HEAD"]);
      write(sourceRoot, "base.txt", "base work\n");
      git(sourceRoot, ["add", "."]);
      git(sourceRoot, ["commit", "-m", "base advanced"]);
      if (strategy === "ordinary") {
        git(sourceRoot, ["merge", "--no-ff", BRANCH, "-m", "merge feature"]);
      } else if (strategy === "squash") {
        git(sourceRoot, ["merge", "--squash", BRANCH]);
        git(sourceRoot, ["commit", "-m", "squashed feature"]);
      } else {
        const rebased = path.join(fixture.sandbox, "rebased");
        git(sourceRoot, ["worktree", "add", "-b", "integration", rebased, BRANCH]);
        git(rebased, ["rebase", "main"]);
        git(sourceRoot, ["merge", "--ff-only", "integration"]);
      }
      const snapshot = await collectCleanupEvidence(fixture.runtime, fixture.candidate);
      expect(snapshot.repository?.defaultHead).not.toBe(snapshot.head);
      expect(eligibleForCleanup(snapshot)).toBeTruthy();
    }
  );

  test("accepts a recorded path with a different branch name and an arbitrary verified default", async () => {
    const fixture = createFixture();
    const snapshot = await collectCleanupEvidence(fixture.runtime, fixture.candidate);
    expect(snapshot.branch).toBe(BRANCH);
    expect(snapshot.committedWorkAttempted).toBeTruthy();
    expect(snapshot.repository?.defaultBranch).toBe("develop");
    expect(eligibleForCleanup(snapshot)).toBeTruthy();
  });

  test("proves an unchanged dependency against the current default without a PR", async () => {
    const fixture = createFixture();
    fixture.pr.head.ref = "another-branch";
    const candidate = { ...fixture.candidate, role: "dependency" as const };
    const snapshot = await collectCleanupEvidence(fixture.runtime, candidate);
    expect(decideCleanupEligibility(snapshot)).toMatchObject({
      code: "unchanged-dependency",
      eligible: true
    });
    expect(
      eligibleForCleanup(await collectCleanupEvidence(fixture.runtime, fixture.candidate))
    ).toBeFalsy();
  });

  test.each([
    { comparison: "ahead", expected: true, label: "remote ancestry proof" },
    { comparison: "behind", expected: false, label: "unique dependency commits" },
    { comparison: "unavailable", expected: false, label: "unavailable ancestry" }
  ])("handles a missing local default commit with $label", async ({ comparison, expected }) => {
    const fixture = createFixture();
    fixture.pr.head.ref = "another-branch";
    const original = fixture.runtime.execAsync;
    fixture.runtime.execAsync = async (command, args, options) => {
      const endpoint = args?.[1] ?? "";
      if (endpoint.includes("/git/ref/heads/")) {
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({ object: { sha: OTHER_HEAD } }) };
      }
      if (endpoint.includes("/compare/")) {
        if (comparison === "unavailable") {
          throw new Error("comparison unavailable");
        }
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            behind_by: comparison === "behind" ? 1 : 0,
            merge_base_commit: { sha: fixture.pr.head.sha },
            status: comparison
          })
        };
      }
      return await original(command, args, options);
    };
    const snapshot = await collectCleanupEvidence(fixture.runtime, {
      ...fixture.candidate,
      role: "dependency"
    });
    expect(eligibleForCleanup(snapshot)).toBe(expected);
    const expectedStatus =
      comparison === "unavailable" ? "unknown" : expected ? "eligible" : "ineligible";
    expect(decideCleanupEligibility(snapshot).status).toBe(expectedStatus);
  });

  test.each(["staged", "unstaged", "untracked"] as const)("rejects %s changes", async (kind) => {
    const fixture = createFixture();
    write(
      fixture.candidate.worktreePath,
      kind === "untracked" ? "new.txt" : "tracked.txt",
      "edited\n"
    );
    if (kind === "staged") {
      git(fixture.candidate.worktreePath, ["add", "."]);
    }
    const snapshot = await collectCleanupEvidence(fixture.runtime, fixture.candidate);
    expect(snapshot.committedWorkAttempted).toBeFalsy();
    expect(decideCleanupEligibility(snapshot)).toMatchObject({
      code: "dirty-worktree",
      eligible: false
    });
  });

  test("detects dirty submodules even when repository config hides them", async () => {
    const fixture = createFixture();
    const { sourceRoot, worktreePath } = fixture.candidate;
    const dependency = createRepo(path.join(fixture.sandbox, "dependency"), {
      "sub.txt": "original\n"
    });
    git(worktreePath, ["-c", "protocol.file.allow=always", "submodule", "add", dependency, "dep"]);
    git(worktreePath, ["commit", "-am", "add submodule"]);
    git(sourceRoot, ["config", "submodule.dep.ignore", "all"]);
    write(worktreePath, "dep/sub.txt", "uncommitted\n");
    fixture.pr.head.sha = git(worktreePath, ["rev-parse", "HEAD"]);
    expect(git(worktreePath, ["status", "--porcelain"])).toBe("");
    const snapshot = await collectCleanupEvidence(fixture.runtime, fixture.candidate);
    expect(decideCleanupEligibility(snapshot).code).toBe("dirty-worktree");
    // The existing cleanup command must also stop reporting this checkout as clean.
    const legacy = inspectMergedWorktreeCleanup(
      {
        ...fixture.runtime,
        exec: (command, args, options) =>
          command === "git"
            ? fixture.baseRuntime.exec(command, args, options)
            : fixture.runtime.exec(command, args, options)
      },
      {
        ...fixture.candidate,
        session: BRANCH
      },
      { refreshDefaultBranch: false }
    );
    expect(legacy.eligible).toBeFalsy();
    expect(legacy.reasons.join(" ")).toContain("dirty/untracked");
  });

  test.each(["--assume-unchanged", "--skip-worktree"])(
    "does not trust hidden index entries: %s",
    async (flag) => {
      const fixture = createFixture();
      git(fixture.candidate.worktreePath, ["update-index", flag, "tracked.txt"]);
      write(fixture.candidate.worktreePath, "tracked.txt", "concealed edit\n");
      const snapshot = await collectCleanupEvidence(fixture.runtime, fixture.candidate);
      expect(decideCleanupEligibility(snapshot)).toMatchObject({
        code: "hidden-index-entries",
        eligible: false
      });
    }
  );

  test.each(["--assume-unchanged", "--skip-worktree"])(
    "rejects concealed submodule edits across all cleanup checks: %s",
    async (flag) => {
      const fixture = createFixture();
      const { worktreePath } = fixture.candidate;
      const dependency = createRepo(path.join(fixture.sandbox, "dependency"), {
        "sub.txt": "original\n"
      });
      git(worktreePath, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        dependency,
        "dep"
      ]);
      git(worktreePath, ["commit", "-am", "add submodule"]);
      fixture.pr.head.sha = git(worktreePath, ["rev-parse", "HEAD"]);
      git(path.join(worktreePath, "dep"), ["update-index", flag, "sub.txt"]);
      write(worktreePath, "dep/sub.txt", "concealed edit\n");
      expect(git(worktreePath, ["status", "--porcelain", "--ignore-submodules=none"])).toBe("");
      const snapshot = await collectCleanupEvidence(fixture.runtime, fixture.candidate);
      const legacy = inspectMergedWorktreeCleanup(
        {
          ...fixture.runtime,
          exec: (command, args, options) =>
            command === "git"
              ? fixture.baseRuntime.exec(command, args, options)
              : fixture.runtime.exec(command, args, options)
        },
        { ...fixture.candidate, session: BRANCH },
        { refreshDefaultBranch: false }
      );
      let chopAccepted = true;
      try {
        assertCleanWorktree(fixture.baseRuntime, worktreePath);
      } catch {
        chopAccepted = false;
      }
      expect([eligibleForCleanup(snapshot), legacy.eligible, chopAccepted]).toStrictEqual([
        false,
        false,
        false
      ]);
    }
  );

  test.each(["during lookup", "between cached calls"])(
    "revalidates repository identity %s",
    async (when) => {
      const fixture = createFixture();
      const cache = createCleanupEvidenceCache();
      const replaceRemote = () =>
        git(fixture.candidate.sourceRoot, [
          "remote",
          "set-url",
          "origin",
          "git@github.com:different/repo.git"
        ]);
      const initial = await collectCleanupEvidence(fixture.runtime, fixture.candidate, cache);
      expect(eligibleForCleanup(initial)).toBeTruthy();
      if (when === "between cached calls") {
        replaceRemote();
      } else {
        cache.clear();
        const original = fixture.runtime.execAsync;
        fixture.runtime.execAsync = async (...args) => {
          replaceRemote();
          return await original(...args);
        };
      }
      const snapshot = await collectCleanupEvidence(fixture.runtime, fixture.candidate, cache);
      expect(eligibleForCleanup(snapshot)).toBeFalsy();
    }
  );

  test.each(["source", "detached", "locked", "missing", "wrong-source"])(
    "excludes a %s target",
    async (kind) => {
      const fixture = createFixture();
      const candidate = { ...fixture.candidate };
      if (kind === "source") {
        candidate.worktreePath = candidate.sourceRoot;
      }
      if (kind === "detached") {
        git(candidate.worktreePath, ["checkout", "--detach"]);
      }
      if (kind === "locked") {
        git(candidate.sourceRoot, ["worktree", "lock", candidate.worktreePath]);
      }
      if (kind === "missing") {
        candidate.worktreePath = path.join(fixture.sandbox, "missing");
      }
      if (kind === "wrong-source") {
        candidate.sourceRoot = createRepo(path.join(fixture.sandbox, "other"), { a: "a" });
      }
      expect(
        eligibleForCleanup(await collectCleanupEvidence(fixture.runtime, candidate))
      ).toBeFalsy();
    }
  );

  test("provider failure is unknown, and never becomes a clean/unmerged success", async () => {
    const fixture = createFixture();
    fixture.runtime.execAsync = async () => {
      throw new Error("offline");
    };
    expect(
      decideCleanupEligibility(await collectCleanupEvidence(fixture.runtime, fixture.candidate))
    ).toMatchObject({ code: "repository-unavailable", eligible: false, status: "unknown" });
  });

  test("malformed provider evidence fails closed", async () => {
    const fixture = createFixture();
    fixture.runtime.execAsync = async () => ({ exitCode: 0, stderr: "", stdout: "{}" });
    expect(
      eligibleForCleanup(await collectCleanupEvidence(fixture.runtime, fixture.candidate))
    ).toBeFalsy();
  });

  test.each(["head", "dirty"])(
    "rechecks %s after provider lookup, even with a shared cache",
    async (change) => {
      const fixture = createFixture();
      const original = fixture.runtime.execAsync;
      let changed = false;
      fixture.runtime.execAsync = async (...args) => {
        const result = await original(...args);
        if (!changed) {
          changed = true;
          write(fixture.candidate.worktreePath, "tracked.txt", "new work\n");
          if (change === "head") {
            git(fixture.candidate.worktreePath, ["commit", "-am", "new work"]);
          }
        }
        return result;
      };
      const cache = createCleanupEvidenceCache();
      const snapshot = await collectCleanupEvidence(fixture.runtime, fixture.candidate, cache);
      expect(eligibleForCleanup(snapshot)).toBeFalsy();
      expect(
        eligibleForCleanup(await collectCleanupEvidence(fixture.runtime, fixture.candidate, cache))
      ).toBeFalsy();
    }
  );
});

function withPrs(pullRequests: CleanupRepositoryEvidence["pullRequests"]) {
  const snapshot = evidence();
  if (snapshot.repository) {
    snapshot.repository.pullRequests = pullRequests;
  }
  return snapshot;
}

function createFixture() {
  const tempRoot = path.resolve("tmp");
  mkdirSync(tempRoot, { recursive: true });
  const sandbox = mkdtempSync(path.join(tempRoot, "cleanup-eligibility-test-"));
  sandboxes.push(sandbox);
  const sourceRoot = createRepo(path.join(sandbox, "source"), { "tracked.txt": "original\n" });
  const worktreePath = path.join(sandbox, "session-with-a-different-name");
  git(sourceRoot, ["remote", "add", "origin", `git@github.com:${REPOSITORY}.git`]);
  git(sourceRoot, ["worktree", "add", "-b", BRANCH, worktreePath]);
  const pr = mergedPr();
  pr.head.sha = git(worktreePath, ["rev-parse", "HEAD"]);
  const baseRuntime = createTestRuntime({ cwd: sourceRoot, env: { GH_REPO: "wrong/repo" } });
  const runtime: Runtime = {
    ...baseRuntime,
    exec(command, args, options) {
      if (command === "gh") {
        const result =
          args?.[0] === "repo"
            ? { nameWithOwner: REPOSITORY }
            : [
                {
                  baseRefName: "main",
                  headRefName: BRANCH,
                  headRefOid: pr.head.sha,
                  isCrossRepository: false,
                  mergedAt: pr.merged_at,
                  number: 1
                }
              ];
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(result) };
      }
      expect(options?.env).toMatchObject({ GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" });
      expect(args).not.toContain("fetch");
      return baseRuntime.exec(command, args, options);
    },
    async execAsync(command, args) {
      expect(command).toBe("gh");
      expect(args).toContain("--hostname");
      expect(args).toContain("github.com");
      const endpoint = args?.[1];
      const responses = {
        [`repos/${REPOSITORY}/git/ref/heads/develop`]: {
          object: { sha: git(sourceRoot, ["rev-parse", "HEAD"]) }
        },
        [`repos/${REPOSITORY}/pulls?state=all&per_page=100`]: [[pr]],
        [`repos/${REPOSITORY}`]: { default_branch: "develop", full_name: REPOSITORY }
      };
      const value = Object.entries(responses).find(([key]) => key === endpoint)?.[1];
      if (!value) {
        throw new Error(`Unexpected API endpoint: ${endpoint}`);
      }
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(value) };
    }
  };
  return { baseRuntime, candidate: { sourceRoot, worktreePath }, pr, runtime, sandbox };
}
