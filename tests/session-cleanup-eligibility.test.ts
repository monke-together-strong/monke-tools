import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { stringify } from "yaml";

import { getExpectedWorktreePath } from "../src/git.ts";
import { inspectSessionCleanup } from "../src/session-cleanup-eligibility.ts";
import { createSessionCleanupReport } from "../src/session-cleanup-report.ts";
import { getSessionStateFilePath, saveSessionState } from "../src/session-state-store.ts";
import type { Runtime, SessionState } from "../src/types.ts";
import { preflightWorktreeRemoval } from "../src/worktree-safety.ts";
import { createRepo, git, write } from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

const sandboxes: string[] = [];

function fixture() {
  mkdirSync("tmp", { recursive: true });
  const sandbox = mkdtempSync(path.resolve("tmp/session-cleanup-"));
  sandboxes.push(sandbox);
  const home = path.join(sandbox, "home");
  const root = createRepo(path.join(sandbox, "root"), { "tracked.txt": "root\n" });
  const dependency = createRepo(path.join(sandbox, "dependency"), {
    "tracked.txt": "dependency\n"
  });
  const session = "feature/finished";
  const sources = [dependency, root];
  for (const source of sources) {
    git(source, [
      "remote",
      "add",
      "origin",
      `https://github.com/owner/${path.basename(source)}.git`
    ]);
    git(source, ["worktree", "add", "-b", session, getExpectedWorktreePath(home, source, session)]);
  }
  const state: SessionState = {
    generation: { number: 1, status: "complete" },
    repos: sources.map((sourceRoot) => ({
      assignedPorts: [],
      cleanupEligible: true,
      materializationStatus: "materialized",
      preparationStatus: "prepared",
      sourceRoot,
      worktreePath: getExpectedWorktreePath(home, sourceRoot, session)
    })),
    rootSourceRoot: root,
    session,
    version: 2
  };
  saveSessionState(home, state);
  const rootPath = getExpectedWorktreePath(home, root, session);
  const dependencyPath = getExpectedWorktreePath(home, dependency, session);
  // The Root has exact PR proof; the dependency has only default ancestry proof.
  const rootHead = git(rootPath, ["rev-parse", "HEAD"]);
  const baseRuntime = createTestRuntime({ cwd: root, env: { MONKE_HOME: home } });
  const runtime: Runtime = {
    ...baseRuntime,
    exec(command, args, options) {
      expect(command).toBe("git");
      expect(options?.env).toMatchObject({ GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" });
      expect(args).toContain("core.fsmonitor=false");
      return baseRuntime.exec(command, args, options);
    },
    async execAsync(command, args) {
      expect(command).toBe("gh");
      expect(args).toContain("github.com");
      const endpoint = args?.[1] ?? "";
      const repo = endpoint.includes("owner/dependency") ? "dependency" : "root";
      const source = repo === "root" ? root : dependency;
      const value = (() => {
        if (endpoint.includes("/git/ref/heads/")) {
          return { object: { sha: git(source, ["rev-parse", "main"]) } };
        } else if (endpoint.includes("/pulls?")) {
          return [
            repo === "root"
              ? [
                  {
                    base: { ref: "main", repo: { full_name: "owner/root" } },
                    head: { ref: session, repo: { full_name: "owner/root" }, sha: rootHead },
                    html_url: "https://github.com/owner/root/pull/1",
                    merged_at: "2026-09-06T00:00:00Z",
                    number: 1,
                    state: "closed"
                  }
                ]
              : []
          ];
        } else if (endpoint.includes("/compare/")) {
          return { behind_by: 1, merge_base_commit: { sha: rootHead }, status: "diverged" };
        }
        return { default_branch: "main", full_name: `owner/${repo}` };
      })();
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(value) };
    }
  };
  return { dependency, dependencyPath, home, root, rootPath, runtime, sandbox, state };
}

function nestedChild(f: ReturnType<typeof fixture>, childSource: string) {
  const child = path.join(f.rootPath, "child");
  writeFileSync(path.join(f.root, ".git/info/exclude"), "child/\n");
  git(childSource, ["worktree", "add", "-b", "child-branch", child]);
  write(child, "unfinished.txt", "child work\n");
  return child;
}

async function decisionFor(f: ReturnType<typeof fixture>) {
  const report = await inspectSessionCleanup(f.runtime, f.home);
  const result = report.sessions.find(
    (row) => row.snapshot.session === f.state.session && row.snapshot.rootSourceRoot === f.root
  );
  if (!result) {
    throw new Error("Expected Session missing from report");
  }
  return result;
}

describe("whole-Session read-only eligibility", () => {
  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) {
      rmSync(sandbox, { force: true, recursive: true });
    }
  });

  test("requires Root PR proof and accepts its unchanged dependency, without effects", async () => {
    const f = fixture();
    const statePath = getSessionStateFilePath(f.home, f.root, f.state.session);
    const before = readFileSync(statePath, "utf-8");
    const result = await decisionFor(f);
    expect(result.decision).toMatchObject({ eligible: true, kind: "live" });
    expect(result.decision.reasons).toStrictEqual(["unchanged-dependency", "exact-merged-pr"]);
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    expect(existsSync(f.rootPath)).toBeTruthy();
    expect(existsSync(path.join(f.home, "lock"))).toBeFalsy();
  });

  test.each(["dirty", "unique-commit", "detached", "locked"])(
    "a %s dependency blocks the entire Session",
    async (kind) => {
      const f = fixture();
      if (kind === "dirty" || kind === "unique-commit") {
        write(f.dependencyPath, "tracked.txt", "unfinished\n");
        if (kind === "unique-commit") {
          git(f.dependencyPath, ["commit", "-am", "unfinished"]);
        }
      } else if (kind === "detached") {
        git(f.dependencyPath, ["checkout", "--detach"]);
      } else {
        git(f.dependency, ["worktree", "lock", f.dependencyPath]);
      }
      const result = await decisionFor(f);
      expect(result.decision.eligible).toBeFalsy();
    }
  );

  test("two Session records claiming one dependency block both owners", async () => {
    const f = fixture();
    const [dependencyRepo] = f.state.repos;
    if (!dependencyRepo) {
      throw new Error("Missing fixture dependency");
    }
    saveSessionState(f.home, { ...f.state, repos: [dependencyRepo], rootSourceRoot: f.dependency });
    const report = await inspectSessionCleanup(f.runtime, f.home);
    expect(report.sessions).toHaveLength(2);
    for (const row of report.sessions) {
      expect(row.decision.eligible).toBeFalsy();
      expect(row.decision.reasons).toContain("ownership-conflict");
    }
  });

  test.each([false, true])(
    "a corrupt record with overlap=%s is isolated only with bounded ownership",
    async (overlap) => {
      const f = fixture();
      const otherRoot = overlap ? f.dependency : path.join(f.sandbox, "unrelated");
      const corrupt = {
        ...f.state,
        repos: [
          {
            sourceRoot: otherRoot,
            worktreePath: getExpectedWorktreePath(f.home, otherRoot, "broken")
          }
        ],
        rootSourceRoot: otherRoot,
        session: "broken",
        version: 1
      };
      writeFileSync(path.join(f.home, "sessions", "corrupt.yml"), stringify(corrupt));
      const report = await inspectSessionCleanup(f.runtime, f.home);
      const valid = report.sessions.find((row) => row.snapshot.session === f.state.session);
      expect(valid?.decision.eligible).toBe(!overlap);
      expect(
        report.sessions.find((row) => row.snapshot.session === null)?.decision.reasons
      ).toContain("invalid-state");
    }
  );

  test("unreadable ownership cannot be bounded by an unrelated absolute scalar", async () => {
    const f = fixture();
    writeFileSync(
      path.join(f.home, "sessions", "corrupt.yml"),
      "unrelated: /somewhere/else\nrepos: [\n"
    );
    const result = await decisionFor(f);
    expect(result.decision.reasons).toContain("invalid-state-overlap");
  });

  test.each(["hold", "operation-lock", "state-change", "member-change"])(
    "%s blocks a finished Session",
    async (kind) => {
      const f = fixture();
      if (kind === "hold") {
        saveSessionState(f.home, { ...f.state, cleanupHold: true });
      } else if (kind === "operation-lock") {
        writeFileSync(path.join(f.home, "lock"), "unverified lock");
      } else {
        const original = f.runtime.execAsync;
        f.runtime.execAsync = async (command, args, options) => {
          const result = await original(command, args, options);
          if (args?.[1]?.includes("owner/root/pulls?")) {
            if (kind === "state-change") {
              saveSessionState(f.home, { ...f.state, cleanupHold: true });
            } else {
              write(f.dependencyPath, "late.txt", "work arrived during Root lookup\n");
            }
          }
          return result;
        };
      }
      const result = await decisionFor(f);
      expect(result.decision.eligible).toBeFalsy();
    }
  );

  test("rechecks an earlier dependency after the Root finishes its provider reads", async () => {
    const f = fixture();
    const original = f.runtime.exec;
    let dependencyStatuses = 0;
    let rootStatuses = 0;
    let injected = false;
    f.runtime.exec = (command, args, options) => {
      const result = original(command, args, options);
      if (args?.includes("status")) {
        if (options?.cwd === f.dependencyPath) {
          dependencyStatuses += 1;
        }
        if (options?.cwd === f.rootPath) {
          rootStatuses += 1;
        }
        if (!injected && dependencyStatuses >= 2 && rootStatuses >= 2) {
          write(f.dependencyPath, "late.txt", "new work after dependency inspection\n");
          injected = true;
        }
      }
      return result;
    };
    const result = await decisionFor(f);
    expect(injected).toBeTruthy();
    expect(result.decision.eligible).toBeFalsy();
    expect(result.decision.reasons).toContain("member-changed-during-inspection");
  });

  test.each(["root", "dependency"])(
    "recovers a Session with a verified absent %s",
    async (missing) => {
      const f = fixture();
      const source = missing === "root" ? f.root : f.dependency;
      const target = missing === "root" ? f.rootPath : f.dependencyPath;
      git(source, ["worktree", "remove", target]);
      const result = await decisionFor(f);
      expect(result.decision).toMatchObject({ eligible: true, kind: "recovery" });
      const remaining = missing === "root" ? f.dependencyPath : f.rootPath;
      write(remaining, "untracked.txt", "unfinished work\n");
      const dirty = await decisionFor(f);
      expect(dirty.decision.eligible).toBeFalsy();
    }
  );

  test("fully absent owned members can finalize, but a Session branch elsewhere blocks", async () => {
    const f = fixture();
    git(f.root, ["worktree", "remove", f.rootPath]);
    git(f.dependency, ["worktree", "remove", f.dependencyPath]);
    const gone = await decisionFor(f);
    expect(gone.decision).toMatchObject({ eligible: true, kind: "finalization" });
    git(f.root, ["worktree", "add", path.join(f.sandbox, "elsewhere"), f.state.session]);
    const result = await decisionFor(f);
    expect(result.decision.eligible).toBeFalsy();
  });

  test("a skipped Session invalidates an earlier member that changes during provider lookup", async () => {
    const f = fixture();
    const original = f.runtime.execAsync;
    f.runtime.execAsync = async (command, args, options) => {
      const result = await original(command, args, options);
      if (args?.[1]?.includes("owner/root/pulls?")) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
        write(f.dependencyPath, "late.txt", "new work\n");
        return { ...result, stdout: "[[]]" };
      }
      return result;
    };
    const result = await decisionFor(f);
    expect(result.decision.reasons).toContain("member-changed-during-inspection");
    const report = createSessionCleanupReport(result.snapshot);
    expect(report.members[0]?.checks.local.status).toBe("unknown");
    expect(report.members[0]?.checks.committedWork.status).toBe("unknown");
  });

  test("a stale member changing registered branches invalidates recovery", async () => {
    const f = fixture();
    const admin = git(f.dependencyPath, ["rev-parse", "--absolute-git-dir"]);
    renameSync(f.dependencyPath, path.join(f.sandbox, "moved"));
    const original = f.runtime.execAsync;
    f.runtime.execAsync = async (command, args, options) => {
      const result = await original(command, args, options);
      if (args?.[1]?.includes("owner/root/pulls?")) {
        writeFileSync(path.join(admin, "HEAD"), "ref: refs/heads/different\n");
      }
      return result;
    };
    const result = await decisionFor(f);
    expect(result.decision.eligible).toBeFalsy();
    expect(result.decision.reasons).toContain("member-changed-during-inspection");
  });

  test("nested retained ownership and Ordinary preflight protect a dirty child", async () => {
    const f = fixture();
    const child = nestedChild(f, f.root);
    const rootRepo = f.state.repos.find((repo) => repo.sourceRoot === f.root);
    if (!rootRepo) {
      throw new Error("Missing Root fixture");
    }
    const childState = {
      ...f.state,
      repos: [{ ...rootRepo, worktreePath: child }],
      session: `${f.state.session}/child`
    };
    saveSessionState(f.home, childState);
    const owned = await decisionFor(f);
    expect(owned.decision.reasons).toContain("ownership-conflict");
    renameSync(
      getSessionStateFilePath(f.home, f.root, childState.session),
      path.join(f.sandbox, "retained-child.yml")
    );
    const unowned = await decisionFor(f);
    expect(unowned.decision.reasons).toContain("ownership-conflict");
    for (const force of [false, true]) {
      expect(() =>
        preflightWorktreeRemoval(createTestRuntime({ cwd: f.root }), f.root, f.rootPath, { force })
      ).toThrow(/overlaps another registered worktree/u);
    }
  });

  test("a nested unowned worktree from another known Source blocks the parent", async () => {
    const f = fixture();
    nestedChild(f, f.dependency);
    const unowned = await decisionFor(f);
    expect(unowned.decision.eligible).toBeFalsy();
    expect(unowned.decision.reasons).toContain("ownership-conflict");
  });

  test("an unowned worktree is reported without inferring Session membership", async () => {
    const f = fixture();
    const ordinary = path.join(f.sandbox, "ordinary");
    git(f.root, ["worktree", "add", "-b", "ordinary", ordinary]);
    const report = await inspectSessionCleanup(f.runtime, f.home, [`${f.root}/.`, f.root]);
    expect(report.unownedWorktrees).toStrictEqual([
      { branch: "ordinary", eligible: false, sourceRoot: f.root, worktreePath: ordinary }
    ]);
  });
});
