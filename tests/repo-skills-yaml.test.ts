import path from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { parseDocument } from "yaml";

import { runCliAsync } from "../src/index.ts";
import { createRepo, git, makeTempDir, read, write, writeExecutable } from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

function fixture() {
  const sandbox = makeTempDir("repo-skills-yaml");
  const repo = createRepo(path.join(sandbox, "consumer"), { "README.md": "Consumer\n" });
  const upstream = createRepo(path.join(sandbox, "upstream"), {
    "skills/example/SKILL.md": "---\nname: example\ndescription: Example skill.\n---\nExample.\n"
  });
  const bin = path.join(sandbox, "bin");
  writeExecutable(
    path.join(bin, "npx"),
    `#!/bin/sh
set -eu
mkdir -p .agents/skills
cp -R "$4/skills/example" .agents/skills/
`
  );
  const runtime = createTestRuntime({
    cwd: repo,
    env: {
      HOME: path.join(sandbox, "home"),
      MONKE_HOME: path.join(sandbox, "monke"),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`
    },
    onStderr() {},
    onStdout() {}
  });
  const recipe = {
    commit: git(upstream, ["rev-parse", "HEAD"]).trim(),
    skills: ["example"],
    source: upstream
  };
  return { recipe, repo, runtime, upstream };
}

describe("repo skill edits preserve unrelated YAML bytes", () => {
  test("add appends skills without changing four-space indentation or quoting", async () => {
    const { repo, runtime, upstream } = fixture();
    const original =
      "# My configuration\napps:\n    web:\n        path: '.' # Keep this\nbootstrapCommand: 'echo setup'";
    write(repo, "monke.yml", original);
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "example"], runtime);
    const updated = read(repo, "monke.yml");
    expect(updated.startsWith(`${original}\n`)).toBeTruthy();
    expect(parseDocument(updated).getIn(["skills", 0, "source"])).toBe(upstream);
  });

  test.each(["block", "flow", "flow root"])(
    "policy replaces a %s skills value without changing surrounding comments and formatting",
    async (style) => {
      const { recipe, repo, runtime, upstream } = fixture();
      const block = style === "block";
      const flowRoot = style === "flow root";
      const prefix = flowRoot
        ? "{ apps: { web: { path: '.' } }, \"skills\": "
        : `# Header\napps:\n    web:\n        path: '.'\n\n"skills":${block ? " # Selected guidance\n    " : "  "}`;
      const value = block
        ? `- source: ${recipe.source}\n      commit: ${recipe.commit}\n      skills: [example]\n`
        : JSON.stringify([recipe]);
      const suffix = flowRoot
        ? ", cleanupCommand: 'echo cleanup' } # End\n"
        : `${block ? "\n" : " # Selected guidance\n\n"}# After skills\ncleanupCommand: 'echo cleanup' # End\n`;
      write(repo, "monke.yml", `${prefix}${value}${suffix}`);
      await runCliAsync(
        ["skills", "policy", upstream, "example", "--repo", "--description", "Updated trigger."],
        runtime
      );
      const updated = read(repo, "monke.yml");
      expect(updated.startsWith(prefix)).toBeTruthy();
      expect(updated.endsWith(suffix)).toBeTruthy();
      expect(parseDocument(updated).getIn(["skills", 0, "skills", 0, "description"])).toBe(
        "Updated trigger."
      );
      expect(read(repo, "skills/imported/example/SKILL.md")).toContain("Updated trigger.");
    }
  );

  test.each([
    "{apps: {web: {path: '.'}}} # End\n",
    "{apps: {}, bootstrapCommand: 'echo setup'} # End\n",
    "{apps: {web: {path: '.'}}, # Keep trailing comma\n} # End\n",
    "{ # Empty config\n} # End\n"
  ])("add appends inside a flow mapping: %s", async (original) => {
    const { repo, runtime, upstream } = fixture();
    write(repo, "monke.yml", original);
    const insertion = original.lastIndexOf("}");
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "example"], runtime);
    const updated = read(repo, "monke.yml");
    expect(updated.startsWith(original.slice(0, insertion))).toBeTruthy();
    expect(updated.endsWith(original.slice(insertion))).toBeTruthy();
    expect(parseDocument(updated).getIn(["skills", 0, "source"])).toBe(upstream);
  });

  test.each(["", "# Guidance only\n", "---\n# Guidance only\n...\n"])(
    "add handles an empty YAML document: %j",
    async (original) => {
      const { repo, runtime, upstream } = fixture();
      write(repo, "monke.yml", original);
      await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "example"], runtime);
      const updated = read(repo, "monke.yml");
      const beforeEndMarker = original.replace(/\.\.\.\n$/u, "");
      expect(updated.startsWith(beforeEndMarker)).toBeTruthy();
      expect(parseDocument(updated).getIn(["skills", 0, "source"])).toBe(upstream);
    }
  );
});
