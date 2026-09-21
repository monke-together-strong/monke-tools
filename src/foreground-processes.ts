import type { Runtime } from "./types.ts";

interface ProcessIdentity {
  pid: number;
  ppid: number;
  started: string;
}

function readProcesses(exec: Runtime["exec"]) {
  const result = exec("ps", ["-axo", "pid=,ppid=,stat=,lstart="], {});
  const processes = new Map<number, ProcessIdentity>();
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<status>\S+)\s+(?<started>.+)$/u.exec(line);
    if (!match?.groups || match.groups.status?.includes("Z")) {
      continue;
    }
    const { pid, ppid, started } = match.groups;
    if (pid && ppid && started) {
      processes.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), started });
    }
  }
  return processes;
}

function retainDescendants(
  roots: Map<number, ProcessIdentity>,
  current: Map<number, ProcessIdentity>
) {
  let added = true;
  while (added) {
    added = false;
    for (const process of current.values()) {
      const parent = roots.get(process.ppid);
      if (
        parent &&
        current.get(parent.pid)?.started === parent.started &&
        !roots.has(process.pid)
      ) {
        roots.set(process.pid, process);
        added = true;
      }
    }
  }
}

function signalProcesses(
  retained: Map<number, ProcessIdentity>,
  current: Map<number, ProcessIdentity>,
  signal: NodeJS.Signals
) {
  for (const identity of retained.values()) {
    if (current.get(identity.pid)?.started !== identity.started) {
      continue;
    }
    try {
      process.kill(identity.pid, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        throw error;
      }
    }
  }
}

/** Preserve the controlling terminal; retain descendants before signaling can orphan them. */
export async function stopForegroundProcesses(
  exec: Runtime["exec"],
  pid: number,
  signal: NodeJS.Signals,
  protect: ((pids: number[]) => void) | undefined
) {
  const current = readProcesses(exec);
  const root = current.get(pid);
  if (!root) {
    return;
  }
  const retained = new Map([[pid, root]]);
  retainDescendants(retained, current);
  protect?.([...retained.keys()]);
  signalProcesses(retained, current, signal);
  await Bun.sleep(250);
  // Keep the original identities after their parent exits, including across escalation.
  for (;;) {
    const live = readProcesses(exec);
    retainDescendants(retained, live);
    const remaining = [...retained.values()].filter(
      (entry) => live.get(entry.pid)?.started === entry.started
    );
    if (remaining.length === 0) {
      return;
    }
    protect?.(remaining.map((entry) => entry.pid));
    signalProcesses(retained, live, "SIGKILL");
    // oxlint-disable-next-line no-await-in-loop -- Keep the lease until the signaled processes exit.
    await Bun.sleep(20);
  }
}
