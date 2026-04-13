import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

import { createRuntime, withGlobalLock } from "../src/runtime.ts";
import { makeTempDir } from "./helpers.ts";

test("createRuntime surfaces signal-terminated commands as failures", () => {
  const runtime = createRuntime();

  expect(() => runtime.exec("sh", ["-c", "kill -TERM $$"])).toThrow(/terminated by signal SIGTERM/);
});

test("withGlobalLock evicts stale locks left by dead processes", () => {
  const sandbox = makeTempDir("runtime-stale-lock");
  const home = path.join(sandbox, "home");
  const lockPath = path.join(home, "lock");

  mkdirSync(home, { recursive: true });
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999_999, acquiredAt: Date.now() - 86_400_000 }),
    "utf8",
  );

  const result = withGlobalLock(home, () => "acquired");

  expect(result).toBe("acquired");
  expect(existsSync(lockPath)).toBe(false);
});
