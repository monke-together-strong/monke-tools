import { existsSync, renameSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { parseDocument, stringify } from "yaml";
import * as z from "zod";

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

function repoFixture() {
  const sandbox = makeTempDir("repo-skills");
  const repo = createRepo(path.join(sandbox, "consumer"), { "README.md": "Consumer\n" });
  const upstream = createRepo(path.join(sandbox, "upstream"), {
    "skills/first/SKILL.md": "---\nname: first\ndescription: First skill.\n---\nPinned first.\n",
    "skills/second/SKILL.md": "---\nname: second\ndescription: Second skill.\n---\nPinned second.\n"
  });
  const bin = path.join(sandbox, "bin");
  writeExecutable(
    path.join(bin, "npx"),
    `#!/bin/sh
set -eu
source="$4"
shift 4
mkdir -p .agents/skills
while [ "$1" = --skill ]; do
  if [ "$2" = '*' ]; then cp -R "$source/skills/"* .agents/skills/;
  else cp -R "$source/skills/$2" .agents/skills/; fi
  shift 2
done
`
  );
  const messages: string[] = [];
  const runtime = createTestRuntime({
    cwd: repo,
    env: {
      HOME: path.join(sandbox, "home"),
      MONKE_HOME: path.join(sandbox, "monke"),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`
    },
    onStderr() {},
    onStdout(message) {
      messages.push(message);
    }
  });
  return { bin, messages, repo, runtime, sandbox, upstream };
}

describe("repo import recipes through mt skills", () => {
  test("add pins a compact declaration, preserves YAML, and restores ignored guidance", async () => {
    const { repo, runtime, upstream } = repoFixture();
    const original = "# Keep this comment\nbootstrapCommand: 'echo setup' # Keep this too\n";
    write(repo, "monke.yml", original);
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
    const config = read(repo, "monke.yml");
    expect(config.startsWith(original)).toBeTruthy();
    expect(
      z.object({ skills: z.array(z.unknown()) }).parse(parseDocument(config).toJS()).skills
    ).toStrictEqual([
      { commit: git(upstream, ["rev-parse", "HEAD"]).trim(), skills: ["first"], source: upstream }
    ]);
    expect(read(repo, "skills/imported/first/SKILL.md")).toContain("Pinned first.");
    expect(git(repo, ["check-ignore", "skills/imported/first/SKILL.md"]).trim()).toBe(
      "skills/imported/first/SKILL.md"
    );
    expect(existsSync(path.join(repo, "skills.lock.json"))).toBeFalsy();
    await runCliAsync(["skills", "restore", "--repo"], runtime);
    expect(read(repo, ".gitignore").split("/skills/imported/")).toHaveLength(2);
  });

  test("hand edits restore new selections at their pin, reapply overrides, prune removals, and replace local edits", async () => {
    const { bin, repo, runtime, upstream } = repoFixture();
    const commit = git(upstream, ["rev-parse", "HEAD"]);
    write(
      repo,
      "monke.yml",
      stringify({ skills: [{ commit, skills: ["first"], source: upstream }] })
    );
    await runCliAsync(["skills", "restore", "--repo"], runtime);
    write(upstream, "skills/second/SKILL.md", "---\nname: second\n---\nNew upstream revision.\n");
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Advance upstream"]);
    write(
      repo,
      "monke.yml",
      stringify({
        skills: [
          {
            commit,
            modelInvocation: "deny",
            skills: [
              "first",
              { description: "Retuned description.", modelInvocation: "allow", slug: "second" }
            ],
            source: upstream
          }
        ]
      })
    );
    await runCliAsync(["skills", "restore", "--repo"], runtime);
    expect(read(repo, "skills/imported/first/SKILL.md")).toContain(
      "disable-model-invocation: true"
    );
    expect(read(repo, "skills/imported/second/SKILL.md")).toContain("Pinned second.");
    expect(read(repo, "skills/imported/second/SKILL.md")).toContain(
      "description: Retuned description."
    );
    expect(read(repo, "skills/imported/second/SKILL.md")).toContain(
      "disable-model-invocation: false"
    );
    const config = stringify({ skills: [{ commit, skills: ["second"], source: upstream }] });
    write(repo, "monke.yml", config);
    await runCliAsync(["skills", "restore", "--repo"], runtime);
    expect(existsSync(path.join(repo, "skills/imported/first"))).toBeFalsy();
    write(repo, "skills/imported/second/SKILL.md", "Edited locally.\n");
    await runCliAsync(["skills", "restore", "--repo"], runtime);
    expect(read(repo, "skills/imported/second/SKILL.md")).toContain("Pinned second.");
    renameSync(upstream, `${upstream}-offline`);
    writeExecutable(path.join(bin, "npx"), "#!/bin/sh\nexit 42\n");
    await runCliAsync(["skills", "restore", "--repo"], runtime);
    expect(read(repo, "monke.yml")).toBe(config);
  });

  test("restore refuses an unpinned entry and update pins it with one comparison", async () => {
    const { bin, repo, runtime, upstream } = repoFixture();
    const reviewLog = installFakeCodiff(bin);
    installFakeCodexSummary(bin);
    write(repo, "monke.yml", stringify({ skills: [{ skills: ["first"], source: upstream }] }));
    await expect(runCliAsync(["skills", "restore", "--repo"], runtime)).rejects.toThrow(
      "mt skills update --repo"
    );
    await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);
    expect(read(repo, "monke.yml")).toContain(git(upstream, ["rev-parse", "HEAD"]));
    expect(read(repo, "skills/imported/first/SKILL.md")).toContain("Pinned first.");
    expect(read(repo, path.relative(repo, reviewLog))).toContain("--commit");
  });

  test("reference imports and policy and remove commands update the repo declaration", async () => {
    const { repo, runtime, upstream } = repoFixture();
    await runCliAsync(["skills", "add", upstream, "--repo", "--ref", "--skill", "first"], runtime);
    expect(read(repo, "skills/references/imported/first/MAIN.md")).toBe("Pinned first.\n");
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first", "second"], runtime);
    await runCliAsync(
      [
        "skills",
        "policy",
        upstream,
        "second",
        "--repo",
        "--description",
        "New trigger.",
        "--model-invocation",
        "deny"
      ],
      runtime
    );
    expect(read(repo, "skills/imported/second/SKILL.md")).toContain("description: New trigger.");
    expect(read(repo, "monke.yml")).toContain("modelInvocation: deny");
    await runCliAsync(["skills", "remove", upstream, "--repo"], runtime);
    expect(existsSync(path.join(repo, "skills/imported/second"))).toBeFalsy();
    expect(read(repo, "monke.yml")).toContain("skills: []");
  });

  test("update prepares Git sources concurrently and prunes guidance removed by hand", async () => {
    const { bin, repo, runtime, sandbox, upstream } = repoFixture();
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
    const sources = Array.from({ length: 5 }, (_, index) => {
      const slug = `concurrent-${index}`;
      const source = createRepo(path.join(sandbox, slug), {
        [`skills/${slug}/SKILL.md`]: `---\nname: ${slug}\ndescription: Concurrent skill.\n---\n${slug}.\n`
      });
      return { skills: [slug], source };
    });
    write(repo, "monke.yml", stringify({ skills: sources }));
    writeExecutable(
      path.join(bin, "npx"),
      `#!${process.execPath}
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const slug = args[args.indexOf("--skill") + 1];
const index = Number(slug.split("-")[1]);
const barrier = ${JSON.stringify(sandbox)};
writeFileSync(path.join(barrier, "entered-" + index), "");
if (index < 4) {
  const deadline = Date.now() + 5000;
  while (![0, 1, 2, 3].every((item) => existsSync(path.join(barrier, "entered-" + item)))) {
    if (Date.now() > deadline) throw new Error("Git source preparation did not overlap");
    await Bun.sleep(10);
  }
}
mkdirSync(".agents/skills", { recursive: true });
cpSync(path.join(args[3], "skills", slug), path.join(".agents/skills", slug), { recursive: true });
`
    );
    const reviewLog = installFakeCodiff(bin);
    installFakeCodexSummary(bin);
    await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);
    expect(existsSync(path.join(repo, "skills/imported/first"))).toBeFalsy();
    for (const {
      skills: [slug]
    } of sources) {
      expect(read(repo, `skills/imported/${slug}/SKILL.md`)).toContain(`${slug}.`);
    }
    expect(read(repo, path.relative(repo, reviewLog)).split("--commit")).toHaveLength(2);
  });

  test("update advances successful sources, retains failed pins, and opens one complete review", async () => {
    const { bin, messages, repo, runtime, sandbox, upstream } = repoFixture();
    const other = createRepo(path.join(sandbox, "other"), {
      "skills/other/SKILL.md": "---\nname: other\ndescription: Other skill.\n---\nOther content.\n"
    });
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
    await runCliAsync(["skills", "add", other, "--repo", "--skill", "other"], runtime);
    await runCliAsync(
      ["skills", "policy", upstream, "--repo", "--model-invocation", "deny"],
      runtime
    );
    const previousPin = git(other, ["rev-parse", "HEAD"]);
    renameSync(other, `${other}-unavailable`);
    write(
      upstream,
      "skills/first/SKILL.md",
      "---\nname: first\ndescription: First skill.\n---\nAdvanced first.\n"
    );
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Advance successful source"]);
    const reviewLog = installFakeCodiff(bin);
    installFakeCodexSummary(bin);
    await expect(
      runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime)
    ).rejects.toThrow(other);
    expect(read(repo, "monke.yml")).toContain(git(upstream, ["rev-parse", "HEAD"]));
    expect(read(repo, "monke.yml")).toContain(previousPin);
    expect(read(repo, "skills/imported/first/SKILL.md")).toContain("Advanced first.");
    expect(read(repo, "skills/imported/other/SKILL.md")).toContain("Other content.");
    expect(read(repo, path.relative(repo, reviewLog)).split("--commit")).toHaveLength(2);
    expect(messages.join("")).toContain("# Skill update summary");
  });
});
