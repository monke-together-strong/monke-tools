import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readSync,
  rmdirSync,
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
import { ReleaseCatalogPageSchema } from "./release-catalog-schema.ts";
import { sha256 } from "./sha256.ts";
import type {
  ExecOptions,
  ExecResult,
  InstallationActivationPhase,
  ReleaseDistribution,
  Runtime,
  SessionMaterializationCheckpoint
} from "./types.ts";

const GLOBAL_LOCK_TIMEOUT_MS = 5000;
const ASYNC_TERMINATION_GRACE_MS = 250;
const LOCK_RETRY_INTERVAL_MS = 50;
const RELEASE_CATALOG_PAGE_SIZE = 100;
const RELEASE_REQUEST_TIMEOUT_MS = 30_000;
const STALE_LOCK_AGE_MS = 60_000;
type AsyncChildProcess = Bun.PipedSubprocess;
const activeAsyncChildren = new Set<AsyncChildProcess>();
const timedOutProcessGroups = new Map<number, AsyncChildProcess>();
const PARENT_TERMINATION_SIGNALS = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const;
// Stable handler identities, so detaching removes exactly what attaching added.
const PARENT_TERMINATION_HANDLERS = new Map<NodeJS.Signals, () => void>(
  PARENT_TERMINATION_SIGNALS.map((signal) => [
    signal,
    () => {
      forwardParentTermination(signal);
    }
  ])
);
let forwardedTerminationSignal: NodeJS.Signals | undefined;
let parentExitScheduled = false;
let terminationEscalated = false;
const LockMetadataSchema = z.object({
  acquiredAt: z.unknown().optional(),
  pid: z.unknown().optional()
});
const LockPidSchema = z.number().int().positive();
const LockTimestampSchema = z.number();

/** Runtime construction options for CLI commands and integration-style tests. */
export interface RuntimeOptions {
  /** Machine architecture override used by platform behavior tests. */
  architecture?: string;
  /** Current working directory used by command execution. */
  cwd?: string;
  /** Environment overrides merged over the process environment. */
  env?: Record<string, string | undefined>;
  /** Optional injected activation boundary used by failure-behavior tests. */
  installationActivationBoundary?: (phase: InstallationActivationPhase) => void;
  /** Operating system override used by platform behavior tests. */
  platform?: NodeJS.Platform;
  /** Official Release boundary override used by update behavior tests. */
  releaseDistribution?: ReleaseDistribution;
  /** Optional injected Session checkpoint boundary used by interruption tests. */
  sessionMaterializationBoundary?: (checkpoint: SessionMaterializationCheckpoint) => void;
  /** Status-output TTY override used by presentation behavior tests. */
  stderrIsTTY?: boolean;
  /** Compiled Tool build identity override used by installation behavior tests. */
  toolBuildIdentity?: string;
  /** Versioned install root override used by installation behavior tests. */
  toolInstallRoot?: string;
  /** Output sinks for embedding the CLI. */
  writeStderr?: (text: string) => void;
  writeStdout?: (text: string) => void;
}

/** Create the default runtime adapter around the current process. */
export function createRuntime(options: RuntimeOptions = {}): Runtime {
  // oxlint-disable-next-line node/no-process-env -- This adapter centralizes access to the process environment.
  const runtimeEnv = { ...process.env, ...options.env };
  const runtimeCwd = options.cwd ?? process.cwd();
  const writeStdout =
    options.writeStdout ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const writeStderr =
    options.writeStderr ??
    ((text: string) => {
      process.stderr.write(text);
    });

  return {
    architecture: options.architecture ?? process.arch,
    cwd: runtimeCwd,
    env: runtimeEnv,
    exec(command: string, args: string[] = [], execOptions?: ExecOptions) {
      return executeCommand(runtimeEnv, runtimeCwd, command, args, execOptions);
    },
    execAsync(command: string, args: string[] = [], execOptions?: ExecOptions) {
      return executeCommandAsync(runtimeEnv, runtimeCwd, command, args, execOptions);
    },
    installationActivationBoundary: options.installationActivationBoundary,
    async multiSelect(prompt) {
      const selected = await clackMultiSelect(prompt);
      if (isCancel(selected)) {
        throw new MonkeError(`${prompt.message} cancelled`);
      }
      return selected;
    },
    platform: options.platform ?? process.platform,
    readLine(prompt: string) {
      writeStdout(prompt);
      return readLineFromStdin();
    },
    releaseDistribution: options.releaseDistribution ?? createGitHubReleaseDistribution(runtimeEnv),
    async select(prompt) {
      const selected = await clackSelect(prompt);
      if (isCancel(selected)) {
        throw new MonkeError(`${prompt.message} cancelled`);
      }
      return selected;
    },
    sessionMaterializationBoundary: options.sessionMaterializationBoundary,
    stderrIsTTY: options.stderrIsTTY ?? process.stderr.isTTY,
    toolBuildIdentity: options.toolBuildIdentity ?? DEFAULT_TOOL_BUILD_IDENTITY,
    toolInstallRoot: options.toolInstallRoot ?? resolveRunningToolInstallRoot(),
    writeStderr,
    writeStdout
  };
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
      response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(RELEASE_REQUEST_TIMEOUT_MS)
      });
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
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        throw new MonkeError("GitHub Release asset URL is invalid");
      }
      if (
        parsedUrl.protocol !== "https:" ||
        parsedUrl.hostname !== "github.com" ||
        !parsedUrl.pathname.startsWith(`/${repository}/releases/download/`)
      ) {
        throw new MonkeError("GitHub Release asset URL is not an approved repository download");
      }
      return await request(url);
    },
    async listReleases(page) {
      try {
        const response = await request(
          `https://api.github.com/repos/${repository}/releases?per_page=${RELEASE_CATALOG_PAGE_SIZE}&page=${page}`
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

function executeCommand(
  runtimeEnv: Record<string, string | undefined>,
  runtimeCwd: string,
  command: string,
  args: string[],
  options: ExecOptions | undefined
) {
  const childEnv = {
    ...runtimeEnv,
    ...options?.env,
    MONKE_SHELL_DIR_DIRECTIVE: undefined
  };

  let result: Bun.ReadableSyncSubprocess;
  try {
    result = Bun.spawnSync({
      cmd: [command, ...args],
      cwd: options?.cwd ?? runtimeCwd,
      env: childEnv,
      stderr: "pipe",
      stdin: options?.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
      stdout: "pipe",
      timeout: options?.timeoutSeconds === undefined ? undefined : options.timeoutSeconds * 1000
    });
  } catch (error) {
    throw new MonkeError(`Failed to run ${formatCommand(command, args)}: ${errorMessage(error)}`, {
      cause: error
    });
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
  if (forwardedTerminationSignal !== undefined) {
    return Promise.reject(
      new MonkeError("Cannot start a command while the process is terminating")
    );
  }
  const childEnv = {
    ...runtimeEnv,
    ...options?.env,
    MONKE_SHELL_DIR_DIRECTIVE: undefined
  };

  return new Promise((resolve, reject) => {
    let child: AsyncChildProcess;
    try {
      child = Bun.spawn({
        cmd: [command, ...args],
        cwd: options?.cwd ?? runtimeCwd,
        detached: process.platform !== "win32",
        env: childEnv,
        stderr: "pipe",
        stdin: "pipe",
        stdout: "pipe"
      });
    } catch (error) {
      reject(
        new MonkeError(`Failed to run ${formatCommand(command, args)}: ${errorMessage(error)}`, {
          cause: error
        })
      );
      return;
    }
    new AsyncCommandExecution(child, command, args, options, resolve, reject).start();
  });
}

class AsyncCommandExecution {
  #forceKill: ReturnType<typeof setTimeout> | undefined;
  #input: Promise<void> | undefined;
  #output: Promise<void> | undefined;
  #settled = false;
  #stderr = "";
  #stdinError: Error | undefined;
  #stdout = "";
  #timedOut = false;
  #timeout: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly child: AsyncChildProcess,
    private readonly command: string,
    private readonly args: string[],
    private readonly options: ExecOptions | undefined,
    private readonly resolve: (result: ExecResult) => void,
    private readonly reject: (error: Error) => void
  ) {}

  start() {
    registerAsyncChild(this.child);
    this.#output = this.captureOutput();
    this.#input = this.writeInput();
    this.startTimeout();
    void this.complete();
  }

  private async complete() {
    try {
      const exitCode = await this.child.exited;
      await Promise.all([this.#output, this.#input]);
      this.handleExit(exitCode, this.child.signalCode);
    } catch (error) {
      if (this.#timedOut) {
        return;
      }
      this.rejectOnce(
        new MonkeError(
          `Failed to run ${formatCommand(this.command, this.args)}: ${errorMessage(error)}`,
          { cause: error }
        )
      );
      unregisterAsyncChild(this.child);
    }
  }

  private async captureOutput() {
    [this.#stdout, this.#stderr] = await Promise.all([
      new Response(this.child.stdout).text(),
      new Response(this.child.stderr).text()
    ]);
  }

  private clearTimers() {
    if (this.#timeout !== undefined) {
      clearTimeout(this.#timeout);
    }
    if (this.#forceKill !== undefined) {
      clearTimeout(this.#forceKill);
    }
  }

  private async forceTimeoutCompletion() {
    terminateChildProcessTree(this.child.pid, "SIGKILL", () => {
      this.child.kill("SIGKILL");
    });
    await Promise.allSettled([this.child.exited, this.#output, this.#input]);
    if (this.child.pid !== undefined) {
      timedOutProcessGroups.delete(this.child.pid);
    }
    unregisterAsyncChild(this.child);
    this.settleTimeout();
    finishParentTerminationAfterEscalation();
    detachParentTerminationHandlersIfIdle();
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null) {
    try {
      if (this.#timedOut) {
        return;
      }
      const exitCode = code ?? -1;
      if (code !== 0 && this.options?.allowFailure !== true) {
        const reason =
          this.#stderr.trim() ||
          this.#stdout.trim() ||
          `terminated by signal ${signal ?? "unknown"}`;
        this.rejectOnce(
          new MonkeError(`Command failed: ${formatCommand(this.command, this.args)}\n${reason}`)
        );
        return;
      }
      if (this.#stdinError !== undefined && code === 0) {
        // A successful exit cannot be trusted when the input was never fully delivered.
        this.rejectOnce(
          new MonkeError(
            `Command input was not fully written: ${formatCommand(this.command, this.args)}\n${this.#stdinError.message}`,
            { cause: this.#stdinError }
          )
        );
        return;
      }
      this.resolveOnce({ exitCode, stderr: this.#stderr, stdout: this.#stdout });
    } finally {
      unregisterAsyncChild(this.child);
    }
  }

  private rejectOnce(error: Error) {
    if (this.#settled) {
      return;
    }
    this.#settled = true;
    this.clearTimers();
    this.reject(error);
  }

  private resolveOnce(result: ExecResult) {
    if (this.#settled) {
      return;
    }
    this.#settled = true;
    this.clearTimers();
    this.resolve(result);
  }

  private settleTimeout() {
    if (this.options?.allowFailure === true) {
      this.resolveOnce({
        exitCode: -1,
        stderr: this.#stderr,
        stdout: this.#stdout,
        timedOut: true
      });
      return;
    }
    this.rejectOnce(new MonkeError(`Command timed out: ${formatCommand(this.command, this.args)}`));
  }

  private startTimeout() {
    if (this.options?.timeoutSeconds === undefined) {
      return;
    }
    this.#timeout = setTimeout(() => {
      this.#timedOut = true;
      if (this.child.pid !== undefined) {
        timedOutProcessGroups.set(this.child.pid, this.child);
      }
      terminateChildProcessTree(this.child.pid, "SIGTERM", () => {
        this.child.kill("SIGTERM");
      });
      this.#forceKill = setTimeout(() => {
        void this.forceTimeoutCompletion();
      }, ASYNC_TERMINATION_GRACE_MS);
    }, this.options.timeoutSeconds * 1000);
  }

  private async writeInput() {
    try {
      if (this.options?.stdin !== undefined) {
        await this.child.stdin.write(this.options.stdin);
      }
      await this.child.stdin.end();
    } catch (error) {
      this.#stdinError = error instanceof Error ? error : new Error(String(error));
    }
  }
}

function registerAsyncChild(child: AsyncChildProcess) {
  if (activeAsyncChildren.size === 0 && timedOutProcessGroups.size === 0) {
    attachParentTerminationHandlers();
  }
  activeAsyncChildren.add(child);
}

function unregisterAsyncChild(child: AsyncChildProcess) {
  if (!activeAsyncChildren.delete(child)) {
    return;
  }
  if (forwardedTerminationSignal !== undefined) {
    finishParentTerminationAfterEscalation();
    return;
  }
  detachParentTerminationHandlersIfIdle();
}

function detachParentTerminationHandlersIfIdle() {
  if (
    activeAsyncChildren.size === 0 &&
    timedOutProcessGroups.size === 0 &&
    forwardedTerminationSignal === undefined
  ) {
    detachParentTerminationHandlers();
  }
}

function attachParentTerminationHandlers() {
  for (const [signal, handler] of PARENT_TERMINATION_HANDLERS) {
    process.on(signal, handler);
  }
}

function detachParentTerminationHandlers() {
  for (const [signal, handler] of PARENT_TERMINATION_HANDLERS) {
    process.off(signal, handler);
  }
}

function finishParentTerminationAfterEscalation() {
  if (
    terminationEscalated &&
    activeAsyncChildren.size === 0 &&
    timedOutProcessGroups.size === 0 &&
    !parentExitScheduled
  ) {
    detachParentTerminationHandlers();
    parentExitScheduled = true;
    setImmediate(() => {
      const signal = forwardedTerminationSignal;
      forwardedTerminationSignal = undefined;
      parentExitScheduled = false;
      terminationEscalated = false;
      if (signal !== undefined) {
        process.kill(process.pid, signal);
      }
    });
  }
}

function forwardParentTermination(signal: NodeJS.Signals) {
  forwardedTerminationSignal ??= signal;
  terminationEscalated = true;
  for (const child of activeAsyncChildren) {
    terminateActiveChild(child.pid, child, signal);
  }
  for (const [pid, child] of timedOutProcessGroups) {
    terminateActiveChild(pid, child, signal);
  }
  finishParentTerminationAfterEscalation();
}

function terminateActiveChild(
  pid: number | undefined,
  child: AsyncChildProcess,
  signal: NodeJS.Signals
) {
  terminateChildProcessTree(pid, signal, () => {
    child.kill(signal);
  });
  terminateChildProcessTree(pid, "SIGKILL", () => {
    child.kill("SIGKILL");
  });
}

function terminateChildProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
  fallback: () => void
) {
  if (pid === undefined || process.platform === "win32") {
    fallback();
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    fallback();
  }
}

function handleCompletedCommand(
  result: Bun.ReadableSyncSubprocess,
  command: string,
  args: string[],
  allowFailure: boolean
) {
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  // Bun 1.4.1 returns null at runtime after a timeout or signal, despite the numeric type.
  const exitCode = result.exitCode ?? -1;

  if (result.exitedDueToTimeout === true) {
    if (allowFailure) {
      return { exitCode: -1, stderr, stdout, timedOut: true };
    }
    throw new MonkeError(
      `Failed to run ${formatCommand(command, args)}: spawnSync ${command} ETIMEDOUT`
    );
  }
  if (!allowFailure && result.signalCode !== undefined) {
    const reason = `terminated by signal ${result.signalCode}`;
    throw new MonkeError(`Command failed: ${formatCommand(command, args)}\n${reason}`);
  }
  if (!allowFailure && exitCode !== 0) {
    const reason = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
    throw new MonkeError(`Command failed: ${formatCommand(command, args)}\n${reason}`);
  }
  return { exitCode, stderr, stdout };
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
  return sha256(value);
}

export function findExecutable(command: string, env: Record<string, string | undefined>) {
  const pathValue = env.PATH;
  if (!pathValue) {
    return null;
  }
  return Bun.which(command, { PATH: pathValue });
}

export function withGlobalLock<T>(home: string, callback: () => T) {
  return withLockPath(path.join(home, "lock"), callback);
}

/** Run asynchronous Session work while holding the machine-wide Monke lock. */
export async function withGlobalLockAsync<T>(home: string, callback: () => Promise<T>) {
  return await withLockPathAsync(path.join(home, "lock"), callback);
}

/** Run an asynchronous installation mutation under the machine-wide installation lock. */
export async function withInstallationLockAsync<T>(home: string, callback: () => Promise<T>) {
  return await withLockPathAsync(path.join(home, "locks", "installation.lock"), callback);
}

function acquireLockPathAsync(lockPath: string) {
  const deadline = prepareLockAcquisition(lockPath);
  return new Promise<() => void>((resolve, reject) => {
    const poll = () => {
      try {
        const attempt = tryAcquireLockBeforeDeadline(lockPath, deadline);
        if (attempt.release) {
          resolve(attempt.release);
          return;
        }
        setTimeout(poll, attempt.wait ? LOCK_RETRY_INTERVAL_MS : 0);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    poll();
  });
}

/** Run asynchronous work while holding a lock scoped inside the monke home directory. */
export async function withScopedLockAsync<T>(
  home: string,
  namespace: string,
  callback: () => Promise<T>
) {
  return await withLockPathAsync(path.join(home, "locks", `${hashKey(namespace)}.lock`), callback);
}

async function withLockPathAsync<T>(lockPath: string, callback: () => Promise<T>) {
  const release = await acquireLockPathAsync(lockPath);
  try {
    return await callback();
  } finally {
    release();
  }
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
    const attempt = tryAcquireLockBeforeDeadline(lockPath, deadline);
    if (attempt.release) {
      return attempt.release;
    }
    if (attempt.wait) {
      sleep(LOCK_RETRY_INTERVAL_MS);
    }
  }
}

function tryAcquireLockBeforeDeadline(lockPath: string, deadline: number) {
  const attempt = tryAcquireLockPath(lockPath);
  if (!attempt.release) {
    assertLockDeadline(lockPath, deadline);
  }
  return attempt;
}

function prepareLockAcquisition(lockPath: string) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  return Date.now() + GLOBAL_LOCK_TIMEOUT_MS;
}

function tryAcquireLockPath(lockPath: string) {
  if (existsSync(reclaimPathFor(lockPath))) {
    return { wait: true };
  }
  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = openSync(lockPath, "wx");
    writeFileSync(
      fileDescriptor,
      JSON.stringify({ acquiredAt: Date.now(), pid: process.pid }),
      "utf-8"
    );
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
        data() {
          // Port probing never consumes socket data.
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
  const bytes: number[] = [];
  const buffer = Buffer.alloc(1);

  while (true) {
    const bytesRead = readSync(0, buffer, 0, 1, null);
    if (bytesRead === 0) {
      break;
    }

    const byte = buffer.readUInt8(0);
    if (byte === 10) {
      break;
    }
    if (byte !== 13) {
      bytes.push(byte);
    }
  }

  return Buffer.from(bytes).toString("utf-8");
}

function tryEvictStaleLock(lockPath: string) {
  const reclaimPath = reclaimPathFor(lockPath);
  try {
    mkdirSync(reclaimPath);
  } catch (error) {
    if (errorMessage(error).includes("EEXIST")) {
      return false;
    }
    throw error;
  }

  try {
    return evictStaleLockUnderClaim(lockPath);
  } finally {
    rmdirSync(reclaimPath);
  }
}

function reclaimPathFor(lockPath: string) {
  return `${lockPath}.reclaim`;
}

function evictStaleLockUnderClaim(lockPath: string) {
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

export function isProcessRunning(pid: number) {
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
    return true;
  }
}

function resolveRunningToolInstallRoot() {
  try {
    return path.dirname(realpathSync.native(process.execPath));
  } catch {
    return path.dirname(process.execPath);
  }
}
