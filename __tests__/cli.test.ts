import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/index.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const ROOT_USAGE =
  "Usage:\n  mt create <session> [-m|--main|--master]\n  mt materialize\n  mt cleanup [--merged] [--dry-run]\n  mt setup\n  mt skills configure";
const CREATE_USAGE = "Usage: mt create <session> [-m|--main|--master]";
const CLEANUP_USAGE = "Usage: mt cleanup [--merged] [--dry-run]";
const SKILLS_USAGE = "Usage: mt skills configure";
const SKILLS_LOCAL_INSTALL_USAGE = "Usage: mt skills local-install <source-checkout>";

test("runCli preserves top-level usage for missing and unknown commands", () => {
  expect(() => runCli([])).toThrow(ROOT_USAGE);
  expect(() => runCli(["unknown"])).toThrow(ROOT_USAGE);
});

test("runCli preserves command-specific usage for invalid arity", () => {
  expect(() => runCli(["create"])).toThrow(CREATE_USAGE);
  expect(() => runCli(["create", "banana", "extra"])).toThrow(CREATE_USAGE);
  expect(() => runCli(["materialize", "extra"])).toThrow("Usage: mt materialize");
  expect(() => runCli(["cleanup", "extra"])).toThrow(CLEANUP_USAGE);
  expect(() => runCli(["cleanup", "--dry-run"])).toThrow(CLEANUP_USAGE);
  expect(() => runCli(["setup", "extra"])).toThrow("Usage: mt setup");
  expect(() => runCli(["install-dependencies", "extra"])).toThrow("Usage: mt install-dependencies");
  expect(() => runCli(["skills"])).toThrow(SKILLS_USAGE);
  expect(() => runCli(["skills", "unknown"])).toThrow(SKILLS_USAGE);
  expect(() => runCli(["skills", "configure", "extra"])).toThrow(SKILLS_USAGE);
  expect(() => runCli(["skills", "local-install"])).toThrow(SKILLS_LOCAL_INSTALL_USAGE);
  expect(() => runCli(["skills", "local-install", "/tmp/source", "extra"])).toThrow(
    SKILLS_LOCAL_INSTALL_USAGE,
  );
});

test("main entrypoint writes usage errors to stderr", () => {
  const result = spawnSync("bun", ["run", "src/index.ts", "cleanup", "extra"], {
    cwd: projectRoot,
    encoding: "utf8",
  });

  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(`${CLEANUP_USAGE}\n`);
});
