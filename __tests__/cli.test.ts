import { describe, expect, test } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/index.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

describe("CLI", () => {
  test("runCli enforces cleanup option relationships", () => {
    expect(() => {
      runCli(["cleanup", "--dry-run"]);
    }).toThrow("error: option '--dry-run' cannot be used without option '--merged'");
  });

  test.each([
    ["main", "src/index.ts", ["cleanup", "extra"]],
    ["skill import", "scripts/import-skills.ts", []],
    ["skill update", "scripts/update-skills.ts", ["extra"]],
  ])("%s CLI reports one concise process failure", (_name, script, args) => {
    const result = spawnSync("bun", ["run", script, ...args], {
      cwd: projectRoot,
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^error: [^\n]+\n$/u);
  });

  test.each([
    ["skill import", "scripts/import-skills.ts", "Usage: bun run skills:import"],
    ["skill update", "scripts/update-skills.ts", "Usage: bun run skills:update"],
  ])("%s CLI help is successful", (_name, script, usage) => {
    const result = spawnSync("bun", ["run", script, "--help"], {
      cwd: projectRoot,
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(usage);
    expect(result.stderr).toBe("");
  });
});
