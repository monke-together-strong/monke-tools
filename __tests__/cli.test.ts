import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/index.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const ROOT_USAGE = "Usage:\n  monke create <session>\n  monke materialize\n  monke cleanup";

test("runCli preserves top-level usage for missing and unknown commands", () => {
  expect(() => runCli([])).toThrow(ROOT_USAGE);
  expect(() => runCli(["unknown"])).toThrow(ROOT_USAGE);
});

test("runCli preserves command-specific usage for invalid arity", () => {
  expect(() => runCli(["create"])).toThrow("Usage: monke create <session>");
  expect(() => runCli(["create", "banana", "extra"])).toThrow("Usage: monke create <session>");
  expect(() => runCli(["materialize", "extra"])).toThrow("Usage: monke materialize");
  expect(() => runCli(["cleanup", "extra"])).toThrow("Usage: monke cleanup");
});

test("main entrypoint writes usage errors to stderr", () => {
  const result = spawnSync("bun", ["run", "src/index.ts", "cleanup", "extra"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("Usage: monke cleanup\n");
});
