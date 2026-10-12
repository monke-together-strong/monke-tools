import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { CheckoutResourceStore, resourceOwner } from "../src/checkout-resource-store.ts";
import { resolveResourceCommands, runResourceCommand } from "../src/resources.ts";
import { hashKey } from "../src/runtime.ts";
import type { RepoConfig, Runtime } from "../src/types.ts";
import { makeTempDir } from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

describe("resources", () => {
  test("resource runner output with a BOM is a protocol violation", async () => {
    const sourceRoot = makeTempDir("resources-output-bom");
    const runtime: Runtime = {
      ...createTestRuntime({ cwd: sourceRoot, env: {}, onStderr() {}, onStdout() {} }),
      async execAsync(_command, args) {
        await Bun.write(args?.[5] ?? "", '\uFEFF{"value":{"VALUE":"allocated"}}');
        return { exitCode: 0, stderr: "", stdout: "" };
      }
    };
    await expect(
      runResourceCommand({
        command: { name: "example", outputs: ["VALUE"], run: "example.ts", timeoutSeconds: 60 },
        resourceValues: [],
        runtime,
        session: "",
        sourceRoot,
        stdin: {},
        worktreePath: sourceRoot
      })
    ).rejects.toThrow("runner protocol violation");
  });

  test.each([false, true])(
    "checkpointing a new command retains each retired output once for legacy=%s",
    async (legacy) => {
      const sandbox = makeTempDir("resources-retired-output-checkpoint");
      const sourceRoot = path.join(sandbox, "repo");
      const store = new CheckoutResourceStore(path.join(sandbox, "home"));
      const record = store.get(resourceOwner(sourceRoot, sourceRoot));
      const original = {
        legacy,
        name: "retained",
        outputs: [
          { env: "KEPT", value: "kept" },
          { env: "RETIRED", value: "retired" }
        ],
        run: "retained.ts",
        timeoutSeconds: 60
      };
      record.resourceCommandOutputs = [original];
      store.save(record);
      const repoConfig: RepoConfig = {
        appsInOrder: [],
        configPath: path.join(sourceRoot, "monke.yml"),
        externalInOrder: [],
        externalMappingsInOrder: [],
        localPortOrder: [],
        resourceCommandsInOrder: [
          { name: "retained", outputs: ["KEPT"], run: "retained.ts", timeoutSeconds: 60 },
          { name: "new", outputs: ["NEW"], run: "new.ts", timeoutSeconds: 60 }
        ],
        resourceValuesInOrder: [],
        seedPaths: [],
        sourceRoot
      };
      const runtime: Runtime = {
        ...createTestRuntime({ cwd: sourceRoot, env: {}, onStderr() {}, onStdout() {} }),
        async execAsync(_command, args) {
          expect(args?.[4]).toBe(path.join(sourceRoot, "new.ts"));
          writeFileSync(args?.[5] ?? "", JSON.stringify({ value: { NEW: "new" } }));
          return { exitCode: 0, stderr: "", stdout: "" };
        }
      };
      let checkpointed = false;
      await resolveResourceCommands({
        existingRepoState: record,
        onCommandExecutionStarting(commands) {
          expect(commands[0]).toStrictEqual(original);
        },
        onResolvedCommandOutputs(commands) {
          checkpointed = true;
          record.resourceCommandOutputs = commands;
          store.save(record);
        },
        repoConfig,
        resourceValues: [],
        rootSourceRoot: sourceRoot,
        runtime,
        session: "",
        store,
        worktreePath: sourceRoot
      });
      expect(checkpointed).toBeTruthy();
      expect(store.get(record.owner).resourceCommandOutputs).toStrictEqual([
        original,
        expect.objectContaining({ name: "new", outputs: [{ env: "NEW", value: "new" }] })
      ]);
    }
  );

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
        expect(JSON.parse(options?.stdin ?? "")).toMatchObject({
          previous: { E2E_FLOW1_SYMBOL: [] }
        });
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
        expect(commands).toMatchObject([
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
      store: new CheckoutResourceStore(home),
      worktreePath: sourceRoot
    });

    expect(commandSawLock).toBeTruthy();
    expect(persistenceSawLock).toBeTruthy();
    expect(existsSync(lockPath)).toBeFalsy();
    expect(resolved.commands).toMatchObject([
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
      store: new CheckoutResourceStore(home),
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
