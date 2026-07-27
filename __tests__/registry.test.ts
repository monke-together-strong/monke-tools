import { describe, expect, test } from "vite-plus/test";
import { readdirSync } from "node:fs";
import path from "node:path";

import {
  allocateLocalPorts,
  getOrCreateReservation,
  getSessionStateFilePath,
  loadSessionState,
  saveSessionState,
} from "../src/registry.ts";
import type { RepoConfig, RepoReservation } from "../src/types.ts";
import { makeTempDir, write } from "./helpers.ts";

describe("session registry", () => {
  test("loadSessionState rejects corrupt persisted state with the file and field path", () => {
    const sandbox = makeTempDir("registry-corrupt-session");
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
`,
    );

    expect(() => loadSessionState(home, sourceRoot, "banana")).toThrow(
      new RegExp(`Invalid ${escapeRegExp(statePath)}:[\\s\\S]*repos`, "u"),
    );
  });

  test("loadSessionState rejects persisted assigned ports with invalid port keys", () => {
    const sandbox = makeTempDir("registry-invalid-port-key");
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
`,
    );

    expect(() => loadSessionState(home, sourceRoot, "invalid-port-key")).toThrow(/assignedPorts/u);
  });

  test("loadSessionState rejects unknown keys in application-owned state", () => {
    const sandbox = makeTempDir("registry-unknown-session-key");
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
`,
    );

    expect(() => loadSessionState(home, sourceRoot, "banana")).toThrow(
      new RegExp(`Invalid ${escapeRegExp(statePath)}`, "u"),
    );
  });

  test("loadSessionState rejects unknown future versions", () => {
    const sandbox = makeTempDir("registry-future-session-version");
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
`,
    );

    expect(() => loadSessionState(home, sourceRoot, "banana")).toThrow(
      new RegExp(`Invalid ${escapeRegExp(statePath)}:[\\s\\S]*version`, "u"),
    );
  });

  test("saveSessionState rejects invalid values before writing them", () => {
    const sandbox = makeTempDir("registry-invalid-write");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "root");

    expect(() => {
      saveSessionState(home, {
        repos: "wrong",
        rootSourceRoot: sourceRoot,
        session: "banana",
        version: 1,
      } as never);
    }).toThrow(/Invalid .*sessions.*repos/su);
  });

  test("getOrCreateReservation rejects corrupt persisted reservations", () => {
    const sandbox = makeTempDir("registry-corrupt-reservation");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "root");
    getOrCreateReservation(home, sourceRoot, 1);
    const reservationDirectory = path.join(home, "repo-reservations");
    const reservationName = readdirSync(reservationDirectory)[0]!;
    write(
      reservationDirectory,
      reservationName,
      `version: 1
sourceRoot: ${sourceRoot}
blockStart: 10000
size: wrong
`,
    );

    expect(() => getOrCreateReservation(home, sourceRoot, 1)).toThrow(
      /Invalid .*repo-reservations.*size/su,
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
      name: "unknown keys",
    },
    {
      contents: (sourceRoot: string) =>
        `version: 2
sourceRoot: ${sourceRoot}
blockStart: 10000
size: 1000
`,
      expected: /version/u,
      name: "unknown future versions",
    },
  ])("getOrCreateReservation rejects $name", ({ contents, expected }) => {
    const sandbox = makeTempDir("registry-reservation-versioning");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "root");
    getOrCreateReservation(home, sourceRoot, 1);
    const reservationDirectory = path.join(home, "repo-reservations");
    const reservationName = readdirSync(reservationDirectory)[0]!;
    write(reservationDirectory, reservationName, contents(sourceRoot));

    expect(() => getOrCreateReservation(home, sourceRoot, 1)).toThrow(expected);
  });

  test("allocateLocalPorts skips ports that are already taken inside the reserved block", async () => {
    const sandbox = makeTempDir("registry-taken");
    const repoConfig = makeRepoConfig(path.join(sandbox, "root"), ["API_PORT"]);

    const listener = Bun.serve({
      fetch() {
        return new Response("ok");
      },
      hostname: "127.0.0.1",
      port: 0,
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
        session: "swing",
      });

      expect(assignments.get("API_PORT")).toBe(occupiedPort + 1);
    } finally {
      await listener.stop(true);
    }
  });

  test("allocateLocalPorts skips baseline local-dev ports before choosing session ports", () => {
    const sandbox = makeTempDir("registry-baseline");
    const repoConfig = makeRepoConfig(path.join(sandbox, "root"), ["API_PORT"]);
    const reservation = makeReservation(repoConfig.sourceRoot, 10_000, 2);

    const assignments = allocateLocalPorts({
      baselinePorts: new Set([10_000]),
      existingRepoState: undefined,
      home: path.join(sandbox, "home"),
      repoConfig,
      reservation,
      rootSourceRoot: repoConfig.sourceRoot,
      session: "swing",
    });

    expect(assignments.get("API_PORT")).toBe(10_001);
  });

  test("getOrCreateReservation fails instead of resizing an existing repo block", () => {
    const sandbox = makeTempDir("registry-overflow");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "root");

    const firstReservation = getOrCreateReservation(home, sourceRoot, 1);
    expect(firstReservation?.blockStart).toBe(10_000);
    expect(firstReservation?.size).toBe(1000);

    expect(() => getOrCreateReservation(home, sourceRoot, 1001)).toThrow(
      /its reservation only has room for 1000/u,
    );
  });

  test("getOrCreateReservation leaves spare ports for multiple retained sessions", () => {
    const sandbox = makeTempDir("registry-capacity");
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
      session: "one",
    });
    saveSessionState(home, {
      repos: [
        {
          assignedPorts: [{ key: "API_PORT", value: firstSession.get("API_PORT") ?? -1 }],
          sourceRoot,
          worktreePath: path.join(sandbox, "one"),
        },
      ],
      rootSourceRoot: sourceRoot,
      session: "one",
      version: 1,
    });
    const secondSession = allocateLocalPorts({
      baselinePorts: new Set(),
      existingRepoState: undefined,
      home,
      repoConfig,
      reservation,
      rootSourceRoot: sourceRoot,
      session: "two",
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
    sourceRoot,
  };
}

function makeReservation(sourceRoot: string, blockStart: number, size: number): RepoReservation {
  return {
    blockStart,
    size,
    sourceRoot,
    version: 1,
  };
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
