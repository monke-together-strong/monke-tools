import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test, vi } from "vitest";

import { createRuntime, findExecutable, isProcessRunning, withGlobalLock } from "../src/runtime.ts";
import { makeTempDir, write, writeExecutable } from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

describe(findExecutable, () => {
  test("uses the supplied PATH in order", () => {
    const sandbox = makeTempDir("runtime-which-order");
    const firstBin = path.join(sandbox, "first");
    const secondBin = path.join(sandbox, "second");
    const firstExecutable = path.join(firstBin, "example");
    writeExecutable(firstExecutable, "#!/bin/sh\n");
    writeExecutable(path.join(secondBin, "example"), "#!/bin/sh\n");

    expect(findExecutable("example", { PATH: [firstBin, secondBin].join(path.delimiter) })).toBe(
      firstExecutable
    );
  });

  test.each([undefined, ""])("treats PATH %j as unavailable", (pathValue) => {
    expect(findExecutable("sh", { PATH: pathValue })).toBeNull();
  });

  test("returns null for a missing executable", () => {
    expect(findExecutable("missing", { PATH: makeTempDir("runtime-which-missing") })).toBeNull();
  });

  test.skipIf(process.platform === "win32")("rejects a non-executable file", () => {
    const sandbox = makeTempDir("runtime-which-permission");
    write(sandbox, "example", "#!/bin/sh\n");

    expect(findExecutable("example", { PATH: sandbox })).toBeNull();
  });
});

describe("runtime", () => {
  test("interactive lines preserve UTF-8 across CRLF and final EOF", () => {
    const runtimeUrl = new URL("../src/runtime.ts", import.meta.url).href;
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        `
      import { createRuntime } from ${JSON.stringify(runtimeUrl)};
      const runtime = createRuntime();
      console.log(JSON.stringify([runtime.readLine(""), runtime.readLine(""), runtime.readLine("")]));
    `
      ],
      { stdin: Buffer.from("café/日本語\\r\\nsecond/🍌") }
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toStrictEqual(["café/日本語", "second/🍌", ""]);
  });

  test("createRuntime executes with its cwd, environment, and stdin", () => {
    const sandbox = makeTempDir("runtime-sync-input");
    const runtime = createRuntime({ cwd: sandbox, env: { MONKE_VALUE: "value" } });

    expect(
      runtime.exec(
        "sh",
        [
          "-c",
          `printf "%s|%s|" "$PWD" "$MONKE_VALUE"; if [ "\${MONKE_SHELL_DIR_DIRECTIVE+x}" = x ]; then printf set; else printf unset; fi; printf "|"; cat`
        ],
        { stdin: "input" }
      )
    ).toStrictEqual({
      exitCode: 0,
      stderr: "",
      stdout: `${sandbox}|value|unset|input`
    });
  });

  test("createRuntime preserves output from allowed command failures", () => {
    const runtime = createRuntime();

    expect(
      runtime.exec("sh", ["-c", "printf output; printf error >&2; exit 7"], {
        allowFailure: true
      })
    ).toStrictEqual({ exitCode: 7, stderr: "error", stdout: "output" });
    expect(() => runtime.exec("sh", ["-c", "printf output; printf error >&2; exit 7"])).toThrow(
      /Command failed:.*error/u
    );
  });

  test("createRuntime reports commands that cannot be started", () => {
    expect(() => createRuntime().exec("definitely-missing-monke-command")).toThrow(
      /Failed to run definitely-missing-monke-command/u
    );
  });

  test("createRuntime normalizes allowed synchronous timeouts", () => {
    expect(
      createRuntime().exec("sh", ["-c", "printf started; sleep 1"], {
        allowFailure: true,
        timeoutSeconds: 0.05
      })
    ).toStrictEqual({ exitCode: -1, stderr: "", stdout: "started", timedOut: true });
  });

  test("createRuntime executes asynchronously with its cwd, environment, and stdin", async () => {
    const sandbox = makeTempDir("runtime-async-input");
    const runtime = createRuntime({ cwd: sandbox, env: { MONKE_VALUE: "value" } });

    await expect(
      runtime.execAsync("sh", ["-c", 'printf "%s|%s|" "$PWD" "$MONKE_VALUE"; cat'], {
        stdin: "input"
      })
    ).resolves.toStrictEqual({
      exitCode: 0,
      stderr: "",
      stdout: `${sandbox}|value|input`
    });
  });

  test("createRuntime preserves output from allowed asynchronous failures", async () => {
    const runtime = createRuntime();

    await expect(
      runtime.execAsync("sh", ["-c", "printf output; printf error >&2; exit 7"], {
        allowFailure: true
      })
    ).resolves.toStrictEqual({ exitCode: 7, stderr: "error", stdout: "output" });
    await expect(
      runtime.execAsync("sh", ["-c", "printf output; printf error >&2; exit 7"])
    ).rejects.toThrow(/Command failed:.*error/u);
  });

  test("createRuntime reports asynchronous commands that cannot be started", async () => {
    await expect(createRuntime().execAsync("definitely-missing-monke-command")).rejects.toThrow(
      /Failed to run definitely-missing-monke-command/u
    );
  });

  test("createRuntime preserves output from allowed asynchronous timeouts", async () => {
    await expect(
      createRuntime().execAsync("sh", ["-c", "printf started; trap '' TERM; sleep 10"], {
        allowFailure: true,
        timeoutSeconds: 0.05
      })
    ).resolves.toStrictEqual({ exitCode: -1, stderr: "", stdout: "started", timedOut: true });
  });

  test("createRuntime rejects successful commands that did not consume stdin", async () => {
    await expect(
      createRuntime().execAsync("sh", ["-c", "exec 0<&-; sleep 0.1"], {
        stdin: "input".repeat(1_000_000)
      })
    ).rejects.toThrow(/Command input was not fully written/u);
  });

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

  test.each(["SIGHUP", "SIGQUIT", "SIGTERM"] as const)(
    "createRuntime forwards %s to detached async command groups",
    async (signal) => {
      const sandbox = makeTempDir("runtime-parent-termination");
      const workerPath = path.join(sandbox, "worker.ts");
      const childPidPath = path.join(sandbox, "child.pid");
      const descendantPidPath = path.join(sandbox, "descendant.pid");
      const descendantSurvivedMarker = path.join(sandbox, "descendant-survived");
      const unexpectedCommandMarker = path.join(sandbox, "unexpected-command");
      const runtimeUrl = pathToFileURL(path.resolve("src/runtime.ts")).href;
      write(
        sandbox,
        "worker.ts",
        `import { createRuntime } from ${JSON.stringify(runtimeUrl)};

const runtime = createRuntime();
try {
  await runtime.execAsync("sh", ["-c", ${JSON.stringify(`trap 'exit 0' HUP INT QUIT TERM; sh -c 'trap "" HUP INT QUIT TERM; sleep 1.5; touch "${descendantSurvivedMarker}"; while :; do sleep 1; done' </dev/null >/dev/null 2>&1 & printf '%s' "$$" > "${childPidPath}"; printf '%s' "$!" > "${descendantPidPath}"; wait`)}]);
} catch {}
await runtime.execAsync("sh", ["-c", ${JSON.stringify(`touch "${unexpectedCommandMarker}"`)}]);
`
      );
      const worker = Bun.spawn({
        cmd: [process.execPath, workerPath],
        stderr: "pipe",
        stdout: "pipe"
      });
      let childPid: number | undefined;
      let descendantPid: number | undefined;

      try {
        await waitFor(() => {
          childPid = readPublishedPid(childPidPath);
          descendantPid = readPublishedPid(descendantPidPath);
          return childPid !== undefined && descendantPid !== undefined;
        });
        worker.kill(signal);
        await worker.exited;
        await wait(1700);
        // kill(pid, 0) also sees an exited child awaiting its parent's reap on Linux.
        const childStatus = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(childPid)]);
        expect(childStatus.stderr.toString()).toBe("");
        expect(childStatus.stdout.toString().trim()).toMatch(/^(?:Z.*)?$/u);
        expect(existsSync(descendantSurvivedMarker)).toBeFalsy();
        expect(existsSync(unexpectedCommandMarker)).toBeFalsy();
      } finally {
        worker.kill("SIGKILL");
        killRetainedDescendant(childPid, descendantPid);
      }
    }
  );

  test("createRuntime kills command descendants before a timeout settles", async () => {
    const sandbox = makeTempDir("runtime-timeout-descendant");
    const childPidPath = path.join(sandbox, "child.pid");
    const descendantPidPath = path.join(sandbox, "descendant.pid");
    const descendantSurvivedMarker = path.join(sandbox, "descendant-survived");
    const runtime = createRuntime();
    const resultPromise = runtime.execAsync(
      "sh",
      [
        "-c",
        `trap 'exit 0' TERM; sh -c 'trap "" TERM; sleep 1.5; touch "${descendantSurvivedMarker}"; while :; do sleep 1; done' </dev/null >/dev/null 2>&1 & printf '%s' "$$" > "${childPidPath}"; printf '%s' "$!" > "${descendantPidPath}"; wait`
      ],
      { allowFailure: true, timeoutSeconds: 0.5 }
    );
    await waitFor(() => existsSync(childPidPath) && existsSync(descendantPidPath));
    const childPid = Number(readFileSync(childPidPath, "utf-8"));
    const descendantPid = Number(readFileSync(descendantPidPath, "utf-8"));

    try {
      await expect(resultPromise).resolves.toMatchObject({ timedOut: true });
      await wait(1100);
      expect(existsSync(descendantSurvivedMarker)).toBeFalsy();
    } finally {
      killRetainedDescendant(childPid, descendantPid);
    }
  });

  test("parent termination during timeout grace still kills command descendants", async () => {
    const sandbox = makeTempDir("runtime-timeout-timeout-parent-termination");
    const workerPath = path.join(sandbox, "worker.ts");
    const childPidPath = path.join(sandbox, "child.pid");
    const descendantPidPath = path.join(sandbox, "descendant.pid");
    const timeoutStartedMarker = path.join(sandbox, "timeout-started");
    const descendantSurvivedMarker = path.join(sandbox, "descendant-survived");
    const runtimeUrl = pathToFileURL(path.resolve("src/runtime.ts")).href;
    write(
      sandbox,
      "worker.ts",
      `import { createRuntime } from ${JSON.stringify(runtimeUrl)};

const runtime = createRuntime();
await runtime.execAsync(
  "sh",
  ["-c", ${JSON.stringify(`trap 'touch "${timeoutStartedMarker}"; exit 0' TERM; sh -c 'trap "" TERM; sleep 1.5; touch "${descendantSurvivedMarker}"; while :; do sleep 1; done' </dev/null >/dev/null 2>&1 & printf '%s' "$$" > "${childPidPath}"; printf '%s' "$!" > "${descendantPidPath}"; wait`)}],
  { allowFailure: true, timeoutSeconds: 0.5 }
);
`
    );
    const worker = Bun.spawn({
      cmd: [process.execPath, workerPath],
      stderr: "pipe",
      stdout: "pipe"
    });
    let childPid: number | undefined;
    let descendantPid: number | undefined;

    try {
      await waitFor(
        () =>
          existsSync(childPidPath) &&
          existsSync(descendantPidPath) &&
          existsSync(timeoutStartedMarker)
      );
      childPid = Number(readFileSync(childPidPath, "utf-8"));
      descendantPid = Number(readFileSync(descendantPidPath, "utf-8"));
      await waitFor(() => childPid !== undefined && !isProcessRunning(childPid));
      worker.kill("SIGTERM");
      await worker.exited;
      await wait(1700);
      expect(existsSync(descendantSurvivedMarker)).toBeFalsy();
    } finally {
      worker.kill("SIGKILL");
      killRetainedDescendant(childPid, descendantPid);
    }
  });

  test("commands started during timeout grace do not duplicate termination listeners", async () => {
    const sandbox = makeTempDir("runtime-timeout-listener-overlap");
    const childPidPath = path.join(sandbox, "child.pid");
    const timeoutStartedMarker = path.join(sandbox, "timeout-started");
    const signals = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const;
    const baselineListeners = new Map(
      signals.map((signal) => [signal, process.listenerCount(signal)])
    );
    const runtime = createRuntime();
    const timedResult = runtime.execAsync(
      "sh",
      [
        "-c",
        `trap 'touch "${timeoutStartedMarker}"; exit 0' TERM; printf '%s' "$$" > "${childPidPath}"; while :; do sleep 1; done`
      ],
      { allowFailure: true, timeoutSeconds: 0.5 }
    );
    let timedResultSettled = false;
    const observedTimedResult = (async () => {
      const result = await timedResult;
      timedResultSettled = true;
      return result;
    })();

    await waitFor(() => existsSync(childPidPath) && existsSync(timeoutStartedMarker));
    const childPid = Number(readFileSync(childPidPath, "utf-8"));
    await waitFor(() => !isProcessRunning(childPid));
    expect(timedResultSettled).toBeFalsy();
    await runtime.execAsync("sh", ["-c", ":"]);
    await observedTimedResult;

    for (const signal of signals) {
      expect(process.listenerCount(signal)).toBe(baselineListeners.get(signal));
    }
  });

  test("createRuntime reports exhausted scripted select values clearly", async () => {
    const runtime = createTestRuntime({ selectValues: [] });

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

  test("Release asset downloads expose the response body without buffering it", async () => {
    const response = new Response("streamed asset");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    try {
      const runtime = createRuntime();
      const downloaded = await runtime.releaseDistribution.downloadReleaseAsset(
        "https://github.com/monke-together-strong/monke-tools/releases/download/monke-tools-v1.2.3/monke-tools-v1.2.3-linux-x64.tar.gz"
      );

      expect(downloaded).toBe(response);
      expect(downloaded.bodyUsed).toBeFalsy();
      await expect(downloaded.text()).resolves.toBe("streamed asset");
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

function readPublishedPid(filePath: string) {
  const value = existsSync(filePath) ? readFileSync(filePath, "utf-8").trim() : "";
  return /^[1-9]\d*$/u.test(value) ? Number(value) : undefined;
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for subprocess state");
    }
    await wait(10);
  }
}

function killRetainedDescendant(
  groupLeaderPid: number | undefined,
  descendantPid: number | undefined
) {
  if (descendantPid === undefined || descendantPid <= 0 || !isProcessRunning(descendantPid)) {
    return;
  }
  if (groupLeaderPid !== undefined && groupLeaderPid > 0) {
    try {
      process.kill(-groupLeaderPid, "SIGKILL");
    } catch {
      // Fall through to exact-PID cleanup.
    }
  }
  if (isProcessRunning(descendantPid)) {
    try {
      process.kill(descendantPid, "SIGKILL");
    } catch {
      // The descendant exited between the liveness check and cleanup.
    }
  }
}

async function wait(milliseconds: number) {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
