import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

import { createRuntime, withGlobalLock } from "../src/runtime.ts";
import { makeTempDir } from "./helpers.ts";

test("createRuntime surfaces signal-terminated commands as failures", () => {
  const runtime = createRuntime();

  expect(() => runtime.exec("sh", ["-c", "kill -TERM $$"])).toThrow(/terminated by signal SIGTERM/);
});

test("createRuntime reports exhausted scripted select values clearly", async () => {
  const runtime = createRuntime({ selectValues: [] });

  await expect(
    runtime.select({
      message: "Choose one",
      options: [{ value: "one", label: "One" }],
    }),
  ).rejects.toThrow(/No scripted select values remain/);
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

test("withGlobalLock falls back to the file timestamp for invalid lock metadata", () => {
  const sandbox = makeTempDir("runtime-invalid-lock");
  const home = path.join(sandbox, "home");
  const lockPath = path.join(home, "lock");
  const staleTime = new Date(Date.now() - 86_400_000);

  mkdirSync(home, { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ pid: "not-a-number" }), "utf8");
  utimesSync(lockPath, staleTime, staleTime);

  expect(withGlobalLock(home, () => "acquired")).toBe("acquired");
  expect(existsSync(lockPath)).toBe(false);
});

test("withGlobalLock does not evict stale locks held by a live process", () => {
  const sandbox = makeTempDir("runtime-live-stale-lock");
  const home = path.join(sandbox, "home");
  const lockPath = path.join(home, "lock");

  mkdirSync(home, { recursive: true });
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, acquiredAt: Date.now() - 86_400_000 }),
    "utf8",
  );

  expect(() => withGlobalLock(home, () => "acquired")).toThrow(/Timed out waiting for lock/);
  expect(existsSync(lockPath)).toBe(true);
}, 7_000);
