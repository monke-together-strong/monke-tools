import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";

import { MonkeError } from "./errors.ts";
import { ensureDirectory, hashKey, isPortAvailable } from "./runtime.ts";
import { RepoReservationSchema, SessionStateSchema } from "./state-schema.ts";
import { parseBoundaryValue, parseOwnedYamlFile } from "./validation.ts";
import type {
  AssignedPort,
  RepoConfig,
  RepoReservation,
  SessionRepoState,
  SessionState,
} from "./types.ts";

const GLOBAL_PORT_FLOOR = 10_000;
// Reserve a generous flat block per repo so multiple concurrent sessions can each allocate
// their full port set without exhausting the block. Sized for the heaviest realistic repo
// (tens of ports per session) times comfortable concurrency headroom; blocks stack from
// GLOBAL_PORT_FLOOR, so even ~50 repos at this width fit under the 65535 ceiling.
const MIN_REPO_RESERVATION_SIZE = 1000;

export function loadSessionState(
  home: string,
  rootSourceRoot: string,
  session: string,
): SessionState {
  const filePath = getSessionStateFilePath(home, rootSourceRoot, session);
  if (!existsSync(filePath)) {
    return {
      repos: [],
      rootSourceRoot,
      session,
      version: 1,
    };
  }

  return parseOwnedYamlFile(filePath, SessionStateSchema);
}

export function saveSessionState(home: string, state: SessionState): void {
  const filePath = getSessionStateFilePath(home, state.rootSourceRoot, state.session);
  const parsed = parseBoundaryValue(SessionStateSchema, state, filePath);
  ensureDirectory(path.dirname(filePath));
  writeFileSync(filePath, stringify(parsed), "utf-8");
}

export function removeSessionState(home: string, rootSourceRoot: string, session: string): void {
  rmSync(getSessionStateFilePath(home, rootSourceRoot, session), { force: true });
}

export function listSessionStates(home: string): SessionState[] {
  const directoryPath = path.join(home, "sessions");
  if (!existsSync(directoryPath)) {
    return [];
  }

  return readdirSync(directoryPath)
    .filter((entry) => entry.endsWith(".yml"))
    .map((entry) => parseOwnedYamlFile(path.join(directoryPath, entry), SessionStateSchema));
}

export function ensureSessionPrefix(state: SessionState, expectedOrder: string[]): void {
  const recordedRoots = state.repos.map((repo) => repo.sourceRoot);
  for (const [index, recordedRoot] of recordedRoots.entries()) {
    if (expectedOrder[index] !== recordedRoot) {
      throw new MonkeError(
        `Session state for ${state.session} is out of sync with the current dependency graph`,
      );
    }
  }
}

export function getOrCreateReservation(
  home: string,
  sourceRoot: string,
  size: number,
): RepoReservation | null {
  if (size === 0) {
    return null;
  }

  const filePath = getReservationFilePath(home, sourceRoot);
  if (existsSync(filePath)) {
    const existing = parseOwnedYamlFile(filePath, RepoReservationSchema);
    if (size > existing.size) {
      throw new MonkeError(
        `Repo ${sourceRoot} owns ${size} local ports but its reservation only has room for ${existing.size}`,
      );
    }
    return existing;
  }

  const reservations = listReservations(home);
  const highestReservedPort = reservations.reduce((highest, reservation) => {
    const blockEnd = reservation.blockStart + reservation.size - 1;
    return Math.max(highest, blockEnd);
  }, GLOBAL_PORT_FLOOR - 1);
  const nextReservation: RepoReservation = {
    blockStart: Math.max(GLOBAL_PORT_FLOOR, highestReservedPort + 1),
    size: Math.max(size, MIN_REPO_RESERVATION_SIZE),
    sourceRoot,
    version: 1,
  };

  ensureDirectory(path.dirname(filePath));
  const parsed = parseBoundaryValue(RepoReservationSchema, nextReservation, filePath);
  writeFileSync(filePath, stringify(parsed), "utf-8");
  return parsed;
}

export function allocateLocalPorts(options: {
  home: string;
  rootSourceRoot: string;
  session: string;
  repoConfig: RepoConfig;
  existingRepoState: SessionRepoState | undefined;
  reservation: RepoReservation | null;
  baselinePorts: Set<number>;
}): Map<string, number> {
  const assignments = new Map<string, number>(
    (options.existingRepoState?.assignedPorts ?? []).map((entry) => [entry.key, entry.value]),
  );
  if (options.repoConfig.localPortOrder.length === 0) {
    return assignments;
  }

  if (!options.reservation) {
    throw new MonkeError(`Missing reservation for ${options.repoConfig.sourceRoot}`);
  }

  const globallyManagedPorts = new Set<number>();
  for (const state of listSessionStates(options.home)) {
    for (const repo of state.repos) {
      if (
        state.rootSourceRoot === options.rootSourceRoot &&
        state.session === options.session &&
        repo.sourceRoot === options.repoConfig.sourceRoot
      ) {
        continue;
      }
      for (const assignment of repo.assignedPorts) {
        globallyManagedPorts.add(assignment.value);
      }
    }
  }

  const blockEnd = options.reservation.blockStart + options.reservation.size - 1;
  const usedInRepo = new Set<number>(assignments.values());

  for (const key of options.repoConfig.localPortOrder) {
    if (assignments.has(key)) {
      continue;
    }

    let nextPort: number | null = null;
    for (let port = options.reservation.blockStart; port <= blockEnd; port += 1) {
      if (usedInRepo.has(port)) {
        continue;
      }
      if (globallyManagedPorts.has(port)) {
        continue;
      }
      if (options.baselinePorts.has(port)) {
        continue;
      }
      if (!isPortAvailable(port)) {
        continue;
      }
      nextPort = port;
      break;
    }

    if (nextPort === null) {
      const blockSize = options.reservation.size;
      const inUse = globallyManagedPorts.size;
      throw new MonkeError(
        `No available ports remain inside the reserved block for ${options.repoConfig.sourceRoot} ` +
          `(block holds ${blockSize} ports from ${options.reservation.blockStart}, ${inUse} already held by other sessions). ` +
          `Tear down unused sessions to free ports, or delete the reservation file under ` +
          `<MONKE_HOME>/repo-reservations and re-run to grow the block.`,
      );
    }

    assignments.set(key, nextPort);
    usedInRepo.add(nextPort);
  }

  return assignments;
}

export function toAssignedPorts(
  repoConfig: RepoConfig,
  assignments: Map<string, number>,
): AssignedPort[] {
  return repoConfig.localPortOrder.map((key) => ({
    key,
    value: requireAssignment(assignments, key, repoConfig.sourceRoot),
  }));
}

export function recordRepoSuccess(state: SessionState, repoState: SessionRepoState): SessionState {
  const existingIndex = state.repos.findIndex((repo) => repo.sourceRoot === repoState.sourceRoot);
  if (existingIndex !== -1) {
    const nextRepos = [...state.repos];
    nextRepos[existingIndex] = repoState;
    return { ...state, repos: nextRepos };
  }

  return {
    ...state,
    repos: [...state.repos, repoState],
  };
}

export function getSessionStateFilePath(
  home: string,
  rootSourceRoot: string,
  session: string,
): string {
  return path.join(home, "sessions", `${hashKey(`${rootSourceRoot}\u0000${session}`)}.yml`);
}

function getReservationFilePath(home: string, sourceRoot: string): string {
  return path.join(home, "repo-reservations", `${hashKey(sourceRoot)}.yml`);
}

function listReservations(home: string): RepoReservation[] {
  const directoryPath = path.join(home, "repo-reservations");
  if (!existsSync(directoryPath)) {
    return [];
  }

  return readdirSync(directoryPath)
    .filter((entry) => entry.endsWith(".yml"))
    .map((entry) => parseOwnedYamlFile(path.join(directoryPath, entry), RepoReservationSchema));
}

function requireAssignment(
  assignments: Map<string, number>,
  key: string,
  repoRoot: string,
): number {
  const value = assignments.get(key);
  if (value === undefined) {
    throw new MonkeError(`Missing assigned port ${key} for ${repoRoot}`);
  }
  return value;
}
