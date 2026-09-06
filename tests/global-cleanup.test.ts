import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  lstatSync
} from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import * as z from "zod";

import { getExpectedWorktreePath } from "../src/git.ts";
import { runCliAsync } from "../src/index.ts";
import { saveSessionState, getSessionStateFilePath } from "../src/session-state-store.ts";
import type { SessionState } from "../src/types.ts";
import { createRepo, git, write } from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

const ActionSchema = z.object({
  command: z.string().optional(),
  sourceRoot: z.string(),
  step: z.string(),
  worktreePath: z.string().optional()
});
const ReportSchema = z.object({
  exitCode: z.number(),
  globalFailure: z.string().nullable(),
  sessions: z.array(
    z.object({
      execution: z.object({
        attemptedAction: ActionSchema.optional(),
        completedActions: z.array(ActionSchema).optional(),
        outcome: z.string(),
        remainingActions: z.array(ActionSchema).optional(),
        retryCleanupCommands: z.array(ActionSchema).optional(),
        sourceRoot: z.string().optional(),
        step: z.string().optional()
      }),
      inspectionFailed: z.boolean(),
      members: z.array(z.object({ checks: z.object({ local: z.object({ status: z.string() }) }) })),
      outcome: z.string(),
      plannedActions: z.array(ActionSchema),
      reasons: z.array(z.object({ code: z.string() })),
      session: z.string().nullable()
    })
  ),
  unavailableSources: z.array(z.string()),
  unownedWorktrees: z.array(z.unknown())
});
const sandboxes: string[] = [];
function sandbox() {
  mkdirSync("tmp", { recursive: true });
  const directory = mkdtempSync(path.resolve("tmp/global-cleanup-"));
  sandboxes.push(directory);
  return directory;
}

describe("global Session cleanup", () => {
  afterEach(() => {
    for (const directory of sandboxes.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("dry-run outside a repository reports an empty inventory without creating Monke home", async () => {
    const cwd = sandbox();
    const home = path.join(cwd, "absent");
    let stdout = "";
    const runtime = createTestRuntime({
      cwd,
      env: { GIT_CEILING_DIRECTORIES: path.dirname(cwd), MONKE_HOME: home },
      onStdout: (text) => {
        stdout += text;
      }
    });
    expect(() => runtime.exec("git", ["rev-parse", "--show-toplevel"])).toThrow(
      /not a git repository/u
    );
    await runCliAsync(["cleanup", "--dry-run", "--json"], runtime);
    expect(JSON.parse(stdout)).toMatchObject({
      dryRun: true,
      exitCode: 0,
      schemaVersion: 1,
      sessions: [],
      unownedWorktrees: []
    });
    expect(existsSync(home)).toBeFalsy();
  });

  function fixture() {
    const cwd = sandbox();
    const home = path.join(cwd, "home");
    const sources = ["dependency", "root"].map((name) => {
      const source = createRepo(path.join(cwd, name), { "tracked.txt": `${name}\n` });
      git(source, ["remote", "add", "origin", `https://github.com/owner/${name}.git`]);
      return source;
    });
    const root = sources.at(1);
    if (!root) {
      throw new Error("Missing fixture Root");
    }
    const states: SessionState[] = [];
    function addSession(session: string, rootSourceRoot: string = root ?? "") {
      const state: SessionState = {
        generation: { number: 1, status: "complete" },
        repos: sources
          .filter((source) => rootSourceRoot === root || source === rootSourceRoot)
          .map((sourceRoot) => {
            const worktreePath = getExpectedWorktreePath(home, sourceRoot, session);
            git(sourceRoot, ["worktree", "add", "-b", session, worktreePath]);
            return {
              assignedPorts: [],
              cleanupEligible: true,
              materializationStatus: "materialized",
              preparationStatus: "prepared",
              sourceRoot,
              worktreePath
            };
          }),
        rootSourceRoot,
        session,
        version: 2
      };
      saveSessionState(home, state);
      states.push(state);
      return state;
    }
    let stdout = "";
    const runtime = createTestRuntime({
      cwd,
      env: { GIT_CEILING_DIRECTORIES: path.dirname(cwd), MONKE_HOME: home },
      onStdout: (text) => {
        stdout += text;
      }
    });
    runtime.execAsync = async (command, args) => {
      expect(command).toBe("gh");
      const endpoint = args?.[1] ?? "";
      const name = endpoint.includes("owner/dependency") ? "dependency" : "root";
      const source = sources.find((candidate) => path.basename(candidate) === name);
      if (!source) {
        throw new Error("Missing fixture Source");
      }
      const value = endpoint.includes("/git/ref/heads/")
        ? { object: { sha: git(source, ["rev-parse", "main"]) } }
        : endpoint.includes("/pulls?")
          ? [
              states
                .filter((state) => state.rootSourceRoot === source)
                .map((state, index) => ({
                  base: { ref: "main", repo: { full_name: `owner/${name}` } },
                  head: {
                    ref: state.session,
                    repo: { full_name: `owner/${name}` },
                    sha: git(source, ["rev-parse", state.session])
                  },
                  html_url: `https://github.com/owner/${name}/pull/${index + 1}`,
                  merged_at: "2026-09-06T00:00:00Z",
                  number: index + 1,
                  state: "closed"
                }))
            ]
          : { default_branch: "main", full_name: `owner/${name}` };
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(value) };
    };
    async function run(dryRun = false, invocationCwd = runtime.cwd) {
      stdout = "";
      let failure: unknown;
      try {
        await runCliAsync(["cleanup", "--json", ...(dryRun ? ["--dry-run"] : [])], {
          ...runtime,
          cwd: invocationCwd
        });
      } catch (error) {
        failure = error;
      }
      return { error: failure, report: ReportSchema.parse(JSON.parse(stdout)) };
    }
    return { addSession, cwd, home, root, run, runtime, sources };
  }

  function files(directory: string) {
    return Object.fromEntries(
      readdirSync(directory, { encoding: "utf-8", recursive: true }).map((relative) => {
        const target = path.join(directory, relative);
        const stat = lstatSync(target);
        return [
          relative,
          {
            content: stat.isFile() ? readFileSync(target).toString("base64") : null,
            mode: stat.mode,
            mtime: stat.mtimeMs
          }
        ];
      })
    );
  }

  test("global preview is immutable and execution cleans whole Sessions across Roots, preserving branches and unowned worktrees", async () => {
    const f = fixture();
    expect(() => f.runtime.exec("git", ["rev-parse", "--show-toplevel"])).toThrow(
      /not a git repository/u
    );
    const a = f.addSession("feature/a");
    const b = f.addSession("feature/b", f.sources[0]);
    const unowned = path.join(f.cwd, "ordinary");
    git(f.root, ["worktree", "add", "-b", "ordinary", unowned]);
    const before = files(f.cwd);
    const preview = await f.run(true);
    expect(preview.error).toBeUndefined();
    expect(preview.report.sessions.map((row: { outcome: string }) => row.outcome)).toStrictEqual([
      "would-clean",
      "would-clean"
    ]);
    expect(preview.report.unownedWorktrees).toHaveLength(1);
    expect(files(f.cwd)).toStrictEqual(before);
    const result = await f.run();
    expect(result.error).toBeUndefined();
    expect(result.report.sessions.map((row: { outcome: string }) => row.outcome)).toStrictEqual([
      "cleaned",
      "cleaned"
    ]);
    for (const state of [a, b]) {
      expect(
        existsSync(getSessionStateFilePath(f.home, state.rootSourceRoot, state.session))
      ).toBeFalsy();
      for (const repo of state.repos) {
        expect(existsSync(repo.worktreePath)).toBeFalsy();
        expect(git(repo.sourceRoot, ["rev-parse", "--verify", state.session])).toBeTruthy();
      }
    }
    expect(existsSync(unowned)).toBeTruthy();
  }, 30_000);

  test("human output leads with a summary and --eligible hides skipped Sessions", async () => {
    const f = fixture();
    f.addSession("feature/clean");
    const blocked = f.addSession("feature/blocked");
    const [dependency] = blocked.repos;
    if (!dependency) {
      throw new Error("Missing dependency");
    }
    write(dependency.worktreePath, "tracked.txt", "unfinished\n");
    let stdout = "";
    const runtime = {
      ...f.runtime,
      writeStdout(text: string) {
        stdout += text;
      }
    };
    await runCliAsync(["cleanup", "--dry-run"], runtime);
    const [summary] = stdout.split("\n");
    expect(summary).toBe("Inspected 2 Sessions: 1 would clean, 1 skipped");
    expect(stdout).toContain("Skipped: root / feature/blocked");
    expect(stdout).toContain("       M tracked.txt");
    stdout = "";
    await runCliAsync(["cleanup", "--dry-run", "--eligible"], runtime);
    expect(stdout).toContain("Would clean: root / feature/clean");
    expect(stdout).not.toContain("Skipped:");
  }, 30_000);

  test("one dirty member skips the whole Session before any effect", async () => {
    const f = fixture();
    const state = f.addSession("feature/blocked");
    const [dependency] = state.repos;
    if (!dependency) {
      throw new Error("Missing dependency");
    }
    write(dependency.worktreePath, "tracked.txt", "unfinished\n");
    const before = files(f.cwd);
    const result = await f.run();
    expect(result.error).toBeUndefined();
    expect(result.report.sessions[0]?.outcome).toBe("skipped");
    for (const repo of state.repos) {
      expect(existsSync(repo.worktreePath)).toBeTruthy();
    }
    // Real execution may create its lock, but no Session or Git files change on a skip.
    const after = files(f.cwd);
    expect({ ...after, home: before.home }).toStrictEqual(before);
  }, 30_000);

  test("foreign locks block execution and dry-run leaves them untouched", async () => {
    const f = fixture();
    const state = f.addSession("feature/locked");
    const contents = JSON.stringify({ acquiredAt: Date.now(), pid: process.pid });
    write(f.home, "lock", contents);
    const before = files(f.cwd);
    const preview = await f.run(true);
    expect(preview.report.exitCode).toBe(1);
    expect(files(f.cwd)).toStrictEqual(before);
    const result = await f.run();
    expect(result.report.globalFailure).toContain("Timed out waiting for lock");
    expect(readFileSync(path.join(f.home, "lock"), "utf-8")).toBe(contents);
    for (const repo of state.repos) {
      expect(existsSync(repo.worktreePath)).toBeTruthy();
    }
  }, 30_000);

  test("losing the acquired lock stops the run without deleting its replacement", async () => {
    const f = fixture();
    const state = f.addSession("feature/replaced-lock");
    const original = f.runtime.execAsync;
    f.runtime.execAsync = async (command, args, options) => {
      const result = await original(command, args, options);
      write(f.home, "lock", "replacement lock");
      return result;
    };
    const result = await f.run();
    expect(result.report.globalFailure).toContain("lock ownership lost");
    expect(readFileSync(path.join(f.home, "lock"), "utf-8")).toBe("replacement lock");
    for (const repo of state.repos) {
      expect(existsSync(repo.worktreePath)).toBeTruthy();
    }
  }, 30_000);

  test("removal failure reports completed work, retains state, and retries the remaining worktree", async () => {
    const f = fixture();
    const state = f.addSession("feature/partial");
    const original = f.runtime.exec;
    f.runtime.exec = (command, args, options) => {
      if (command === "git" && args?.includes("remove") && options?.cwd === f.root) {
        throw new Error("removal failed");
      }
      return original(command, args, options);
    };
    const result = await f.run();
    expect(result.report.sessions[0]).toMatchObject({
      execution: {
        completedActions: [{ sourceRoot: f.sources[0], step: "worktree-removal" }],
        remainingActions: [
          { sourceRoot: f.root, step: "worktree-removal" },
          { step: "state-removal" }
        ],
        sourceRoot: f.root,
        step: "worktree-removal"
      },
      outcome: "failed"
    });
    expect(existsSync(getSessionStateFilePath(f.home, f.root, state.session))).toBeTruthy();
    f.runtime.exec = original;
    const retry = await f.run();
    expect(retry.error).toBeUndefined();
    expect(retry.report.sessions[0]?.outcome).toBe("cleaned");
  }, 30_000);

  test("a member that changes after another removal stops the Session and preserves its new work", async () => {
    const f = fixture();
    const state = f.addSession("feature/race");
    const rootRepo = state.repos.find((repo) => repo.sourceRoot === f.root);
    if (!rootRepo) {
      throw new Error("Missing Root member");
    }
    const original = f.runtime.exec;
    f.runtime.exec = (command, args, options) => {
      const result = original(command, args, options);
      if (command === "git" && args?.includes("remove")) {
        write(rootRepo.worktreePath, "tracked.txt", "late change\n");
      }
      return result;
    };
    const result = await f.run();
    expect(result.report.sessions[0]).toMatchObject({
      execution: {
        completedActions: [{ step: "worktree-removal" }],
        sourceRoot: f.root,
        step: "revalidation"
      },
      outcome: "failed"
    });
    expect(readFileSync(path.join(rootRepo.worktreePath, "tracked.txt"), "utf-8")).toBe(
      "late change\n"
    );
  }, 30_000);

  test("Cleanup commands rerun from the beginning after failure while independent Sessions continue", async () => {
    const f = fixture();
    const state = f.addSession("feature/retry");
    const independent = f.addSession("feature/independent", f.sources[0]);
    const log = path.join(f.cwd, "commands.log");
    const allow = path.join(f.cwd, "allow");
    const withCommands = {
      ...state,
      repos: state.repos.map((repo) => ({
        ...repo,
        cleanupCommand:
          repo.sourceRoot === f.root
            ? `printf 'root\\n' >> '${log}'; printf 'command stdout'`
            : `printf 'dependency\\n' >> '${log}'; test -f '${allow}'`
      }))
    };
    saveSessionState(f.home, withCommands);
    const result = await f.run();
    const failed = result.report.sessions.find((row) => row.session === state.session);
    expect(failed).toMatchObject({
      execution: { sourceRoot: f.sources[0], step: "cleanup-command" },
      outcome: "failed"
    });
    expect(failed?.execution.retryCleanupCommands).toHaveLength(2);
    expect(result.report.sessions.find((row) => row.session === independent.session)?.outcome).toBe(
      "cleaned"
    );
    expect(readFileSync(log, "utf-8")).toBe("root\ndependency\n");
    write(f.cwd, "allow", "yes");
    const retry = await f.run();
    expect(retry.error).toBeUndefined();
    expect(retry.report.sessions[0]?.outcome).toBe("cleaned");
    expect(readFileSync(log, "utf-8")).toBe("root\ndependency\nroot\ndependency\n");
  }, 30_000);

  test("a Cleanup command that dirties a later Session causes fresh inspection to skip it", async () => {
    const f = fixture();
    const states = [f.addSession("feature/first"), f.addSession("feature/later")].toSorted((a, b) =>
      getSessionStateFilePath(f.home, f.root, a.session).localeCompare(
        getSessionStateFilePath(f.home, f.root, b.session)
      )
    );
    const [first, later] = states;
    if (!first || !later) {
      throw new Error("Missing Sessions");
    }
    const laterRoot = later.repos.find((repo) => repo.sourceRoot === f.root);
    if (!laterRoot) {
      throw new Error("Missing later Root");
    }
    saveSessionState(f.home, {
      ...first,
      repos: first.repos.map((repo) => ({
        ...repo,
        cleanupCommand:
          repo.sourceRoot === f.root
            ? `printf 'new work\\n' > '${path.join(laterRoot.worktreePath, "tracked.txt")}'`
            : undefined
      }))
    });
    const result = await f.run();
    expect(result.report.sessions.map((row) => row.outcome)).toStrictEqual(["cleaned", "skipped"]);
    expect(readFileSync(path.join(laterRoot.worktreePath, "tracked.txt"), "utf-8")).toBe(
      "new work\n"
    );
    for (const repo of later.repos) {
      expect(existsSync(repo.worktreePath)).toBeTruthy();
    }
  }, 30_000);

  test("JSON stays valid when cleanup removes the invoking dependency, and planned order matches execution", async () => {
    const f = fixture();
    const state = f.addSession("feature/current");
    const [dependency] = state.repos;
    if (!dependency) {
      throw new Error("Missing dependency");
    }
    const result = await f.run(false, dependency.worktreePath);
    expect(result.error).toBeUndefined();
    const [row] = result.report.sessions;
    expect(row?.execution.completedActions).toStrictEqual(row?.plannedActions);
    expect(row?.plannedActions[0]?.sourceRoot).toBe(f.root);
  }, 30_000);

  test("a missing Source is a settled skip, not an inspection error", async () => {
    const f = fixture();
    const [missing] = f.sources;
    if (!missing) {
      throw new Error("Missing fixture Source");
    }
    const clean = f.addSession("feature/clean");
    saveSessionState(f.home, {
      ...clean,
      repos: clean.repos.filter((repo) => repo.sourceRoot === f.root)
    });
    const dead = f.addSession("feature/dead", missing);
    rmSync(missing, { force: true, recursive: true });
    const preview = await f.run(true);
    expect(preview.error).toBeUndefined();
    expect(preview.report.exitCode).toBe(0);
    expect(preview.report.unavailableSources).toStrictEqual([]);
    const row = preview.report.sessions.find((session) => session.session === dead.session);
    expect(row?.outcome).toBe("skipped");
    expect(row?.inspectionFailed).toBeFalsy();
    expect(row?.reasons.map((reason) => reason.code)).toStrictEqual(["source-missing"]);
    expect(row?.members[0]?.checks.local.status).toBe("blocked");
    const result = await f.run();
    expect(result.error).toBeUndefined();
    expect(
      result.report.sessions.find((session) => session.session === clean.session)?.outcome
    ).toBe("cleaned");
    expect(
      existsSync(getSessionStateFilePath(f.home, dead.rootSourceRoot, dead.session))
    ).toBeTruthy();
  }, 30_000);

  test("an unavailable independent Source does not prevent cleaning an eligible Session", async () => {
    const f = fixture();
    const state = f.addSession("feature/available");
    const [missing] = f.sources;
    if (!missing) {
      throw new Error("Missing fixture Source");
    }
    const unavailable = f.addSession("feature/unavailable", missing);
    saveSessionState(f.home, {
      ...state,
      repos: state.repos.filter((repo) => repo.sourceRoot === f.root)
    });
    // Present but unverifiable: no longer a Git repository.
    rmSync(path.join(missing, ".git"), { force: true, recursive: true });
    const result = await f.run();
    expect(result.report.sessions.find((row) => row.session === state.session)?.outcome).toBe(
      "cleaned"
    );
    expect(result.report.sessions.find((row) => row.session === unavailable.session)?.outcome).toBe(
      "skipped"
    );
    expect(result.report.exitCode).toBe(1);
  }, 30_000);

  test("a waiting operation's reclaim marker does not invalidate or strand cleanup's own lock", async () => {
    const f = fixture();
    f.addSession("feature/contended");
    const original = f.runtime.execAsync;
    f.runtime.execAsync = async (command, args, options) => {
      const result = await original(command, args, options);
      mkdirSync(path.join(f.home, "lock.reclaim"), { recursive: true });
      return result;
    };
    const result = await f.run();
    expect(result.error).toBeUndefined();
    expect(result.report.sessions[0]?.outcome).toBe("cleaned");
    expect(existsSync(path.join(f.home, "lock"))).toBeFalsy();
    expect(existsSync(path.join(f.home, "lock.reclaim"))).toBeTruthy();
  }, 30_000);

  test.each(["dirty", "held"])(
    "%s eligibility does not hide unknown member evidence in either mode",
    async (blocker) => {
      const f = fixture();
      const state = f.addSession("feature/unknown");
      const [dependency] = state.repos;
      if (!dependency) {
        throw new Error("Missing dependency");
      }
      if (blocker === "dirty") {
        write(dependency.worktreePath, "tracked.txt", "unfinished\n");
      } else {
        saveSessionState(f.home, { ...state, cleanupHold: true });
      }
      const original = f.runtime.execAsync;
      f.runtime.execAsync = (command, args, options) => {
        if (args?.[1]?.includes("owner/root")) {
          throw new Error("GitHub unavailable");
        }
        return original(command, args, options);
      };
      const preview = await f.run(true);
      expect(preview.report.exitCode).toBe(1);
      expect(preview.report.sessions[0]?.outcome).toBe("skipped");
      const execution = await f.run();
      expect(execution.report.exitCode).toBe(1);
      expect(execution.report.sessions[0]?.outcome).toBe("skipped");
      for (const repo of state.repos) {
        expect(existsSync(repo.worktreePath)).toBeTruthy();
      }
    },
    30_000
  );
});
