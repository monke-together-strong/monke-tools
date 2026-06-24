import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";

import { hashKey, sessionHashKey } from "./identity.ts";
import type { AgentKind, FrozenSessionRecord, RepoBundle, RepoFindings, RepoMeta } from "./types.ts";

const LOCK_TIMEOUT_MS = 5_000;

/** Root of all retrospective state, matching monke house style under MONKE_HOME. */
export function retroHome(monkeHome?: string): string {
  const home = monkeHome ?? process.env.MONKE_HOME ?? path.join(homedir(), ".monke");
  return path.join(home, "agent-retrospectives");
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

// --- frozen per-session records (the durable, never-recomputed corpus) -------

function sessionPath(root: string, agent: AgentKind, sessionId: string): string {
  return path.join(root, "sessions", `${sessionHashKey(agent, sessionId)}.yml`);
}

export function loadFrozenSession(
  root: string,
  agent: AgentKind,
  sessionId: string,
): FrozenSessionRecord | null {
  const filePath = sessionPath(root, agent, sessionId);
  if (!existsSync(filePath)) {
    return null;
  }
  return parse(readFileSync(filePath, "utf8")) as FrozenSessionRecord;
}

export function saveFrozenSession(root: string, record: FrozenSessionRecord): void {
  const filePath = sessionPath(root, record.agent, record.sessionId);
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, stringify(record), "utf8");
}

export function listFrozenSessions(root: string): FrozenSessionRecord[] {
  const dir = path.join(root, "sessions");
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".yml"))
    .map((entry) => parse(readFileSync(path.join(dir, entry), "utf8")) as FrozenSessionRecord);
}

// --- repo meta ---------------------------------------------------------------

export function saveRepoMeta(root: string, meta: RepoMeta): void {
  const filePath = path.join(root, "repos", `${hashKey(meta.repoKey)}.yml`);
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, stringify(meta), "utf8");
}

export function loadRepoMeta(root: string, repoKey: string): RepoMeta | null {
  const filePath = path.join(root, "repos", `${hashKey(repoKey)}.yml`);
  if (!existsSync(filePath)) {
    return null;
  }
  return parse(readFileSync(filePath, "utf8")) as RepoMeta;
}

// --- run dir (bundles + findings, transient) --------------------------------

export function runDir(root: string, runTs: string): string {
  return path.join(root, "runs", runTs);
}

export function writeBundle(root: string, bundle: RepoBundle): string {
  const dir = runDir(root, bundle.runTs);
  ensureDir(dir);
  const filePath = path.join(dir, `${bundle.repoHash}.json`);
  writeFileSync(filePath, JSON.stringify(bundle, null, 2), "utf8");
  return filePath;
}

export function readBundle(root: string, runTs: string, repoHash: string): RepoBundle {
  return JSON.parse(readFileSync(path.join(runDir(root, runTs), `${repoHash}.json`), "utf8"));
}

export function listBundleHashes(root: string, runTs: string): string[] {
  const dir = runDir(root, runTs);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json") && !entry.endsWith(".findings.json"))
    .map((entry) => entry.slice(0, -".json".length));
}

export function findingsPath(root: string, runTs: string, repoHash: string): string {
  return path.join(runDir(root, runTs), `${repoHash}.findings.json`);
}

export function readFindings(root: string, runTs: string, repoHash: string): RepoFindings | null {
  const filePath = findingsPath(root, runTs, repoHash);
  if (!existsSync(filePath)) {
    return null;
  }
  return JSON.parse(readFileSync(filePath, "utf8")) as RepoFindings;
}

export function cleanRunDir(root: string, runTs: string): void {
  rmSync(runDir(root, runTs), { recursive: true, force: true });
}

// --- reports -----------------------------------------------------------------

export function writeReport(root: string, runTs: string, content: string): string {
  const dir = path.join(root, "reports");
  ensureDir(dir);
  const filePath = path.join(dir, `${runTs}-retrospective.md`);
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

// --- lock (one run at a time) ------------------------------------------------

const STALE_LOCK_AGE_MS = 60_000;

export function withRetroLock<T>(root: string, callback: () => T): T {
  const lockPath = path.join(root, "run.lock");
  ensureDir(path.dirname(lockPath));
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx");
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("EEXIST")) {
        throw error;
      }
      if (evictIfStale(lockPath)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for retrospective lock at ${lockPath}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return callback();
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}

/** Evict a lock whose owning process is gone or whose age exceeds the cutoff. */
function evictIfStale(lockPath: string): boolean {
  let stale = false;
  try {
    const meta = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number; acquiredAt?: number };
    if (typeof meta.acquiredAt === "number") {
      stale = Date.now() - meta.acquiredAt > STALE_LOCK_AGE_MS;
    }
    if (typeof meta.pid === "number" && meta.pid > 0) {
      try {
        process.kill(meta.pid, 0);
      } catch (error) {
        stale = error instanceof Error && "code" in error && error.code === "ESRCH";
      }
    }
  } catch {
    stale = true;
  }
  if (!stale) {
    return false;
  }
  try {
    rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}
