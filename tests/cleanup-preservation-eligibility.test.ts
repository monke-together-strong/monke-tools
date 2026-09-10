import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  collectCleanupEvidence,
  decideCleanupEligibility,
  revalidateCleanupEvidence
} from "../src/cleanup-eligibility.ts";
import type { CleanupCandidate, CleanupRepositoryEvidence } from "../src/cleanup-eligibility.ts";
import type { Runtime } from "../src/types.ts";
import { ageWorktree, createRepo, git, write } from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

const REPOSITORY = "owner/preservation";
const BRANCH = "feature/preserved";
const sandboxes: string[] = [];
type PullRequest = CleanupRepositoryEvidence["pullRequests"][number];

describe("cleanup preservation collection", () => {
  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) {
      rmSync(sandbox, { force: true, recursive: true });
    }
  });

  function fixture(options: { detached?: boolean; ordinary?: boolean; recent?: boolean } = {}) {
    const tempRoot = path.resolve("tmp");
    mkdirSync(tempRoot, { recursive: true });
    const sandbox = mkdtempSync(path.join(tempRoot, "cleanup-preservation-"));
    sandboxes.push(sandbox);
    const sourceRoot = createRepo(path.join(sandbox, "source"), {
      "other.txt": "unchanged\n",
      "tracked.txt": "original\n"
    });
    const worktreePath = path.join(sandbox, "worktree");
    git(sourceRoot, ["remote", "add", "origin", `git@github.com:${REPOSITORY}.git`]);
    git(sourceRoot, ["worktree", "add", "-b", BRANCH, worktreePath]);
    if (options.detached) {
      git(worktreePath, ["checkout", "--detach"]);
    }
    if (!options.recent) {
      ageWorktree(worktreePath);
    }
    const candidate: CleanupCandidate = {
      sourceRoot,
      worktreePath,
      ...(options.ordinary ? {} : { sessionBranch: BRANCH })
    };
    const prs: PullRequest[] = [];
    const baseRuntime = createTestRuntime({ cwd: sourceRoot });
    const runtime: Runtime = {
      ...baseRuntime,
      async execAsync(command, args) {
        expect(command).toBe("gh");
        const endpoint = args?.[1];
        const responses = {
          [`repos/${REPOSITORY}/git/ref/heads/main`]: {
            object: { sha: git(sourceRoot, ["rev-parse", "main"]) }
          },
          [`repos/${REPOSITORY}/pulls?state=all&per_page=100`]: [prs],
          [`repos/${REPOSITORY}`]: { default_branch: "main", full_name: REPOSITORY }
        };
        const response =
          endpoint?.includes("/commits/") && endpoint.endsWith("/pulls?per_page=100")
            ? [[]]
            : Object.entries(responses).find(([key]) => key === endpoint)?.[1];
        if (!response) {
          throw new Error(`Unexpected API endpoint: ${endpoint}`);
        }
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(response) };
      }
    };
    return { candidate, prs, runtime, sourceRoot, worktreePath };
  }

  function commit(root: string, contents: string, message: string) {
    write(root, "tracked.txt", contents);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", message]);
    return git(root, ["rev-parse", "HEAD"]);
  }

  function landPending(item: ReturnType<typeof fixture>) {
    const witness = commit(item.sourceRoot, "landed\n", "land pending changes");
    write(item.worktreePath, "tracked.txt", "landed\n");
    return witness;
  }

  function pullRequest(head: string, patch: Partial<PullRequest> = {}): PullRequest {
    return {
      base: { ref: "main", repo: { full_name: REPOSITORY } },
      head: { ref: BRANCH, repo: { full_name: REPOSITORY }, sha: head },
      html_url: `https://github.com/${REPOSITORY}/pull/1`,
      merged_at: "2026-09-06T00:00:00Z",
      number: 1,
      state: "closed",
      ...patch
    };
  }

  describe("managed pending-work evidence", () => {
    test("collects a forward bundle and committed ancestry together", async () => {
      const item = fixture();
      const witness = landPending(item);
      const snapshot = await collectCleanupEvidence(item.runtime, item.candidate);
      expect(snapshot.pendingWork).toMatchObject({
        kind: "forward-bundle",
        paths: ["tracked.txt"],
        witness
      });
      expect(snapshot.ancestorOfDefault).toBeTruthy();
      expect(decideCleanupEligibility(snapshot)).toMatchObject({
        code: "unchanged-branch",
        eligible: true
      });
      expect(revalidateCleanupEvidence(item.runtime, snapshot)).toBeNull();
    });

    test("does not apply pending-work exceptions to an ordinary worktree", async () => {
      const item = fixture({ ordinary: true });
      landPending(item);
      const snapshot = await collectCleanupEvidence(item.runtime, item.candidate);
      expect(snapshot.pendingWork).toBeUndefined();
      expect(decideCleanupEligibility(snapshot)).toMatchObject({
        code: "dirty-worktree",
        eligible: false
      });
    });

    test("a merged PR does not waive the age gate for accepted dirt", async () => {
      const item = fixture({ recent: true });
      landPending(item);
      item.prs.push(pullRequest(git(item.worktreePath, ["rev-parse", "HEAD"])));
      const snapshot = await collectCleanupEvidence(item.runtime, item.candidate);
      expect(snapshot.pendingWork?.kind).toBe("forward-bundle");
      expect(decideCleanupEligibility(snapshot)).toMatchObject({
        code: "recent-worktree",
        eligible: false
      });
    });

    test("an exact merged PR cannot excuse unpreserved pending bytes", async () => {
      const item = fixture();
      landPending(item);
      item.prs.push(pullRequest(git(item.worktreePath, ["rev-parse", "HEAD"])));
      write(item.worktreePath, "other.txt", "unique pending work\n");
      const snapshot = await collectCleanupEvidence(item.runtime, item.candidate);
      expect(snapshot.pendingWork).toBeUndefined();
      expect(decideCleanupEligibility(snapshot)).toMatchObject({
        code: "dirty-worktree",
        eligible: false
      });
    });

    test("rejects changed dirty bytes with identical status during provider reads", async () => {
      const item = fixture();
      landPending(item);
      const status = git(item.worktreePath, ["status", "--porcelain=v1"]);
      const original = item.runtime.execAsync;
      item.runtime.execAsync = async (...args) => {
        write(item.worktreePath, "tracked.txt", "unique!\n");
        return await original(...args);
      };
      const snapshot = await collectCleanupEvidence(item.runtime, item.candidate);
      expect(decideCleanupEligibility(snapshot)).toMatchObject({
        code: "changed-during-inspection",
        eligible: false
      });
      expect(git(item.worktreePath, ["status", "--porcelain=v1"])).toBe(status);
    });

    test("rejects changed dirty bytes with identical status after collection", async () => {
      const item = fixture();
      landPending(item);
      const status = git(item.worktreePath, ["status", "--porcelain=v1"]);
      const snapshot = await collectCleanupEvidence(item.runtime, item.candidate);
      expect(decideCleanupEligibility(snapshot).eligible).toBeTruthy();
      write(item.worktreePath, "tracked.txt", "unique!\n");
      expect(revalidateCleanupEvidence(item.runtime, snapshot)?.code).toBe(
        "changed-during-inspection"
      );
      expect(git(item.worktreePath, ["status", "--porcelain=v1"])).toBe(status);
    });

    test("rejects hidden index entries even when another path is visibly dirty", async () => {
      const item = fixture();
      landPending(item);
      git(item.worktreePath, ["update-index", "--assume-unchanged", "other.txt"]);
      write(item.worktreePath, "other.txt", "hidden unique bytes\n");
      const snapshot = await collectCleanupEvidence(item.runtime, item.candidate);
      expect(decideCleanupEligibility(snapshot)).toMatchObject({
        code: "hidden-index-entries",
        eligible: false
      });
    });
  });

  describe("complete default-tree and detached evidence", () => {
    test.each([false, true])(
      "accepts an exact historical whole tree after a rewrite, detached=%s",
      async (detached) => {
        const item = fixture({ detached });
        const witness = commit(item.sourceRoot, "same snapshot\n", "landed implementation");
        commit(item.sourceRoot, "newer main\n", "subsequent main change");
        const head = commit(item.worktreePath, "same snapshot\n", "rewritten implementation");
        expect(head).not.toBe(witness);
        const snapshot = await collectCleanupEvidence(item.runtime, item.candidate);
        expect(snapshot.ancestorOfDefault).toBeFalsy();
        expect(snapshot.defaultTree).toMatchObject({
          tree: git(item.sourceRoot, ["rev-parse", `${witness}^{tree}`]),
          witness
        });
        expect(decideCleanupEligibility(snapshot)).toMatchObject({
          code: "matching-default-tree",
          eligible: true
        });
        write(item.worktreePath, "other.txt", "different complete tree\n");
        git(item.worktreePath, ["add", "."]);
        git(item.worktreePath, ["commit", "-m", "unique file outside matching path"]);
        const different = await collectCleanupEvidence(item.runtime, item.candidate);
        expect(different.defaultTree).toBeFalsy();
        expect(decideCleanupEligibility(different).eligible).toBeFalsy();
      }
    );

    test("accepts old managed detached ancestry and invalidates a changed detached HEAD", async () => {
      const item = fixture({ detached: true });
      const snapshot = await collectCleanupEvidence(item.runtime, item.candidate);
      expect(snapshot.branch).toBeNull();
      expect(decideCleanupEligibility(snapshot)).toMatchObject({
        code: "unchanged-branch",
        eligible: true
      });
      commit(item.worktreePath, "new detached work\n", "new detached commit");
      expect(revalidateCleanupEvidence(item.runtime, snapshot)?.code).toBe(
        "changed-during-inspection"
      );
    });

    test.each([
      { label: "retained Session branch", ref: BRANCH, sameHead: false },
      { label: "same-repository exact head", ref: "another-branch", sameHead: true }
    ])("an open PR on $label blocks detached ancestry", async ({ ref, sameHead }) => {
      const item = fixture({ detached: true });
      const head = sameHead ? git(item.worktreePath, ["rev-parse", "HEAD"]) : "f".repeat(40);
      item.prs.push(
        pullRequest(head, {
          head: { ref, repo: { full_name: REPOSITORY }, sha: head },
          merged_at: null,
          state: "open"
        })
      );
      const snapshot = await collectCleanupEvidence(item.runtime, item.candidate);
      expect(decideCleanupEligibility(snapshot)).toMatchObject({
        code: "open-pr",
        eligible: false
      });
    });

    test.each([
      { code: "detached-head", ordinary: true, recent: false },
      { code: "recent-worktree", ordinary: false, recent: true }
    ])(
      "detached ordinary=$ordinary recent=$recent stays blocked",
      async ({ code, ordinary, recent }) => {
        const item = fixture({ detached: true, ordinary, recent });
        const snapshot = await collectCleanupEvidence(item.runtime, item.candidate);
        expect(decideCleanupEligibility(snapshot)).toMatchObject({ code, eligible: false });
      }
    );
  });
});
