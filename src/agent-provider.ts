import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

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
  run(options: AgentRunOptions): Promise<AgentRunResult> {
    mkdirSync(path.dirname(options.logPath), { recursive: true });
    writeFileSync(options.logPath, this.#formatLogHeader(options), "utf8");
    const logStream = createWriteStream(options.logPath, { flags: "a" });

    const args = this.#buildCodexArgs(options);
    const child = spawn(this.#codexPath, args, {
      cwd: options.repoRoot,
      env: this.#runtime.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      logStream.write(chunk);
      this.#runtime.writeStdout(text);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      logStream.write(chunk);
      this.#runtime.writeStderr(text);
    });

    const completion = new Promise<AgentRunResult>((resolve, reject) => {
      let settled = false;
      let streamError: Error | null = null;

      const rejectOnce = (error: Error): void => {
        if (settled) {
          return;
        }

        settled = true;
        reject(error);
      };

      const resolveOnce = (result: AgentRunResult): void => {
        if (settled) {
          return;
        }

        settled = true;
        resolve(result);
      };

      logStream.on("error", (error) => {
        streamError = error;
        child.kill();
        rejectOnce(new MonkeError(`Failed to write log ${options.logPath}: ${error.message}`));
      });

      child.on("error", (error) => {
        logStream.destroy();
        rejectOnce(
          new MonkeError(`Failed to run ${formatCommand(this.#codexPath, args)}: ${error.message}`),
        );
      });

      child.on("close", (exitCode, signal) => {
        if (settled) {
          return;
        }

        logStream.end(() => {
          if (streamError) {
            return;
          }

          if (exitCode === null) {
            const reason = signal ? `terminated by signal ${signal}` : "terminated by signal";
            rejectOnce(
              new MonkeError(`Command failed: ${formatCommand(this.#codexPath, args)}\n${reason}`),
            );
            return;
          }

          resolveOnce({ exitCode });
        });
      });
    });

    child.stdin.end(options.prompt);
    return completion;
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

  #formatLogHeader(options: AgentRunOptions): string {
    return [
      "# Monke Tools Agent Phase Log",
      `phase: ${options.phase}`,
      `provider: ${this.id}`,
      `effort: ${options.reasoningEffort ?? "omitted"}`,
      `startedAt: ${new Date().toISOString()}`,
      "",
      "--- output ---",
      "",
    ].join("\n");
  }
}
