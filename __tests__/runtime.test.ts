import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test, vi } from "vite-plus/test";

import { createRuntime, withGlobalLock } from "../src/runtime.ts";
import { makeTempDir } from "./helpers.ts";

describe("runtime", () => {
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
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      authorization = new Headers(init?.headers).get("Authorization") ?? "";
      return new Response("[]", { status: 200 });
    });

    try {
      const runtime = createRuntime({ env: { GH_TOKEN: "", GITHUB_TOKEN: "fallback-token" } });
      await runtime.releaseDistribution.listReleases(1);
    } finally {
      fetchMock.mockRestore();
    }

    expect(authorization).toBe("Bearer fallback-token");
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
