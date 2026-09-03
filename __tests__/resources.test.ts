import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { resolveResourceCommands } from "../src/resources.ts";
import { createRuntime, hashKey } from "../src/runtime.ts";
import { saveSessionState } from "../src/session-state-store.ts";
import type { RepoConfig, Runtime } from "../src/types.ts";
import { completeSessionState, makeTempDir, materializedRepoState } from "./helpers.ts";

describe("resources", () => {
  test("resource command lock covers command execution and immediate persistence", async () => {
    const sandbox = makeTempDir("resources-command-lock");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "repo");
    const lockPath = path.join(
      home,
      "locks",
      `${hashKey(`resource-command\u0000${sourceRoot}\u0000e2e-symbols`)}.lock`
    );
    let commandSawLock = false;
    let persistenceSawLock = false;

    const repoConfig: RepoConfig = {
      appsByLabel: new Map(),
      appsInOrder: [],
      configPath: path.join(sourceRoot, "monke.yml"),
      externalInOrder: [],
      externalMappingsInOrder: [],
      externalTargetApps: new Set(),
      localMappingsByPort: new Map(),
      localPortOrder: [],
      resourceCommandsInOrder: [
        {
          name: "e2e-symbols",
          outputs: ["E2E_FLOW1_SYMBOL"],
          run: "scripts/allocate-symbols.ts",
          timeoutSeconds: 60
        }
      ],
      resourceValuesInOrder: [],
      seedPaths: [],
      sourceRoot
    };
    const runtime: Runtime = {
      ...createRuntime({ cwd: sourceRoot }),
      cwd: sourceRoot,
      env: {},
      async execAsync(command, args, options) {
        expect(command).toBe("bun");
        expect(args?.[0]).toBe("--eval");
        expect(args?.[2]).toBe("--");
        expect(args?.[3]).toBe("monke-resource-command-runner");
        expect(args?.[4]).toBe(path.join(sourceRoot, "scripts/allocate-symbols.ts"));
        expect(options?.cwd).toBe(sourceRoot);
        commandSawLock = existsSync(lockPath);
        expect(JSON.parse(options?.stdin ?? "")).toStrictEqual({ E2E_FLOW1_SYMBOL: [] });
        expect(options?.env).toStrictEqual({ E2E_CHANNEL_NAME: "banana" });
        writeFileSync(
          args?.[5] ?? "",
          JSON.stringify({ value: { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" } }),
          "utf-8"
        );
        return {
          exitCode: 0,
          stderr: "",
          stdout: "progress log\n"
        };
      },
      multiSelect() {
        return Promise.reject(new Error("unexpected multiSelect"));
      },
      readLine() {
        throw new Error("unexpected readLine");
      },
      select() {
        return Promise.reject(new Error("unexpected select"));
      },
      writeStderr() {},
      writeStdout() {}
    };

    const resolved = await resolveResourceCommands({
      existingRepoState: undefined,
      home,
      onResolvedCommandOutputs(commands) {
        persistenceSawLock = existsSync(lockPath);
        expect(commands).toStrictEqual([
          {
            name: "e2e-symbols",
            outputs: [{ env: "E2E_FLOW1_SYMBOL", value: "SOL/USDT:USDT" }]
          }
        ]);
      },
      repoConfig,
      resourceValues: [{ env: "E2E_CHANNEL_NAME", value: "banana" }],
      runtime,
      session: "banana",
      worktreePath: sourceRoot
    });

    expect(commandSawLock).toBeTruthy();
    expect(persistenceSawLock).toBeTruthy();
    expect(existsSync(lockPath)).toBeFalsy();
    expect(resolved.commands).toStrictEqual([
      {
        name: "e2e-symbols",
        outputs: [{ env: "E2E_FLOW1_SYMBOL", value: "SOL/USDT:USDT" }]
      }
    ]);
  });

  test("resource command input values are sorted for deterministic stdin", async () => {
    const sandbox = makeTempDir("resources-command-input-sort");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "repo");
    const repoConfig: RepoConfig = {
      appsByLabel: new Map(),
      appsInOrder: [],
      configPath: path.join(sourceRoot, "monke.yml"),
      externalInOrder: [],
      externalMappingsInOrder: [],
      externalTargetApps: new Set(),
      localMappingsByPort: new Map(),
      localPortOrder: [],
      resourceCommandsInOrder: [
        {
          name: "e2e-symbols",
          outputs: ["E2E_FLOW1_SYMBOL"],
          run: "scripts/allocate-symbols.ts",
          timeoutSeconds: 60
        }
      ],
      resourceValuesInOrder: [],
      seedPaths: [],
      sourceRoot
    };
    let stdin: unknown;
    let commandEnv: Record<string, string | undefined> | undefined;

    saveSessionState(
      home,
      completeSessionState({
        repos: [
          materializedRepoState({
            cleanupEligible: true,
            resourceCommandOutputs: [
              {
                name: "e2e-symbols",
                outputs: [{ env: "E2E_FLOW1_SYMBOL", value: "ZEC/USDT:USDT" }]
              }
            ],
            sourceRoot,
            worktreePath: path.join(sourceRoot, "later")
          })
        ],
        rootSourceRoot: sourceRoot,
        session: "later"
      })
    );
    saveSessionState(
      home,
      completeSessionState({
        repos: [
          materializedRepoState({
            cleanupEligible: true,
            resourceCommandOutputs: [
              {
                name: "e2e-symbols",
                outputs: [{ env: "E2E_FLOW1_SYMBOL", value: "ADA/USDT:USDT" }]
              }
            ],
            sourceRoot,
            worktreePath: path.join(sourceRoot, "earlier")
          })
        ],
        rootSourceRoot: sourceRoot,
        session: "earlier"
      })
    );

    const runtime: Runtime = {
      ...createRuntime({ cwd: sourceRoot }),
      cwd: sourceRoot,
      env: {},
      async execAsync(command, args, options) {
        expect(command).toBe("bun");
        stdin = JSON.parse(options?.stdin ?? "");
        commandEnv = options?.env;
        writeFileSync(
          args?.[5] ?? "",
          JSON.stringify({ value: { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" } }),
          "utf-8"
        );
        return {
          exitCode: 0,
          stderr: "",
          stdout: ""
        };
      },
      multiSelect() {
        return Promise.reject(new Error("unexpected multiSelect"));
      },
      readLine() {
        throw new Error("unexpected readLine");
      },
      select() {
        return Promise.reject(new Error("unexpected select"));
      },
      writeStderr() {},
      writeStdout() {}
    };

    await resolveResourceCommands({
      existingRepoState: undefined,
      home,
      onResolvedCommandOutputs() {},
      repoConfig,
      resourceValues: [{ env: "E2E_CHANNEL_NAME", value: "current" }],
      runtime,
      session: "current",
      worktreePath: sourceRoot
    });

    expect(stdin).toStrictEqual({
      E2E_FLOW1_SYMBOL: ["ADA/USDT:USDT", "ZEC/USDT:USDT"]
    });
    expect(commandEnv).toStrictEqual({ E2E_CHANNEL_NAME: "current" });
  });

  test("pnpm workspaces run resource modules through pnpm-mediated bun", async () => {
    const sandbox = makeTempDir("resources-command-pnpm-runner");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "repo");
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(path.join(sourceRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf-8");
    const repoConfig: RepoConfig = {
      appsByLabel: new Map(),
      appsInOrder: [],
      configPath: path.join(sourceRoot, "monke.yml"),
      externalInOrder: [],
      externalMappingsInOrder: [],
      externalTargetApps: new Set(),
      localMappingsByPort: new Map(),
      localPortOrder: [],
      resourceCommandsInOrder: [
        {
          name: "e2e-symbols",
          outputs: ["E2E_FLOW1_SYMBOL"],
          run: "scripts/allocate-symbols.ts",
          timeoutSeconds: 60
        }
      ],
      resourceValuesInOrder: [],
      seedPaths: [],
      sourceRoot
    };
    const invocations: { args: string[] | undefined; command: string }[] = [];

    const runtime: Runtime = {
      ...createRuntime({ cwd: sourceRoot }),
      cwd: sourceRoot,
      env: {},
      async execAsync(command, args, _options) {
        invocations.push({ args, command });
        writeFileSync(
          args?.[7] ?? "",
          JSON.stringify({ value: { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" } }),
          "utf-8"
        );
        return {
          exitCode: 0,
          stderr: "",
          stdout: "pnpm progress log\n"
        };
      },
      multiSelect() {
        return Promise.reject(new Error("unexpected multiSelect"));
      },
      readLine() {
        throw new Error("unexpected readLine");
      },
      select() {
        return Promise.reject(new Error("unexpected select"));
      },
      writeStderr() {},
      writeStdout() {}
    };

    await resolveResourceCommands({
      existingRepoState: undefined,
      home,
      onResolvedCommandOutputs() {},
      repoConfig,
      resourceValues: [],
      runtime,
      session: "current",
      worktreePath: sourceRoot
    });

    const [invocation] = invocations;
    expect(invocation?.command).toBe("pnpm");
    expect(invocation?.args?.slice(0, 5)).toStrictEqual([
      "exec",
      "bun",
      "--eval",
      expect.any(String),
      "--"
    ]);
    expect(invocation?.args?.[5]).toBe("monke-resource-command-runner");
    expect(invocation?.args?.[6]).toBe(path.join(sourceRoot, "scripts/allocate-symbols.ts"));
  });
});
