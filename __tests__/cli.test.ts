import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/index.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const ROOT_USAGE =
  "Usage:\n  mt spawn <session> [--no-dirty] [-m|--main|--master]\n  mt swing [target] [--codex]\n  mt materialize\n  mt cleanup [--merged] [--dry-run]\n  mt setup\n  mt shell install\n  mt shell init <bash|zsh>\n  mt skills configure";
const SPAWN_USAGE = "Usage: mt spawn <session> [--no-dirty] [-m|--main|--master]";
const SWING_USAGE = "Usage: mt swing [target] [--codex]";
const CLEANUP_USAGE = "Usage: mt cleanup [--merged] [--dry-run]";
const SKILLS_USAGE = "Usage: mt skills configure";
const SKILLS_LOCAL_INSTALL_USAGE = "Usage: mt skills local-install <source-checkout>";
const SHELL_USAGE = "Usage:\n  mt shell install\n  mt shell init <bash|zsh>";

test("runCli preserves top-level usage for missing and unknown commands", () => {
  expect(() => runCli([])).toThrow(ROOT_USAGE);
  expect(() => runCli(["unknown"])).toThrow(ROOT_USAGE);
  expect(() => runCli(["create", "banana"])).toThrow(ROOT_USAGE);
});

test("runCli preserves command-specific usage for invalid arity", () => {
  expect(() => runCli(["spawn"])).toThrow(SPAWN_USAGE);
  expect(() => runCli(["spawn", "banana", "extra"])).toThrow(SPAWN_USAGE);
  expect(() => runCli(["swing", "banana", "extra"])).toThrow(SWING_USAGE);
  expect(() => runCli(["materialize", "extra"])).toThrow("Usage: mt materialize");
  expect(() => runCli(["cleanup", "extra"])).toThrow(CLEANUP_USAGE);
  expect(() => runCli(["cleanup", "--dry-run"])).toThrow(CLEANUP_USAGE);
  expect(() => runCli(["setup", "extra"])).toThrow("Usage: mt setup");
  expect(() => runCli(["install-dependencies", "extra"])).toThrow("Usage: mt install-dependencies");
  expect(() => runCli(["shell"])).toThrow(SHELL_USAGE);
  expect(() => runCli(["shell", "unknown"])).toThrow(SHELL_USAGE);
  expect(() => runCli(["shell", "install", "extra"])).toThrow(SHELL_USAGE);
  expect(() => runCli(["shell", "init"])).toThrow(SHELL_USAGE);
  expect(() => runCli(["shell", "init", "fish"])).toThrow("Usage: mt shell init <bash|zsh>");
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
