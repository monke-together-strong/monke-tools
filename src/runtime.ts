import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { isCancel, multiselect as clackMultiSelect, select as clackSelect } from "@clack/prompts";
import * as z from "zod";

import { errorMessage, MonkeError } from "./errors.ts";
import type { ExecOptions, ExecResult, MultiSelectPrompt, Runtime, SelectPrompt } from "./types.ts";

const GLOBAL_LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_AGE_MS = 60_000;
const LockMetadataSchema = z.object({
  acquiredAt: z.unknown().optional(),
  pid: z.unknown().optional()
});
const LockPidSchema = z.number().int().positive();
const LockTimestampSchema = z.number();

/** Runtime construction options for CLI commands and integration-style tests. */
export interface RuntimeOptions {
  /** Current working directory used by command execution. */
  cwd?: string;
  /** Environment overrides merged over the process environment. */
  env?: Record<string, string | undefined>;
  /** Scripted selected value sets used by tests for Clack-style multi-select prompts. */
  multiSelectValues?: string[][];
  /** Optional observer used by tests and embedding callers to inspect multi-select prompts. */
  onMultiSelect?: (prompt: MultiSelectPrompt) => void;
  /** Optional observer used by tests and embedding callers to inspect select prompts. */
  onSelect?: (prompt: SelectPrompt) => void;
  /** Optional stderr sink used by tests and embedding callers. */
  onStderr?: (text: string) => void;
  /** Optional stdout sink used by tests and embedding callers. */
  onStdout?: (text: string) => void;
  /** Scripted selected values used by tests for Clack-style select prompts. */
  selectValues?: string[];
  /** Scripted stdin lines used by tests for interactive prompts. */
  stdinText?: string;
}

/** Create the default runtime adapter around the current process. */
export function createRuntime(options?: RuntimeOptions): Runtime {
  // oxlint-disable-next-line node/no-process-env -- This adapter centralizes access to the process environment.
  const runtimeEnv = { ...process.env, ...options?.env };
  const runtimeCwd = options?.cwd ?? process.cwd();
  const scriptedInput = options?.stdinText === undefined ? null : options.stdinText.split(/\r?\n/u);
  const scriptedSelectValues = options?.selectValues ? [...options.selectValues] : null;
  const scriptedMultiSelectValues = options?.multiSelectValues
    ? [...options.multiSelectValues]
    : null;

  const writeStdout = (text: string): void => {
    if (options?.onStdout) {
      options.onStdout(text);
      return;
    }

    process.stdout.write(text);
  };

  return {
    cwd: runtimeCwd,
    env: runtimeEnv,
    exec(command: string, args: string[] = [], execOptions?: ExecOptions): ExecResult {
      return executeCommand(runtimeEnv, runtimeCwd, command, args, execOptions);
    },
    async multiSelect(prompt): Promise<string[]> {
      options?.onMultiSelect?.(prompt);
      if (scriptedMultiSelectValues !== null) {
        const selected = scriptedMultiSelectValues.shift();
        if (selected === undefined) {
          throw new MonkeError("No scripted multi-select values remain");
        }
        for (const value of selected) {
          if (!prompt.options.some((option) => option.value === value)) {
            throw new MonkeError(`Unknown selection: ${value}`);
          }
        }
        if (prompt.required === true && selected.length === 0) {
          throw new MonkeError(`Select at least one option for ${prompt.message}`);
        }
        return selected;
      }

      const selected = await clackMultiSelect(prompt);
      if (isCancel(selected)) {
        throw new MonkeError(`${prompt.message} cancelled`);
      }
      return selected;
    },
    readLine(prompt: string): string {
      writeStdout(prompt);
      if (scriptedInput !== null) {
        return scriptedInput.shift() ?? "";
      }

      return readLineFromStdin();
    },
    async select(prompt): Promise<string> {
      options?.onSelect?.(prompt);
      if (scriptedSelectValues !== null) {
        const selected = scriptedSelectValues.shift();
        if (selected === undefined) {
          throw new MonkeError("No scripted select values remain");
        }
        if (!prompt.options.some((option) => option.value === selected)) {
          throw new MonkeError(`Unknown selection: ${selected}`);
        }
        return selected;
      }

      const selected = await clackSelect(prompt);
      if (isCancel(selected)) {
        throw new MonkeError(`${prompt.message} cancelled`);
      }
      return selected;
    },
    writeStderr(text: string): void {
      if (options?.onStderr) {
        options.onStderr(text);
        return;
      }

      process.stderr.write(text);
    },
    writeStdout(text: string): void {
      writeStdout(text);
    }
  };
}

function executeCommand(
  runtimeEnv: Record<string, string | undefined>,
  runtimeCwd: string,
  command: string,
  args: string[],
  options: ExecOptions | undefined
): ExecResult {
  const childEnv = { ...runtimeEnv, ...options?.env };
  delete childEnv.MONKE_SHELL_DIR_DIRECTIVE;

  const result = spawnSync(command, args, {
    cwd: options?.cwd ?? runtimeCwd,
    encoding: "utf-8",
    env: childEnv,
    input: options?.stdin,
    timeout: options?.timeoutSeconds === undefined ? undefined : options.timeoutSeconds * 1000
  });

  if (result.error) {
    return handleSpawnError(result, command, args, options?.allowFailure === true);
  }
  return handleCompletedCommand(result, command, args, options?.allowFailure === true);
}

function handleSpawnError(
  result: SpawnSyncReturns<string>,
  command: string,
  args: string[],
  allowFailure: boolean
): ExecResult {
  const { error } = result;
  if (error === undefined) {
    throw new MonkeError(`Expected ${formatCommand(command, args)} to have a spawn error`);
  }
  if (allowFailure && isTimeoutError(error)) {
    return {
      exitCode: -1,
      stderr: result.stderr ?? "",
      stdout: result.stdout ?? "",
      timedOut: true
    };
  }
  throw new MonkeError(`Failed to run ${formatCommand(command, args)}: ${error.message}`);
}

function handleCompletedCommand(
  result: SpawnSyncReturns<string>,
  command: string,
  args: string[],
  allowFailure: boolean
): ExecResult {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = result.status ?? -1;

  if (!allowFailure && result.status === null) {
    const reason = result.signal ? `terminated by signal ${result.signal}` : "terminated by signal";
    throw new MonkeError(`Command failed: ${formatCommand(command, args)}\n${reason}`);
  }
  if (!allowFailure && exitCode !== 0) {
    const reason = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
    throw new MonkeError(`Command failed: ${formatCommand(command, args)}\n${reason}`);
  }
  return { exitCode, stderr, stdout };
}

function isTimeoutError(error: Error): boolean {
  return "code" in error && error.code === "ETIMEDOUT";
}

export function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

/** Resolve the absolute Monke home path for this runtime. */
export function getMonkeHome(runtime: Runtime): string {
  const configuredHome = runtime.env.MONKE_HOME;
  return configuredHome === undefined
    ? path.join(homedir(), ".monke")
    : path.resolve(runtime.cwd, configuredHome);
}

/** Resolve the OS home directory used for external Agent skill roots. */
export function getHomeDirectory(runtime: Runtime): string {
  return runtime.env.HOME ?? homedir();
}

export function ensureDirectory(directoryPath: string): void {
  mkdirSync(directoryPath, { recursive: true });
}

export function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function findExecutable(
  command: string,
  env: Record<string, string | undefined>
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
      writeFileSync(
        lockPath,
        JSON.stringify({ acquiredAt: Date.now(), pid: process.pid }),
        "utf-8"
      );
    } catch (error) {
      const message = errorMessage(error);
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
  let server: { stop: (closeActiveConnections?: boolean) => void } | null = null;

  try {
    server = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: {
        close() {
          // Port probing only needs the listener lifecycle.
        },
        data() {
          // Port probing never consumes socket data.
        },
        drain() {
          // Port probing never writes socket data.
        },
        error() {
          // Listen failures are handled by the surrounding try/catch.
        },
        open() {
          // A successful open means the port is available.
        }
      }
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

function readLineFromStdin(): string {
  const chunks: string[] = [];
  const buffer = Buffer.alloc(1);

  while (true) {
    const bytesRead = readSync(0, buffer, 0, 1, null);
    if (bytesRead === 0) {
      break;
    }

    const character = buffer.toString("utf-8", 0, bytesRead);
    if (character === "\n") {
      break;
    }
    if (character !== "\r") {
      chunks.push(character);
    }
  }

  return chunks.join("");
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
    const parsed = LockMetadataSchema.safeParse(JSON.parse(readFileSync(lockPath, "utf-8")));
    if (parsed.success) {
      const metadata = parsed.data;
      const acquiredAt = LockTimestampSchema.safeParse(metadata.acquiredAt);
      const pid = LockPidSchema.safeParse(metadata.pid);

      if (acquiredAt.success) {
        isStale = acquiredAt.data <= staleSince;
      }

      if (pid.success) {
        isStale = !isProcessRunning(pid.data);
      }
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
