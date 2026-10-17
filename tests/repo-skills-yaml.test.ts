import { existsSync, linkSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { parseDocument } from "yaml";

import { runCliAsync } from "../src/index.ts";
import {
  createRepo,
  git,
  installFakeCodexSummary,
  installFakeCodiff,
  makeTempDir,
  read,
  write,
  writeExecutable
} from "./helpers.ts";
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
source="$4"
shift 4
while [ "$1" = --skill ]; do
  if [ "$2" = '*' ]; then cp -R "$source/skills/"* .agents/skills/;
  else cp -R "$source/skills/$2" .agents/skills/; fi
  shift 2
done
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

  return { bin, recipe, repo, runtime, sandbox, upstream };
}

describe("repo skill edits preserve unrelated YAML bytes", () => {
  it.each([false, true])(
    "rejects a slug shared by skills and references on repo add with reference first=%s",
    async (referenceFirst) => {
      const { repo, runtime, sandbox, upstream } = fixture();

      const other = createRepo(path.join(sandbox, "other"), {
        "skills/example/SKILL.md":
          "---\nname: example\ndescription: Other skill.\n---\nOther source.\n"
      });

      await runCliAsync(
        [
          "skills",
          "add",
          upstream,
          "--repo",
          "--skill",
          "example",
          ...(referenceFirst ? ["--ref"] : [])
        ],
        runtime
      );
      const config = read(repo, "monke.yml");
      const marker = read(repo, "skills/.monke-restored.json");

      const acceptedPath = referenceFirst
        ? "skills/references/imported/example/MAIN.md"
        : "skills/imported/example/SKILL.md";

      const rejectedPath = referenceFirst
        ? "skills/imported/example"
        : "skills/references/imported/example";

      const accepted = read(repo, acceptedPath);

      await expect(
        runCliAsync(
          [
            "skills",
            "add",
            other,
            "--repo",
            "--skill",
            "example",
            ...(referenceFirst ? [] : ["--ref"])
          ],
          runtime
        )
      ).rejects.toThrow(/slug example/u);

      expect(read(repo, "monke.yml")).toBe(config);
      expect(read(repo, "skills/.monke-restored.json")).toBe(marker);
      expect(read(repo, acceptedPath)).toBe(accepted);
      expect(existsSync(path.join(repo, rejectedPath))).toBeFalsy();
    }
  );

  it.each(["restore", "update"])(
    "rejects handwritten mixed-kind slug ownership on repo %s before changing restored state",
    async (action) => {
      const { bin, recipe, repo, runtime, sandbox, upstream } = fixture();

      const other = createRepo(path.join(sandbox, "other"), {
        "skills/Example/SKILL.md":
          "---\nname: Example\ndescription: Other skill.\n---\nOther source.\n"
      });

      await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "example"], runtime);
      const marker = read(repo, "skills/.monke-restored.json");
      const accepted = read(repo, "skills/imported/example/SKILL.md");

      const original = `${JSON.stringify({
        skills: [
          recipe,
          {
            commit: git(other, ["rev-parse", "HEAD"]),
            skills: [{ kind: "reference", selector: "Example", slug: "example" }],
            source: other
          }
        ]
      })}\n`;

      write(repo, "monke.yml", original);
      writeExecutable(
        path.join(bin, "npx"),
        `#!/bin/sh
set -eu
mkdir -p .agents/skills
source="$4"
shift 4
while [ "$1" = --skill ]; do
  if [ "$2" = '*' ]; then
    for skill in "$source/skills/"*; do
      destination="$(basename "$skill")"
      if [ "$destination" = Example ]; then destination=example; fi
      cp -R "$skill" ".agents/skills/$destination"
    done
  else
    destination="$2"
    if [ "$2" = Example ]; then destination=example; fi
    cp -R "$source/skills/$2" ".agents/skills/$destination"
  fi
  shift 2
done
`
      );
      const ignore = read(repo, ".gitignore");
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);

      await expect(
        runCliAsync(
          ["skills", action, "--repo", ...(action === "update" ? ["--adapter", "codiff"] : [])],
          runtime
        )
      ).rejects.toThrow(/slug example/u);

      expect(read(repo, "monke.yml")).toBe(original);
      expect(read(repo, ".gitignore")).toBe(ignore);
      expect(read(repo, "skills/.monke-restored.json")).toBe(marker);
      expect(read(repo, "skills/imported/example/SKILL.md")).toBe(accepted);
      expect(existsSync(path.join(repo, "skills/references/imported/example"))).toBeFalsy();
    }
  );

  it("resolves shared commit and source aliases for restore, list, and update", async () => {
    const { bin, repo, runtime, sandbox, upstream } = fixture();
    write(
      upstream,
      "skills/other/SKILL.md",
      "---\nname: other\ndescription: Other.\n---\nOther.\n"
    );
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Add another selection"]);
    const copy = path.join(sandbox, "upstream-copy");
    git(sandbox, ["clone", "--quiet", "--", upstream, copy]);
    const original = `# Shared values\napps:\n  upstream:\n    path: &source ${upstream}\nskills:\n  - source: *source\n    commit: &pin ${git(upstream, ["rev-parse", "HEAD"])}\n    skills: [example]\n  - source: ${copy}\n    commit: *pin\n    skills: [other]\n# Keep the tail.\n`;
    write(repo, "monke.yml", original);
    await runCliAsync(["skills", "restore", "--repo"], runtime);
    await runCliAsync(["skills", "list", "--repo"], runtime);
    expect(read(repo, "monke.yml")).toBe(original);
    expect(read(repo, "skills/imported/example/SKILL.md")).toContain("Example.");
    expect(read(repo, "skills/imported/other/SKILL.md")).toContain("Other.");
    installFakeCodiff(bin);
    installFakeCodexSummary(bin);
    await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);
    const updated = read(repo, "monke.yml");
    expect(updated.startsWith(original.slice(0, original.indexOf("skills:")))).toBeTruthy();
    expect(updated.endsWith("# Keep the tail.\n")).toBeTruthy();
    expect(parseDocument(updated).toJS()).toMatchObject({
      skills: [
        { commit: git(upstream, ["rev-parse", "HEAD"]) },
        { commit: git(upstream, ["rev-parse", "HEAD"]) }
      ]
    });
  });

  describe.each([
    { prefix: "", state: "unresolved" },
    { prefix: 'cleanupCommand: &command "echo cleanup"\n', state: "rebound" }
  ])("$state aliases outside skills", ({ prefix }) => {
    it.each(["add", "policy", "remove", "update"])(
      "refuses on %s to change an anchor referenced outside skills",
      async (action) => {
        const { bin, recipe, repo, runtime, upstream } = fixture();
        const original = `${prefix}skills:\n  - source: ${upstream}\n    commit: ${recipe.commit}\n    skills:\n      - slug: example\n        description: &command "echo setup"\nbootstrapCommand: *command\n`;
        write(repo, "monke.yml", original);
        await runCliAsync(["skills", "restore", "--repo"], runtime);
        const accepted = read(repo, "skills/imported/example/SKILL.md");
        const marker = read(repo, "skills/.monke-restored.json");
        write(
          upstream,
          "skills/example/SKILL.md",
          "---\nname: example\ndescription: Example.\n---\nNew body.\n"
        );
        git(upstream, ["add", "."]);
        git(upstream, ["commit", "-m", "Advance upstream"]);
        installFakeCodiff(bin);
        installFakeCodexSummary(bin);

        const args =
          action === "add"
            ? ["skills", "add", upstream, "--repo", "--skill", "example"]
            : action === "policy"
              ? ["skills", "policy", upstream, "example", "--repo", "--model-invocation", "deny"]
              : action === "remove"
                ? ["skills", "remove", upstream, "--repo"]
                : ["skills", "update", "--repo", "--adapter", "codiff"];

        await expect(runCliAsync(args, runtime)).rejects.toThrow(/YAML aliases/u);
        expect(read(repo, "monke.yml")).toBe(original);
        expect(read(repo, "skills/imported/example/SKILL.md")).toBe(accepted);
        expect(read(repo, "skills/.monke-restored.json")).toBe(marker);
        expect(parseDocument(read(repo, "monke.yml")).toJS()).toMatchObject({
          bootstrapCommand: "echo setup"
        });
      }
    );
  });

  it.each([
    { alias: "symlink", temporary: "monke.yml.tmp" },
    { alias: "hardlink", temporary: "monke.yml.tmp" },
    { alias: "symlink", temporary: "skills/.monke-restored.json.tmp" },
    { alias: "hardlink", temporary: "skills/.monke-restored.json.tmp" }
  ])(
    "leaves a $alias at $temporary and its external bytes untouched on add",
    async ({ alias, temporary }) => {
      const { recipe, repo, runtime, sandbox, upstream } = fixture();
      const external = path.join(sandbox, "external");
      write(sandbox, "external", "Unrelated external bytes.\n");
      const target = path.join(repo, temporary);
      mkdirSync(path.dirname(target), { recursive: true });

      if (alias === "hardlink") {
        linkSync(external, target);
      } else {
        symlinkSync(external, target);
      }

      await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "example"], runtime);
      expect(read(sandbox, "external")).toBe("Unrelated external bytes.\n");
      expect(read(repo, temporary)).toBe("Unrelated external bytes.\n");
      expect(parseDocument(read(repo, "monke.yml")).getIn(["skills", 0, "commit"])).toBe(
        recipe.commit
      );
      expect(read(repo, "skills/imported/example/SKILL.md")).toContain("Example.");
    }
  );

  it("appends skills on add without changing four-space indentation or quoting", async () => {
    const { repo, runtime, upstream } = fixture();

    const original =
      "# My configuration\napps:\n    web:\n        path: '.' # Keep this\nbootstrapCommand: 'echo setup'";

    write(repo, "monke.yml", original);
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "example"], runtime);
    const updated = read(repo, "monke.yml");
    expect(updated.startsWith(`${original}\n`)).toBeTruthy();
    expect(parseDocument(updated).getIn(["skills", 0, "source"])).toBe(upstream);
  });

  it("preserves indented root keys on add", async () => {
    const { repo, runtime, upstream } = fixture();
    const original = "    apps: {}\n    bootstrapCommand: 'echo setup'\n";
    write(repo, "monke.yml", original);
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "example"], runtime);
    const updated = read(repo, "monke.yml");
    expect(updated.startsWith(original)).toBeTruthy();
    expect(parseDocument(updated).errors).toStrictEqual([]);
    expect(parseDocument(updated).getIn(["skills", 0, "source"])).toBe(upstream);
  });

  it("extends a source's selection on add --ref without converting existing skills", async () => {
    const { repo, runtime, upstream } = fixture();

    write(
      upstream,
      "skills/guide/SKILL.md",
      "---\nname: guide\ndescription: Guide.\n---\nGuide.\n"
    );
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Add guide"]);
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "example"], runtime);
    await runCliAsync(["skills", "add", upstream, "--repo", "--ref", "--skill", "guide"], runtime);
    expect(parseDocument(read(repo, "monke.yml")).toJS()).toMatchObject({
      skills: [{ skills: ["example", { kind: "reference", slug: "guide" }] }]
    });
    expect(existsSync(path.join(repo, "skills/imported/example/SKILL.md"))).toBeTruthy();
    expect(existsSync(path.join(repo, "skills/references/imported/guide/MAIN.md"))).toBeTruthy();
  });

  it.each(["block", "flow", "flow root"])(
    "replaces a %s skills value on policy without changing surrounding comments and formatting",
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

  it.each([
    "{apps: {web: {path: '.'}}} # End\n",
    "{apps: {}, bootstrapCommand: 'echo setup'} # End\n",
    "{apps: {web: {path: '.'}}, # Keep trailing comma\n} # End\n",
    "{ # Empty config\n} # End\n"
  ])("appends inside a flow mapping on add: %s", async (original) => {
    const { repo, runtime, upstream } = fixture();
    write(repo, "monke.yml", original);
    const insertion = original.lastIndexOf("}");
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "example"], runtime);
    const updated = read(repo, "monke.yml");
    expect(updated.startsWith(original.slice(0, insertion))).toBeTruthy();
    expect(updated.endsWith(original.slice(insertion))).toBeTruthy();
    expect(parseDocument(updated).getIn(["skills", 0, "source"])).toBe(upstream);
  });

  it.each(["", "# Guidance only\n", "---\n# Guidance only\n...\n"])(
    "handles an empty YAML document on add: %j",
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

describe("repo skill imports stay ignored", () => {
  it.each([
    {
      entry: "/skills/imported/",
      reference: false,
      target: "skills/imported/example/SKILL.md"
    },
    {
      entry: "/skills/references/imported/",
      reference: true,
      target: "skills/references/imported/example/MAIN.md"
    },
    {
      entry: "/skills/.monke-restored.json",
      reference: false,
      target: "skills/.monke-restored.json"
    }
  ])("repairs a later negation of $entry once on add", async ({ entry, reference, target }) => {
    const { repo, runtime, upstream } = fixture();
    const original = `# Keep these bytes.\r\n${entry}\r\n!${entry}\r\n# Keep the tail.`;
    write(repo, ".gitignore", original);
    await runCliAsync(
      ["skills", "add", upstream, "--repo", "--skill", "example", ...(reference ? ["--ref"] : [])],
      runtime
    );
    expect(git(repo, ["check-ignore", "--", target])).toBe(target);
    const repaired = read(repo, ".gitignore");
    expect(repaired.startsWith(original)).toBeTruthy();
    await runCliAsync(["skills", "restore", "--repo"], runtime);
    expect(read(repo, ".gitignore")).toBe(repaired);
  });

  it.each([
    { action: "add", ignore: "skills/.gitignore", pattern: "!imported/\n", reference: false },
    {
      action: "restore",
      ignore: "skills/references/.gitignore",
      pattern: "!imported/\n",
      reference: true
    },
    {
      action: "update",
      ignore: "skills/.gitignore",
      pattern: "!.monke-restored.json\n",
      reference: false
    },
    { action: "remove", ignore: "skills/.gitignore", pattern: "!imported/\n", reference: false },
    {
      action: "policy",
      ignore: "skills/.gitignore",
      pattern: "!imported/\n",
      reference: false
    }
  ])(
    "refuses conflicting nested $ignore rules on $action before accepted state changes",
    async ({ action, ignore, pattern, reference }) => {
      const { bin, repo, runtime, upstream } = fixture();
      await runCliAsync(
        [
          "skills",
          "add",
          upstream,
          "--repo",
          "--skill",
          "example",
          ...(reference ? ["--ref"] : [])
        ],
        runtime
      );

      const guidance = reference
        ? "skills/references/imported/example/MAIN.md"
        : "skills/imported/example/SKILL.md";

      const accepted = read(repo, guidance);
      const config = read(repo, "monke.yml");
      const marker = read(repo, "skills/.monke-restored.json");
      const originalIgnore = read(repo, ".gitignore");
      write(repo, ignore, pattern);
      write(
        upstream,
        "skills/example/SKILL.md",
        "---\nname: example\ndescription: Example.\n---\nNew upstream body.\n"
      );
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Advance upstream"]);
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);

      const args =
        action === "add"
          ? [
              "skills",
              "add",
              upstream,
              "--repo",
              "--skill",
              "example",
              ...(reference ? ["--ref"] : [])
            ]
          : action === "policy"
            ? ["skills", "policy", upstream, "example", "--repo", "--description", "New trigger."]
            : action === "remove"
              ? ["skills", "remove", upstream, "--repo"]
              : [
                  "skills",
                  action,
                  "--repo",
                  ...(action === "update" ? ["--adapter", "codiff"] : [])
                ];

      await expect(runCliAsync(args, runtime)).rejects.toThrow(/conflicting.*\.gitignore/u);
      expect(read(repo, ".gitignore")).toBe(originalIgnore);
      expect(read(repo, ignore)).toBe(pattern);
      expect(read(repo, "monke.yml")).toBe(config);
      expect(read(repo, guidance)).toBe(accepted);
      expect(read(repo, "skills/.monke-restored.json")).toBe(marker);
    }
  );
});
