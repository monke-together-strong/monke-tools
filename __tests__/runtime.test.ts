import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test, vi } from "vite-plus/test";

import { createRuntime, isProcessRunning, withGlobalLock } from "../src/runtime.ts";
import { makeTempDir } from "./helpers.ts";

describe("runtime", () => {
  test.each([
    ["EPERM", true],
    ["ESRCH", false],
    ["EIO", true]
  ])("process liveness treats %s conservatively", (code, expected) => {
    const killMock = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });
    try {
      expect(isProcessRunning(1234)).toBe(expected);
    } finally {
      killMock.mockRestore();
    }
  });

  test("createRuntime surfaces signal-terminated commands as failures", () => {
    const runtime = createRuntime();

    expect(() => runtime.exec("sh", ["-c", "kill -TERM $$"])).toThrow(
      /terminated by signal SIGTERM/u
    );
  });

  test("createRuntime reports exhausted scripted select values clearly", async () => {
    const runtime = createRuntime({ selectValues: [] });

    await expect(
      runtime.select({
        message: "Choose one",
        options: [{ label: "One", value: "one" }]
      })
    ).rejects.toThrow(/No scripted select values remain/u);
  });

  test("Release requests fall through an empty GH_TOKEN to GITHUB_TOKEN", async () => {
    let authorization = "";
    let signal: AbortSignal | null | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      authorization = new Headers(init?.headers).get("Authorization") ?? "";
      signal = init?.signal;
      return new Response("[]", { status: 200 });
    });

    try {
      const runtime = createRuntime({ env: { GH_TOKEN: "", GITHUB_TOKEN: "fallback-token" } });
      await runtime.releaseDistribution.listReleases(1);
    } finally {
      fetchMock.mockRestore();
    }

    expect(authorization).toBe("Bearer fallback-token");
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  test("Release asset downloads reject unapproved URLs before sending credentials", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const runtime = createRuntime({ env: { GITHUB_TOKEN: "secret-token" } });
      await expect(
        runtime.releaseDistribution.downloadReleaseAsset("https://example.com/release.tar.gz")
      ).rejects.toThrow(/not an approved repository download/u);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("withGlobalLock evicts stale locks left by dead processes", () => {
    const sandbox = makeTempDir("runtime-stale-lock");
    const home = path.join(sandbox, "home");
    const lockPath = path.join(home, "lock");

    mkdirSync(home, { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ acquiredAt: Date.now() - 86_400_000, pid: 999_999 }),
      "utf-8"
    );

    const result = withGlobalLock(home, () => "acquired");

    expect(result).toBe("acquired");
    expect(existsSync(lockPath)).toBeFalsy();
    expect(existsSync(`${lockPath}.reclaim`)).toBeFalsy();
  });

  test("withGlobalLock waits for an in-progress stale-lock reclaim", async () => {
    const sandbox = makeTempDir("runtime-lock-reclaim");
    const home = path.join(sandbox, "home");
    const reclaimPath = path.join(home, "lock.reclaim");
    mkdirSync(reclaimPath, { recursive: true });
    const reclaimer = Bun.spawn({
      cmd: ["sh", "-c", 'sleep 0.1; rmdir "$1"', "sh", reclaimPath],
      stderr: "pipe",
      stdout: "pipe"
    });

    expect(withGlobalLock(home, () => "acquired")).toBe("acquired");
    await expect(reclaimer.exited).resolves.toBe(0);
    expect(existsSync(reclaimPath)).toBeFalsy();
  });

  test("withGlobalLock falls back to the file timestamp for invalid lock metadata", () => {
    const sandbox = makeTempDir("runtime-invalid-lock");
    const home = path.join(sandbox, "home");
    const lockPath = path.join(home, "lock");
    const staleTime = new Date(Date.now() - 86_400_000);

    mkdirSync(home, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: "not-a-number" }), "utf-8");
    utimesSync(lockPath, staleTime, staleTime);

    expect(withGlobalLock(home, () => "acquired")).toBe("acquired");
    expect(existsSync(lockPath)).toBeFalsy();
  });

  test("withGlobalLock does not evict stale locks held by a live process", () => {
    const sandbox = makeTempDir("runtime-live-stale-lock");
    const home = path.join(sandbox, "home");
    const lockPath = path.join(home, "lock");

    mkdirSync(home, { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ acquiredAt: Date.now() - 86_400_000, pid: process.pid }),
      "utf-8"
    );

    expect(() => withGlobalLock(home, () => "acquired")).toThrow(/Timed out waiting for lock/u);
    expect(existsSync(lockPath)).toBeTruthy();
  }, 7000);

  test("withGlobalLock preserves a valid live pid when another metadata field is invalid", () => {
    const sandbox = makeTempDir("runtime-live-mixed-lock");
    const home = path.join(sandbox, "home");
    const lockPath = path.join(home, "lock");
    const staleTime = new Date(Date.now() - 86_400_000);

    mkdirSync(home, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ acquiredAt: "invalid", pid: process.pid }), "utf-8");
    utimesSync(lockPath, staleTime, staleTime);

    expect(() => withGlobalLock(home, () => "acquired")).toThrow(/Timed out waiting for lock/u);
    expect(existsSync(lockPath)).toBeTruthy();
  }, 7000);
});
