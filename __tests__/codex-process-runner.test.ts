import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

import { CodexProcessSpawnError, runCodexProcess } from "../src/codex-process-runner.ts";
import { makeTempDir } from "./helpers.ts";

test("runCodexProcess captures output, forwards chunks, and preserves stdin", async () => {
  const sandbox = makeTempDir("codex-process-capture");
  const command = path.join(sandbox, "fake-codex");
  writeExecutable(
    command,
    `#!/bin/sh
set -eu
input=$(/bin/cat)
printf 'cwd=%s\\n' "$PWD"
printf 'arg=%s\\n' "$1"
printf 'env=%s\\n' "$MONKE_TEST_VALUE"
printf 'stdin=%s\\n' "$input"
printf 'stderr=%s\\n' "$input" >&2
exit 3
`,
  );
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const result = await runCodexProcess({
    command,
    args: ["first-arg"],
    cwd: sandbox,
    env: {
      ...process.env,
      MONKE_TEST_VALUE: "present",
    },
    stdin: "hello from stdin",
    onStdout(chunk) {
      stdoutChunks.push(chunk.toString("utf8"));
    },
    onStderr(chunk) {
      stderrChunks.push(chunk.toString("utf8"));
    },
  });

  expect(result.exitCode).toBe(3);
  expect(result.signal).toBeNull();
  expect(result.timedOut).toBe(false);
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expect(result.stdout).toContain(`cwd=${sandbox}`);
  expect(result.stdout).toContain("arg=first-arg");
  expect(result.stdout).toContain("env=present");
  expect(result.stdout).toContain("stdin=hello from stdin");
  expect(result.stderr).toContain("stderr=hello from stdin");
  expect(stdoutChunks.join("")).toBe(result.stdout);
  expect(stderrChunks.join("")).toBe(result.stderr);
});

test("runCodexProcess reports spawn failures with captured process context", async () => {
  const sandbox = makeTempDir("codex-process-spawn-failure");

  await expect(
    runCodexProcess({
      command: path.join(sandbox, "missing-codex"),
      args: [],
      cwd: sandbox,
      env: process.env,
      stdin: "prompt",
    }),
  ).rejects.toBeInstanceOf(CodexProcessSpawnError);
});

test("runCodexProcess can stream output without retaining it", async () => {
  const sandbox = makeTempDir("codex-process-no-capture");
  const command = path.join(sandbox, "fake-codex");
  writeExecutable(
    command,
    `#!/bin/sh
set -eu
/bin/cat >/dev/null
printf 'streamed stdout\\n'
printf 'streamed stderr\\n' >&2
`,
  );
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const result = await runCodexProcess({
    command,
    args: [],
    cwd: sandbox,
    env: process.env,
    stdin: "prompt",
    captureOutput: false,
    onStdout(chunk) {
      stdoutChunks.push(chunk.toString("utf8"));
    },
    onStderr(chunk) {
      stderrChunks.push(chunk.toString("utf8"));
    },
  });

  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
  expect(stdoutChunks.join("")).toBe("streamed stdout\n");
  expect(stderrChunks.join("")).toBe("streamed stderr\n");
});

test("runCodexProcess terminates a process when the timeout elapses", async () => {
  const sandbox = makeTempDir("codex-process-timeout");
  const scriptPath = path.join(sandbox, "slow-codex.ts");
  writeFileSync(
    scriptPath,
    "process.stdin.resume(); process.stdin.on('end', () => setInterval(() => {}, 1_000));\n",
    "utf8",
  );

  const result = await runCodexProcess({
    command: process.execPath,
    args: [scriptPath],
    cwd: sandbox,
    env: process.env,
    stdin: "prompt",
    timeoutMs: 50,
  });

  expect(result.exitCode).toBe(-1);
  expect(result.signal).not.toBeNull();
  expect(result.timedOut).toBe(true);
});

test("runCodexProcess force terminates a timeout process that ignores SIGTERM", async () => {
  const sandbox = makeTempDir("codex-process-force-timeout");
  const scriptPath = path.join(sandbox, "slow-codex-ignore-term.ts");
  writeFileSync(
    scriptPath,
    [
      "process.on('SIGTERM', () => {});",
      "process.stdin.resume();",
      "process.stdin.on('end', () => setInterval(() => {}, 1_000));",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = await runCodexProcess({
    command: process.execPath,
    args: [scriptPath],
    cwd: sandbox,
    env: process.env,
    stdin: "prompt",
    timeoutMs: 50,
    forceKillGraceMs: 50,
  });

  expect(result.exitCode).toBe(-1);
  expect(result.signal).toBe("SIGKILL");
  expect(result.timedOut).toBe(true);
});

function writeExecutable(targetPath: string, contents: string): void {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, contents, "utf8");
  chmodSync(targetPath, 0o755);
}
