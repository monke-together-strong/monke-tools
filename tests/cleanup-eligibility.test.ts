import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  collectCleanupEvidence,
  createCleanupEvidenceCache,
  decideCleanupEligibility,
  eligibleForCleanup,
  RECENT_WORKTREE_MS
} from "../src/cleanup-eligibility.ts";
import type { CleanupEvidence, CleanupRepositoryEvidence } from "../src/cleanup-eligibility.ts";
import type { Runtime } from "../src/types.ts";
import { assertCleanWorktree } from "../src/worktree-safety.ts";
import { ageWorktree, createRepo, git, write } from "./helpers.ts";
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
    worktreeAgeMs: 2 * RECENT_WORKTREE_MS,
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

  test("a moved branch whose HEAD is inside the default branch passes despite a stale merged PR", () => {
    const snapshot = evidence({ ancestorOfDefault: true, head: OTHER_HEAD });
    expect(decideCleanupEligibility(snapshot)).toMatchObject({
      code: "unchanged-branch",
      eligible: true
    });
  });

  test("rejects a clean worktree with commits after merge, even for a dependency", () => {
    const snapshot = evidence({
      ancestorOfDefault: false,
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

  test("a Root with no merged PR and unique commits is a settled ineligible, not unknown", () => {
    const snapshot = withPrs([]);
    snapshot.ancestorOfDefault = false;
    expect(decideCleanupEligibility(snapshot)).toMatchObject({
      code: "no-merged-pr",
      eligible: false,
      status: "ineligible"
    });
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
    { ancestor: true, code: "unchanged-branch", expected: true, role: "dependency" },
    { ancestor: false, code: "no-merged-pr", expected: false, role: "dependency" },
    { ancestor: null, code: "ancestry-unavailable", expected: false, role: "dependency" },
    { ancestor: true, code: "unchanged-branch", expected: true, role: "root" },
    { ancestor: false, code: "no-merged-pr", expected: false, role: "root" },
    { ancestor: null, code: "ancestry-unavailable", expected: false, role: "root" }
  ] as const)(
    "ancestry=$ancestor, role=$role gives $code without a PR",
    ({ ancestor, code, expected, role }) => {
      const snapshot = withPrs([]);
      snapshot.ancestorOfDefault = ancestor;
      snapshot.candidate.role = role;
      expect(decideCleanupEligibility(snapshot)).toMatchObject({ code, eligible: expected });
    }
  );

  test.each([
    { age: RECENT_WORKTREE_MS - 1, code: "recent-worktree", status: "ineligible" },
    { age: null, code: "recent-worktree", status: "unknown" },
    { age: undefined, code: "recent-worktree", status: "unknown" },
    { age: RECENT_WORKTREE_MS, code: "unchanged-branch", status: "eligible" }
  ] as const)("ancestry-only proof with worktree age $age is $code", ({ age, code, status }) => {
    const snapshot = withPrs([]);
    snapshot.ancestorOfDefault = true;
    if (age === undefined) {
      delete snapshot.worktreeAgeMs;
    } else {
      snapshot.worktreeAgeMs = age;
    }
    expect(decideCleanupEligibility(snapshot)).toMatchObject({ code, status });
  });

  test("an exact merged PR does not wait for worktree age", () => {
    const snapshot = evidence({ ancestorOfDefault: true, worktreeAgeMs: 0 });
    expect(decideCleanupEligibility(snapshot).code).toBe("exact-merged-pr");
  });

  test("ancestry proof never overrides a dirty worktree", () => {
    const snapshot = withPrs([]);
    snapshot.ancestorOfDefault = true;
    snapshot.localBlock = {
      code: "dirty-worktree",
      eligible: false,
      evidence: ["?? new.txt"],
      status: "ineligible"
    };
    expect(decideCleanupEligibility(snapshot).code).toBe("dirty-worktree");
  });

  test.each([
    { age: RECENT_WORKTREE_MS - 1, code: "recent-worktree", status: "ineligible" },
    { age: null, code: "recent-worktree", status: "unknown" },
    { age: RECENT_WORKTREE_MS, code: "merged-pr-head", status: "eligible" }
  ] as const)(
    "an exact HEAD merged under another branch waits for age $age",
    ({ age, code, status }) => {
      const snapshot = withPrs([]);
      snapshot.ancestorOfDefault = false;
      snapshot.worktreeAgeMs = age;
      snapshot.commitPullRequests = [
        {
          ancestorOfDefault: true,
          pullRequest: {
            ...mergedPr(),
            head: { ...mergedPr().head, ref: "renamed" },
            merge_commit_sha: OTHER_HEAD
          }
        }
      ];
      expect(decideCleanupEligibility(snapshot)).toMatchObject({ code, status });
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

  test("finds an exact squash-merged HEAD on another branch, including later API pages", async () => {
    const fixture = createCommitPrFixture();
    const cache = createCleanupEvidenceCache();
    const snapshot = await collectCleanupEvidence(fixture.runtime, fixture.candidate, cache);
    expect(snapshot.ancestorOfDefault).toBeFalsy();
    expect(decideCleanupEligibility(snapshot)).toMatchObject({
      code: "merged-pr-head",
      eligible: true
    });
    expect(decideCleanupEligibility(snapshot).evidence).toContain(
      `merge commit ${fixture.commitPr.merge_commit_sha} is an ancestor of verified default HEAD ${snapshot.repository?.defaultHead}`
    );
    await collectCleanupEvidence(fixture.runtime, fixture.candidate, cache);
    expect(fixture.lookups()).toBe(1);
    expect(fixture.requests[0]).toContain(
      `repos/${REPOSITORY}/commits/${fixture.commitPr.head.sha}/pulls?per_page=100`
    );
    expect(fixture.requests[0]).toContain("--paginate");
    write(fixture.candidate.worktreePath, "uncommitted.txt", "new work\n");
    expect(
      decideCleanupEligibility(
        await collectCleanupEvidence(fixture.runtime, fixture.candidate, cache)
      ).code
    ).toBe("dirty-worktree");
  });

  test.each([
    "intermediate",
    "fork",
    "wrong-base",
    "wrong-repo",
    "unmerged",
    "open",
    "missing-merge",
    "rewritten"
  ] as const)("does not accept %s commit-associated PR evidence", async (kind) => {
    const fixture = createCommitPrFixture();
    const pr = fixture.commitPr;
    switch (kind) {
      case "intermediate": {
        pr.head.sha = OTHER_HEAD;
        break;
      }
      case "fork": {
        pr.head.repo.full_name = "fork/repo";
        break;
      }
      case "wrong-base": {
        pr.base.ref = "release";
        break;
      }
      case "wrong-repo": {
        pr.base.repo.full_name = "another/repo";
        break;
      }
      case "unmerged": {
        pr.merged_at = null;
        break;
      }
      case "open": {
        pr.state = "open";
        break;
      }
      case "missing-merge": {
        pr.merge_commit_sha = null;
        break;
      }
      case "rewritten": {
        pr.merge_commit_sha = pr.head.sha;
        break;
      }
      default: {
        throw new Error("Unexpected PR fixture variant");
      }
    }
    const snapshot = await collectCleanupEvidence(fixture.runtime, fixture.candidate);
    expect(decideCleanupEligibility(snapshot)).toMatchObject({
      code: "no-merged-pr",
      eligible: false,
      status: "ineligible"
    });
  });

  test.each([
    "unavailable",
    "malformed",
    "ambiguous",
    "merge-ancestry-unavailable",
    "open-branch",
    "changed-head"
  ] as const)("fails closed on %s during commit PR lookup", async (kind) => {
    const fixture = createCommitPrFixture();
    const original = fixture.runtime.execAsync;
    fixture.runtime.execAsync = async (command, args, options) => {
      if (kind === "open-branch" && args?.[1]?.includes("/pulls?state=")) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify([
            [
              {
                ...fixture.commitPr,
                head: { ...fixture.commitPr.head, ref: BRANCH },
                merged_at: null,
                state: "open"
              }
            ]
          ])
        };
      }
      if (args?.[1]?.includes("/commits/")) {
        if (kind === "unavailable") {
          throw new Error("offline");
        }
        if (kind === "malformed") {
          return { exitCode: 0, stderr: "", stdout: "[[{}]]" };
        }
        if (kind === "ambiguous") {
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify([[fixture.commitPr, { ...fixture.commitPr, number: 2 }]])
          };
        }
        if (kind === "merge-ancestry-unavailable") {
          fixture.commitPr.merge_commit_sha = OTHER_HEAD;
        }
        if (kind === "changed-head") {
          write(fixture.candidate.worktreePath, "after.txt", "after lookup\n");
          git(fixture.candidate.worktreePath, ["add", "."]);
          git(fixture.candidate.worktreePath, ["commit", "-m", "changed during lookup"]);
        }
      }
      return await original(command, args, options);
    };
    const snapshot = await collectCleanupEvidence(fixture.runtime, fixture.candidate);
    const codes = {
      ambiguous: "ambiguous-pr",
      "changed-head": "changed-during-inspection",
      malformed: "commit-pr-unavailable",
      "merge-ancestry-unavailable": "ancestry-unavailable",
      "open-branch": "open-pr",
      unavailable: "commit-pr-unavailable"
    };
    expect(decideCleanupEligibility(snapshot)).toMatchObject({
      code: codes[kind],
      eligible: false
    });
  });

  test("verifies a missing local merge commit through remote comparison without fetching", async () => {
    const fixture = createCommitPrFixture();
    fixture.commitPr.merge_commit_sha = OTHER_HEAD;
    const original = fixture.runtime.execAsync;
    fixture.runtime.execAsync = async (command, args, options) => {
      if (args?.[1]?.includes(`/compare/${OTHER_HEAD}...`)) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            behind_by: 0,
            merge_base_commit: { sha: OTHER_HEAD },
            status: "ahead"
          })
        };
      }
      return await original(command, args, options);
    };
    expect(
      decideCleanupEligibility(await collectCleanupEvidence(fixture.runtime, fixture.candidate))
        .code
    ).toBe("merged-pr-head");
  });

  test.each([404, 422])(
    "a commit GitHub has never seen remains a settled skip (HTTP %s)",
    async (status) => {
      const fixture = createCommitPrFixture();
      const original = fixture.runtime.execAsync;
      fixture.runtime.execAsync = async (command, args, options) => {
        if (args?.[1]?.includes("/commits/")) {
          const stderr =
            status === 404
              ? "gh: Not Found (HTTP 404)"
              : `gh: No commit found for SHA: ${fixture.commitPr.head.sha} (HTTP 422)`;
          // Exercise the real command adapter: without allowFailure it throws before HTTP classification.
          return await fixture.baseRuntime.execAsync(
            "bun",
            ["-e", `process.stderr.write(${JSON.stringify(stderr)}); process.exit(1);`],
            options
          );
        }
        return await original(command, args, options);
      };
      expect(
        decideCleanupEligibility(await collectCleanupEvidence(fixture.runtime, fixture.candidate))
      ).toMatchObject({ code: "no-merged-pr", status: "ineligible" });
    }
  );

  test("an unrelated HTTP 422 remains an unavailable provider check", async () => {
    const fixture = createCommitPrFixture();
    const original = fixture.runtime.execAsync;
    fixture.runtime.execAsync = async (command, args, options) => {
      if (args?.[1]?.includes("/commits/")) {
        return { exitCode: 1, stderr: "gh: Validation Failed (HTTP 422)", stdout: "" };
      }
      return await original(command, args, options);
    };
    expect(
      decideCleanupEligibility(await collectCleanupEvidence(fixture.runtime, fixture.candidate))
    ).toMatchObject({ code: "commit-pr-unavailable", status: "unknown" });
  });

  test.each(["root", "dependency"] as const)(
    "proves an unchanged %s against the current default without a PR",
    async (role) => {
      const fixture = createFixture();
      fixture.pr.head.ref = "another-branch";
      const candidate = { ...fixture.candidate, role };
      const snapshot = await collectCleanupEvidence(fixture.runtime, candidate);
      expect(decideCleanupEligibility(snapshot)).toMatchObject({
        code: "unchanged-branch",
        eligible: true
      });
      write(candidate.worktreePath, "unique.txt", "new work\n");
      git(candidate.worktreePath, ["add", "."]);
      git(candidate.worktreePath, ["commit", "-m", "unique"]);
      const unique = await collectCleanupEvidence(fixture.runtime, candidate);
      // Never pushed: no remote compare is possible, and none is needed.
      expect(decideCleanupEligibility(unique)).toMatchObject({
        code: "no-merged-pr",
        eligible: false,
        status: "ineligible"
      });
    }
  );

  test.each([
    { comparison: "ahead", expected: true, label: "remote ancestry proof" },
    { comparison: "behind", expected: false, label: "unique dependency commits" },
    { comparison: "unavailable", expected: false, label: "unavailable ancestry" },
    { comparison: "not-found", expected: false, label: "a commit GitHub has never seen" }
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
        if (comparison === "not-found") {
          return { exitCode: 1, stderr: "gh: Not Found (HTTP 404)", stdout: "" };
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
      eligible: false,
      evidence: [
        kind === "untracked"
          ? "?? new.txt"
          : kind === "staged"
            ? "M  tracked.txt"
            : " M tracked.txt"
      ]
    });
  });

  test("dirty evidence lists at most five paths and counts the rest", async () => {
    const fixture = createFixture();
    for (const index of [1, 2, 3, 4, 5, 6, 7]) {
      write(fixture.candidate.worktreePath, `new-${index}.txt`, "edited\n");
    }
    const snapshot = await collectCleanupEvidence(fixture.runtime, fixture.candidate);
    const { evidence: details } = decideCleanupEligibility(snapshot);
    expect(details).toHaveLength(6);
    expect(details.at(-1)).toBe("and 2 more");
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
      let chopAccepted = true;
      try {
        assertCleanWorktree(fixture.baseRuntime, worktreePath);
      } catch {
        chopAccepted = false;
      }
      expect([eligibleForCleanup(snapshot), chopAccepted]).toStrictEqual([false, false]);
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
        cache.repositories.clear();
        cache.commitPullRequests.clear();
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

function createCommitPrFixture() {
  const fixture = createFixture();
  const { sourceRoot, worktreePath } = fixture.candidate;
  write(worktreePath, "feature.txt", "work merged under a different branch\n");
  git(worktreePath, ["add", "."]);
  git(worktreePath, ["commit", "-m", "feature"]);
  const head = git(worktreePath, ["rev-parse", "HEAD"]);
  git(sourceRoot, ["merge", "--squash", BRANCH]);
  git(sourceRoot, ["commit", "-m", "squashed feature"]);
  const commitPr: Omit<ReturnType<typeof mergedPr>, "state" | "merged_at"> & {
    merge_commit_sha: string | null;
    merged_at: string | null;
    state: "closed" | "open";
  } = {
    ...mergedPr(),
    head: { ref: "feature/merged-name", repo: { full_name: REPOSITORY }, sha: head },
    merge_commit_sha: git(sourceRoot, ["rev-parse", "HEAD"]),
    merged_at: "2026-09-06T00:00:00Z",
    state: "closed"
  };
  let lookups = 0;
  const requests: string[][] = [];
  const original = fixture.runtime.execAsync;
  fixture.runtime.execAsync = async (command, args, options) => {
    if (args?.[1]?.includes("/commits/")) {
      lookups += 1;
      requests.push(args);
      return { exitCode: 0, stderr: "", stdout: JSON.stringify([[], [commitPr]]) };
    }
    if (args?.[1]?.includes("/pulls?state=")) {
      return { exitCode: 0, stderr: "", stdout: "[[]]" };
    }
    return await original(command, args, options);
  };
  return { ...fixture, commitPr, lookups: () => lookups, requests };
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
  ageWorktree(worktreePath);
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
      if (endpoint?.includes("/commits/") && endpoint.endsWith("/pulls?per_page=100")) {
        return { exitCode: 0, stderr: "", stdout: "[[]]" };
      }
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
