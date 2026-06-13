import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { formatCommand } from "./runtime.ts";

const DEFAULT_FORCE_KILL_GRACE_MS = 1_000;

/** Raw result from one Codex CLI child process invocation. */
export interface CodexProcessResult {
  /** Process exit code, or -1 when the process ended without an exit code. */
  readonly exitCode: number;
  /** Signal reported by Node when the process ended by signal. */
  readonly signal: NodeJS.Signals | null;
  /** Captured stdout text. */
  readonly stdout: string;
  /** Captured stderr text. */
  readonly stderr: string;
  /** Wall-clock duration spent in the process. */
  readonly durationMs: number;
  /** True when this runner killed the process because timeoutMs elapsed. */
  readonly timedOut: boolean;
}

/** Options for running one Codex CLI process behind a concrete adapter. */
export interface RunCodexProcessOptions {
  /** Absolute or relative Codex CLI executable path. */
  readonly command: string;
  /** Full argument vector passed to the Codex CLI executable. */
  readonly args: readonly string[];
  /** Working directory for the Codex process. */
  readonly cwd: string;
  /** Environment for the Codex process. */
  readonly env: Record<string, string | undefined>;
  /** Prompt text sent to Codex on stdin. */
  readonly stdin: string;
  /** Whether stdout/stderr should be retained in the returned result. Defaults to true. */
  readonly captureOutput?: boolean;
  /** Optional timeout before the child process is terminated. */
  readonly timeoutMs?: number;
  /** Grace period after timeout SIGTERM before SIGKILL. Defaults to 1 second. */
  readonly forceKillGraceMs?: number;
  /** Optional hook for live stdout streaming. */
  readonly onStdout?: (chunk: Buffer) => void;
  /** Optional hook for live stderr streaming. */
  readonly onStderr?: (chunk: Buffer) => void;
  /** Optional hook for adapters that need direct child lifecycle access. */
  readonly onProcess?: (child: ChildProcessWithoutNullStreams) => void;
}

/** Spawn failure with any output captured before Node reported the error. */
export class CodexProcessSpawnError extends Error {
  readonly stdout: string;
  readonly stderr: string;

  constructor(error: unknown, stdout: string, stderr: string) {
    super(formatUnknownError(error));
    this.name = "CodexProcessSpawnError";
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** Run one Codex child process while capturing output and optional live stream hooks. */
export function runCodexProcess(options: RunCodexProcessOptions): Promise<CodexProcessResult> {
  return new Promise((resolve, reject) => {
    const startedAtMs = Date.now();
    const captureOutput = options.captureOutput ?? true;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcessWithoutNullStreams;
    let cleanupStdinErrorListener: () => void = () => {};

    const clearProcessTimeouts = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }

      if (forceKillTimeout !== undefined) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = undefined;
      }
    };

    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearProcessTimeouts();
      cleanupStdinErrorListener();
      reject(error);
    };

    const resolveOnce = (result: CodexProcessResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearProcessTimeouts();
      cleanupStdinErrorListener();
      resolve(result);
    };

    try {
      child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      rejectOnce(new CodexProcessSpawnError(error, stdout, stderr || formatUnknownError(error)));
      return;
    }

    try {
      options.onProcess?.(child);
    } catch (error) {
      child.kill();
      rejectOnce(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceKillTimeout = setTimeout(() => {
          child.kill("SIGKILL");
        }, options.forceKillGraceMs ?? DEFAULT_FORCE_KILL_GRACE_MS);
      }, options.timeoutMs);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (captureOutput) {
        stdout += chunk.toString("utf8");
      }

      try {
        options.onStdout?.(chunk);
      } catch (error) {
        child.kill();
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (captureOutput) {
        stderr += chunk.toString("utf8");
      }

      try {
        options.onStderr?.(chunk);
      } catch (error) {
        child.kill();
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
      }
    });

    child.on("error", (error) => {
      rejectOnce(new CodexProcessSpawnError(error, stdout, stderr || error.message));
    });

    child.on("close", (exitCode, signal) => {
      const durationMs = Date.now() - startedAtMs;
      resolveOnce({
        exitCode: exitCode ?? -1,
        signal,
        stdout,
        stderr:
          !timedOut && exitCode === null && signal
            ? [stderr, `terminated by signal ${signal}`].filter(Boolean).join("\n")
            : stderr,
        durationMs,
        timedOut,
      });
    });

    const handleStdinError = (): void => {
      cleanupStdinErrorListener();
    };
    cleanupStdinErrorListener = (): void => {
      child.stdin.off("error", handleStdinError);
    };

    child.stdin.once("error", handleStdinError);
    child.stdin.end(options.stdin, cleanupStdinErrorListener);
  });
}

/** Format a process failure with captured stderr/stdout snippets and the command line. */
export function formatCodexProcessError(
  stage: string,
  command: string,
  args: readonly string[],
  result: Pick<CodexProcessResult, "exitCode" | "stdout" | "stderr">,
): string {
  return `${formatCodexProcessDetails(stage, result)}\ncommand: ${formatCommand(command, [...args])}`;
}

/** Format the stage and captured output snippets for a failed Codex process. */
export function formatCodexProcessDetails(
  stage: string,
  result: Pick<CodexProcessResult, "exitCode" | "stdout" | "stderr">,
): string {
  return [
    `${stage} failed with exit code ${result.exitCode}`,
    `stderr: ${snippet(result.stderr)}`,
    `stdout: ${snippet(result.stdout)}`,
  ].join("\n");
}

export function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function snippet(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "(empty)";
  }

  return trimmed.length > 2_000 ? `${trimmed.slice(0, 2_000)}...` : trimmed;
}
