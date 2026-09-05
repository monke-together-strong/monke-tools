import { closeSync, openSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  allocateLocalPorts,
  getOrCreateReservation,
  getSessionStateFilePath,
  listSessionStatesRelevantToWorktrees,
  loadSessionState,
  saveSessionState,
  SessionStateStore
} from "../src/session-state-store.ts";
import type { RepoConfig, RepoReservation } from "../src/types.ts";
import { completeSessionState, makeTempDir, materializedRepoState, write } from "./helpers.ts";

describe("Session state store", () => {
  test("missing retained state stays explicit", () => {
    const home = makeTempDir("session-state-store-missing");
    const store = new SessionStateStore(home);

    expect(store.get("/repo", "missing")).toBeUndefined();
    expect(() => loadSessionState(home, "/repo", "missing")).toThrow(
      /Missing retained Session state/u
    );
    expect(store.list()).toStrictEqual([]);
  });

  test("checkpoints atomically replace disk state and expose only committed snapshots", () => {
    const home = makeTempDir("session-state-store-atomic");
    const store = new SessionStateStore(home);
    const original = completeSessionState({
      repos: [materializedRepoState({ sourceRoot: "/repo", worktreePath: "/worktree" })],
      rootSourceRoot: "/repo",
      session: "atomic"
    });
    store.checkpoint(original);
    const filePath = getSessionStateFilePath(home, "/repo", "atomic");
    const originalText = readFileSync(filePath, "utf-8");
    const openReader = openSync(filePath, "r");
    const updated = { ...original, copyDirty: false };
    try {
      store.checkpoint(updated);
      // A reader of the previous inode sees the complete old checkpoint, never an overwritten file.
      expect(readFileSync(openReader, "utf-8")).toBe(originalText);
    } finally {
      closeSync(openReader);
    }
    expect(loadSessionState(home, "/repo", "atomic")).toStrictEqual(updated);
    expect(store.get("/repo", "atomic")).toStrictEqual(updated);
    expect(readdirSync(path.dirname(filePath))).toStrictEqual([path.basename(filePath)]);

    const committedText = readFileSync(filePath, "utf-8");
    expect(() => {
      store.checkpoint({ ...updated, repos: [] });
    }).toThrow(/Root repo/u);
    expect(readFileSync(filePath, "utf-8")).toBe(committedText);
    expect(store.get("/repo", "atomic")).toStrictEqual(updated);

    updated.copyDirty = true;
    const borrowed = store.get("/repo", "atomic");
    if (!borrowed) {
      throw new Error("expected retained checkpoint");
    }
    borrowed.copyDirty = true;
    expect(store.get("/repo", "atomic")?.copyDirty).toBeFalsy();
  });

  test("cross-session resource queries observe checkpoints and removals in the opened store", () => {
    const home = makeTempDir("session-state-store-resource-view");
    const store = new SessionStateStore(home);
    const retained = completeSessionState({
      repos: [
        materializedRepoState({
          cleanupEligible: true,
          resourceCommandOutputs: [
            { name: "identity", outputs: [{ env: "OUTPUT", value: "first" }] }
          ],
          resourceValues: [{ env: "VALUE", value: "owned" }],
          sourceRoot: "/repo",
          worktreePath: "/worktree"
        })
      ],
      rootSourceRoot: "/repo",
      session: "first"
    });
    const command = {
      name: "identity",
      outputs: ["OUTPUT"],
      run: "identity.ts",
      timeoutSeconds: 60
    };
    const current = { session: "second", sourceRoot: "/repo" };
    const values = {
      ...current,
      rootSourceRoot: "/repo",
      values: [{ env: "VALUE", value: "owned" }]
    };
    expect(store.resourceCommandInput({ ...current, command })).toStrictEqual({ OUTPUT: [] });
    expect(store.resourceValueCollision(values)).toBeNull();

    store.checkpoint(retained);
    expect(store.resourceCommandInput({ ...current, command })).toStrictEqual({
      OUTPUT: ["first"]
    });
    expect(store.resourceCommandInput({ ...current, command, session: "first" })).toStrictEqual({
      OUTPUT: []
    });
    expect(store.resourceValueCollision(values)).toStrictEqual({
      env: "VALUE",
      session: "first",
      value: "owned"
    });
    expect(store.resourceValueCollision({ ...values, session: "first" })).toBeNull();

    store.remove(retained);
    expect(store.resourceCommandInput({ ...current, command })).toStrictEqual({ OUTPUT: [] });
    expect(store.resourceValueCollision(values)).toBeNull();
    expect(store.get("/repo", "first")).toBeUndefined();
  });

  test("loadSessionState accepts strict v2 repo lifecycle state without an optional Diff base", () => {
    const sandbox = makeTempDir("session-state-store-v2-diff-base");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "root");
    const statePath = getSessionStateFilePath(home, sourceRoot, "banana");
    write(
      home,
      path.relative(home, statePath),
      `version: 2
rootSourceRoot: ${sourceRoot}
session: banana
generation:
  number: 1
  status: complete
repos:
  - sourceRoot: ${sourceRoot}
    worktreePath: /worktree
    assignedPorts: []
    cleanupEligible: false
    preparationStatus: prepared
    materializationStatus: materialized
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
      `version: 2
rootSourceRoot: ${sourceRoot}
session: banana
generation:
  number: 1
  status: complete
repos:
  - sourceRoot: ${sourceRoot}
    worktreePath: /worktree
    assignedPorts: []
    cleanupEligible: false
    preparationStatus: prepared
    materializationStatus: materialized
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
      `version: 2
rootSourceRoot: ${sourceRoot}
session: banana
generation:
  number: 1
  status: incomplete
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
      `version: 2
rootSourceRoot: ${sourceRoot}
session: invalid-port-key
generation:
  number: 1
  status: complete
repos:
  - sourceRoot: ${sourceRoot}
    worktreePath: /worktree
    assignedPorts:
      - key: api-port
        value: 10000
    cleanupEligible: false
    preparationStatus: prepared
    materializationStatus: materialized
`
    );

    expect(() => loadSessionState(home, sourceRoot, "invalid-port-key")).toThrow(/assignedPorts/u);
  });

  test("loadSessionState rejects payload identity that differs from its storage key", () => {
    const sandbox = makeTempDir("session-state-store-identity-mismatch");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "root");
    const statePath = getSessionStateFilePath(home, sourceRoot, "expected");
    write(
      home,
      path.relative(home, statePath),
      `version: 2
rootSourceRoot: ${sourceRoot}
session: different
generation:
  number: 1
  status: complete
repos:
  - sourceRoot: ${sourceRoot}
    worktreePath: /worktree
    assignedPorts: []
    cleanupEligible: false
    preparationStatus: prepared
    materializationStatus: materialized
`
    );

    expect(() => loadSessionState(home, sourceRoot, "expected")).toThrow(/identity.*storage/u);
  });

  test("loadSessionState rejects unknown keys in application-owned state", () => {
    const sandbox = makeTempDir("session-state-store-unknown-session-key");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "root");
    const statePath = getSessionStateFilePath(home, sourceRoot, "banana");
    write(
      home,
      path.relative(home, statePath),
      `version: 2
rootSourceRoot: ${sourceRoot}
session: banana
generation:
  number: 1
  status: complete
repos:
  - sourceRoot: ${sourceRoot}
    worktreePath: /worktree
    assignedPorts: []
    cleanupEligible: false
    preparationStatus: prepared
    materializationStatus: materialized
typo: true
`
    );

    expect(() => loadSessionState(home, sourceRoot, "banana")).toThrow(
      new RegExp(`Invalid ${RegExp.escape(statePath)}[\\s\\S]*typo`, "u")
    );
  });

  test.each([
    {
      expected: /complete generation requires every repo to be prepared and materialized/u,
      name: "a complete generation with pending materialization",
      state: {
        generation: { number: 1, status: "complete" },
        repos: [
          {
            assignedPorts: [],
            cleanupEligible: false,
            materializationStatus: "pending",
            preparationStatus: "pending",
            sourceRoot: "/repo",
            worktreePath: "/worktree"
          }
        ],
        rootSourceRoot: "/repo",
        session: "invalid",
        version: 2
      }
    },
    {
      expected: /complete generation requires every repo to be prepared and materialized/u,
      name: "a complete generation with failed preparation and retained materialization",
      state: {
        generation: { number: 1, status: "complete" },
        repos: [
          {
            assignedPorts: [],
            cleanupEligible: false,
            failure: { message: "missing worktree", phase: "worktree-preparation" },
            materializationStatus: "materialized",
            preparationStatus: "failed",
            sourceRoot: "/repo",
            worktreePath: "/worktree"
          }
        ],
        rootSourceRoot: "/repo",
        session: "invalid",
        version: 2
      }
    },
    {
      expected: /failed preparation requires a Worktree-preparation failure/u,
      name: "failed preparation with pending materialization",
      state: {
        generation: { number: 1, status: "incomplete" },
        repos: [
          {
            assignedPorts: [],
            cleanupEligible: false,
            materializationStatus: "pending",
            preparationStatus: "failed",
            sourceRoot: "/repo",
            worktreePath: "/worktree"
          }
        ],
        rootSourceRoot: "/repo",
        session: "invalid",
        version: 2
      }
    },
    {
      expected: /blocked materialization requires completed preparation/u,
      name: "blocked materialization before preparation",
      state: {
        generation: { number: 1, status: "incomplete" },
        repos: [
          {
            assignedPorts: [],
            blockedBy: "/dependency",
            cleanupEligible: false,
            materializationStatus: "blocked",
            preparationStatus: "pending",
            sourceRoot: "/repo",
            worktreePath: "/worktree"
          }
        ],
        rootSourceRoot: "/repo",
        session: "invalid",
        version: 2
      }
    },
    {
      expected: /default-branch repo requires pinnedRef/u,
      name: "prepared default-branch repo without pinned identity",
      state: {
        generation: { number: 1, status: "complete" },
        repos: [
          {
            assignedPorts: [],
            cleanupEligible: false,
            materializationStatus: "materialized",
            preparationStatus: "prepared",
            sourceRoot: "/repo",
            worktreePath: "/worktree"
          }
        ],
        rootSourceRoot: "/repo",
        session: "invalid",
        spawnSource: "default-branch",
        version: 2
      }
    },
    {
      expected: /Session state requires at least the Root repo/u,
      name: "an empty complete generation",
      state: {
        generation: { number: 1, status: "complete" },
        repos: [],
        rootSourceRoot: "/repo",
        session: "invalid",
        version: 2
      }
    },
    {
      expected: /Session state must include its Root repo/u,
      name: "a repo set without the Root repo",
      state: {
        generation: { number: 1, status: "complete" },
        repos: [
          {
            assignedPorts: [],
            cleanupEligible: false,
            materializationStatus: "materialized",
            preparationStatus: "prepared",
            sourceRoot: "/dependency",
            worktreePath: "/dependency-worktree"
          }
        ],
        rootSourceRoot: "/repo",
        session: "invalid",
        version: 2
      }
    },
    {
      expected: /cannot contain duplicate Source checkouts/u,
      name: "duplicate Source checkout records",
      state: {
        generation: { number: 1, status: "complete" },
        repos: [
          {
            assignedPorts: [],
            cleanupEligible: false,
            materializationStatus: "materialized",
            preparationStatus: "prepared",
            sourceRoot: "/repo",
            worktreePath: "/worktree"
          },
          {
            assignedPorts: [],
            cleanupEligible: false,
            materializationStatus: "materialized",
            preparationStatus: "prepared",
            sourceRoot: "/repo",
            worktreePath: "/other-worktree"
          }
        ],
        rootSourceRoot: "/repo",
        session: "invalid",
        version: 2
      }
    },
    {
      expected: /cannot contain duplicate Session worktrees/u,
      name: "duplicate Session worktree records",
      state: {
        generation: { number: 1, status: "complete" },
        repos: [
          {
            assignedPorts: [],
            cleanupEligible: false,
            materializationStatus: "materialized",
            preparationStatus: "prepared",
            sourceRoot: "/repo",
            worktreePath: "/worktree"
          },
          {
            assignedPorts: [],
            cleanupEligible: false,
            materializationStatus: "materialized",
            preparationStatus: "prepared",
            sourceRoot: "/dependency",
            worktreePath: "/worktree"
          }
        ],
        rootSourceRoot: "/repo",
        session: "invalid",
        version: 2
      }
    },
    {
      expected: /not-started generation cannot be cleanup-eligible/u,
      name: "cleanup eligibility before a generation starts",
      state: {
        generation: { number: 0, status: "not-started" },
        repos: [
          {
            assignedPorts: [],
            cleanupCommand: "cleanup",
            cleanupEligible: true,
            materializationStatus: "pending",
            preparationStatus: "prepared",
            sourceRoot: "/repo",
            worktreePath: "/worktree"
          }
        ],
        rootSourceRoot: "/repo",
        session: "invalid",
        version: 2
      }
    },
    {
      expected: /Resource command outputs require Cleanup eligibility/u,
      name: "Resource command outputs without Cleanup eligibility",
      state: {
        generation: { number: 1, status: "complete" },
        repos: [
          {
            assignedPorts: [],
            cleanupEligible: false,
            materializationStatus: "materialized",
            preparationStatus: "prepared",
            resourceCommandOutputs: [
              {
                name: "identity",
                outputs: [{ env: "AUTH_OUTPUT", value: "retained" }]
              }
            ],
            sourceRoot: "/repo",
            worktreePath: "/worktree"
          }
        ],
        rootSourceRoot: "/repo",
        session: "invalid",
        version: 2
      }
    },
    {
      expected: /retained Spawn source policy requires Session-branch graph source/u,
      name: "default-branch Spawn policy without Session-branch graph source",
      state: {
        generation: { number: 1, status: "complete" },
        repos: [
          {
            assignedPorts: [],
            cleanupEligible: false,
            materializationStatus: "materialized",
            pinnedRef: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            preparationStatus: "prepared",
            sourceRoot: "/repo",
            worktreePath: "/worktree"
          }
        ],
        rootSourceRoot: "/repo",
        session: "invalid",
        spawnSource: "default-branch",
        version: 2
      }
    },
    {
      expected: /retained Spawn source policy requires Session-branch graph source/u,
      name: "session-branch Spawn policy without Session-branch graph source",
      state: {
        generation: { number: 1, status: "complete" },
        repos: [
          {
            assignedPorts: [],
            cleanupEligible: false,
            materializationStatus: "materialized",
            preparationStatus: "prepared",
            sourceRoot: "/repo",
            worktreePath: "/worktree"
          }
        ],
        rootSourceRoot: "/repo",
        session: "invalid",
        spawnSource: "session-branch",
        version: 2
      }
    },
    {
      expected: /pending dirty carry requires current-HEAD Spawn with copyDirty enabled/u,
      name: "pending dirty carry for default-branch Spawn",
      state: {
        generation: { number: 1, status: "incomplete" },
        graphSource: "session-branch",
        repos: [
          {
            assignedPorts: [],
            cleanupEligible: false,
            dirtyCarryStatus: "pending",
            materializationStatus: "pending",
            pinnedRef: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            preparationStatus: "pending",
            sourceRoot: "/repo",
            worktreePath: "/worktree"
          }
        ],
        rootSourceRoot: "/repo",
        session: "invalid",
        spawnSource: "default-branch",
        version: 2
      }
    },
    {
      expected: /pending dirty carry requires current-HEAD Spawn with copyDirty enabled/u,
      name: "pending dirty carry when current-head Spawn disables dirty carry",
      state: {
        copyDirty: false,
        generation: { number: 1, status: "incomplete" },
        repos: [
          {
            assignedPorts: [],
            cleanupEligible: false,
            dirtyCarryStatus: "pending",
            materializationStatus: "pending",
            preparationStatus: "pending",
            sourceRoot: "/repo",
            worktreePath: "/worktree"
          }
        ],
        rootSourceRoot: "/repo",
        session: "invalid",
        version: 2
      }
    },
    {
      expected: /blockedBy must identify another recorded repo/u,
      name: "a repo blocked by itself",
      state: {
        generation: { number: 1, status: "incomplete" },
        repos: [
          {
            assignedPorts: [],
            blockedBy: "/repo",
            cleanupEligible: false,
            materializationStatus: "blocked",
            preparationStatus: "prepared",
            sourceRoot: "/repo",
            worktreePath: "/worktree"
          }
        ],
        rootSourceRoot: "/repo",
        session: "invalid",
        version: 2
      }
    },
    {
      expected: /blockedBy must identify another recorded repo/u,
      name: "a repo blocked by an absent dependency",
      state: {
        generation: { number: 1, status: "incomplete" },
        repos: [
          {
            assignedPorts: [],
            blockedBy: "/missing",
            cleanupEligible: false,
            materializationStatus: "blocked",
            preparationStatus: "prepared",
            sourceRoot: "/repo",
            worktreePath: "/worktree"
          }
        ],
        rootSourceRoot: "/repo",
        session: "invalid",
        version: 2
      }
    },
    {
      expected: /default-branch repo requires pinnedRef/u,
      name: "a pending default-branch repo without pinned identity",
      state: {
        generation: { number: 1, status: "incomplete" },
        repos: [
          {
            assignedPorts: [],
            cleanupEligible: false,
            materializationStatus: "pending",
            preparationStatus: "pending",
            sourceRoot: "/repo",
            worktreePath: "/worktree"
          }
        ],
        rootSourceRoot: "/repo",
        session: "invalid",
        spawnSource: "default-branch",
        version: 2
      }
    },
    {
      expected: /cannot contain duplicate Source checkouts/u,
      name: "normalized duplicate Source checkout records",
      state: {
        generation: { number: 1, status: "complete" },
        repos: [
          {
            assignedPorts: [],
            cleanupEligible: false,
            materializationStatus: "materialized",
            preparationStatus: "prepared",
            sourceRoot: "/repo",
            worktreePath: "/worktree"
          },
          {
            assignedPorts: [],
            cleanupEligible: false,
            materializationStatus: "materialized",
            preparationStatus: "prepared",
            sourceRoot: "/repo/.",
            worktreePath: "/other-worktree"
          }
        ],
        rootSourceRoot: "/repo",
        session: "invalid",
        version: 2
      }
    },
    {
      expected: /cannot contain duplicate Session worktrees/u,
      name: "normalized duplicate Session worktree records",
      state: {
        generation: { number: 1, status: "complete" },
        repos: [
          {
            assignedPorts: [],
            cleanupEligible: false,
            materializationStatus: "materialized",
            preparationStatus: "prepared",
            sourceRoot: "/dependency",
            worktreePath: "/worktree"
          },
          {
            assignedPorts: [],
            cleanupEligible: false,
            materializationStatus: "materialized",
            preparationStatus: "prepared",
            sourceRoot: "/repo",
            worktreePath: "/worktree/."
          }
        ],
        rootSourceRoot: "/repo",
        session: "invalid",
        version: 2
      }
    },
    {
      expected: /Root repo must follow its dependencies in materialization order/u,
      name: "the Root repo before its dependencies",
      state: {
        generation: { number: 1, status: "complete" },
        repos: [
          {
            assignedPorts: [],
            cleanupEligible: false,
            materializationStatus: "materialized",
            preparationStatus: "prepared",
            sourceRoot: "/repo",
            worktreePath: "/root-worktree"
          },
          {
            assignedPorts: [],
            cleanupEligible: false,
            materializationStatus: "materialized",
            preparationStatus: "prepared",
            sourceRoot: "/dependency",
            worktreePath: "/dependency-worktree"
          }
        ],
        rootSourceRoot: "/repo",
        session: "invalid",
        version: 2
      }
    },
    {
      expected: /must be an immutable Git object ID/u,
      name: "a symbolic default-branch pin",
      state: {
        generation: { number: 1, status: "complete" },
        repos: [
          {
            assignedPorts: [],
            cleanupEligible: false,
            materializationStatus: "materialized",
            pinnedRef: "refs/heads/main",
            preparationStatus: "prepared",
            sourceRoot: "/repo",
            worktreePath: "/worktree"
          }
        ],
        rootSourceRoot: "/repo",
        session: "invalid",
        spawnSource: "default-branch",
        version: 2
      }
    },
    {
      expected: /Session state must include its Root repo/u,
      name: "an aliased Root identity",
      state: {
        generation: { number: 1, status: "complete" },
        repos: [
          {
            assignedPorts: [],
            cleanupEligible: false,
            materializationStatus: "materialized",
            preparationStatus: "prepared",
            sourceRoot: "/repo",
            worktreePath: "/worktree"
          }
        ],
        rootSourceRoot: "/repo/.",
        session: "invalid",
        version: 2
      }
    }
  ])("saveSessionState rejects $name", ({ expected, state }) => {
    const sandbox = makeTempDir("session-state-store-lifecycle-invariant");
    // Pin the named invariant: several of these states also trip a second, incidental rule,
    // so matching only /Invalid/ would not prove the intended one fired.
    expect(() => {
      saveSessionState(path.join(sandbox, "home"), state);
    }).toThrow(expected);
  });

  test.each([1, 3])("loadSessionState rejects unsupported version %i", (version) => {
    const sandbox = makeTempDir("session-state-store-future-session-version");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "root");
    const statePath = getSessionStateFilePath(home, sourceRoot, "banana");
    write(
      home,
      path.relative(home, statePath),
      `version: ${version}
rootSourceRoot: ${sourceRoot}
session: banana
repos: []
`
    );

    expect(() => loadSessionState(home, sourceRoot, "banana")).toThrow(
      new RegExp(`Unsupported Session state version ${version}.*${RegExp.escape(statePath)}`, "u")
    );
  });

  test("targeted state checks recognize escaped worktree paths in corrupt YAML", () => {
    const sandbox = makeTempDir("session-state-store-escaped-corrupt-session");
    const home = path.join(sandbox, "home");
    const worktreePath = String.raw`C:\worktrees\banana`;
    write(
      home,
      "sessions/corrupt.yml",
      `version: 2
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
        generation: { number: 1, status: "incomplete" },
        repos: "wrong",
        rootSourceRoot: sourceRoot,
        session: "banana",
        version: 2
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
        repoConfig,
        reservation,
        rootSourceRoot: repoConfig.sourceRoot,
        session: "swing",
        store: new SessionStateStore(path.join(sandbox, "home"))
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
      repoConfig,
      reservation,
      rootSourceRoot: repoConfig.sourceRoot,
      session: "swing",
      store: new SessionStateStore(path.join(sandbox, "home"))
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

    const store = new SessionStateStore(home);
    const firstSession = allocateLocalPorts({
      baselinePorts: new Set(),
      existingRepoState: undefined,
      repoConfig,
      reservation,
      rootSourceRoot: sourceRoot,
      session: "one",
      store
    });
    store.checkpoint({
      generation: { number: 1, status: "complete" },
      repos: [
        {
          assignedPorts: [{ key: "API_PORT", value: firstSession.get("API_PORT") ?? -1 }],
          cleanupEligible: false,
          materializationStatus: "materialized",
          preparationStatus: "prepared",
          sourceRoot,
          worktreePath: path.join(sandbox, "one")
        }
      ],
      rootSourceRoot: sourceRoot,
      session: "one",
      version: 2
    });
    const secondSession = allocateLocalPorts({
      baselinePorts: new Set(),
      existingRepoState: undefined,
      repoConfig,
      reservation,
      rootSourceRoot: sourceRoot,
      session: "two",
      store
    });

    expect(firstSession.get("API_PORT")).toBe(10_000);
    expect(secondSession.get("API_PORT")).toBe(10_001);
  });
});

function makeRepoConfig(sourceRoot: string, localPortOrder: string[]): RepoConfig {
  return {
    appsInOrder: [],
    configPath: path.join(sourceRoot, "monke.yml"),
    externalInOrder: [],
    externalMappingsInOrder: [],
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
