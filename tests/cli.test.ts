import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { runCliAsync } from "../src/index.ts";
import { makeTempDir } from "./helpers.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

describe("CLI", () => {
  it("prints the default Monke home for mt home", () => {
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

  it("prints the configured Monke home for mt home without creating it", () => {
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

  it("resolves a relative MONKE_HOME against the current directory for mt home", () => {
    const result = spawnSync("bun", ["run", "src/index.ts", "home"], {
      cwd: projectRoot,
      encoding: "utf-8",
      env: { ...process.env, MONKE_HOME: ".custom-monke-home" }
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${path.join(projectRoot, ".custom-monke-home")}\n`);
    expect(result.stderr).toBe("");
  });

  it("accepts at most one target for Chop", async () => {
    await expect(runCliAsync(["chop", "first", "second"])).rejects.toThrow(/too many arguments/u);
  });

  it.each([
    ["root", [], "Usage: mt [options] [command]"],
    ["nested", ["shell"], "Usage: mt shell [options] [command]"]
  ])("shows %s command help for the main CLI when no command is selected", (_name, args, usage) => {
    const result = spawnSync("bun", ["run", "src/index.ts", ...args], {
      cwd: projectRoot,
      encoding: "utf-8"
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(usage);
  });

  it.each([
    ["main", "src/index.ts", ["chop", "first", "second"]],
    ["skill import", "src/index.ts", ["skills", "add", "unexpected", "extra"]],
    ["skill update", "src/index.ts", ["skills", "update", "extra"]]
  ])("reports one concise process failure for the %s CLI", (_name, script, args) => {
    const result = spawnSync("bun", ["run", script, ...args], {
      cwd: projectRoot,
      encoding: "utf-8"
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^error: [^\n]+\n$/u);
  });

  it.each([
    ["main", "src/index.ts", ["--help"], "Usage: mt [options] [command]"],
    ["main nested", "src/index.ts", ["help", "shell"], "Usage: mt shell [options] [command]"],
    ["skill import", "src/index.ts", ["skills", "add", "--help"], "Usage: mt skills add"],
    ["skill update", "src/index.ts", ["skills", "update", "--help"], "Usage: mt skills update"]
  ])("succeeds for %s CLI help", (_name, script, args, usage) => {
    const result = spawnSync("bun", ["run", script, ...args], {
      cwd: projectRoot,
      encoding: "utf-8"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(usage);
    expect(result.stderr).toBe("");
  });

  it("documents force, ignored-file disposal, and explicit recovery in Chop help", () => {
    const result = spawnSync("bun", ["run", "src/index.ts", "chop", "--help"], {
      cwd: projectRoot,
      encoding: "utf-8"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: mt chop [options] [target]");
    expect(result.stdout).toContain("--force");
    expect(result.stdout.replaceAll(/\s+/gu, " ")).toContain("ignored files are always deleted");
    expect(result.stdout).toContain("--cleanup-from-source");
    expect(result.stderr).toBe("");
  });
});
