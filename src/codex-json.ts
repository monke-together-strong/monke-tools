import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as z from "zod";

import type { CodexReasoningEffort } from "./agent-provider.ts";
import {
  CodexProcessSpawnError,
  formatCodexProcessDetails,
  formatCodexProcessError,
  formatUnknownError,
  runCodexProcess,
  type CodexProcessResult,
} from "./codex-process-runner.ts";
import { MonkeError } from "./errors.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Log destination and workflow identity for one structured Codex invocation. */
export interface CodexJsonLogOptions {
  /** Plain-text log file that receives structured Codex process output. */
  readonly path: string;
  /** Workflow phase label written to the structured Codex log. */
  readonly phase: string;
}

/** Options for one non-streaming structured `codex exec` invocation. */
export interface RunCodexJsonOptions<TSchema extends z.ZodTypeAny> {
  /** Absolute or relative path to the Codex CLI executable to run. */
  readonly codexPath: string;
  /** Working directory for the Codex process. */
  readonly cwd: string;
  /** Prompt text sent to Codex on stdin unchanged. */
  readonly prompt: string;
  /** Zod schema used to generate JSON Schema and validate Codex's final JSON message. Must be JSON Schema-representable. */
  readonly schema: TSchema;
  /** Optional Codex model name. Omitted unless explicitly provided. */
  readonly model?: string;
  /** Optional Codex reasoning effort forwarded through `--config model_reasoning_effort="..."`. */
  readonly reasoningEffort?: CodexReasoningEffort;
  /** Optional image paths forwarded as repeated `--image` flags. */
  readonly images?: readonly string[];
  /** Optional environment overrides merged on top of `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** Optional log destination for the structured Codex process output. */
  readonly log?: CodexJsonLogOptions;
}

/** Run Codex once with a Zod-backed output schema and return validated JSON data. */
export async function runCodexJson<TSchema extends z.ZodTypeAny>(
  options: RunCodexJsonOptions<TSchema>,
): Promise<z.infer<TSchema>> {
  const tempDirectory = await createTempDirectory();
  const schemaPath = path.join(tempDirectory, "schema.json");
  const outputPath = path.join(tempDirectory, "output.json");

  try {
    const jsonSchema = toJsonSchema(options.schema);
    await writeTempFile("schema-write", schemaPath, JSON.stringify(jsonSchema));
    await writeTempFile("output-create", outputPath, "");

    const args = buildCodexJsonArgs(options, schemaPath, outputPath);
    const startedAt = new Date();
    const processResult = await runCodexJsonProcess(options, args);
    if (processResult.timedOut) {
      throw new MonkeError(
        formatCodexProcessError(
          "codex-timeout",
          options.codexPath,
          args,
          timeoutProcessResult(processResult),
        ),
      );
    }

    const capturedOutputText = await tryReadOutputFile(outputPath);
    await writeCodexJsonLog(options, processResult, capturedOutputText, startedAt);

    if (processResult.exitCode !== 0) {
      throw new MonkeError(
        formatCodexProcessError("codex-exit", options.codexPath, args, processResult),
      );
    }

    const outputText = capturedOutputText ?? (await readOutputFile(outputPath, processResult));
    const parsed = parseJsonOutput(outputText, processResult);
    return parseSchema(options.schema, parsed, processResult);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function buildCodexJsonArgs<TSchema extends z.ZodTypeAny>(
  options: RunCodexJsonOptions<TSchema>,
  schemaPath: string,
  outputPath: string,
): string[] {
  const args = [
    "exec",
    "--ephemeral",
    "-s",
    "read-only",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
  ];

  if (options.model !== undefined) {
    args.push("--model", options.model);
  }

  if (options.reasoningEffort !== undefined) {
    args.push("--config", `model_reasoning_effort="${options.reasoningEffort}"`);
  }

  for (const image of options.images ?? []) {
    args.push("--image", image);
  }

  args.push("-");
  return args;
}

async function createTempDirectory(): Promise<string> {
  try {
    return await mkdtemp(path.join(tmpdir(), "monke-codex-json-"));
  } catch (error) {
    throw new MonkeError(`temp-create failed: ${formatUnknownError(error)}`);
  }
}

async function writeTempFile(stage: string, filePath: string, contents: string): Promise<void> {
  try {
    await writeFile(filePath, contents, "utf8");
  } catch (error) {
    throw new MonkeError(`${stage} failed for ${filePath}: ${formatUnknownError(error)}`);
  }
}

function toJsonSchema(schema: z.ZodTypeAny): unknown {
  try {
    return z.toJSONSchema(schema);
  } catch (error) {
    throw new MonkeError(`schema-definition failed: ${formatUnknownError(error)}`);
  }
}

async function runCodexJsonProcess<TSchema extends z.ZodTypeAny>(
  options: RunCodexJsonOptions<TSchema>,
  args: string[],
): Promise<CodexProcessResult> {
  try {
    return await runCodexProcess({
      command: options.codexPath,
      args,
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
      },
      stdin: options.prompt,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof CodexProcessSpawnError) {
      throw new MonkeError(
        formatCodexProcessError("codex-spawn", options.codexPath, args, {
          exitCode: -1,
          stdout: error.stdout,
          stderr: error.stderr,
        }),
      );
    }

    throw error;
  }
}

function timeoutProcessResult(processResult: CodexProcessResult): CodexProcessResult {
  return {
    ...processResult,
    exitCode: -1,
    stderr: processResult.signal ? `terminated by signal ${processResult.signal}` : "timed out",
  };
}

async function readOutputFile(
  outputPath: string,
  processResult: CodexProcessResult,
): Promise<string> {
  try {
    return await readFile(outputPath, "utf8");
  } catch (error) {
    throw new MonkeError(
      `${formatCodexProcessDetails("output-read", processResult)}\nreadError: ${formatUnknownError(error)}`,
    );
  }
}

async function tryReadOutputFile(outputPath: string): Promise<string | null> {
  try {
    return await readFile(outputPath, "utf8");
  } catch {
    return null;
  }
}

async function writeCodexJsonLog<TSchema extends z.ZodTypeAny>(
  options: RunCodexJsonOptions<TSchema>,
  processResult: CodexProcessResult,
  outputText: string | null,
  startedAt: Date,
): Promise<void> {
  if (options.log === undefined) {
    return;
  }

  try {
    await mkdir(path.dirname(options.log.path), { recursive: true });
    await writeFile(
      options.log.path,
      formatCodexJsonLog(
        options.log,
        options.reasoningEffort,
        processResult,
        outputText,
        startedAt,
      ),
      "utf8",
    );
  } catch (error) {
    throw new MonkeError(`Failed to write log ${options.log.path}: ${formatUnknownError(error)}`);
  }
}

function formatCodexJsonLog(
  log: CodexJsonLogOptions,
  reasoningEffort: CodexReasoningEffort | undefined,
  processResult: CodexProcessResult,
  outputText: string | null,
  startedAt: Date,
): string {
  return [
    "# Monke Tools Structured Codex Log",
    `phase: ${log.phase}`,
    "provider: codex-json",
    `effort: ${reasoningEffort ?? "omitted"}`,
    `startedAt: ${startedAt.toISOString()}`,
    "",
    "--- stdout ---",
    processResult.stdout,
    "--- stderr ---",
    processResult.stderr,
    "--- final message ---",
    outputText ?? "(unavailable)",
    "",
  ].join("\n");
}

function parseJsonOutput(outputText: string, processResult: CodexProcessResult): unknown {
  try {
    return JSON.parse(outputText);
  } catch (error) {
    throw new MonkeError(
      `${formatCodexProcessDetails("json-parse", processResult)}\nparseError: ${formatUnknownError(error)}`,
    );
  }
}

function parseSchema<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  parsed: unknown,
  processResult: CodexProcessResult,
): z.infer<TSchema> {
  try {
    return schema.parse(parsed);
  } catch (error) {
    throw new MonkeError(
      `${formatCodexProcessDetails("schema-parse", processResult)}\nvalidationError: ${formatUnknownError(error)}`,
    );
  }
}
