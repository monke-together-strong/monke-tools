import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/index.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const ROOT_USAGE =
  "Usage:\n  mt create <session>\n  mt materialize\n  mt cleanup\n  mt setup\n  mt skills configure\n  mt work (<text> | --plan <text> | --prd <text>) [--effort <level>]";
const RUN_USAGE = "Usage: mt work (<text> | --plan <text> | --prd <text>) [--effort <level>]";
const SKILLS_USAGE = "Usage: mt skills configure";

test("runCli preserves top-level usage for missing and unknown commands", () => {
  expect(() => runCli([])).toThrow(ROOT_USAGE);
  expect(() => runCli(["unknown"])).toThrow(ROOT_USAGE);
});

test("runCli preserves command-specific usage for invalid arity", () => {
  expect(() => runCli(["create"])).toThrow("Usage: mt create <session>");
  expect(() => runCli(["create", "banana", "extra"])).toThrow("Usage: mt create <session>");
  expect(() => runCli(["materialize", "extra"])).toThrow("Usage: mt materialize");
  expect(() => runCli(["cleanup", "extra"])).toThrow("Usage: mt cleanup");
  expect(() => runCli(["setup", "extra"])).toThrow("Usage: mt setup");
  expect(() => runCli(["install-dependencies", "extra"])).toThrow("Usage: mt install-dependencies");
  expect(() => runCli(["skills"])).toThrow(SKILLS_USAGE);
  expect(() => runCli(["skills", "unknown"])).toThrow(SKILLS_USAGE);
  expect(() => runCli(["skills", "configure", "extra"])).toThrow(SKILLS_USAGE);
  expect(() => runCli(["work"])).toThrow(RUN_USAGE);
  expect(() => runCli(["work", "--plan", "ship it", "--prd", "issue 22"])).toThrow(RUN_USAGE);
  expect(() => runCli(["work", "positional plan", "--plan", "ship it"])).toThrow(RUN_USAGE);
  expect(() => runCli(["work", "positional plan", "--prd", "issue 22"])).toThrow(RUN_USAGE);
});

test("main entrypoint writes usage errors to stderr", () => {
  const result = spawnSync("bun", ["run", "src/index.ts", "cleanup", "extra"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("Usage: mt cleanup\n");
});
