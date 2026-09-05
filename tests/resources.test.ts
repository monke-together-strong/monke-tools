import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { resolveResourceCommands } from "../src/resources.ts";
import { hashKey } from "../src/runtime.ts";
import { SessionStateStore } from "../src/session-state-store.ts";
import type { RepoConfig, Runtime } from "../src/types.ts";
import { makeTempDir } from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

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
      appsInOrder: [],
      configPath: path.join(sourceRoot, "monke.yml"),
      externalInOrder: [],
      externalMappingsInOrder: [],
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
      ...createTestRuntime({ cwd: sourceRoot, env: {}, onStderr() {}, onStdout() {} }),
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
      }
    };

    const resolved = await resolveResourceCommands({
      existingRepoState: undefined,
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
      rootSourceRoot: sourceRoot,
      runtime,
      session: "banana",
      store: new SessionStateStore(home),
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

  test("pnpm workspaces run resource modules through pnpm-mediated bun", async () => {
    const sandbox = makeTempDir("resources-command-pnpm-runner");
    const home = path.join(sandbox, "home");
    const sourceRoot = path.join(sandbox, "repo");
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(path.join(sourceRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf-8");
    const repoConfig: RepoConfig = {
      appsInOrder: [],
      configPath: path.join(sourceRoot, "monke.yml"),
      externalInOrder: [],
      externalMappingsInOrder: [],
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
      ...createTestRuntime({ cwd: sourceRoot, env: {}, onStderr() {}, onStdout() {} }),
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
      }
    };

    await resolveResourceCommands({
      existingRepoState: undefined,
      onResolvedCommandOutputs() {},
      repoConfig,
      resourceValues: [],
      rootSourceRoot: sourceRoot,
      runtime,
      session: "current",
      store: new SessionStateStore(home),
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
