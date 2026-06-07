import { expect, test } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";

import { resolveResourceCommands } from "../src/resources.ts";
import { hashKey } from "../src/runtime.ts";
import type { RepoConfig, Runtime } from "../src/types.ts";
import { makeTempDir } from "./helpers.ts";

test("resource command lock covers command execution and immediate persistence", () => {
  const sandbox = makeTempDir("resources-command-lock");
  const home = path.join(sandbox, "home");
  const sourceRoot = path.join(sandbox, "repo");
  const lockPath = path.join(
    home,
    "locks",
    `${hashKey(`resource-command\u0000${sourceRoot}\u0000e2e-symbols`)}.lock`,
  );
  let commandSawLock = false;
  let persistenceSawLock = false;

  const repoConfig: RepoConfig = {
    sourceRoot,
    configPath: path.join(sourceRoot, "monke.yml"),
    seedPaths: [],
    resourceValuesInOrder: [],
    resourceCommandsInOrder: [
      {
        name: "e2e-symbols",
        command: "allocate-symbols",
        timeoutSeconds: 60,
        outputs: ["E2E_FLOW1_SYMBOL"],
      },
    ],
    appsInOrder: [],
    appsByLabel: new Map(),
    externalInOrder: [],
    localPortOrder: [],
    localMappingsByPort: new Map(),
    externalMappingsInOrder: [],
    externalTargetApps: new Set(),
  };
  const runtime: Runtime = {
    cwd: sourceRoot,
    env: {},
    exec(_command, _args, options) {
      commandSawLock = existsSync(lockPath);
      expect(JSON.parse(options?.stdin ?? "")).toEqual({ E2E_FLOW1_SYMBOL: [] });
      return {
        stdout: '{"E2E_FLOW1_SYMBOL":"SOL/USDT:USDT"}',
        stderr: "",
        exitCode: 0,
      };
    },
    writeStdout() {},
    writeStderr() {},
  };

  const resolved = resolveResourceCommands({
    runtime,
    home,
    session: "banana",
    repoConfig,
    existingRepoState: undefined,
    worktreePath: sourceRoot,
    onResolvedCommandOutputs(commands) {
      persistenceSawLock = existsSync(lockPath);
      expect(commands).toEqual([
        {
          name: "e2e-symbols",
          outputs: [{ env: "E2E_FLOW1_SYMBOL", value: "SOL/USDT:USDT" }],
        },
      ]);
    },
  });

  expect(commandSawLock).toBe(true);
  expect(persistenceSawLock).toBe(true);
  expect(existsSync(lockPath)).toBe(false);
  expect(resolved.commands).toEqual([
    {
      name: "e2e-symbols",
      outputs: [{ env: "E2E_FLOW1_SYMBOL", value: "SOL/USDT:USDT" }],
    },
  ]);
});
