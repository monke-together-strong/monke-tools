import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { parse, stringify } from "yaml";
import * as z from "zod";

import { hashKey, sessionHashKey } from "./identity.ts";
import {
  FrozenSessionRecordSchema,
  RepoBundleSchema,
  RepoFindingsSchema,
  RepoMetaSchema,
  RetrospectiveWindowSchema,
  RetroLockMetadataSchema
} from "./schemas.ts";
import type {
  AgentKind,
  FrozenSessionRecord,
  RepoBundle,
  RepoMeta,
  RetrospectiveWindow
} from "./types.ts";

const LOCK_TIMEOUT_MS = 5000;

/** Root of all retrospective state, matching monke house style under MONKE_HOME. */
export function retroHome(monkeHome?: string) {
  const home = monkeHome ?? process.env.MONKE_HOME ?? path.join(homedir(), ".monke");
  return path.join(home, "agent-retrospectives");
}

// --- frozen per-session records (the durable, never-recomputed corpus) -------

function sessionPath(root: string, agent: AgentKind, sessionId: string) {
  return path.join(root, "sessions", `${sessionHashKey(agent, sessionId)}.yml`);
}

export function loadFrozenSession(root: string, agent: AgentKind, sessionId: string) {
  const filePath = sessionPath(root, agent, sessionId);
  if (!existsSync(filePath)) {
    return null;
  }
  return parseYamlFile(filePath, FrozenSessionRecordSchema);
}

export function saveFrozenSession(root: string, record: FrozenSessionRecord) {
  const filePath = sessionPath(root, record.agent, record.sessionId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, stringify(record), "utf-8");
}

export function listFrozenSessions(root: string) {
  const dir = path.join(root, "sessions");
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".yml"))
    .flatMap((entry) => {
      try {
        return [parseYamlFile(path.join(dir, entry), FrozenSessionRecordSchema)];
      } catch {
        return [];
      }
    });
}

// --- repo meta ---------------------------------------------------------------

export function saveRepoMeta(root: string, meta: RepoMeta) {
  const filePath = path.join(root, "repos", `${hashKey(meta.repoKey)}.yml`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, stringify(meta), "utf-8");
}

export function loadRepoMeta(root: string, repoKey: string) {
  const filePath = path.join(root, "repos", `${hashKey(repoKey)}.yml`);
  if (!existsSync(filePath)) {
    return null;
  }
  return parseYamlFile(filePath, RepoMetaSchema);
}

// --- run dir (bundles + findings, transient) --------------------------------

export function runDir(root: string, runTs: string) {
  return path.join(root, "runs", runTs);
}

export function writeBundle(root: string, bundle: RepoBundle) {
  const dir = runDir(root, bundle.runTs);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${bundle.repoHash}.json`);
  writeFileSync(filePath, JSON.stringify(bundle, null, 2), "utf-8");
  return filePath;
}

export function readBundle(root: string, runTs: string, repoHash: string) {
  return parseJsonFile(path.join(runDir(root, runTs), `${repoHash}.json`), RepoBundleSchema);
}

export function listBundleHashes(root: string, runTs: string) {
  const dir = runDir(root, runTs);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter(
      (entry) =>
        entry.endsWith(".json") && entry !== "window.json" && !entry.endsWith(".findings.json")
    )
    .map((entry) => entry.slice(0, -".json".length));
}

export function writeRunWindow(root: string, runTs: string, window: RetrospectiveWindow) {
  const filePath = path.join(runDir(root, runTs), "window.json");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(window, null, 2), "utf-8");
  return filePath;
}

export function readRunWindow(root: string, runTs: string) {
  const filePath = path.join(runDir(root, runTs), "window.json");
  if (!existsSync(filePath)) {
    return null;
  }
  return parseJsonFile(filePath, RetrospectiveWindowSchema);
}

export function findingsPath(root: string, runTs: string, repoHash: string) {
  return path.join(runDir(root, runTs), `${repoHash}.findings.json`);
}

export function readFindings(root: string, runTs: string, repoHash: string) {
  const filePath = findingsPath(root, runTs, repoHash);
  if (!existsSync(filePath)) {
    return null;
  }
  return parseJsonFile(filePath, RepoFindingsSchema);
}

export function prAnalysisPath(root: string, runTs: string) {
  return path.join(runDir(root, runTs), "pr-analysis.md");
}

export function readPrAnalysis(root: string, runTs: string) {
  const filePath = prAnalysisPath(root, runTs);
  if (!existsSync(filePath)) {
    return null;
  }
  return readFileSync(filePath, "utf-8");
}

export function cleanRunDir(root: string, runTs: string) {
  rmSync(runDir(root, runTs), { force: true, recursive: true });
}

// --- reports -----------------------------------------------------------------

export function writeReport(root: string, runTs: string, content: string) {
  const dir = path.join(root, "reports");
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${runTs}-retrospective.md`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

export function writeReportArtifact(root: string, runTs: string, suffix: string, content: string) {
  const dir = path.join(root, "reports");
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${runTs}-${suffix}.md`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

export function listReportPaths(root: string) {
  const dir = path.join(root, "reports");
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((entry) => entry.endsWith("-retrospective.md"))
    .map((entry) => path.join(dir, entry))
    .toSorted();
}

// --- lock (one run at a time) ------------------------------------------------

const STALE_LOCK_AGE_MS = 60_000;
const LOCK_RETRY_INTERVAL_MS = 50;

export function withRetroLock<T>(root: string, callback: () => T) {
  const lockPath = path.join(root, "run.lock");
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let release = tryAcquireRetroLock(lockPath);
  while (!release) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for retrospective lock at ${lockPath}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_INTERVAL_MS);
    release = tryAcquireRetroLock(lockPath);
  }
  try {
    return callback();
  } finally {
    release();
  }
}

function tryAcquireRetroLock(lockPath: string) {
  if (existsSync(`${lockPath}.reclaim`)) {
    return;
  }
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
    evictIfStale(lockPath);
    return;
  }
  const identity = fstatSync(fd);
  try {
    writeFileSync(fd, JSON.stringify({ acquiredAt: Date.now(), pid: process.pid }), "utf-8");
  } catch (error) {
    closeSync(fd);
    removeOwnedLock(lockPath, identity);
    throw error;
  }
  return () => {
    try {
      removeOwnedLock(lockPath, identity);
    } finally {
      closeSync(fd);
    }
  };
}

/** Only one contender may inspect and reclaim a stale lock at a time. */
function evictIfStale(lockPath: string) {
  const reclaimPath = `${lockPath}.reclaim`;
  try {
    mkdirSync(reclaimPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return;
    }
    throw error;
  }
  try {
    const identity = lstatSync(lockPath);
    let stale = Date.now() - identity.mtimeMs > STALE_LOCK_AGE_MS;
    try {
      const meta = parseJsonFile(lockPath, RetroLockMetadataSchema);
      if (meta.pid !== undefined) {
        try {
          process.kill(meta.pid, 0);
          stale = false;
        } catch (error) {
          stale = error instanceof Error && "code" in error && error.code === "ESRCH";
        }
      }
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) {
        throw error;
      }
      // Incomplete metadata may belong to a process initializing a fresh lock.
    }
    if (stale) {
      removeOwnedLock(lockPath, identity);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  } finally {
    rmdirSync(reclaimPath);
  }
}

function removeOwnedLock(lockPath: string, identity: Pick<Stats, "dev" | "ino">) {
  try {
    const current = lstatSync(lockPath);
    if (current.dev === identity.dev && current.ino === identity.ino) {
      unlinkSync(lockPath);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

function parseYamlFile<T extends z.ZodType>(filePath: string, schema: T) {
  const value: unknown = parse(readFileSync(filePath, "utf-8"));
  return schema.parse(value);
}

function parseJsonFile<T extends z.ZodType>(filePath: string, schema: T) {
  const value: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
  return schema.parse(value);
}
