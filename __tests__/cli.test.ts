import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { runCli } from "../src/index.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

describe("CLI", () => {
  test("runCli enforces cleanup option relationships", () => {
    expect(() => {
      runCli(["cleanup", "--dry-run"]);
    }).toThrow("error: option '--dry-run' cannot be used without option '--merged'");
  });

  test("Chop accepts at most one target", () => {
    expect(() => {
      runCli(["chop", "first", "second"]);
    }).toThrow(/too many arguments/u);
  });

  test.each([
    ["root", [], "Usage: mt [options] [command]"],
    ["nested", ["shell"], "Usage: mt shell [options] [command]"]
  ])("main CLI shows %s command help when no command is selected", (_name, args, usage) => {
    const result = spawnSync("bun", ["run", "src/index.ts", ...args], {
      cwd: projectRoot,
      encoding: "utf-8"
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(usage);
  });

  test.each([
    ["main", "src/index.ts", ["cleanup", "extra"]],
    ["skill import", "scripts/import-skills.ts", []],
    ["skill update", "scripts/update-skills.ts", ["extra"]]
  ])("%s CLI reports one concise process failure", (_name, script, args) => {
    const result = spawnSync("bun", ["run", script, ...args], {
      cwd: projectRoot,
      encoding: "utf-8"
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^error: [^\n]+\n$/u);
  });

  test.each([
    ["main", "src/index.ts", ["--help"], "Usage: mt [options] [command]"],
    ["main nested", "src/index.ts", ["help", "shell"], "Usage: mt shell [options] [command]"],
    ["skill import", "scripts/import-skills.ts", ["--help"], "Usage: bun run skills:import"],
    ["skill update", "scripts/update-skills.ts", ["--help"], "Usage: bun run skills:update"]
  ])("%s CLI help is successful", (_name, script, args, usage) => {
    const result = spawnSync("bun", ["run", script, ...args], {
      cwd: projectRoot,
      encoding: "utf-8"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(usage);
    expect(result.stderr).toBe("");
  });

  test("Chop help documents force and ignored-file disposal", () => {
    const result = spawnSync("bun", ["run", "src/index.ts", "chop", "--help"], {
      cwd: projectRoot,
      encoding: "utf-8"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: mt chop [options] [target]");
    expect(result.stdout).toContain("--force");
    expect(result.stdout).toMatch(/ignored files are\s+always deleted/u);
    expect(result.stderr).toBe("");
  });
});
