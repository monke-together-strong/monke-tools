import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/index.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("runCli exposes Commander's concise command errors", () => {
  expect(() => runCli([])).toThrow("error: missing command");
  expect(() => runCli(["unknown"])).toThrow("error: unknown command 'unknown'");
  expect(() => runCli(["create", "banana"])).toThrow("error: unknown command 'create'");
});

test("runCli exposes Commander's concise argument and option errors", () => {
  expect(() => runCli(["spawn"])).toThrow("error: missing required argument 'session'");
  expect(() => runCli(["spawn", "banana", "extra"])).toThrow(
    "error: too many arguments for 'spawn'. Expected 1 argument but got 2:",
  );
  expect(() => runCli(["swing", "banana", "extra"])).toThrow(
    "error: too many arguments for 'swing'. Expected 1 argument but got 2:",
  );
  expect(() => runCli(["materialize", "extra"])).toThrow(
    "error: too many arguments for 'materialize'. Expected 0 arguments but got 1:",
  );
  expect(() => runCli(["cleanup", "--dry-run"])).toThrow(
    "error: option '--dry-run' cannot be used without option '--merged'",
  );
  expect(() => runCli(["shell"])).toThrow("error: missing command");
  expect(() => runCli(["shell", "unknown"])).toThrow("error: unknown command 'unknown'");
  expect(() => runCli(["shell", "init"])).toThrow("error: missing required argument 'shell'");
  expect(() => runCli(["shell", "init", "fish"])).toThrow(
    "error: command-argument value 'fish' is invalid for argument 'shell'. Allowed choices are bash, zsh.",
  );
  expect(() => runCli(["skills"])).toThrow("error: missing command");
  expect(() => runCli(["skills", "local-install"])).toThrow(
    "error: missing required argument 'source-checkout'",
  );
});

test("main entrypoint writes one Commander diagnostic to stderr", () => {
  const result = spawnSync("bun", ["run", "src/index.ts", "cleanup", "extra"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "error: too many arguments for 'cleanup'. Expected 0 arguments but got 1: extra.\n",
  );
});

test("source-maintenance CLIs write one Commander diagnostic to stderr", () => {
  const importResult = spawnSync("bun", ["run", "scripts/import-skills.ts"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  const updateResult = spawnSync("bun", ["run", "scripts/update-skills.ts", "extra"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  expect(importResult.status).toBe(1);
  expect(importResult.stdout).toBe("");
  expect(importResult.stderr).toBe("error: missing required argument 'source'\n");
  expect(updateResult.status).toBe(1);
  expect(updateResult.stdout).toBe("");
  expect(updateResult.stderr).toBe(
    "error: too many arguments. Expected 0 arguments but got 1: extra.\n",
  );
});

test("source-maintenance CLI help is successful and writes to stdout", () => {
  const importResult = spawnSync("bun", ["run", "scripts/import-skills.ts", "--help"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  const updateResult = spawnSync("bun", ["run", "scripts/update-skills.ts", "--help"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  expect(importResult.status).toBe(0);
  expect(importResult.stdout).toContain("Usage: bun run skills:import [options] <source>");
  expect(importResult.stderr).toBe("");
  expect(updateResult.status).toBe(0);
  expect(updateResult.stdout).toContain("Usage: bun run skills:update [options]");
  expect(updateResult.stderr).toBe("");
});
