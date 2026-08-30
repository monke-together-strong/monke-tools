import { readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import {
  allocateLocalPorts,
  getOrCreateReservation,
  getSessionStateFilePath,
  listSessionStatesRelevantToWorktrees,
  loadSessionState,
  saveSessionState
} from "../src/session-state-store.ts";
import type { RepoConfig, RepoReservation } from "../src/types.ts";
import { makeTempDir, write } from "./helpers.ts";

describe("Session state store", () => {
  test("loadSessionState keeps legacy repo entries without an optional Diff base compatible", () => {
    const sandbox = makeTempDir("session-state-store-legacy-diff-base");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "root");
    const statePath = getSessionStateFilePath(home, sourceRoot, "banana");
    write(
      home,
      path.relative(home, statePath),
      `version: 1
rootSourceRoot: ${sourceRoot}
session: banana
repos:
  - sourceRoot: ${sourceRoot}
    worktreePath: /worktree
    assignedPorts: []
`
    );

    expect(loadSessionState(home, sourceRoot, "banana").repos[0]?.diffBaseRef).toBeUndefined();
  });

  test("loadSessionState rejects an externally persisted empty Diff base", () => {
    const sandbox = makeTempDir("session-state-store-invalid-diff-base");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "root");
    const statePath = getSessionStateFilePath(home, sourceRoot, "banana");
    write(
      home,
      path.relative(home, statePath),
      `version: 1
rootSourceRoot: ${sourceRoot}
session: banana
repos:
  - sourceRoot: ${sourceRoot}
    worktreePath: /worktree
    assignedPorts: []
    diffBaseRef: ""
`
    );

    expect(() => loadSessionState(home, sourceRoot, "banana")).toThrow(/diffBaseRef/u);
  });

  test("loadSessionState rejects corrupt persisted state with the file and field path", () => {
    const sandbox = makeTempDir("session-state-store-corrupt-session");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "root");
    const statePath = getSessionStateFilePath(home, sourceRoot, "banana");
    write(
      home,
      path.relative(home, statePath),
      `version: 1
rootSourceRoot: ${sourceRoot}
session: banana
repos: wrong
`
    );

    expect(() => loadSessionState(home, sourceRoot, "banana")).toThrow(
      new RegExp(`Invalid ${RegExp.escape(statePath)}:[\\s\\S]*repos`, "u")
    );
  });

  test("loadSessionState rejects persisted assigned ports with invalid port keys", () => {
    const sandbox = makeTempDir("session-state-store-invalid-port-key");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "root");
    const statePath = getSessionStateFilePath(home, sourceRoot, "invalid-port-key");
    write(
      home,
      path.relative(home, statePath),
      `version: 1
rootSourceRoot: ${sourceRoot}
session: invalid-port-key
repos:
  - sourceRoot: ${sourceRoot}
    worktreePath: /worktree
    assignedPorts:
      - key: api-port
        value: 10000
`
    );

    expect(() => loadSessionState(home, sourceRoot, "invalid-port-key")).toThrow(/assignedPorts/u);
  });

  test("loadSessionState rejects unknown keys in application-owned state", () => {
    const sandbox = makeTempDir("session-state-store-unknown-session-key");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "root");
    const statePath = getSessionStateFilePath(home, sourceRoot, "banana");
    write(
      home,
      path.relative(home, statePath),
      `version: 1
rootSourceRoot: ${sourceRoot}
session: banana
repos: []
typo: true
`
    );

    expect(() => loadSessionState(home, sourceRoot, "banana")).toThrow(
      new RegExp(`Invalid ${RegExp.escape(statePath)}`, "u")
    );
  });

  test("loadSessionState rejects unknown future versions", () => {
    const sandbox = makeTempDir("session-state-store-future-session-version");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "root");
    const statePath = getSessionStateFilePath(home, sourceRoot, "banana");
    write(
      home,
      path.relative(home, statePath),
      `version: 2
rootSourceRoot: ${sourceRoot}
session: banana
repos: []
`
    );

    expect(() => loadSessionState(home, sourceRoot, "banana")).toThrow(
      new RegExp(`Invalid ${RegExp.escape(statePath)}:[\\s\\S]*version`, "u")
    );
  });

  test("targeted state checks recognize escaped worktree paths in corrupt YAML", () => {
    const sandbox = makeTempDir("session-state-store-escaped-corrupt-session");
    const home = path.join(sandbox, "home");
    const worktreePath = String.raw`C:\worktrees\banana`;
    write(
      home,
      "sessions/corrupt.yml",
      `version: 1
rootSourceRoot: root
session: banana
repos:
  - worktreePath: ${JSON.stringify(worktreePath)}
    duplicate: first
    duplicate: second
`
    );

    expect(() => listSessionStatesRelevantToWorktrees(home, [worktreePath])).toThrow(
      /corrupt\.yml/u
    );
  });

  test("saveSessionState rejects invalid values before writing them", () => {
    const sandbox = makeTempDir("session-state-store-invalid-write");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "root");

    expect(() => {
      saveSessionState(home, {
        repos: "wrong",
        rootSourceRoot: sourceRoot,
        session: "banana",
        version: 1
      });
    }).toThrow(/Invalid .*sessions.*repos/su);
  });

  test("getOrCreateReservation rejects corrupt persisted reservations", () => {
    const sandbox = makeTempDir("session-state-store-corrupt-reservation");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "root");
    getOrCreateReservation(home, sourceRoot, 1);
    const reservationDirectory = path.join(home, "repo-reservations");
    const [reservationName] = readdirSync(reservationDirectory);
    if (reservationName === undefined) {
      throw new Error("expected a reservation file");
    }
    write(
      reservationDirectory,
      reservationName,
      `version: 1
sourceRoot: ${sourceRoot}
blockStart: 10000
size: wrong
`
    );

    expect(() => getOrCreateReservation(home, sourceRoot, 1)).toThrow(
      /Invalid .*repo-reservations.*size/su
    );
  });

  test.each([
    {
      contents: (sourceRoot: string) =>
        `version: 1
sourceRoot: ${sourceRoot}
blockStart: 10000
size: 1000
typo: true
`,
      expected: /typo/u,
      name: "unknown keys"
    },
    {
      contents: (sourceRoot: string) =>
        `version: 2
sourceRoot: ${sourceRoot}
blockStart: 10000
size: 1000
`,
      expected: /version/u,
      name: "unknown future versions"
    }
  ])("getOrCreateReservation rejects $name", ({ contents, expected }) => {
    const sandbox = makeTempDir("session-state-store-reservation-versioning");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "root");
    getOrCreateReservation(home, sourceRoot, 1);
    const reservationDirectory = path.join(home, "repo-reservations");
    const [reservationName] = readdirSync(reservationDirectory);
    if (reservationName === undefined) {
      throw new Error("expected a reservation file");
    }
    write(reservationDirectory, reservationName, contents(sourceRoot));

    expect(() => getOrCreateReservation(home, sourceRoot, 1)).toThrow(expected);
  });

  test("allocateLocalPorts skips ports that are already taken inside the reserved block", async () => {
    const sandbox = makeTempDir("session-state-store-taken");
    const repoConfig = makeRepoConfig(path.join(sandbox, "root"), ["API_PORT"]);

    const listener = Bun.serve({
      fetch() {
        return new Response("ok");
      },
      hostname: "127.0.0.1",
      port: 0
    });
    const occupiedPort = listener.port;
    if (occupiedPort === undefined) {
      throw new Error("expected Bun.serve to bind a TCP port");
    }
    const reservation = makeReservation(repoConfig.sourceRoot, occupiedPort, 2);

    try {
      const assignments = allocateLocalPorts({
        baselinePorts: new Set(),
        existingRepoState: undefined,
        home: path.join(sandbox, "home"),
        repoConfig,
        reservation,
        rootSourceRoot: repoConfig.sourceRoot,
        session: "swing"
      });

      expect(assignments.get("API_PORT")).toBe(occupiedPort + 1);
    } finally {
      await listener.stop(true);
    }
  });

  test("allocateLocalPorts skips baseline local-dev ports before choosing session ports", () => {
    const sandbox = makeTempDir("session-state-store-baseline");
    const repoConfig = makeRepoConfig(path.join(sandbox, "root"), ["API_PORT"]);
    const reservation = makeReservation(repoConfig.sourceRoot, 10_000, 2);

    const assignments = allocateLocalPorts({
      baselinePorts: new Set([10_000]),
      existingRepoState: undefined,
      home: path.join(sandbox, "home"),
      repoConfig,
      reservation,
      rootSourceRoot: repoConfig.sourceRoot,
      session: "swing"
    });

    expect(assignments.get("API_PORT")).toBe(10_001);
  });

  test("getOrCreateReservation fails instead of resizing an existing repo block", () => {
    const sandbox = makeTempDir("session-state-store-overflow");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "root");

    const firstReservation = getOrCreateReservation(home, sourceRoot, 1);
    expect(firstReservation?.blockStart).toBe(10_000);
    expect(firstReservation?.size).toBe(1000);

    expect(() => getOrCreateReservation(home, sourceRoot, 1001)).toThrow(
      /its reservation only has room for 1000/u
    );
  });

  test("getOrCreateReservation leaves spare ports for multiple retained sessions", () => {
    const sandbox = makeTempDir("session-state-store-capacity");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "root");
    const repoConfig = makeRepoConfig(sourceRoot, ["API_PORT"]);
    const reservation = getOrCreateReservation(home, sourceRoot, repoConfig.localPortOrder.length);

    const firstSession = allocateLocalPorts({
      baselinePorts: new Set(),
      existingRepoState: undefined,
      home,
      repoConfig,
      reservation,
      rootSourceRoot: sourceRoot,
      session: "one"
    });
    saveSessionState(home, {
      repos: [
        {
          assignedPorts: [{ key: "API_PORT", value: firstSession.get("API_PORT") ?? -1 }],
          sourceRoot,
          worktreePath: path.join(sandbox, "one")
        }
      ],
      rootSourceRoot: sourceRoot,
      session: "one",
      version: 1
    });
    const secondSession = allocateLocalPorts({
      baselinePorts: new Set(),
      existingRepoState: undefined,
      home,
      repoConfig,
      reservation,
      rootSourceRoot: sourceRoot,
      session: "two"
    });

    expect(firstSession.get("API_PORT")).toBe(10_000);
    expect(secondSession.get("API_PORT")).toBe(10_001);
  });
});

function makeRepoConfig(sourceRoot: string, localPortOrder: string[]): RepoConfig {
  return {
    appsByLabel: new Map(),
    appsInOrder: [],
    configPath: path.join(sourceRoot, "monke.yml"),
    externalInOrder: [],
    externalMappingsInOrder: [],
    externalTargetApps: new Set(),
    localMappingsByPort: new Map(),
    localPortOrder,
    resourceCommandsInOrder: [],
    resourceValuesInOrder: [],
    seedPaths: [],
    sourceRoot
  };
}

function makeReservation(sourceRoot: string, blockStart: number, size: number): RepoReservation {
  return {
    blockStart,
    size,
    sourceRoot,
    version: 1
  };
}
