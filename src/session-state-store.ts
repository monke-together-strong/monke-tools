import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { parseDocument, stringify, visit } from "yaml";
import * as z from "zod";

import { MonkeError } from "./errors.ts";
import { samePath } from "./path-identity.ts";
import { hashKey, isPortAvailable } from "./runtime.ts";
import { RepoReservationSchema, SessionStateSchema } from "./state-schema.ts";
import type {
  RepoConfig,
  RepoReservation,
  ResourceCommandConfig,
  ResourceValueState,
  SessionRepoState,
  SessionState
} from "./types.ts";
import { parseBoundaryValue, parseOwnedYamlFile } from "./validation.ts";

const GLOBAL_PORT_FLOOR = 10_000;
// Reserve a generous flat block per repo so multiple concurrent sessions can each allocate
// their full port set without exhausting the block. Sized for the heaviest realistic repo
// (tens of ports per session) times comfortable concurrency headroom; blocks stack from
// GLOBAL_PORT_FLOOR, so even ~50 repos at this width fit under the 65535 ceiling.
const MIN_REPO_RESERVATION_SIZE = 1000;
const SessionStateIdentitySchema = z.object({
  rootSourceRoot: z.string(),
  session: z.string()
});
const SessionStateWorktreePathsSchema = z.object({
  repos: z.array(z.object({ worktreePath: z.string() }))
});
const SessionStateVersionSchema = z.object({ version: z.number().int() });

export function loadSessionState(
  home: string,
  rootSourceRoot: string,
  session: string
): SessionState {
  const filePath = getSessionStateFilePath(home, rootSourceRoot, session);
  if (!existsSync(filePath)) {
    throw new MonkeError(`Missing retained Session state for ${session} at ${rootSourceRoot}`);
  }

  return parseSessionStateFile(home, filePath);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Persisted state is validated before its identity or contents are used.
export function saveSessionState(home: string, state: unknown) {
  const identity = SessionStateIdentitySchema.safeParse(state);
  const label = identity.success
    ? getSessionStateFilePath(home, identity.data.rootSourceRoot, identity.data.session)
    : "session state";
  const parsed = parseBoundaryValue(SessionStateSchema, state, label);
  const filePath = getSessionStateFilePath(home, parsed.rootSourceRoot, parsed.session);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, stringify(parsed), { encoding: "utf-8", flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return parsed;
}

export function removeSessionState(home: string, rootSourceRoot: string, session: string) {
  rmSync(getSessionStateFilePath(home, rootSourceRoot, session), { force: true });
}

export function listSessionStates(home: string) {
  return listSessionStateFiles(home).map((filePath) => parseSessionStateFile(home, filePath));
}

/** Open under the global lock; owns the retained-state view for that operation. */
export class SessionStateStore {
  readonly #states: Map<string, SessionState>;

  constructor(
    readonly home: string,
    retainedStates = listSessionStates(home)
  ) {
    this.#states = new Map(
      retainedStates.map((state) => [this.key(state), structuredClone(state)])
    );
  }

  get(rootSourceRoot: string, session: string): SessionState | undefined {
    return structuredClone(this.#states.get(this.key({ rootSourceRoot, session })));
  }

  list(): SessionState[] {
    return structuredClone([...this.#states.values()]);
  }

  checkpoint(state: SessionState) {
    const committed = saveSessionState(this.home, state);
    this.#states.set(this.key(committed), committed);
  }

  remove(state: SessionState) {
    removeSessionState(this.home, state.rootSourceRoot, state.session);
    this.#states.delete(this.key(state));
  }

  assignedPortsOutsideRepo(current: {
    rootSourceRoot: string;
    session: string;
    sourceRoot: string;
  }) {
    const ports = new Set<number>();
    for (const state of this.#states.values()) {
      for (const repo of state.repos) {
        if (this.key(state) === this.key(current) && repo.sourceRoot === current.sourceRoot) {
          continue;
        }
        for (const assignment of repo.assignedPorts) {
          ports.add(assignment.value);
        }
      }
    }
    return ports;
  }

  resourceCommandInput(options: {
    command: ResourceCommandConfig;
    rootSourceRoot: string;
    session: string;
    sourceRoot: string;
  }) {
    const valuesByEnv = new Map(options.command.outputs.map((env) => [env, new Set<string>()]));

    for (const state of this.#states.values()) {
      if (this.key(state) === this.key(options)) {
        continue;
      }

      for (const repoState of state.repos) {
        if (repoState.sourceRoot !== options.sourceRoot) {
          continue;
        }

        const rememberedCommand = (repoState.resourceCommandOutputs ?? []).find(
          (command) => command.name === options.command.name
        );
        if (!rememberedCommand) {
          continue;
        }

        const rememberedByEnv = new Map(
          rememberedCommand.outputs.map((output) => [output.env, output.value])
        );
        for (const env of options.command.outputs) {
          const remembered = rememberedByEnv.get(env);
          if (remembered !== undefined && remembered.trim() !== "") {
            valuesByEnv.get(env)?.add(remembered);
          }
        }
      }
    }

    return Object.fromEntries(
      options.command.outputs.map((env) => [env, [...(valuesByEnv.get(env) ?? [])].toSorted()])
    );
  }

  resourceValueCollision(options: {
    rootSourceRoot: string;
    session: string;
    sourceRoot: string;
    values: ResourceValueState[];
  }) {
    if (options.values.length === 0) {
      return null;
    }
    for (const state of this.#states.values()) {
      if (this.key(state) === this.key(options)) {
        continue;
      }
      const repo = state.repos.find((candidate) => candidate.sourceRoot === options.sourceRoot);
      const remembered = new Map(
        (repo?.resourceValues ?? []).map((value) => [value.env, value.value])
      );
      const collision = options.values.find((value) => remembered.get(value.env) === value.value);
      if (collision) {
        return { ...collision, session: state.session };
      }
    }
    return null;
  }

  private key(state: { rootSourceRoot: string; session: string }) {
    return `${state.rootSourceRoot}\u0000${state.session}`;
  }
}

/**
 * List Session states for targeted ownership checks.
 *
 * Invalid state blocks only when it names a participating worktree; broad maintenance remains
 * responsible for reporting unrelated invalid state.
 */
export function listSessionStatesRelevantToWorktrees(home: string, worktreePaths: string[]) {
  const states: SessionState[] = [];
  for (const filePath of listSessionStateFiles(home)) {
    try {
      states.push(parseSessionStateFile(home, filePath));
    } catch (error) {
      if (invalidSessionStateReferencesWorktree(filePath, worktreePaths)) {
        throw error;
      }
    }
  }
  return states;
}

function parseSessionStateFile(home: string, filePath: string) {
  const state = parseSupportedSessionState(filePath);
  const expectedFilePath = getSessionStateFilePath(home, state.rootSourceRoot, state.session);
  if (path.normalize(expectedFilePath) !== path.normalize(filePath)) {
    throw new MonkeError(`Session state identity does not match its storage key: ${filePath}`);
  }
  return state;
}

/**
 * Parse one Session state file, reporting an unsupported version rather than a shape mismatch.
 *
 * The strict v2 schema pins `version`, so a v1 record always fails it. Only that failure path pays
 * for a second read; a healthy record is read and parsed once.
 */
function parseSupportedSessionState(filePath: string) {
  try {
    return parseOwnedYamlFile(filePath, SessionStateSchema);
  } catch (error) {
    const { version } = parseOwnedYamlFile(filePath, SessionStateVersionSchema);
    if (version !== 2) {
      throw new MonkeError(
        `Unsupported Session state version ${version} in ${filePath}; monke-tools requires strict v2 Session state`
      );
    }
    throw error;
  }
}

export function ensureSessionPrefix(state: SessionState, expectedOrder: string[]) {
  const recordedRoots = state.repos.map((repo) => repo.sourceRoot);
  for (const [index, recordedRoot] of recordedRoots.entries()) {
    if (expectedOrder[index] !== recordedRoot) {
      throw new MonkeError(
        `Session state for ${state.session} is out of sync with the current dependency graph`
      );
    }
  }
}

export function getOrCreateReservation(home: string, sourceRoot: string, size: number) {
  if (size === 0) {
    return null;
  }

  const filePath = getReservationFilePath(home, sourceRoot);
  if (existsSync(filePath)) {
    const existing = parseOwnedYamlFile(filePath, RepoReservationSchema);
    if (size > existing.size) {
      throw new MonkeError(
        `Repo ${sourceRoot} owns ${size} local ports but its reservation only has room for ${existing.size}`
      );
    }
    return existing;
  }

  let highestReservedPort = GLOBAL_PORT_FLOOR - 1;
  for (const reservation of listReservations(home)) {
    const blockEnd = reservation.blockStart + reservation.size - 1;
    highestReservedPort = Math.max(highestReservedPort, blockEnd);
  }
  const nextReservation: RepoReservation = {
    blockStart: Math.max(GLOBAL_PORT_FLOOR, highestReservedPort + 1),
    size: Math.max(size, MIN_REPO_RESERVATION_SIZE),
    sourceRoot,
    version: 1
  };

  mkdirSync(path.dirname(filePath), { recursive: true });
  const parsed = parseBoundaryValue(RepoReservationSchema, nextReservation, filePath);
  writeFileSync(filePath, stringify(parsed), "utf-8");
  return parsed;
}

export function allocateLocalPorts(options: {
  baselinePorts: Set<number>;
  existingRepoState: SessionRepoState | undefined;
  repoConfig: RepoConfig;
  reservation: RepoReservation | null;
  rootSourceRoot: string;
  session: string;
  store: SessionStateStore;
}) {
  const assignments = new Map<string, number>(
    (options.existingRepoState?.assignedPorts ?? []).map((entry) => [entry.key, entry.value])
  );
  if (options.repoConfig.localPortOrder.length === 0) {
    return assignments;
  }

  if (!options.reservation) {
    throw new MonkeError(`Missing reservation for ${options.repoConfig.sourceRoot}`);
  }

  const globallyManagedPorts = options.store.assignedPortsOutsideRepo({
    rootSourceRoot: options.rootSourceRoot,
    session: options.session,
    sourceRoot: options.repoConfig.sourceRoot
  });

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
          `<MONKE_HOME>/repo-reservations and re-run to grow the block.`
      );
    }

    assignments.set(key, nextPort);
    usedInRepo.add(nextPort);
  }

  return assignments;
}

export function toAssignedPorts(repoConfig: RepoConfig, assignments: Map<string, number>) {
  return repoConfig.localPortOrder.map((key) => ({
    key,
    value: requireAssignment(assignments, key, repoConfig.sourceRoot)
  }));
}

export function getSessionStateFilePath(home: string, rootSourceRoot: string, session: string) {
  return path.join(home, "sessions", `${hashKey(`${rootSourceRoot}\u0000${session}`)}.yml`);
}

function listSessionStateFiles(home: string) {
  const directoryPath = path.join(home, "sessions");
  if (!existsSync(directoryPath)) {
    return [];
  }
  return readdirSync(directoryPath)
    .filter((entry) => entry.endsWith(".yml"))
    .map((entry) => path.join(directoryPath, entry));
}

function invalidSessionStateReferencesWorktree(filePath: string, worktreePaths: string[]) {
  try {
    const partial = parseOwnedYamlFile(filePath, SessionStateWorktreePathsSchema);
    return partial.repos.some((repo) =>
      worktreePaths.some((worktreePath) => samePath(repo.worktreePath, worktreePath))
    );
  } catch {
    const text = readFileSync(filePath, "utf-8");
    const document = parseDocument(text, {
      merge: false,
      strict: false,
      uniqueKeys: false
    });
    let referencesWorktree = false;
    visit(document, {
      Scalar(key, scalar) {
        const scalarValue = z.string().safeParse(scalar.value);
        if (
          key !== "key" &&
          scalarValue.success &&
          worktreePaths.some((candidate) => samePath(scalarValue.data, candidate))
        ) {
          referencesWorktree = true;
        }
        return referencesWorktree ? visit.BREAK : visit.SKIP;
      }
    });
    return referencesWorktree;
  }
}

function getReservationFilePath(home: string, sourceRoot: string) {
  return path.join(home, "repo-reservations", `${hashKey(sourceRoot)}.yml`);
}

function listReservations(home: string) {
  const directoryPath = path.join(home, "repo-reservations");
  if (!existsSync(directoryPath)) {
    return [];
  }

  return readdirSync(directoryPath)
    .filter((entry) => entry.endsWith(".yml"))
    .map((entry) => parseOwnedYamlFile(path.join(directoryPath, entry), RepoReservationSchema));
}

function requireAssignment(assignments: Map<string, number>, key: string, repoRoot: string) {
  const value = assignments.get(key);
  if (value === undefined) {
    throw new MonkeError(`Missing assigned port ${key} for ${repoRoot}`);
  }
  return value;
}
