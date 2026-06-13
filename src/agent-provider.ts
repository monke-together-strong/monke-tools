import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CodexProcessSpawnError, runCodexProcess } from "./codex-process-runner.ts";
import { MonkeError } from "./errors.ts";
import { formatCommand } from "./runtime.ts";
import type { Runtime } from "./types.ts";

/** Codex reasoning effort levels supported by `mt work --effort`. */
export const CODEX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

/** Codex reasoning effort level accepted by the current Codex-backed provider. */
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

/** Workflow phases that can be delegated to an agent provider. */
export type AgentPhase = "cleanup" | "implementer" | "reviewer" | "final-prd-reviewer";

/** Options required to execute one agent-backed workflow phase. */
export interface AgentRunOptions {
  /** Repository root where the provider should execute. */
  readonly repoRoot: string;
  /** Workflow phase identity for logging and provider metadata. */
  readonly phase: AgentPhase;
  /** Full prompt text sent to the provider on stdin. */
  readonly prompt: string;
  /** Plain-text log file that receives the phase header and raw output chunks. */
  readonly logPath: string;
  /** Reasoning effort to pass to providers that support it. */
  readonly reasoningEffort?: CodexReasoningEffort;
}

/** Result returned after a provider phase process exits normally. */
export interface AgentRunResult {
  /** Process exit code returned by the provider. */
  readonly exitCode: number;
  /** Wall-clock duration spent in the provider process. */
  readonly durationMs?: number;
}

/** Minimal provider contract used by the run workflow orchestrator. */
export interface AgentProvider {
  /** Stable provider identifier used in logs and summaries. */
  readonly id: string;
  /** Execute a single phase and stream output to both terminal and phase log. */
  run(options: AgentRunOptions): Promise<AgentRunResult>;
}

/** Codex CLI-backed provider for the current `mt work` workflow. */
export class CodexAgentProvider implements AgentProvider {
  /** Stable provider identifier used in logs and summaries. */
  readonly id = "codex";

  readonly #runtime: Runtime;
  readonly #codexPath: string;

  /** Create a provider that delegates phases to the Codex CLI executable. */
  constructor(runtime: Runtime, codexPath: string) {
    this.#runtime = runtime;
    this.#codexPath = codexPath;
  }

  /** Execute Codex with live stdout/stderr teeing and a self-describing phase log. */
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const startedAt = new Date();
    mkdirSync(path.dirname(options.logPath), { recursive: true });
    writeFileSync(options.logPath, this.#formatLogHeader(options, startedAt), "utf8");
    const logStream = createWriteStream(options.logPath, { flags: "a" });

    const args = this.#buildCodexArgs(options);
    let streamError: Error | null = null;

    try {
      const processResult = await runCodexProcess({
        command: this.#codexPath,
        args,
        cwd: options.repoRoot,
        env: this.#runtime.env,
        stdin: options.prompt,
        captureOutput: false,
        onProcess(child) {
          logStream.on("error", (error) => {
            streamError = error;
            child.kill();
          });
        },
        onStdout: (chunk) => {
          const text = chunk.toString("utf8");
          logStream.write(chunk);
          this.#runtime.writeStdout(text);
        },
        onStderr: (chunk) => {
          const text = chunk.toString("utf8");
          logStream.write(chunk);
          this.#runtime.writeStderr(text);
        },
      });

      if (streamError) {
        logStream.destroy();
        throw new MonkeError(`Failed to write log ${options.logPath}: ${streamError.message}`);
      }

      try {
        await finishLogStream(logStream);
      } catch (error) {
        throw new MonkeError(
          `Failed to write log ${options.logPath}: ${formatUnknownError(error)}`,
        );
      }

      if (streamError) {
        throw new MonkeError(`Failed to write log ${options.logPath}: ${streamError.message}`);
      }

      if (processResult.signal !== null) {
        throw new MonkeError(
          `Command failed: ${formatCommand(this.#codexPath, args)}\nterminated by signal ${
            processResult.signal
          }`,
        );
      }

      return { exitCode: processResult.exitCode, durationMs: processResult.durationMs };
    } catch (error) {
      logStream.destroy();
      if (error instanceof CodexProcessSpawnError) {
        throw new MonkeError(
          `Failed to run ${formatCommand(this.#codexPath, args)}: ${error.message}`,
        );
      }

      throw error;
    }
  }

  #buildCodexArgs(options: AgentRunOptions): string[] {
    // `mt work` needs real repo access for git metadata updates and agent-authored edits.
    const args = ["exec", "--dangerously-bypass-approvals-and-sandbox", "--cd", options.repoRoot];

    if (options.reasoningEffort !== undefined) {
      args.push("-c", `model_reasoning_effort="${options.reasoningEffort}"`);
    }

    args.push("-");
    return args;
  }

  #formatLogHeader(options: AgentRunOptions, startedAt: Date): string {
    return [
      "# Monke Tools Agent Phase Log",
      `phase: ${options.phase}`,
      `provider: ${this.id}`,
      `effort: ${options.reasoningEffort ?? "omitted"}`,
      `startedAt: ${startedAt.toISOString()}`,
      "",
      "--- output ---",
      "",
    ].join("\n");
  }
}

function finishLogStream(logStream: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      logStream.off("error", rejectStreamError);
    };
    const rejectStreamError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    logStream.once("error", rejectStreamError);
    logStream.end(() => {
      cleanup();
      resolve();
    });
  });
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
