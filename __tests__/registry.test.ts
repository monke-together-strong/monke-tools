import { expect, test } from "vitest";
import path from "node:path";

import { allocateLocalPorts, getOrCreateReservation } from "../src/registry.ts";
import type { RepoConfig, RepoReservation } from "../src/types.ts";
import { makeTempDir } from "./helpers.ts";

test("allocateLocalPorts skips ports that are already taken inside the reserved block", () => {
  const sandbox = makeTempDir("registry-taken");
  const repoConfig = makeRepoConfig(path.join(sandbox, "root"), ["API_PORT"]);

  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data() {},
      open() {},
      close() {},
      drain() {},
      error() {},
    },
    fetch() {
      return new Response("ok");
    },
  });
  const reservation = makeReservation(repoConfig.sourceRoot, listener.port, 2);

  try {
    const assignments = allocateLocalPorts({
      home: path.join(sandbox, "home"),
      rootSourceRoot: repoConfig.sourceRoot,
      session: "swing",
      repoConfig,
      existingRepoState: undefined,
      reservation,
      baselinePorts: new Set(),
    });

    expect(assignments.get("API_PORT")).toBe(listener.port + 1);
  } finally {
    listener.stop(true);
  }
});

test("allocateLocalPorts skips baseline local-dev ports before choosing session ports", () => {
  const sandbox = makeTempDir("registry-baseline");
  const repoConfig = makeRepoConfig(path.join(sandbox, "root"), ["API_PORT"]);
  const reservation = makeReservation(repoConfig.sourceRoot, 10_000, 2);

  const assignments = allocateLocalPorts({
    home: path.join(sandbox, "home"),
    rootSourceRoot: repoConfig.sourceRoot,
    session: "swing",
    repoConfig,
    existingRepoState: undefined,
    reservation,
    baselinePorts: new Set([10_000]),
  });

  expect(assignments.get("API_PORT")).toBe(10_001);
});

test("getOrCreateReservation fails instead of resizing an existing repo block", () => {
  const sandbox = makeTempDir("registry-overflow");
  const home = path.join(sandbox, "home");
  const sourceRoot = path.join(sandbox, "root");

  const firstReservation = getOrCreateReservation(home, sourceRoot, 1);
  expect(firstReservation?.blockStart).toBe(10_000);
  expect(firstReservation?.size).toBe(1);

  expect(() => getOrCreateReservation(home, sourceRoot, 2)).toThrow(
    /its reservation only has room for 1/,
  );
});

function makeRepoConfig(sourceRoot: string, localPortOrder: string[]): RepoConfig {
  return {
    sourceRoot,
    configPath: path.join(sourceRoot, "monke.yml"),
    appsInOrder: [],
    appsByLabel: new Map(),
    externalInOrder: [],
    localPortOrder,
    localMappingsByPort: new Map(),
    externalMappingsInOrder: [],
    externalTargetApps: new Set(),
  };
}

function makeReservation(sourceRoot: string, blockStart: number, size: number): RepoReservation {
  return {
    version: 1,
    sourceRoot,
    blockStart,
    size,
  };
}
