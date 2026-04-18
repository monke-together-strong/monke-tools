import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import * as z from "zod";

import { runCodexJson } from "../src/codex-json.ts";
import { installFakeCodex, makeTempDir, read } from "./helpers.ts";

function readLoggedArgs(root: string, argsLogPath: string): string[] {
  return read(root, path.relative(root, argsLogPath)).trim().split("\n");
}

function getLoggedArgValue(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  if (index === -1 || args[index + 1] === undefined) {
    throw new Error(`Expected logged Codex args to include ${name} with a value`);
  }

  return args[index + 1]!;
}

test("runCodexJson passes structured output files, preserves stdin, and returns schema-validated data", async () => {
  const sandbox = makeTempDir("codex-json-success");
  const binDirectory = path.join(sandbox, "bin");
  const { argsLogPath, stdinLogPath, schemaLogPath } = installFakeCodex(binDirectory, {
    jsonOutput: JSON.stringify({ summary: "structured result", count: 2 }),
  });

  const result = await runCodexJson({
    codexPath: path.join(binDirectory, "codex"),
    cwd: sandbox,
    prompt: "Line one\nLine two",
    schema: z.object({
      summary: z.string(),
      count: z.number(),
    }),
  });

  expect(result).toEqual({ summary: "structured result", count: 2 });
  expect(read(sandbox, path.relative(sandbox, stdinLogPath))).toContain("Line one\nLine two");

  const args = readLoggedArgs(sandbox, argsLogPath);
  const schemaPath = getLoggedArgValue(args, "--output-schema");
  const outputPath = getLoggedArgValue(args, "--output-last-message");
  expect(args).toEqual([
    "exec",
    "--ephemeral",
    "-s",
    "read-only",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "-",
  ]);
  expect(JSON.parse(read(sandbox, path.relative(sandbox, schemaLogPath)))).toMatchObject({
    type: "object",
    properties: {
      summary: { type: "string" },
      count: { type: "number" },
    },
  });
});

test("runCodexJson writes a structured process log when requested", async () => {
  const sandbox = makeTempDir("codex-json-log");
  const binDirectory = path.join(sandbox, "bin");
  const logPath = path.join(sandbox, "logs", "planner.log");
  installFakeCodex(binDirectory, {
    jsonOutput: JSON.stringify({ ok: true }),
    stdoutText: "structured stdout",
    stderrText: "structured stderr",
  });

  await runCodexJson({
    codexPath: path.join(binDirectory, "codex"),
    cwd: sandbox,
    prompt: "Return JSON",
    schema: z.object({ ok: z.boolean() }),
    reasoningEffort: "high",
    log: {
      path: logPath,
      phase: "planner",
    },
  });

  const log = read(sandbox, path.relative(sandbox, logPath));
  expect(log).toContain("# Monke Tools Structured Codex Log");
  expect(log).toContain("phase: planner");
  expect(log).toContain("provider: codex-json");
  expect(log).toContain("effort: high");
  expect(log).toMatch(/startedAt: \d{4}-\d{2}-\d{2}T/);
  expect(log).toContain("--- stdout ---\nstructured stdout");
  expect(log).toContain("--- stderr ---\nstructured stderr");
  expect(log).toContain('--- final message ---\n{"ok":true}');
});

test("runCodexJson throws when Codex writes invalid JSON", async () => {
  const sandbox = makeTempDir("codex-json-invalid");
  const binDirectory = path.join(sandbox, "bin");
  installFakeCodex(binDirectory, {
    jsonOutput: "not json",
    stdoutText: "process stdout",
    stderrText: "process stderr",
  });

  await expect(
    runCodexJson({
      codexPath: path.join(binDirectory, "codex"),
      cwd: sandbox,
      prompt: "Return JSON",
      schema: z.object({ ok: z.boolean() }),
    }),
  ).rejects.toThrow(/json-parse failed[\s\S]*stderr: process stderr[\s\S]*stdout: process stdout/);
});

test("runCodexJson throws when Codex JSON does not match the Zod schema", async () => {
  const sandbox = makeTempDir("codex-json-schema-mismatch");
  const binDirectory = path.join(sandbox, "bin");
  installFakeCodex(binDirectory, {
    jsonOutput: JSON.stringify({ ok: "yes" }),
  });

  await expect(
    runCodexJson({
      codexPath: path.join(binDirectory, "codex"),
      cwd: sandbox,
      prompt: "Return JSON",
      schema: z.object({ ok: z.boolean() }),
    }),
  ).rejects.toThrow(/schema-parse failed[\s\S]*validationError:/);
});

test("runCodexJson surfaces unsupported Zod schemas as schema-definition errors", async () => {
  const sandbox = makeTempDir("codex-json-schema-definition");

  await expect(
    runCodexJson({
      codexPath: path.join(sandbox, "codex"),
      cwd: sandbox,
      prompt: "Return JSON",
      schema: z.string().transform((value) => value.trim()),
    }),
  ).rejects.toThrow(/schema-definition failed/);
});

test("runCodexJson throws on nonzero Codex exit with stdout and stderr snippets", async () => {
  const sandbox = makeTempDir("codex-json-nonzero");
  const binDirectory = path.join(sandbox, "bin");
  installFakeCodex(binDirectory, {
    exitCode: 7,
    stdoutText: "useful stdout",
    stderrText: "useful stderr",
  });

  await expect(
    runCodexJson({
      codexPath: path.join(binDirectory, "codex"),
      cwd: sandbox,
      prompt: "Return JSON",
      schema: z.object({ ok: z.boolean() }),
    }),
  ).rejects.toThrow(
    /codex-exit failed with exit code 7[\s\S]*stderr: useful stderr[\s\S]*stdout: useful stdout/,
  );
});

test("runCodexJson throws when the Codex output file cannot be read", async () => {
  const sandbox = makeTempDir("codex-json-unreadable-output");
  const binDirectory = path.join(sandbox, "bin");
  installFakeCodex(binDirectory, {
    removeJsonOutput: true,
  });

  await expect(
    runCodexJson({
      codexPath: path.join(binDirectory, "codex"),
      cwd: sandbox,
      prompt: "Return JSON",
      schema: z.object({ ok: z.boolean() }),
    }),
  ).rejects.toThrow(/output-read failed/);
});

test("runCodexJson throws when the provided Codex path cannot spawn", async () => {
  const sandbox = makeTempDir("codex-json-spawn-failure");

  await expect(
    runCodexJson({
      codexPath: path.join(sandbox, "missing-codex"),
      cwd: sandbox,
      prompt: "Return JSON",
      schema: z.object({ ok: z.boolean() }),
    }),
  ).rejects.toThrow(/codex-spawn failed/);
});

test("runCodexJson removes temp schema and output files on success and failure", async () => {
  const successSandbox = makeTempDir("codex-json-cleanup-success");
  const successBinDirectory = path.join(successSandbox, "bin");
  const successFake = installFakeCodex(successBinDirectory, {
    jsonOutput: JSON.stringify({ ok: true }),
  });

  await runCodexJson({
    codexPath: path.join(successBinDirectory, "codex"),
    cwd: successSandbox,
    prompt: "Return JSON",
    schema: z.object({ ok: z.boolean() }),
  });

  const successArgs = readLoggedArgs(successSandbox, successFake.argsLogPath);
  expect(existsSync(getLoggedArgValue(successArgs, "--output-schema"))).toBe(false);
  expect(existsSync(getLoggedArgValue(successArgs, "--output-last-message"))).toBe(false);

  const failureSandbox = makeTempDir("codex-json-cleanup-failure");
  const failureBinDirectory = path.join(failureSandbox, "bin");
  const failureFake = installFakeCodex(failureBinDirectory, {
    jsonOutput: "not json",
  });

  await expect(
    runCodexJson({
      codexPath: path.join(failureBinDirectory, "codex"),
      cwd: failureSandbox,
      prompt: "Return JSON",
      schema: z.object({ ok: z.boolean() }),
    }),
  ).rejects.toThrow(/json-parse failed/);

  const failureArgs = readLoggedArgs(failureSandbox, failureFake.argsLogPath);
  expect(existsSync(getLoggedArgValue(failureArgs, "--output-schema"))).toBe(false);
  expect(existsSync(getLoggedArgValue(failureArgs, "--output-last-message"))).toBe(false);
});

test("runCodexJson forwards optional model, reasoning effort, and image arguments", async () => {
  const sandbox = makeTempDir("codex-json-options");
  const binDirectory = path.join(sandbox, "bin");
  const { argsLogPath } = installFakeCodex(binDirectory, {
    jsonOutput: JSON.stringify({ ok: true }),
  });

  await runCodexJson({
    codexPath: path.join(binDirectory, "codex"),
    cwd: sandbox,
    prompt: "Return JSON",
    schema: z.object({ ok: z.boolean() }),
    model: "gpt-5.4",
    reasoningEffort: "high",
    images: ["first.png", "second.png"],
  });

  const args = readLoggedArgs(sandbox, argsLogPath);
  const schemaPath = getLoggedArgValue(args, "--output-schema");
  const outputPath = getLoggedArgValue(args, "--output-last-message");
  expect(args).toEqual([
    "exec",
    "--ephemeral",
    "-s",
    "read-only",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "--model",
    "gpt-5.4",
    "--config",
    'model_reasoning_effort="high"',
    "--image",
    "first.png",
    "--image",
    "second.png",
    "-",
  ]);
});
