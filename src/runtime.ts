import {
  accessSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { MonkeError } from "./errors.ts";
import type { ExecOptions, ExecResult, Runtime } from "./types.ts";

const GLOBAL_LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_AGE_MS = 60_000;

export function createRuntime(options?: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}): Runtime {
  const runtimeEnv = { ...process.env, ...options?.env };
  const runtimeCwd = options?.cwd ?? process.cwd();

  return {
    cwd: runtimeCwd,
    env: runtimeEnv,
    exec(command: string, args: string[] = [], execOptions?: ExecOptions): ExecResult {
      const result = spawnSync(command, args, {
        cwd: execOptions?.cwd ?? runtimeCwd,
        env: {
          ...runtimeEnv,
          ...execOptions?.env,
        },
        encoding: "utf8",
        input: execOptions?.stdin,
        timeout:
          execOptions?.timeoutSeconds === undefined ? undefined : execOptions.timeoutSeconds * 1000,
      });

      if (result.error) {
        if (execOptions?.allowFailure && isTimeoutError(result.error)) {
          return {
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            exitCode: -1,
            timedOut: true,
          };
        }

        throw new MonkeError(
          `Failed to run ${formatCommand(command, args)}: ${result.error.message}`,
        );
      }

      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      const exitCode = result.status === null ? -1 : result.status;

      if (!execOptions?.allowFailure && result.status === null) {
        const reason = result.signal
          ? `terminated by signal ${result.signal}`
          : "terminated by signal";
        throw new MonkeError(`Command failed: ${formatCommand(command, args)}\n${reason}`);
      }

      if (!execOptions?.allowFailure && exitCode !== 0) {
        const reason = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
        throw new MonkeError(`Command failed: ${formatCommand(command, args)}\n${reason}`);
      }

      return { stdout, stderr, exitCode };
    },
    writeStdout(text: string): void {
      if (options?.onStdout) {
        options.onStdout(text);
        return;
      }

      process.stdout.write(text);
    },
    writeStderr(text: string): void {
      if (options?.onStderr) {
        options.onStderr(text);
        return;
      }

      process.stderr.write(text);
    },
  };
}

function isTimeoutError(error: Error): boolean {
  return "code" in error && error.code === "ETIMEDOUT";
}

export function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

export function getMonkeHome(runtime: Runtime): string {
  return runtime.env.MONKE_HOME ?? path.join(homedir(), ".monke");
}

export function ensureDirectory(directoryPath: string): void {
  mkdirSync(directoryPath, { recursive: true });
}

export function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function findExecutable(
  command: string,
  env: Record<string, string | undefined>,
): string | null {
  const pathValue = env.PATH;
  if (!pathValue) {
    return null;
  }

  for (const segment of pathValue.split(path.delimiter)) {
    if (!segment) {
      continue;
    }

    const candidate = path.join(segment, command);
    if (!existsSync(candidate)) {
      continue;
    }

    try {
      accessSync(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

export function withGlobalLock<T>(home: string, callback: () => T): T {
  return withLockPath(path.join(home, "lock"), callback);
}

/** Run a synchronous callback while holding a lock scoped inside the monke home directory. */
export function withScopedLock<T>(home: string, namespace: string, callback: () => T): T {
  return withLockPath(path.join(home, "locks", `${hashKey(namespace)}.lock`), callback);
}

function withLockPath<T>(lockPath: string, callback: () => T): T {
  ensureDirectory(path.dirname(lockPath));
  const deadline = Date.now() + GLOBAL_LOCK_TIMEOUT_MS;
  let fileDescriptor: number | null = null;

  while (fileDescriptor === null) {
    try {
      fileDescriptor = openSync(lockPath, "wx");
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("EEXIST")) {
        throw error;
      }

      if (tryEvictStaleLock(lockPath)) {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new MonkeError(`Timed out waiting for lock at ${lockPath}`);
      }

      sleep(50);
    }
  }

  try {
    return callback();
  } finally {
    if (fileDescriptor !== null) {
      closeSync(fileDescriptor);
    }
    rmSync(lockPath, { force: true });
  }
}

export function isPortAvailable(port: number): boolean {
  let server: { stop(closeActiveConnections?: boolean): void } | null = null;

  try {
    server = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: {
        data() {},
        open() {},
        close() {},
        drain() {},
        error() {},
      },
    });
    return true;
  } catch {
    return false;
  } finally {
    server?.stop(true);
  }
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function tryEvictStaleLock(lockPath: string): boolean {
  const staleSince = Date.now() - STALE_LOCK_AGE_MS;

  let fileTimestamp = 0;
  try {
    fileTimestamp = statSync(lockPath).mtimeMs;
  } catch {
    return true;
  }

  let isStale = fileTimestamp <= staleSince;
  try {
    const metadata = JSON.parse(readFileSync(lockPath, "utf8")) as {
      pid?: number;
      acquiredAt?: number;
    };

    if (typeof metadata.acquiredAt === "number") {
      isStale = metadata.acquiredAt <= staleSince;
    }

    if (typeof metadata.pid === "number" && metadata.pid > 0 && !isProcessRunning(metadata.pid)) {
      isStale = true;
    }
  } catch {
    // Fall back to the lock file timestamp when metadata is unreadable.
  }

  if (!isStale) {
    return false;
  }

  try {
    rmSync(lockPath, { force: true });
  } catch {
    return false;
  }

  return true;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "EPERM") {
        return true;
      }
      if (error.code === "ESRCH") {
        return false;
      }
    }
    return false;
  }
}
