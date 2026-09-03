import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnSyncReturns } from "node:child_process";
import { hash } from "node:crypto";
import {
  accessSync,
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
import type {
  ExecOptions,
  ExecResult,
  InstallationActivationPhase,
  MultiSelectPrompt,
  ReleaseDistribution,
  Runtime,
  SessionMaterializationCheckpoint,
  SelectPrompt
} from "./types.ts";

const GLOBAL_LOCK_TIMEOUT_MS = 5000;
const ASYNC_TERMINATION_GRACE_MS = 250;
const LOCK_RETRY_INTERVAL_MS = 50;
const RELEASE_CATALOG_PAGE_SIZE = 100;
const RELEASE_REQUEST_TIMEOUT_MS = 30_000;
const STALE_LOCK_AGE_MS = 60_000;
type AsyncChildProcess = ChildProcessWithoutNullStreams;
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
  /** Make the next select prompt follow the normal cancellation path in tests. */
  cancelSelect?: boolean;
  /** Current working directory used by command execution. */
  cwd?: string;
  /** Environment overrides merged over the process environment. */
  env?: Record<string, string | undefined>;
  /** Optional injected activation boundary used by failure-behavior tests. */
  installationActivationBoundary?: (phase: InstallationActivationPhase) => void;
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
  /** Optional injected Session checkpoint boundary used by interruption tests. */
  sessionMaterializationBoundary?: (checkpoint: SessionMaterializationCheckpoint) => void;
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
  const scriptedInput = createScriptedInput(options);
  const scriptedSelectValues = options?.selectValues ? [...options.selectValues] : null;
  const scriptedMultiSelectValues = options?.multiSelectValues
    ? [...options.multiSelectValues]
    : null;

  const writeStdout = createStdoutWriter(options);
  const writeStderr = createStderrWriter(options);

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
    installationActivationBoundary: options?.installationActivationBoundary,
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
    sessionMaterializationBoundary: options?.sessionMaterializationBoundary,
    stderrIsTTY: resolveStderrIsTTY(options),
    toolBuildIdentity: options?.toolBuildIdentity ?? DEFAULT_TOOL_BUILD_IDENTITY,
    toolInstallRoot: options?.toolInstallRoot ?? resolveRunningToolInstallRoot(),
    writeStderr,
    writeStdout
  };
}

function createStdoutWriter(options: RuntimeOptions | undefined) {
  return (text: string) => {
    if (options?.onStdout) {
      options.onStdout(text);
      return;
    }
    process.stdout.write(text);
  };
}

function createScriptedInput(options: RuntimeOptions | undefined) {
  return options?.stdinText === undefined ? null : options.stdinText.split(/\r?\n/u);
}

function createStderrWriter(options: RuntimeOptions | undefined) {
  return (text: string) => {
    if (options?.onStderr) {
      options.onStderr(text);
      return;
    }
    process.stderr.write(text);
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
      const response = await request(url);
      const body = await response.arrayBuffer();
      return new Uint8Array(body);
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
  const childEnv = {
    ...runtimeEnv,
    ...options?.env,
    MONKE_SHELL_DIR_DIRECTIVE: undefined
  };

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
    const child = spawn(command, args, {
      cwd: options?.cwd ?? runtimeCwd,
      detached: process.platform !== "win32",
      env: childEnv,
      stdio: "pipe"
    });
    new AsyncCommandExecution(child, command, args, options, resolve, reject).start();
  });
}

class AsyncCommandExecution {
  #forceKill: ReturnType<typeof setTimeout> | undefined;
  #settled = false;
  #stderr = "";
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
    this.captureOutput();
    this.listenForCompletion();
    this.startTimeout();
    this.child.stdin.end(this.options?.stdin);
  }

  private captureOutput() {
    this.child.stdout.setEncoding("utf-8");
    this.child.stderr.setEncoding("utf-8");
    this.child.stdout.on("data", (chunk: string) => {
      this.#stdout += chunk;
    });
    this.child.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
  }

  private clearTimers() {
    if (this.#timeout !== undefined) {
      clearTimeout(this.#timeout);
    }
    if (this.#forceKill !== undefined) {
      clearTimeout(this.#forceKill);
    }
  }

  private forceTimeoutCompletion() {
    terminateChildProcessTree(this.child.pid, "SIGKILL", () => {
      this.child.kill("SIGKILL");
    });
    if (this.child.pid !== undefined) {
      timedOutProcessGroups.delete(this.child.pid);
    }
    unregisterAsyncChild(this.child);
    this.settleTimeout();
    finishParentTerminationAfterEscalation();
    detachParentTerminationHandlersIfIdle();
  }

  private handleClose(code: number | null, signal: NodeJS.Signals | null) {
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
      this.resolveOnce({ exitCode, stderr: this.#stderr, stdout: this.#stdout });
    } finally {
      unregisterAsyncChild(this.child);
    }
  }

  private listenForCompletion() {
    this.child.once("error", (error) => {
      if (this.#timedOut) {
        return;
      }
      this.rejectOnce(
        new MonkeError(`Failed to run ${formatCommand(this.command, this.args)}: ${error.message}`)
      );
      unregisterAsyncChild(this.child);
    });
    this.child.once("close", (code, signal) => {
      this.handleClose(code, signal);
    });
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
        this.forceTimeoutCompletion();
      }, ASYNC_TERMINATION_GRACE_MS);
    }, this.options.timeoutSeconds * 1000);
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
  return hash("sha256", value, "hex");
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

/** Run a synchronous callback while holding a lock scoped inside the monke home directory. */
export function withScopedLock<T>(home: string, namespace: string, callback: () => T) {
  return withLockPath(path.join(home, "locks", `${hashKey(namespace)}.lock`), callback);
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
