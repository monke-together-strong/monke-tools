import path from "node:path";

import { RECENT_WORKTREE_MS } from "./cleanup-eligibility.ts";
import { MonkeError } from "./errors.ts";
import { containsPath } from "./path-identity.ts";
import type { Runtime } from "./types.ts";

/** A live process whose working directory is inside a managed worktree. */
export interface WorktreeProcess {
  ageMs: number;
  /** True when the executable or an argument lives inside the worktree, not just the cwd. */
  attached: boolean;
  command: string;
  cwd: string;
  pid: number;
  ppid: number;
}

/** Processes with a common ancestor inside the worktree; a supervisor and what it spawned. */
export interface WorktreeProcessTree {
  /** Oldest member's age; a supervisor's short-lived children do not make the tree young. */
  ageMs: number;
  /** True when any member's command line names a path inside the worktree. */
  attached: boolean;
  members: WorktreeProcess[];
  roots: WorktreeProcess[];
}

/** One scan per Cleanup run; index by worktree afterwards. Only cwd is inspected, never open files. */
export interface WorktreeProcessScan {
  scannedAt: number;
  treesUnder: (worktreePath: string) => WorktreeProcessTree[];
}

const TERM_GRACE_MS = 2000;

/**
 * Snapshot every process rooted under the managed worktree area. `lsof -d cwd` avoids walking
 * directory trees, so the cost is one pass over the process table.
 */
export function scanWorktreeProcesses(runtime: Runtime, home: string): WorktreeProcessScan {
  const area = path.join(home, "worktrees");
  const scannedAt = Date.now();
  const cwdByPid = new Map<number, string>();
  const lsof = runtime.exec("lsof", ["-a", "-d", "cwd", "-F", "pn"], { allowFailure: true });
  let pid: number | null = null;
  for (const line of lsof.stdout.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
    } else if (line.startsWith("n") && pid !== null) {
      const cwd = line.slice(1);
      if (containsPath(area, cwd) && cwd !== area) {
        cwdByPid.set(pid, cwd);
      }
    }
  }
  const processes: WorktreeProcess[] = [];
  if (cwdByPid.size > 0) {
    const ps = runtime.exec("ps", ["-axo", "pid=,ppid=,lstart=,command="], {
      allowFailure: true
    });
    for (const line of ps.stdout.split("\n")) {
      const match =
        /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<start>\S+ \S+\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(?<command>.*)$/u.exec(
          line
        );
      if (!match?.groups) {
        continue;
      }
      const id = Number(match.groups.pid);
      const cwd = cwdByPid.get(id);
      if (cwd === undefined) {
        continue;
      }
      const started = Date.parse(match.groups.start ?? "");
      processes.push({
        ageMs: Number.isNaN(started) ? 0 : Math.max(0, scannedAt - started),
        attached: false,
        command: match.groups.command ?? "",
        cwd,
        pid: id,
        ppid: Number(match.groups.ppid)
      });
    }
  }
  return {
    scannedAt,
    treesUnder(worktreePath) {
      const inside = processes
        .filter((candidate) => containsPath(worktreePath, candidate.cwd))
        .map((candidate) => ({
          ...candidate,
          attached: commandReferences(candidate.command, worktreePath)
        }));
      return groupTrees(inside);
    }
  };
}

/** A shell that merely `cd`ed into a worktree is not attached; a server started from it is. */
function commandReferences(command: string, worktreePath: string) {
  return command.split(/\s+/u).some((word) => containsPath(worktreePath, word));
}

function groupTrees(processes: WorktreeProcess[]): WorktreeProcessTree[] {
  const pids = new Set(processes.map((candidate) => candidate.pid));
  const byPid = new Map(processes.map((candidate) => [candidate.pid, candidate]));
  const rootOf = (candidate: WorktreeProcess, seen = new Set<number>()): WorktreeProcess => {
    const parent = byPid.get(candidate.ppid);
    return parent === undefined || seen.has(parent.pid)
      ? candidate
      : rootOf(parent, seen.add(candidate.pid));
  };
  const trees = new Map<number, WorktreeProcess[]>();
  for (const candidate of processes) {
    const root = rootOf(candidate);
    trees.set(root.pid, [...(trees.get(root.pid) ?? []), candidate]);
  }
  return [...trees.values()].map((members) => ({
    ageMs: Math.max(...members.map((member) => member.ageMs)),
    attached: members.some((member) => member.attached),
    members,
    roots: members.filter((member) => !pids.has(member.ppid))
  }));
}

export interface StaleProcessOutcome {
  /** Old trees that never named the worktree; left running with a dangling cwd, reported only. */
  bystanders: WorktreeProcessTree[];
  killed: WorktreeProcessTree[];
  /** Trees younger than the threshold, attached or not; the member must wait. */
  recent: WorktreeProcessTree[];
}

/**
 * Stop attached process trees older than the shared one-day threshold, roots first so a supervisor
 * cannot respawn its children. Any younger tree blocks removal: it may be an agent mid-task.
 */
export function stopStaleWorktreeProcesses(
  runtime: Runtime,
  scan: WorktreeProcessScan,
  worktreePath: string,
  hooks: { beforeKill?: () => void } = {}
): StaleProcessOutcome {
  const trees = scan.treesUnder(worktreePath);
  const recent = trees.filter((tree) => tree.ageMs < RECENT_WORKTREE_MS);
  const old = trees.filter((tree) => tree.ageMs >= RECENT_WORKTREE_MS);
  const stale = old.filter((tree) => tree.attached);
  const bystanders = old.filter((tree) => !tree.attached);
  if (stale.length === 0) {
    return { bystanders, killed: [], recent };
  }
  hooks.beforeKill?.();
  const members = stale.flatMap((tree) => tree.members);
  const roots = stale.flatMap((tree) => tree.roots);
  for (const signal of ["TERM", "KILL"] as const) {
    const targets = signal === "TERM" ? roots : survivors(runtime, members);
    if (targets.length === 0) {
      break;
    }
    runtime.exec("kill", [`-${signal}`, ...targets.map((candidate) => String(candidate.pid))], {
      allowFailure: true
    });
    const deadline = Date.now() + TERM_GRACE_MS;
    while (Date.now() < deadline && survivors(runtime, members).length > 0) {
      Bun.sleepSync(100);
    }
  }
  const remaining = survivors(runtime, members);
  if (remaining.length > 0) {
    throw new MonkeError(
      `Could not stop stale process${remaining.length === 1 ? "" : "es"} in ${worktreePath}: ${remaining
        .map((candidate) => `${candidate.pid} ${candidate.command}`)
        .join(", ")}`
    );
  }
  return { bystanders, killed: stale, recent };
}

/** A zombie still answers `kill -0` until its parent reaps it; it holds no directory. */
function survivors(runtime: Runtime, processes: WorktreeProcess[]) {
  if (processes.length === 0) {
    return [];
  }
  const states = runtime.exec(
    "ps",
    ["-o", "pid=,stat=", "-p", processes.map((candidate) => String(candidate.pid)).join(",")],
    { allowFailure: true }
  );
  const alive = new Set<number>();
  for (const line of states.stdout.split("\n")) {
    const match = /^\s*(?<pid>\d+)\s+(?<stat>\S+)/u.exec(line);
    if (match?.groups && !match.groups.stat?.startsWith("Z")) {
      alive.add(Number(match.groups.pid));
    }
  }
  return processes.filter((candidate) => alive.has(candidate.pid));
}

export function describeTree(tree: WorktreeProcessTree) {
  const days = Math.floor(tree.ageMs / RECENT_WORKTREE_MS);
  const [root] = tree.roots;
  const extra = tree.members.length - 1;
  return `${root?.pid ?? "?"} (${days} day${days === 1 ? "" : "s"} old${extra > 0 ? `, +${extra} child${extra === 1 ? "" : "ren"}` : ""}): ${root?.command ?? ""}`;
}
