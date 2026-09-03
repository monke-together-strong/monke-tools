import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { runCliAsync } from "../src/index.ts";
import { makeTempDir } from "./helpers.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

describe("CLI", () => {
  test("Home prints the default Monke home", () => {
    const env = { ...process.env };
    delete env.MONKE_HOME;

    const result = spawnSync("bun", ["run", "src/index.ts", "home"], {
      cwd: projectRoot,
      encoding: "utf-8",
      env
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${path.join(homedir(), ".monke")}\n`);
    expect(result.stderr).toBe("");
  });

  test("Home prints the configured Monke home without creating it", () => {
    const home = path.join(makeTempDir("cli-home"), "custom-monke-home");
    const result = spawnSync("bun", ["run", "src/index.ts", "home"], {
      cwd: projectRoot,
      encoding: "utf-8",
      env: { ...process.env, MONKE_HOME: home }
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${home}\n`);
    expect(result.stderr).toBe("");
    expect(existsSync(home)).toBeFalsy();
  });

  test("Home resolves a relative MONKE_HOME against the current directory", () => {
    const result = spawnSync("bun", ["run", "src/index.ts", "home"], {
      cwd: projectRoot,
      encoding: "utf-8",
      env: { ...process.env, MONKE_HOME: ".custom-monke-home" }
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${path.join(projectRoot, ".custom-monke-home")}\n`);
    expect(result.stderr).toBe("");
  });

  test("the CLI enforces cleanup option relationships", async () => {
    await expect(runCliAsync(["cleanup", "--dry-run"])).rejects.toThrow(
      "error: option '--dry-run' cannot be used without option '--merged'"
    );
  });

  test("Chop accepts at most one target", async () => {
    await expect(runCliAsync(["chop", "first", "second"])).rejects.toThrow(/too many arguments/u);
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
