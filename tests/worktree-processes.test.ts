import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { RECENT_WORKTREE_MS } from "../src/cleanup-eligibility.ts";
import type { Runtime } from "../src/types.ts";
import {
  describeTree,
  scanWorktreeProcesses,
  stopStaleWorktreeProcesses
} from "../src/worktree-processes.ts";
import type {
  WorktreeProcess,
  WorktreeProcessScan,
  WorktreeProcessTree
} from "../src/worktree-processes.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

const STARTED = "Sun Sep  6 00:00:00 2026";
const EMPTY_RESULT = { exitCode: 0, stderr: "", stdout: "" };

function runtimeWithExec(exec: Runtime["exec"]): Runtime {
  return { ...createTestRuntime(), exec };
}

function processRecord(patch: Partial<WorktreeProcess> = {}): WorktreeProcess {
  return {
    ageMs: RECENT_WORKTREE_MS,
    attached: true,
    command: "bun server.ts",
    cwd: "/home/monke/worktrees/repo/session",
    pid: 100,
    ppid: 1,
    started: STARTED,
    ...patch
  };
}

function processTree(patch: Partial<WorktreeProcessTree> = {}): WorktreeProcessTree {
  const root = processRecord();
  return {
    ageMs: RECENT_WORKTREE_MS,
    attached: true,
    members: [root],
    roots: [root],
    ...patch
  };
}

function processScan(...trees: WorktreeProcessTree[]): WorktreeProcessScan {
  return { scannedAt: Date.now(), treesUnder: () => trees };
}

describe("worktree process scanning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("scans the process table once and groups descendants under a worktree path containing spaces", () => {
    const scannedAt = Date.parse("Mon Sep  7 00:00:00 2026");
    vi.spyOn(Date, "now").mockReturnValue(scannedAt);
    const home = "/home/monke root";
    const worktree = path.join(home, "worktrees/repo/session with spaces");
    const exec = vi.fn<Runtime["exec"]>((command) => {
      if (command === "lsof") {
        return {
          ...EMPTY_RESULT,
          stdout: [
            "p99",
            `n${path.join(home, "worktrees")}`,
            "p100",
            `n${worktree}`,
            "p101",
            `n${path.join(worktree, "app")}`,
            "p102",
            `n${worktree}-other`
          ].join("\n")
        };
      }
      return {
        ...EMPTY_RESULT,
        stdout: [
          `100 1 Sat Sep  5 00:00:00 2026 bun ${worktree}/server.ts`,
          "101 100 Sun Sep  6 12:00:00 2026 sleep 1",
          `102 1 Sun Sep  6 00:00:00 2026 bun ${worktree}-other/server.ts`
        ].join("\n")
      };
    });

    const scan = scanWorktreeProcesses(runtimeWithExec(exec), home);
    const trees = scan.treesUnder(worktree);

    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenNthCalledWith(1, "lsof", ["-a", "-d", "cwd", "-F", "pn"], {
      allowFailure: true
    });
    expect(trees).toHaveLength(1);
    expect(trees[0]).toMatchObject({
      ageMs: 2 * RECENT_WORKTREE_MS,
      attached: true,
      members: [{ pid: 100 }, { pid: 101 }],
      roots: [{ pid: 100 }]
    });
  });

  test("requires a path boundary when deciding whether a command is attached", () => {
    const home = "/home/monke";
    const worktree = path.join(home, "worktrees/repo/session");
    const exec = vi.fn<Runtime["exec"]>((command) =>
      command === "lsof"
        ? {
            ...EMPTY_RESULT,
            stdout: ["p100", `n${worktree}`, "p101", `n${worktree}`].join("\n")
          }
        : {
            ...EMPTY_RESULT,
            stdout: [
              `100 1 ${STARTED} bun ${worktree}-backup/server.ts`,
              `101 1 ${STARTED} bun --cwd ${worktree}`
            ].join("\n")
          }
    );

    const trees = scanWorktreeProcesses(runtimeWithExec(exec), home).treesUnder(worktree);

    expect(
      trees.map((tree) => ({ attached: tree.attached, pid: tree.roots[0]?.pid }))
    ).toStrictEqual([
      { attached: false, pid: 100 },
      { attached: true, pid: 101 }
    ]);
  });

  test("does not read ps when lsof finds no process inside the managed worktree area", () => {
    const exec = vi.fn<Runtime["exec"]>(() => EMPTY_RESULT);

    const scan = scanWorktreeProcesses(runtimeWithExec(exec), "/home/monke");

    expect(exec).toHaveBeenCalledOnce();
    expect(scan.treesUnder("/home/monke/worktrees/repo/session")).toStrictEqual([]);
  });

  test("rejects a process record whose start time cannot be parsed", () => {
    const home = "/home/monke";
    const worktree = path.join(home, "worktrees/repo/session");
    const exec = vi.fn<Runtime["exec"]>((command) =>
      command === "lsof"
        ? { ...EMPTY_RESULT, stdout: `p100\nn${worktree}` }
        : { ...EMPTY_RESULT, stdout: "100 1 Sun Nope  6 00:00:00 2026 bun server.ts" }
    );

    expect(() => scanWorktreeProcesses(runtimeWithExec(exec), home)).toThrow(
      "Unreadable process start time"
    );
  });
});

describe("stale worktree process stopping", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("leaves recent trees and old unattached bystanders running without invoking the kill hook", () => {
    const recent = processTree({ ageMs: RECENT_WORKTREE_MS - 1 });
    const bystander = processTree({ attached: false });
    const exec = vi.fn<Runtime["exec"]>(() => EMPTY_RESULT);
    const beforeKill = vi.fn();

    const result = stopStaleWorktreeProcesses(
      runtimeWithExec(exec),
      processScan(recent, bystander),
      "/worktree",
      { beforeKill }
    );

    expect(result).toStrictEqual({ bystanders: [bystander], killed: [], recent: [recent] });
    expect(beforeKill).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  test("treats the exact one-day boundary as stale and sends TERM to roots before children", () => {
    const root = processRecord({ pid: 100 });
    const child = processRecord({ pid: 101, ppid: 100 });
    const tree = processTree({ members: [root, child], roots: [root] });
    const psOutputs = [`100 S ${STARTED}`, "", "", ""];
    const exec = vi.fn<Runtime["exec"]>((command) =>
      command === "ps" ? { ...EMPTY_RESULT, stdout: psOutputs.shift() ?? "" } : EMPTY_RESULT
    );
    const beforeKill = vi.fn();

    const result = stopStaleWorktreeProcesses(
      runtimeWithExec(exec),
      processScan(tree),
      "/worktree",
      { beforeKill }
    );

    expect(beforeKill).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledWith("kill", ["-TERM", "100"], { allowFailure: true });
    expect(exec).not.toHaveBeenCalledWith("kill", expect.arrayContaining(["-KILL"]), {
      allowFailure: true
    });
    expect(result).toStrictEqual({ bystanders: [], killed: [tree], recent: [] });
  });

  test.each([
    { label: "reused pid", state: `100 S Mon Sep  7 00:00:00 2026` },
    { label: "zombie", state: `100 Z ${STARTED}` }
  ])("does not signal a $label found during identity revalidation", ({ state }) => {
    const tree = processTree();
    const exec = vi.fn<Runtime["exec"]>((command) =>
      command === "ps" ? { ...EMPTY_RESULT, stdout: state } : EMPTY_RESULT
    );

    const result = stopStaleWorktreeProcesses(
      runtimeWithExec(exec),
      processScan(tree),
      "/worktree"
    );

    expect(exec).not.toHaveBeenCalledWith("kill", expect.anything(), expect.anything());
    expect(result.killed).toStrictEqual([tree]);
  });

  test("escalates surviving members to KILL and reports a failure if they still survive", () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      now += 3000;
      return now;
    });
    const root = processRecord({ pid: 100 });
    const child = processRecord({ pid: 101, ppid: 100 });
    const tree = processTree({ members: [root, child], roots: [root] });
    const exec = vi.fn<Runtime["exec"]>((command) =>
      command === "ps"
        ? {
            ...EMPTY_RESULT,
            stdout: [`100 S ${STARTED}`, `101 S ${STARTED}`].join("\n")
          }
        : EMPTY_RESULT
    );

    expect(() =>
      stopStaleWorktreeProcesses(runtimeWithExec(exec), processScan(tree), "/worktree")
    ).toThrow("Could not stop stale processes in /worktree: 100 bun server.ts, 101 bun server.ts");
    expect(exec).toHaveBeenCalledWith("kill", ["-TERM", "100"], { allowFailure: true });
    expect(exec).toHaveBeenCalledWith("kill", ["-KILL", "100", "101"], {
      allowFailure: true
    });
  });

  test("describes process age and descendant count for cleanup diagnostics", () => {
    const root = processRecord({ command: "bun dev", pid: 321 });
    const tree = processTree({
      ageMs: 2 * RECENT_WORKTREE_MS,
      members: [root, processRecord({ pid: 322 }), processRecord({ pid: 323 })],
      roots: [root]
    });

    expect(describeTree(tree)).toBe("321 (2 days old, +2 children): bun dev");
  });
});
