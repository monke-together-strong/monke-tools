import { spawn, spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { isCancel, multiselect as clackMultiSelect, select as clackSelect } from "@clack/prompts";
import * as z from "zod";

import { DEFAULT_TOOL_BUILD_IDENTITY } from "./build-identity.ts";
import { errorMessage, MonkeError } from "./errors.ts";
import type {
  ExecOptions,
  ExecResult,
  MultiSelectPrompt,
  ReleaseCatalogEntry,
  ReleaseDistribution,
  Runtime,
  SelectPrompt
} from "./types.ts";

const GLOBAL_LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_AGE_MS = 60_000;
const LockMetadataSchema = z.object({
  acquiredAt: z.unknown().optional(),
  pid: z.unknown().optional()
});
const LockPidSchema = z.number().int().positive();
const LockTimestampSchema = z.number();
const ReleaseCatalogAssetSchema = z.looseObject({
  browser_download_url: z.url(),
  digest: z.string().nullable().optional(),
  name: z.string()
});
const ReleaseCatalogPageSchema: z.ZodType<ReleaseCatalogEntry[]> = z.array(
  z.looseObject({
    assets: z.array(ReleaseCatalogAssetSchema),
    draft: z.boolean(),
    prerelease: z.boolean(),
    tag_name: z.string(),
    target_commitish: z.string()
  })
);

/** Runtime construction options for CLI commands and integration-style tests. */
export interface RuntimeOptions {
  /** Machine architecture override used by platform behavior tests. */
  architecture?: string;
  /** Make the next select prompt follow the normal cancellation path in tests. */
  cancelSelect?: boolean;
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
  /** Operating system override used by platform behavior tests. */
  platform?: NodeJS.Platform;
  /** Official Release boundary override used by update behavior tests. */
  releaseDistribution?: ReleaseDistribution;
  /** Scripted selected values used by tests for Clack-style select prompts. */
  selectValues?: string[];
  /** Status-output TTY override used by presentation behavior tests. */
  stderrIsTTY?: boolean;
  /** Scripted stdin lines used by tests for interactive prompts. */
  stdinText?: string;
  /** Compiled Tool build identity override used by installation behavior tests. */
  toolBuildIdentity?: string;
  /** Versioned install root override used by installation behavior tests. */
  toolInstallRoot?: string;
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

  const writeStdout = (text: string) => {
    if (options?.onStdout) {
      options.onStdout(text);
      return;
    }

    process.stdout.write(text);
  };

  return {
    architecture: options?.architecture ?? process.arch,
    cwd: runtimeCwd,
    env: runtimeEnv,
    exec(command: string, args: string[] = [], execOptions?: ExecOptions) {
      return executeCommand(runtimeEnv, runtimeCwd, command, args, execOptions);
    },
    execAsync(command: string, args: string[] = [], execOptions?: ExecOptions) {
      return executeCommandAsync(runtimeEnv, runtimeCwd, command, args, execOptions);
    },
    async multiSelect(prompt) {
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
    platform: options?.platform ?? process.platform,
    readLine(prompt: string) {
      writeStdout(prompt);
      if (scriptedInput !== null) {
        return scriptedInput.shift() ?? "";
      }

      return readLineFromStdin();
    },
    releaseDistribution:
      options?.releaseDistribution ?? createGitHubReleaseDistribution(runtimeEnv),
    async select(prompt) {
      options?.onSelect?.(prompt);
      if (options?.cancelSelect === true) {
        throwSelectionCancelled(prompt.message);
      }
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
        throwSelectionCancelled(prompt.message);
      }
      return selected;
    },
    stderrIsTTY: resolveStderrIsTTY(options),
    toolBuildIdentity: options?.toolBuildIdentity ?? DEFAULT_TOOL_BUILD_IDENTITY,
    toolInstallRoot: options?.toolInstallRoot ?? resolveRunningToolInstallRoot(),
    writeStderr(text: string) {
      if (options?.onStderr) {
        options.onStderr(text);
        return;
      }

      process.stderr.write(text);
    },
    writeStdout(text: string) {
      writeStdout(text);
    }
  };
}

function resolveStderrIsTTY(options: RuntimeOptions | undefined) {
  return options?.stderrIsTTY ?? process.stderr.isTTY;
}

function createGitHubReleaseDistribution(
  env: Record<string, string | undefined>
): ReleaseDistribution {
  const repository = "monke-together-strong/monke-tools";
  const commonHeaders = {
    Accept: "application/vnd.github+json",
    "User-Agent": "monke-tools",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  const headers = token ? { ...commonHeaders, Authorization: `Bearer ${token}` } : commonHeaders;

  const request = async (url: string) => {
    let response: Response;
    try {
      response = await fetch(url, { headers });
    } catch (error) {
      throw new MonkeError(`GitHub Release request failed: ${errorMessage(error)}`);
    }
    if (!response.ok) {
      throw new MonkeError(`GitHub Release request failed with HTTP ${response.status}`);
    }
    return response;
  };

  return {
    async downloadReleaseAsset(url) {
      const response = await request(url);
      const body = await response.arrayBuffer();
      return new Uint8Array(body);
    },
    async listReleases(page) {
      try {
        const response = await request(
          `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`
        );
        const body: unknown = await response.json();
        return ReleaseCatalogPageSchema.parse(body);
      } catch (error) {
        if (error instanceof MonkeError) {
          throw error;
        }
        throw new MonkeError(`GitHub Release metadata is invalid: ${errorMessage(error)}`);
      }
    }
  };
}

function throwSelectionCancelled(message: string): never {
  throw new MonkeError(`${message} cancelled`);
}

function executeCommand(
  runtimeEnv: Record<string, string | undefined>,
  runtimeCwd: string,
  command: string,
  args: string[],
  options: ExecOptions | undefined
) {
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

function executeCommandAsync(
  runtimeEnv: Record<string, string | undefined>,
  runtimeCwd: string,
  command: string,
  args: string[],
  options: ExecOptions | undefined
): Promise<ExecResult> {
  const childEnv = { ...runtimeEnv, ...options?.env };
  delete childEnv.MONKE_SHELL_DIR_DIRECTIVE;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd ?? runtimeCwd,
      env: childEnv,
      stdio: "pipe"
    });
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    const timeout =
      options?.timeoutSeconds === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, options.timeoutSeconds * 1000);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      reject(new MonkeError(`Failed to run ${formatCommand(command, args)}: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      const exitCode = timedOut ? -1 : (code ?? -1);
      if (timedOut && options?.allowFailure === true) {
        resolve({ exitCode, stderr, stdout, timedOut: true });
        return;
      }
      if (code !== 0 && options?.allowFailure !== true) {
        const reason =
          stderr.trim() || stdout.trim() || `terminated by signal ${signal ?? "unknown"}`;
        reject(new MonkeError(`Command failed: ${formatCommand(command, args)}\n${reason}`));
        return;
      }
      resolve({ exitCode, stderr, stdout });
    });
    child.stdin.end(options?.stdin);
  });
}

function handleSpawnError(
  result: SpawnSyncReturns<string>,
  command: string,
  args: string[],
  allowFailure: boolean
) {
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
) {
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

function isTimeoutError(error: Error) {
  return "code" in error && error.code === "ETIMEDOUT";
}

export function formatCommand(command: string, args: string[]) {
  return [command, ...args].join(" ");
}

/** Resolve the absolute Monke home path for this runtime. */
export function getMonkeHome(runtime: Runtime) {
  const configuredHome = runtime.env.MONKE_HOME;
  return configuredHome === undefined
    ? path.join(homedir(), ".monke")
    : path.resolve(runtime.cwd, configuredHome);
}

/** Resolve the OS home directory used for external Agent skill roots. */
export function getHomeDirectory(runtime: Runtime) {
  return runtime.env.HOME ?? homedir();
}

export function hashKey(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function findExecutable(command: string, env: Record<string, string | undefined>) {
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

export function withGlobalLock<T>(home: string, callback: () => T) {
  return withLockPath(path.join(home, "lock"), callback);
}

/** Run an asynchronous installation mutation under the machine-wide installation lock. */
export async function withInstallationLockAsync<T>(home: string, callback: () => Promise<T>) {
  const release = await acquireLockPathAsync(path.join(home, "locks", "installation.lock"));
  try {
    return await callback();
  } finally {
    release();
  }
}

async function acquireLockPathAsync(lockPath: string) {
  const deadline = prepareLockAcquisition(lockPath);
  while (true) {
    const attempt = tryAcquireLockPath(lockPath);
    if (attempt.release) {
      return attempt.release;
    }
    assertLockDeadline(lockPath, deadline);
    if (attempt.wait) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Lock retries must remain sequential.
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, 50);
      });
    }
  }
}

/** Run a synchronous callback while holding a lock scoped inside the monke home directory. */
export function withScopedLock<T>(home: string, namespace: string, callback: () => T) {
  return withLockPath(path.join(home, "locks", `${hashKey(namespace)}.lock`), callback);
}

function withLockPath<T>(lockPath: string, callback: () => T) {
  const release = acquireLockPath(lockPath);
  try {
    return callback();
  } finally {
    release();
  }
}

function acquireLockPath(lockPath: string) {
  const deadline = prepareLockAcquisition(lockPath);
  while (true) {
    const attempt = tryAcquireLockPath(lockPath);
    if (attempt.release) {
      return attempt.release;
    }
    assertLockDeadline(lockPath, deadline);
    if (attempt.wait) {
      sleep(50);
    }
  }
}

function prepareLockAcquisition(lockPath: string) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  return Date.now() + GLOBAL_LOCK_TIMEOUT_MS;
}

function tryAcquireLockPath(lockPath: string) {
  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = openSync(lockPath, "wx");
    writeFileSync(lockPath, JSON.stringify({ acquiredAt: Date.now(), pid: process.pid }), "utf-8");
  } catch (error) {
    if (fileDescriptor !== null) {
      closeSync(fileDescriptor);
      rmSync(lockPath, { force: true });
    }
    if (!errorMessage(error).includes("EEXIST")) {
      throw error;
    }
    return { wait: !tryEvictStaleLock(lockPath) };
  }

  return {
    release: () => {
      if (fileDescriptor !== null) {
        closeSync(fileDescriptor);
        fileDescriptor = null;
      }
      rmSync(lockPath, { force: true });
    },
    wait: false
  };
}

function assertLockDeadline(lockPath: string, deadline: number) {
  if (Date.now() >= deadline) {
    throw new MonkeError(`Timed out waiting for lock at ${lockPath}`);
  }
}

export function isPortAvailable(port: number) {
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

function sleep(milliseconds: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function readLineFromStdin() {
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

function tryEvictStaleLock(lockPath: string) {
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

function isProcessRunning(pid: number) {
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

function resolveRunningToolInstallRoot() {
  try {
    return path.dirname(realpathSync.native(process.execPath));
  } catch {
    return path.dirname(process.execPath);
  }
}
