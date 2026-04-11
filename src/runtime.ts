import { accessSync, closeSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { MonkeError } from "./errors.ts";
import type { ExecOptions, ExecResult, Runtime } from "./types.ts";

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
      });

      if (result.error) {
        throw new MonkeError(
          `Failed to run ${formatCommand(command, args)}: ${result.error.message}`,
        );
      }

      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      const exitCode = result.status ?? 0;

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
  ensureDirectory(home);
  const lockPath = path.join(home, "lock");
  const deadline = Date.now() + 5_000;
  let fileDescriptor: number | null = null;

  while (fileDescriptor === null) {
    try {
      fileDescriptor = openSync(lockPath, "wx");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("EEXIST")) {
        throw error;
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
