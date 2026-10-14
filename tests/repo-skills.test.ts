import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { describe, expect, test } from "vite-plus/test";
import { parseDocument, stringify } from "yaml";
import * as z from "zod";

import {
  readRepoImportRecipeStore,
  writeRepoImportRecipeStore
} from "../scripts/skill-import-recipes.ts";
import { runCliAsync } from "../src/index.ts";
import {
  createRepo,
  git,
  installFakeCodexSummary,
  installFakeCodiff,
  installInternalRootImporter,
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

function installPartialSuccessImporter(bin: string) {
  writeExecutable(
    path.join(bin, "npx"),
    `#!/usr/bin/env bun
import { cpSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
const source = process.argv[5];
const selectors = [];
for (let index = 6; process.argv[index] === "--skill"; index += 2) selectors.push(process.argv[index + 1]);
let installed = 0;
for (const folder of readdirSync(path.join(source, "skills"))) {
  const directory = path.join(source, "skills", folder);
  const content = readFileSync(path.join(directory, "SKILL.md"), "utf8");
  const name = /^name: (.+)$/m.exec(content)[1];
  if (!selectors.includes("*") && !selectors.some(selector => selector.toLowerCase() === name.toLowerCase())) continue;
  const slug = name.toLowerCase().replace(/[^a-z0-9._]+/g, "-").replace(/^[.\\-]+|[.\\-]+$/g, "").substring(0, 255) || "unnamed-skill";
  const destination = path.join(".agents", "skills", slug);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(directory, destination, { recursive: true });
  installed += 1;
}
if (installed === 0) throw new Error("No matching skills: " + selectors.join(", "));
`
  );
}

function installEmptyPublisherImporter(
  bin: string,
  failure = {
    exitCode: 1,
    results: [
      {
        error: "No valid skills found. Skills require a SKILL.md with name and description.",
        status: "failed"
      }
    ]
  }
) {
  writeExecutable(
    path.join(bin, "npx"),
    `#!/bin/sh
set -eu
if [ -f "$4/fixtures/example/SKILL.md" ]; then
  printf '%s\\n' '${JSON.stringify(failure.results)}'
  exit ${failure.exitCode}
fi
mkdir -p .agents/skills
cp -R "$4/skills/first" .agents/skills/first
`
  );
}

describe("repo import recipes through mt skills", () => {
  test("repo add rejects a name that normalizes to an empty selector before publication", async () => {
    const { bin, repo, runtime, sandbox, upstream } = repoFixture();
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
    const config = read(repo, "monke.yml");
    const marker = read(repo, "skills/.monke-restored.json");
    const first = read(repo, "skills/imported/first/SKILL.md");
    const invalid = createRepo(path.join(sandbox, "empty-name"), {
      "skills/Fancy Folder/SKILL.md": `---\n${stringify({ description: "Author trigger.", name: " \u001B[31m\u001B[0m " })}---\nUnusable name.\n`
    });
    writeExecutable(
      path.join(bin, "npx"),
      `#!/bin/sh
set -eu
mkdir -p .agents/skills
cp -R "$4/skills/Fancy Folder" .agents/skills/fancy-folder
`
    );
    await expect(runCliAsync(["skills", "add", invalid, "--repo"], runtime)).rejects.toThrow(
      /name.*empty selector/iu
    );
    expect(read(repo, "monke.yml")).toBe(config);
    expect(read(repo, "skills/.monke-restored.json")).toBe(marker);
    expect(read(repo, "skills/imported/first/SKILL.md")).toBe(first);
    expect(existsSync(path.join(repo, "skills/imported/fancy-folder"))).toBeFalsy();
  });

  test.each([
    { action: "add", selectors: ["first"] },
    { action: "add", selectors: ["*"] },
    { action: "update", selectors: ["first"] },
    { action: "readd", selectors: ["first"] }
  ])(
    "$action accepts a declared selection $selectors after upstream discovers no authored skills",
    async ({ action, selectors }) => {
      const { bin, repo, runtime, sandbox, upstream } = repoFixture();
      installEmptyPublisherImporter(bin);
      const declaration = stringify({
        skills: [
          { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["first"], source: upstream }
        ]
      });
      const publisher = createRepo(
        path.join(sandbox, "empty-publisher"),
        action === "add"
          ? { "fixtures/example/SKILL.md": "Example document.\n", "monke.yml": declaration }
          : {
              "skills/first/SKILL.md":
                "---\nname: first\ndescription: First skill.\n---\nOwned first.\n"
            }
      );
      const source = `${publisher}#HEAD`;
      if (action !== "add") {
        await runCliAsync(["skills", "add", source, "--project", "--skill", ...selectors], runtime);
        rmSync(path.join(publisher, "skills/first"), { recursive: true });
        write(publisher, "monke.yml", declaration);
        write(publisher, "fixtures/example/SKILL.md", "Example document.\n");
        git(publisher, ["add", "-A"]);
        git(publisher, ["commit", "-m", "Replace owned skill with declaration"]);
      }
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);
      await runCliAsync(
        action === "update"
          ? ["skills", "update", "--project", "--adapter", "codiff"]
          : [
              "skills",
              "add",
              source,
              "--project",
              ...(action === "add" ? ["--skill", ...selectors] : [])
            ],
        runtime
      );
      expect(read(repo, ".agents/skills/monke-tools/imported/first/SKILL.md")).toContain(
        "Pinned first."
      );
      expect(
        JSON.parse(read(repo, ".git/monke-tools/skill-registry/skills.lock.json"))
      ).toMatchObject({
        recipes: [{ commit: git(publisher, ["rev-parse", "HEAD"]), skills: ["first"] }]
      });
    }
  );

  test.each([
    {
      exitCode: 1,
      label: "unrelated error",
      results: [{ error: "Importer transport failed", status: "failed" }]
    },
    {
      exitCode: 42,
      label: "different exit code",
      results: [
        {
          error: "No valid skills found. Skills require a SKILL.md with name and description.",
          status: "failed"
        }
      ]
    },
    {
      exitCode: 1,
      label: "multiple failures",
      results: [
        {
          error: "No valid skills found. Skills require a SKILL.md with name and description.",
          status: "failed"
        },
        { error: "Importer transport failed", status: "failed" }
      ]
    }
  ])("declared imports preserve the importer's $label", async ({ exitCode, results }) => {
    const { bin, repo, runtime, sandbox, upstream } = repoFixture();
    installEmptyPublisherImporter(bin, { exitCode, results });
    const publisher = createRepo(path.join(sandbox, "failing-publisher"), {
      "fixtures/example/SKILL.md": "Example document.\n",
      "monke.yml": stringify({
        skills: [
          { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["first"], source: upstream }
        ]
      })
    });
    await expect(
      runCliAsync(["skills", "add", `${publisher}#HEAD`, "--project", "--skill", "first"], runtime)
    ).rejects.toThrow(/No valid skills|Importer transport failed/u);
    expect(
      JSON.parse(read(repo, ".git/monke-tools/skill-registry/skills.lock.json"))
    ).toMatchObject({ recipes: [] });
    expect(existsSync(path.join(repo, ".agents/skills/monke-tools/imported/first"))).toBeFalsy();
  });

  test.each([
    { declarations: false, selectors: ["first"] },
    { declarations: true, selectors: ["first", "missing"] }
  ])(
    "empty authored discovery rejects missing selectors $selectors with declarations=$declarations",
    async ({ declarations, selectors }) => {
      const { bin, repo, runtime, sandbox, upstream } = repoFixture();
      installEmptyPublisherImporter(bin);
      const publisher = createRepo(path.join(sandbox, "empty-invalid-publisher"), {
        "fixtures/example/SKILL.md": "Invalid example.\n",
        "monke.yml": stringify({
          skills: declarations
            ? [
                {
                  commit: git(upstream, ["rev-parse", "HEAD"]),
                  skills: ["first"],
                  source: upstream
                }
              ]
            : []
        })
      });
      await expect(
        runCliAsync(
          ["skills", "add", `${publisher}#HEAD`, "--project", "--skill", ...selectors],
          runtime
        )
      ).rejects.toThrow(/No valid skills/u);
      expect(
        JSON.parse(read(repo, ".git/monke-tools/skill-registry/skills.lock.json"))
      ).toMatchObject({ recipes: [] });
      expect(existsSync(path.join(repo, ".agents/skills/monke-tools/imported/first"))).toBeFalsy();
    }
  );

  test.each([
    { name: "padded", rawName: " Fancy Author " },
    { name: "multiline", rawName: "Fancy\r\nAuthor" },
    { name: "terminal escape", rawName: "\u001B[31mFancy Author\u001B[0m" },
    { name: "control", rawName: "Fancy\u0000\u0085 Author" }
  ])("repo selectors replay the importer's normalized $name name", async ({ rawName }) => {
    const { bin, repo, runtime, sandbox } = repoFixture();
    const content = `---\n${stringify({ description: "Author trigger.", name: rawName })}---\nAccepted author.\n`;
    const upstream = createRepo(path.join(sandbox, "normalized-name"), {
      "skills/authors/SKILL.md": content
    });
    writeExecutable(
      path.join(bin, "npx"),
      `#!/bin/sh
set -eu
case "$6" in '*'|'Fancy Author') ;; *) exit 1 ;; esac
mkdir -p .agents/skills
cp -R "$4/skills/authors" .agents/skills/fancy-author
`
    );
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "Fancy Author"], runtime);
    expect(parseDocument(read(repo, "monke.yml")).toJS()).toMatchObject({
      skills: [{ skills: [{ selector: "Fancy Author", slug: "fancy-author" }] }]
    });
    expect(read(repo, "skills/imported/fancy-author/SKILL.md")).toBe(content);
    rmSync(path.join(repo, "skills/imported/fancy-author"), { recursive: true });
    await runCliAsync(["skills", "restore", "--repo"], runtime);
    expect(read(repo, "skills/imported/fancy-author/SKILL.md")).toBe(content);
    write(
      upstream,
      "skills/authors/SKILL.md",
      content.replace("Accepted author.", "Updated author.")
    );
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Advance normalized skill"]);
    installFakeCodiff(bin);
    installFakeCodexSummary(bin);
    await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);
    expect(read(repo, "skills/imported/fancy-author/SKILL.md")).toContain("Updated author.");
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0).each(["add", "update"])(
    "%s rejects an unwritable marker parent before changing accepted state",
    async (action) => {
      const { bin, repo, runtime, upstream } = repoFixture();
      await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
      const config = read(repo, "monke.yml");
      const first = read(repo, "skills/imported/first/SKILL.md");
      const marker = read(repo, "skills/.monke-restored.json");
      write(
        upstream,
        "skills/first/SKILL.md",
        "---\nname: first\ndescription: First skill.\n---\nCandidate first.\n"
      );
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Advance unwritable marker source"]);
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);
      const args =
        action === "add"
          ? ["skills", "add", upstream, "--repo", "--skill", "first", "second"]
          : ["skills", "update", "--repo", "--adapter", "codiff"];
      chmodSync(path.join(repo, "skills"), 0o555);
      try {
        await expect(runCliAsync(args, runtime)).rejects.toThrow(/EACCES|marker/iu);
        expect(read(repo, "monke.yml")).toBe(config);
        expect(read(repo, "skills/imported/first/SKILL.md")).toBe(first);
        expect(read(repo, "skills/.monke-restored.json")).toBe(marker);
        expect(existsSync(path.join(repo, "skills/imported/second"))).toBeFalsy();
      } finally {
        chmodSync(path.join(repo, "skills"), 0o755);
      }
    }
  );

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0).each(["restore", "remove"])(
    "%s with matching restored files does not need marker-parent writes",
    async (action) => {
      const { bin, repo, runtime, sandbox, upstream } = repoFixture();
      const other = createRepo(path.join(sandbox, "other-source"), {
        "skills/other/SKILL.md":
          "---\nname: other\ndescription: Other skill.\n---\nAccepted other.\n"
      });
      await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
      await runCliAsync(["skills", "add", other, "--repo", "--skill", "other"], runtime);
      const marker = read(repo, "skills/.monke-restored.json");
      const acceptedOther = read(repo, "skills/imported/other/SKILL.md");
      writeExecutable(path.join(bin, "npx"), "#!/bin/sh\nexit 42\n");
      chmodSync(path.join(repo, "skills"), 0o555);
      try {
        await runCliAsync(
          ["skills", action, ...(action === "remove" ? [upstream] : []), "--repo"],
          runtime
        );
        const recipes = z
          .object({ skills: z.array(z.unknown()) })
          .parse(parseDocument(read(repo, "monke.yml")).toJS()).skills;
        expect(recipes).toHaveLength(action === "remove" ? 1 : 2);
        expect(read(repo, "skills/imported/other/SKILL.md")).toBe(acceptedOther);
        expect(read(repo, "skills/.monke-restored.json")).toBe(marker);
        expect(existsSync(path.join(repo, "skills/imported/first"))).toBe(action !== "remove");
      } finally {
        chmodSync(path.join(repo, "skills"), 0o755);
      }
    }
  );

  test.each(["add", "update", "restore", "policy", "remove"])(
    "%s rejects an obstructed restore marker before changing accepted state",
    async (action) => {
      const { bin, repo, runtime, sandbox, upstream } = repoFixture();
      await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
      const other = createRepo(path.join(sandbox, "other-source"), {
        "skills/other/SKILL.md":
          "---\nname: other\ndescription: Other skill.\n---\nAccepted other.\n"
      });
      await runCliAsync(["skills", "add", other, "--repo", "--skill", "other"], runtime);
      write(
        upstream,
        "skills/first/SKILL.md",
        "---\nname: first\ndescription: First skill.\n---\nCandidate first.\n"
      );
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Advance obstructed source"]);
      const marker = path.join(repo, "skills/.monke-restored.json");
      renameSync(marker, `${marker}.accepted`);
      write(marker, "obstruction", "Marker obstruction must survive.\n");
      if (action === "restore") {
        write(repo, "skills/imported/first/SKILL.md", "Local bytes before failed restore.\n");
      }
      const config = read(repo, "monke.yml");
      const first = read(repo, "skills/imported/first/SKILL.md");
      const acceptedOther = read(repo, "skills/imported/other/SKILL.md");
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);
      const args =
        action === "add"
          ? ["skills", "add", upstream, "--repo", "--skill", "first", "second"]
          : action === "policy"
            ? ["skills", "policy", upstream, "first", "--repo", "--model-invocation", "deny"]
            : action === "remove"
              ? ["skills", "remove", upstream, "--repo"]
              : [
                  "skills",
                  action,
                  "--repo",
                  ...(action === "update" ? ["--adapter", "codiff"] : [])
                ];

      await expect(runCliAsync(args, runtime)).rejects.toThrow(/\.monke-restored\.json/u);

      expect(read(repo, "monke.yml")).toBe(config);
      expect(read(repo, "skills/imported/first/SKILL.md")).toBe(first);
      expect(read(repo, "skills/imported/other/SKILL.md")).toBe(acceptedOther);
      expect(existsSync(path.join(repo, "skills/imported/second"))).toBeFalsy();
      expect(read(marker, "obstruction")).toBe("Marker obstruction must survive.\n");
    }
  );

  test.each(["remove", "restore", "update"] as const)(
    "%s protects references consumed by ordinary authored skills",
    async (action) => {
      const { bin, repo, runtime, upstream } = repoFixture();
      await runCliAsync(
        ["skills", "add", upstream, "--repo", "--ref", "--skill", "first"],
        runtime
      );
      const consumer =
        "---\nname: local-dependent\ndescription: Local skill.\n---\nLoad [first](../references/imported/first/MAIN.md).\n";
      write(repo, "skills/local-dependent/SKILL.md", consumer);
      if (action !== "remove") {
        write(repo, "monke.yml", stringify({ skills: [] }));
      }
      const config = read(repo, "monke.yml");
      const marker = read(repo, "skills/.monke-restored.json");
      const command =
        action === "remove"
          ? ["skills", "remove", upstream, "--repo"]
          : ["skills", action, "--repo"];
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);

      await expect(runCliAsync(command, runtime)).rejects.toThrow(
        "skills/local-dependent/SKILL.md"
      );
      expect(read(repo, "monke.yml")).toBe(config);
      expect(read(repo, "skills/.monke-restored.json")).toBe(marker);
      expect(read(repo, "skills/local-dependent/SKILL.md")).toBe(consumer);
      expect(read(repo, "skills/references/imported/first/MAIN.md")).toBe("Pinned first.\n");
    }
  );

  test.each(["policy", "remove"] as const)(
    "%s validates the prospective retained consumer before pruning references",
    async (action) => {
      const { repo, runtime, sandbox, upstream } = repoFixture();
      const link = "Load [first](../../references/imported/first/MAIN.md).";
      const source = createRepo(path.join(sandbox, "consumer-source"), {
        "skills/consumer/SKILL.md": `---\nname: consumer\ndescription: ${JSON.stringify(action === "policy" ? link : "Consumer.")}\n---\n${action === "remove" ? link : "Self-contained body."}\n`
      });
      await runCliAsync(
        ["skills", "add", upstream, "--repo", "--ref", "--skill", "first"],
        runtime
      );
      await runCliAsync(["skills", "add", source, "--repo", "--skill", "consumer"], runtime);
      const nextDescription = "Self-contained consumer.";
      if (action === "remove") {
        write(
          source,
          "skills/consumer/SKILL.md",
          "---\nname: consumer\ndescription: Consumer.\n---\nSelf-contained V2 body.\n"
        );
        git(source, ["add", "."]);
        git(source, ["commit", "-m", "Remove dependency"]);
      }
      const store = readRepoImportRecipeStore(repo);
      store.recipes = store.recipes
        .filter((recipe) => action === "remove" || recipe.source !== upstream)
        .map((recipe) =>
          recipe.source === source
            ? { ...recipe, commit: git(source, ["rev-parse", "HEAD"]) }
            : recipe
        );
      writeRepoImportRecipeStore(repo, store);

      await runCliAsync(
        action === "policy"
          ? ["skills", "policy", source, "consumer", "--repo", "--description", nextDescription]
          : ["skills", "remove", upstream, "--repo"],
        runtime
      );

      expect(existsSync(path.join(repo, "skills/references/imported/first"))).toBeFalsy();
      expect(read(repo, "skills/imported/consumer/SKILL.md")).not.toContain(
        "references/imported/first"
      );
      expect(read(repo, "skills/imported/consumer/SKILL.md")).toContain("Self-contained");
      expect(read(repo, "monke.yml")).not.toContain(upstream);
      expect(read(repo, "skills/imported/consumer/SKILL.md")).toContain(
        action === "policy" ? nextDescription : "Self-contained V2 body."
      );
    }
  );

  test.each([
    "SKILL.md",
    ".agents/skills/local-dependent/SKILL.md",
    ".claude/skills/local-dependent/SKILL.md",
    ".codex/skills/local-dependent/SKILL.md",
    ".cursor/skills/local-dependent/SKILL.md"
  ])("restore protects a reference consumed by authored %s", async (consumerPath) => {
    const { repo, runtime, upstream } = repoFixture();
    await runCliAsync(["skills", "add", upstream, "--repo", "--ref", "--skill", "first"], runtime);
    write(
      repo,
      consumerPath,
      "---\nname: local-dependent\ndescription: Local skill.\n---\nLoad skills/references/imported/first/MAIN.md.\n"
    );
    write(repo, "monke.yml", stringify({ skills: [] }));
    const marker = read(repo, "skills/.monke-restored.json");

    await expect(runCliAsync(["skills", "restore", "--repo"], runtime)).rejects.toThrow(
      consumerPath
    );

    expect(read(repo, "skills/references/imported/first/MAIN.md")).toBe("Pinned first.\n");
    expect(read(repo, "skills/.monke-restored.json")).toBe(marker);
  });

  test("policy preparation failure preserves bytes and markers for its uncommitted override", async () => {
    const { repo, runtime, sandbox, upstream } = repoFixture();
    const other = createRepo(path.join(sandbox, "other"), {
      "skills/other/SKILL.md": "---\nname: other\ndescription: Other.\n---\nOther content.\n"
    });
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
    await runCliAsync(["skills", "add", other, "--repo", "--skill", "other"], runtime);
    write(
      other,
      "skills/other/SKILL.md",
      "---\nname: other\ndescription: Other.\n---\nAdvanced other.\n"
    );
    git(other, ["add", "."]);
    git(other, ["commit", "-m", "Advance unavailable source"]);
    const store = readRepoImportRecipeStore(repo);
    store.recipes = store.recipes.map((recipe) =>
      recipe.source === other ? { ...recipe, commit: git(other, ["rev-parse", "HEAD"]) } : recipe
    );
    writeRepoImportRecipeStore(repo, store);
    renameSync(other, `${other}-unavailable`);
    const config = read(repo, "monke.yml");
    const marker = read(repo, "skills/.monke-restored.json");
    const first = read(repo, "skills/imported/first/SKILL.md");

    await expect(
      runCliAsync(
        ["skills", "policy", upstream, "first", "--repo", "--description", "Uncommitted override."],
        runtime
      )
    ).rejects.toThrow(other);

    expect(read(repo, "monke.yml")).toBe(config);
    expect(read(repo, "skills/.monke-restored.json")).toBe(marker);
    expect(read(repo, "skills/imported/first/SKILL.md")).toBe(first);
  });

  test("pruning rejection reviews accepted source advances and cleans review snapshots", async () => {
    const { bin, messages, repo, runtime, sandbox, upstream } = repoFixture();
    const provider = createRepo(path.join(sandbox, "provider"), {
      "skills/base/SKILL.md": "---\nname: base\ndescription: Base.\n---\nAccepted base.\n"
    });
    const source = createRepo(path.join(sandbox, "consumer-source"), {
      "skills/consumer/SKILL.md":
        "---\nname: consumer\ndescription: Consumer.\n---\nLoad [base](../../references/imported/base/MAIN.md).\n"
    });
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
    await runCliAsync(["skills", "add", provider, "--repo", "--ref", "--skill", "base"], runtime);
    await runCliAsync(["skills", "add", source, "--repo", "--skill", "consumer"], runtime);
    const store = readRepoImportRecipeStore(repo);
    store.recipes = store.recipes.filter((recipe) => recipe.source !== provider);
    writeRepoImportRecipeStore(repo, store);
    write(
      upstream,
      "skills/first/SKILL.md",
      "---\nname: first\ndescription: First.\n---\nAdvanced first.\n"
    );
    write(upstream, "skills/first/asset.txt", "Advanced asset.\n");
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Advance independent source"]);
    const reviewLog = installFakeCodiff(bin);
    installFakeCodexSummary(bin);
    const temp = path.join(sandbox, "owned-review-temp");
    mkdirSync(temp);
    const previousTmpdir = process.env.TMPDIR;
    try {
      process.env.TMPDIR = temp;
      await expect(
        runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime)
      ).rejects.toThrow("Cannot replace Imported reference base");
    } finally {
      if (previousTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previousTmpdir;
      }
    }
    expect(read(repo, "monke.yml")).toContain(git(upstream, ["rev-parse", "HEAD"]));
    expect(read(repo, "skills/imported/first/SKILL.md")).toContain("Advanced first.");
    expect(read(repo, "skills/imported/first/asset.txt")).toBe("Advanced asset.\n");
    expect(read(repo, "skills/references/imported/base/MAIN.md")).toBe("Accepted base.\n");
    expect(messages.join("")).toContain("# Skill update summary");
    expect(messages.join("")).toContain("Complete skill review:");
    expect(read(repo, path.relative(repo, reviewLog)).split("--commit")).toHaveLength(2);
    expect(readdirSync(temp)).toStrictEqual([]);
  });

  test.each(["symlink", "dangling symlink", "hardlink"])(
    "update atomically replaces a safe marker %s without changing its target",
    async (alias) => {
      const { bin, repo, runtime, upstream } = repoFixture();
      await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
      const marker = path.join(repo, "skills/.monke-restored.json");
      const original = read(repo, "skills/.monke-restored.json");
      const target = `${marker}.previous`;
      renameSync(marker, target);
      if (alias === "dangling symlink") {
        rmSync(target);
      }
      if (alias === "hardlink") {
        linkSync(target, marker);
      } else {
        symlinkSync(target, marker);
      }
      write(upstream, "skills/first/guide.md", "Accepted new guide.\n");
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Advance aliased marker source"]);
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);

      await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);

      expect(read(repo, "skills/.monke-restored.json")).toContain(
        git(upstream, ["rev-parse", "HEAD"])
      );
      expect(read(repo, "skills/imported/first/guide.md")).toBe("Accepted new guide.\n");
      const targetContent = existsSync(target)
        ? read(repo, "skills/.monke-restored.json.previous")
        : undefined;
      expect(targetContent).toBe(alias === "dangling symlink" ? undefined : original);
    }
  );

  test("removing the last recipe and empty restore or update do not need a restore marker", async () => {
    const { bin, repo, runtime, upstream } = repoFixture();
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
    const marker = path.join(repo, "skills/.monke-restored.json");
    renameSync(marker, `${marker}.accepted`);
    write(marker, "obstruction", "Marker obstruction must survive.\n");
    installFakeCodiff(bin);
    installFakeCodexSummary(bin);

    await runCliAsync(["skills", "remove", upstream, "--repo"], runtime);
    await runCliAsync(["skills", "restore", "--repo"], runtime);
    await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);

    expect(parseDocument(read(repo, "monke.yml")).toJS()).toStrictEqual({ skills: [] });
    expect(existsSync(path.join(repo, "skills/imported/first"))).toBeFalsy();
    expect(read(marker, "obstruction")).toBe("Marker obstruction must survive.\n");
  });

  test.each([
    { nested: false, readd: false },
    { nested: false, readd: true },
    { nested: true, readd: false },
    { nested: true, readd: true }
  ])(
    "repo add rejects a partially matched selection with nested=$nested readd=$readd",
    async ({ nested, readd }) => {
      const { bin, repo, runtime, sandbox, upstream } = repoFixture();
      installPartialSuccessImporter(bin);
      const publisher = createRepo(path.join(sandbox, "publisher"), {
        "monke.yml": stringify({
          skills: [
            { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["first"], source: upstream }
          ]
        }),
        "skills/own/SKILL.md": "---\nname: own\ndescription: Own skill.\n---\nOwn guidance.\n"
      });
      const source = `${nested ? publisher : upstream}#HEAD`;
      const valid = nested ? "own" : "first";
      const missing = nested ? "first" : "unavailable";
      write(repo, "monke.yml", "# Keep consumer settings.\napps: {}\n");
      if (readd) {
        await runCliAsync(["skills", "add", source, "--repo", "--skill", valid], runtime);
      }
      const config = read(repo, "monke.yml");
      const imported = path.join(repo, "skills/imported", valid, "SKILL.md");
      const accepted = existsSync(imported) ? read(repo, path.relative(repo, imported)) : undefined;
      await expect(
        runCliAsync(["skills", "add", source, "--repo", "--skill", valid, missing], runtime)
      ).rejects.toThrow(missing);
      expect(read(repo, "monke.yml")).toBe(config);
      expect(existsSync(imported) ? read(repo, path.relative(repo, imported)) : undefined).toBe(
        accepted
      );
      expect(existsSync(path.join(repo, "skills/imported", missing))).toBeFalsy();
    }
  );

  test("repo selectors match raw upstream names without case sensitivity and wildcard selects all", async () => {
    const { bin, repo, runtime, upstream } = repoFixture();
    installPartialSuccessImporter(bin);
    write(
      upstream,
      "skills/different-folder/SKILL.md",
      "---\nname: Fancy Author\ndescription: Named skill.\n---\nNamed instructions.\n"
    );
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Publish named skill"]);
    const source = `${upstream}#HEAD`;
    await runCliAsync(
      ["skills", "add", source, "--repo", "--skill", "FIRST", "fAnCy AuThOr"],
      runtime
    );
    expect(parseDocument(read(repo, "monke.yml")).toJS()).toStrictEqual({
      skills: [
        {
          commit: git(upstream, ["rev-parse", "HEAD"]),
          skills: [{ selector: "Fancy Author", slug: "fancy-author" }, "first"],
          source
        }
      ]
    });
    expect(read(repo, "skills/imported/fancy-author/SKILL.md")).toContain("Named instructions.");
    const accepted = read(repo, "monke.yml");
    await expect(
      runCliAsync(["skills", "add", source, "--repo", "--skill", "first", "fancy-author"], runtime)
    ).rejects.toThrow("fancy-author");
    expect(read(repo, "monke.yml")).toBe(accepted);
    await runCliAsync(["skills", "add", source, "--repo", "--skill", "*", "unavailable"], runtime);
    expect(read(repo, "skills/imported/second/SKILL.md")).toContain("Pinned second.");
    expect(read(repo, "monke.yml")).not.toContain("unavailable");
  });

  test("repo re-add, update, and restore reject a partially matched retained selection", async () => {
    const { bin, repo, runtime, upstream } = repoFixture();
    installPartialSuccessImporter(bin);
    const source = `${upstream}#HEAD`;
    await runCliAsync(["skills", "add", source, "--repo", "--skill", "first", "second"], runtime);
    const config = read(repo, "monke.yml");
    const first = read(repo, "skills/imported/first/SKILL.md");
    const second = read(repo, "skills/imported/second/SKILL.md");
    rmSync(path.join(upstream, "skills/second"), { recursive: true });
    write(
      upstream,
      "skills/first/SKILL.md",
      "---\nname: first\ndescription: First skill.\n---\nUnaccepted revision.\n"
    );
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Retire selected skill"]);
    await expect(runCliAsync(["skills", "add", source, "--repo"], runtime)).rejects.toThrow(
      "second"
    );
    expect(read(repo, "monke.yml")).toBe(config);
    installFakeCodiff(bin);
    installFakeCodexSummary(bin);
    await expect(
      runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime)
    ).rejects.toThrow("second");
    expect(read(repo, "monke.yml")).toBe(config);
    expect(read(repo, "skills/imported/first/SKILL.md")).toBe(first);
    expect(read(repo, "skills/imported/second/SKILL.md")).toBe(second);
    const edited = stringify({
      skills: [
        { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["first", "second"], source }
      ]
    });
    write(repo, "monke.yml", edited);
    await expect(runCliAsync(["skills", "restore", "--repo"], runtime)).rejects.toThrow(
      /Selected skills not found.*second/u
    );
    expect(read(repo, "monke.yml")).toBe(edited);
    expect(read(repo, "skills/imported/first/SKILL.md")).toBe(first);
    expect(read(repo, "skills/imported/second/SKILL.md")).toBe(second);
  });

  test("repo declarations select their source's own skills and Git and linked consumers resolve one level", async () => {
    const { bin, repo, runtime, sandbox, upstream } = repoFixture();
    const publisher = createRepo(path.join(sandbox, "publisher-b"), {
      "monke.yml": stringify({
        skills: [
          { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["first"], source: upstream }
        ]
      }),
      "skills/own-b/SKILL.md": "---\nname: own-b\ndescription: B skill.\n---\nB first revision.\n"
    });
    write(
      repo,
      "skills/own-a/SKILL.md",
      "---\nname: own-a\ndescription: A skill.\n---\nA guidance.\n"
    );
    const source = `${publisher}#HEAD`;
    await runCliAsync(["skills", "add", source, "--repo"], runtime);
    expect(parseDocument(read(repo, "monke.yml")).toJS()).toStrictEqual({
      skills: [{ commit: git(publisher, ["rev-parse", "HEAD"]), skills: ["own-b"], source }]
    });
    expect(read(repo, "skills/imported/own-b/SKILL.md")).toContain("B first revision.");
    expect(existsSync(path.join(repo, "skills/imported/first"))).toBeFalsy();
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "Publish B own guidance"]);
    const before = git(repo, ["rev-parse", "HEAD"]);

    // B's declaration is outside A's import depth and must never be fetched.
    renameSync(upstream, `${upstream}-offline`);
    rmSync(path.join(repo, "skills/imported/own-b"), { recursive: true });
    await runCliAsync(["skills", "restore", "--repo"], runtime);
    await runCliAsync(
      [
        "skills",
        "policy",
        source,
        "own-b",
        "--repo",
        "--description",
        "A trigger.",
        "--model-invocation",
        "deny"
      ],
      runtime
    );
    write(
      publisher,
      "skills/own-b/SKILL.md",
      "---\nname: own-b\ndescription: B skill.\n---\nB second revision.\n"
    );
    git(publisher, ["add", "."]);
    git(publisher, ["commit", "-m", "Advance B own guidance"]);
    installFakeCodiff(bin);
    installFakeCodexSummary(bin);
    await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);
    expect(read(repo, "skills/imported/own-b/SKILL.md")).toContain("B second revision.");
    expect(read(repo, "skills/imported/own-b/SKILL.md")).toContain("description: A trigger.");
    expect(read(repo, "skills/imported/own-b/SKILL.md")).toContain(
      "disable-model-invocation: true"
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "Publish updated B guidance"]);
    const after = git(repo, ["rev-parse", "HEAD"]);
    const history = await runtime.execAsync(process.execPath, [
      fileURLToPath(new URL("../scripts/review-skills.ts", import.meta.url)),
      before,
      after,
      "--adapter",
      "codiff"
    ]);
    expect(history.stdout).toContain("Complete skill review:");

    for (const kind of ["git", "link"] as const) {
      const consumer = createRepo(path.join(sandbox, `consumer-${kind}`), {
        "README.md": "Consumer.\n"
      });
      const consumerRuntime = createTestRuntime({
        cwd: consumer,
        env: runtime.env,
        onStderr() {},
        onStdout() {}
      });
      await runCliAsync(
        kind === "git"
          ? ["skills", "add", `${repo}#HEAD`, "--project"]
          : ["skills", "add", repo, "--project", "--link", "--name", "publisher-a"],
        consumerRuntime
      );
      const projected = path.join(consumer, ".agents/skills/monke-tools/imported");
      expect(read(projected, "own-a/SKILL.md")).toContain("A guidance.");
      expect(read(projected, "own-b/SKILL.md")).toContain("B second revision.");
      expect(read(projected, "own-b/SKILL.md")).toContain("description: A trigger.");
      expect(existsSync(path.join(projected, "first"))).toBeFalsy();
    }
    await runCliAsync(["skills", "remove", source, "--repo"], runtime);
    expect(existsSync(path.join(repo, "skills/imported/own-b"))).toBeFalsy();
    expect(read(repo, "skills/own-a/SKILL.md")).toContain("A guidance.");
  });

  test("wildcard imports discover upstream hidden catalogs", async () => {
    const { bin, repo, runtime, sandbox } = repoFixture();
    const upstream = createRepo(path.join(sandbox, "curated-source"), {
      "skills/.curated/base/SKILL.md":
        "---\nname: base\ndescription: Curated skill.\n---\nCurated.\n"
    });
    writeExecutable(
      path.join(bin, "npx"),
      '#!/bin/sh\nset -eu\nmkdir -p .agents/skills\ncp -R "$4/skills/.curated/base" .agents/skills/\n'
    );
    await runCliAsync(["skills", "add", upstream, "--repo"], runtime);
    expect(read(repo, "skills/imported/base/SKILL.md")).toContain("Curated.");
    expect(read(repo, "monke.yml")).toContain("base");
  });

  test.each(["add", "restore", "update"])(
    "repo %s rejects selections available only through its source's declarations",
    async (action) => {
      const { bin, repo, runtime, sandbox, upstream } = repoFixture();
      const publisher = createRepo(path.join(sandbox, "publisher"), {
        "monke.yml": stringify({
          skills: [
            { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["first"], source: upstream }
          ]
        }),
        "skills/own/SKILL.md":
          "---\nname: own\ndescription: Own skill.\n---\nAccepted own guidance.\n"
      });
      const source = `${publisher}#HEAD`;
      const commit = git(publisher, ["rev-parse", "HEAD"]);
      await runCliAsync(["skills", "add", source, "--repo", "--skill", "own"], runtime);
      const accepted = read(repo, "skills/imported/own/SKILL.md");
      if (action !== "add") {
        write(repo, "monke.yml", stringify({ skills: [{ commit, skills: ["first"], source }] }));
      }
      const config = read(repo, "monke.yml");
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);
      const args =
        action === "add"
          ? ["skills", "add", source, "--repo", "--skill", "first"]
          : ["skills", action, "--repo", ...(action === "update" ? ["--adapter", "codiff"] : [])];
      await expect(runCliAsync(args, runtime)).rejects.toThrow(/first/u);
      expect(read(repo, "monke.yml")).toBe(config);
      expect(read(repo, "skills/imported/own/SKILL.md")).toBe(accepted);
      expect(existsSync(path.join(repo, "skills/imported/first"))).toBeFalsy();
    }
  );

  test("a failed replacement selection keeps accepted files while another source advances", async () => {
    const { bin, repo, runtime, sandbox, upstream } = repoFixture();
    const other = createRepo(path.join(sandbox, "other"), {
      "skills/other/SKILL.md":
        "---\nname: other\ndescription: Other skill.\n---\nOther first revision.\n"
    });
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
    await runCliAsync(["skills", "add", other, "--repo", "--skill", "other"], runtime);
    const failedPin = git(upstream, ["rev-parse", "HEAD"]);
    const accepted = read(repo, "skills/imported/first/SKILL.md");
    write(
      repo,
      "monke.yml",
      stringify({
        skills: [
          { commit: failedPin, skills: ["unpublished"], source: upstream },
          { commit: git(other, ["rev-parse", "HEAD"]), skills: ["other"], source: other }
        ]
      })
    );
    write(
      other,
      "skills/other/SKILL.md",
      "---\nname: other\ndescription: Other skill.\n---\nOther second revision.\n"
    );
    git(other, ["add", "."]);
    git(other, ["commit", "-m", "Advance working source"]);
    installFakeCodiff(bin);
    installFakeCodexSummary(bin);
    await expect(
      runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime)
    ).rejects.toThrow("1 recipe(s)");
    expect(read(repo, "skills/imported/first/SKILL.md")).toBe(accepted);
    expect(existsSync(path.join(repo, "skills/imported/unpublished"))).toBeFalsy();
    expect(read(repo, "skills/imported/other/SKILL.md")).toContain("Other second revision.");
    expect(parseDocument(read(repo, "monke.yml")).toJS()).toStrictEqual({
      skills: [
        { commit: git(other, ["rev-parse", "HEAD"]), skills: ["other"], source: other },
        { commit: failedPin, skills: ["unpublished"], source: upstream }
      ]
    });
    write(
      repo,
      "monke.yml",
      stringify({
        skills: [{ commit: git(other, ["rev-parse", "HEAD"]), skills: ["other"], source: other }]
      })
    );
    await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);
    expect(existsSync(path.join(repo, "skills/imported/first"))).toBeFalsy();
  });

  test.each([false, true])(
    "publisher collisions use installed names with explicit=%s",
    async (explicit) => {
      const { bin, repo, runtime, sandbox, upstream } = repoFixture();
      const registry = path.join(repo, ".git/monke-tools/skill-registry");
      const projected = path.join(repo, ".agents/skills/monke-tools/imported");
      const publisher = createRepo(path.join(sandbox, "named-publisher"), {
        "monke.yml": stringify({
          skills: [
            { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["first"], source: upstream }
          ]
        }),
        "skills/first/SKILL.md":
          "---\nname: repo-author\ndescription: Publisher skill.\n---\nOwn guidance.\n"
      });
      writeExecutable(
        path.join(bin, "npx"),
        `#!/bin/sh
set -eu
mkdir -p .agents/skills
if grep -q '^name: repo-author$' "$4/skills/first/SKILL.md"; then
  cp -R "$4/skills/first" .agents/skills/repo-author
else
  cp -R "$4/skills/first" .agents/skills/first
fi
`
      );
      await runCliAsync(
        [
          "skills",
          "add",
          `${publisher}#HEAD`,
          "--project",
          ...(explicit ? ["--skill", "first"] : [])
        ],
        runtime
      );
      expect(read(projected, "first/SKILL.md")).toContain("Pinned first.");
      expect(existsSync(path.join(projected, "repo-author"))).toBe(!explicit);
      write(
        publisher,
        "skills/first/SKILL.md",
        "---\nname: first\ndescription: Colliding skill.\n---\nCollision.\n"
      );
      git(publisher, ["add", "."]);
      git(publisher, ["commit", "-m", "Introduce installed slug collision"]);
      const accepted = read(registry, "skills.lock.json");
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);
      await expect(
        runCliAsync(["skills", "update", "--project", "--adapter", "codiff"], runtime)
      ).rejects.toThrow(/collid/u);
      expect(read(registry, "skills.lock.json")).toBe(accepted);
      expect(read(projected, "first/SKILL.md")).toContain("Pinned first.");
    }
  );

  test.each([
    { includeInternal: false, selection: "*" },
    { includeInternal: true, selection: "*" },
    { includeInternal: false, selection: "internal" }
  ])(
    "publishers preserve discovery with internal=$includeInternal selection=$selection",
    async ({ includeInternal, selection }) => {
      const { bin, repo, runtime, sandbox, upstream } = repoFixture();
      const projected = path.join(repo, ".agents/skills/monke-tools/imported");
      const publisher = createRepo(path.join(sandbox, "internal-publisher"), {
        "monke.yml": stringify({
          skills: [
            { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["first"], source: upstream }
          ]
        }),
        "SKILL.md":
          "---\nname: internal\ndescription: Internal skill.\nmetadata:\n  internal: true\n---\nInternal.\n",
        "skills/public/SKILL.md":
          "---\nname: public\ndescription: Public skill.\n---\nPublic guidance.\n"
      });
      installInternalRootImporter(bin);
      runtime.env.INSTALL_INTERNAL_SKILLS = includeInternal ? "1" : "";
      await runCliAsync(
        ["skills", "add", `${publisher}#HEAD`, "--project", "--skill", selection],
        runtime
      );
      expect(existsSync(path.join(projected, "first/SKILL.md"))).toBe(selection === "*");
      expect(existsSync(path.join(projected, "internal/SKILL.md"))).toBe(
        includeInternal || selection === "internal"
      );
      expect(existsSync(path.join(projected, "public/SKILL.md"))).toBe(
        !includeInternal && selection === "*"
      );
    }
  );

  test.each([
    { assessed: true, selection: "public", suffix: "selected" },
    { assessed: true, selection: "internal", suffix: "selected" },
    { assessed: false, selection: "public", suffix: "selected" },
    { assessed: true, selection: "public", suffix: "Generator" },
    { assessed: true, selection: "public", suffix: "SocketGuide" },
    { assessed: true, selection: "public", suffix: "SnykGuide" },
    { assessed: true, selection: "public", suffix: "Installation complete" },
    { assessed: true, selection: "public", suffix: "Installed Guide" },
    { assessed: true, selection: "public", suffix: "Guide  Notes" }
  ])(
    "repo update reports assessments only from chosen $selection catalog entries for $suffix with assessed=$assessed",
    async ({ assessed, selection, suffix }) => {
      const { bin, messages, repo, runtime, sandbox } = repoFixture();
      runtime.env.INSTALL_INTERNAL_SKILLS = "";
      const selected = `assessment-shared-prefix-12345678901234567890-${suffix}`;
      const unselected = "assessment-shared-prefix-12345678901234567890-unselected";
      const publisher = createRepo(path.join(sandbox, "assessed-publisher"), {
        "SKILL.md":
          "---\nname: internal-root\ndescription: Root.\nmetadata:\n  internal: true\n---\nInternal guidance.\n",
        "skills/selected/SKILL.md": `---\nname: ${selected}\ndescription: Public.\n---\nSelected guidance.\n`,
        "skills/unselected/SKILL.md": `---\nname: ${unselected}\ndescription: Other.\n---\nUnselected guidance.\n`
      });
      writeExecutable(
        path.join(bin, "npx"),
        `#!/usr/bin/env bun
import { cpSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const source = args[3];
const selectors = [];
for (let index = 4; args[index] === "--skill"; index += 2) selectors.push(args[index + 1]);
const internal = process.env.INSTALL_INTERNAL_SKILLS === "1" || !selectors.includes("*");
const directories = internal ? [source] : readdirSync(path.join(source, "skills")).map(name => path.join(source, "skills", name));
const results = [];
for (const directory of directories) {
  const name = /^name: (.+)$/m.exec(readFileSync(path.join(directory, "SKILL.md"), "utf8"))[1];
  if (!selectors.includes("*") && !selectors.includes(name)) continue;
  const slug = name.toLowerCase().replace(/[^a-z0-9._]+/g, "-");
  const destination = path.resolve(".agents/skills", slug);
  mkdirSync(destination, { recursive: true });
  if (directory === source) cpSync(path.join(directory, "SKILL.md"), path.join(destination, "SKILL.md"));
  else cpSync(directory, destination, { recursive: true });
  const isSelected = name === ${JSON.stringify(selected)};
  const security = name === "internal-root" ? { gen: "medium", socket: "1 alert", snyk: "low" } : isSelected ? { gen: "critical", socket: "2 alerts", snyk: "high" } : { gen: "safe", socket: "0 alerts", snyk: "low" };
  results.push({ name, path: destination, security: !${assessed} && isSelected ? null : { ...security, details: "https://skills.sh/owner/assessed" }, status: "installed" });
}
const table = "Security Risk Assessments\\n" + results.map(item => item.name.slice(0, 35) + "…  Safe  0 alerts  Low Risk").join("\\n") + "\\nDetails: https://skills.sh/owner/assessed\\nInstallation complete\\n";
if (args.includes("--json")) { console.error("UNSELECTED-INVENTORY-STDERR" + table); console.log(JSON.stringify(results)); }
else console.log(table);
`
      );
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);
      await runCliAsync(
        [
          "skills",
          "add",
          `${publisher}#HEAD`,
          "--repo",
          ...(selection === "internal" ? ["--skill", "internal-root"] : [])
        ],
        runtime
      );
      const chosen = selection === "internal" ? "internal-root" : selected;
      write(
        repo,
        "monke.yml",
        stringify({
          skills: [
            {
              commit: git(publisher, ["rev-parse", "HEAD"]),
              skills: [
                { selector: chosen, slug: chosen.toLowerCase().replaceAll(/[^a-z0-9._]+/gu, "-") }
              ],
              source: `${publisher}#HEAD`
            }
          ]
        })
      );
      messages.length = 0;
      await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);
      const output = stripVTControlCharacters(messages.join(""));
      const expectedReports = assessed ? 1 : 0;
      const risk = selection === "internal" ? "Med Risk" : "Critical Risk";
      const socket = selection === "internal" ? "1 alert" : "2 alerts";
      const snyk = selection === "internal" ? "Low Risk" : "High Risk";
      expect(output.match(/Security Risk Assessments/gu) ?? []).toHaveLength(expectedReports);
      expect(
        output.match(new RegExp(`${chosen} +${risk} +${socket} +${snyk}`, "gu")) ?? []
      ).toHaveLength(expectedReports);
      expect(output.match(/https:\/\/skills.sh\/owner\/assessed/gu) ?? []).toHaveLength(
        expectedReports
      );
      for (const omitted of [
        "UNSELECTED-INVENTORY-STDERR",
        "Safe",
        "0 alerts",
        unselected,
        selection === "internal" ? selected : "internal-root"
      ]) {
        expect(output).not.toContain(omitted);
      }
    }
  );

  test("recorded repo selections distinguish raw names sharing a slug", async () => {
    const { bin, repo, runtime, sandbox } = repoFixture();
    installInternalRootImporter(bin);
    runtime.env.INSTALL_INTERNAL_SKILLS = "";
    const publisher = createRepo(path.join(sandbox, "same-slug"), {
      "SKILL.md":
        "---\nname: Internal Guide\ndescription: Root.\nmetadata:\n  internal: true\n---\nAccepted root.\n",
      "skills/public/SKILL.md":
        "---\nname: Internal-Guide\ndescription: Child.\n---\nOther child.\n"
    });
    await runCliAsync(
      ["skills", "add", `${publisher}#HEAD`, "--repo", "--skill", "Internal Guide"],
      runtime
    );
    const accepted = read(repo, "skills/imported/internal-guide/SKILL.md");
    rmSync(path.join(repo, "skills/imported"), { recursive: true });
    rmSync(path.join(repo, "skills/.monke-restored.json"));
    await runCliAsync(["skills", "restore", "--repo"], runtime);
    expect(read(repo, "skills/imported/internal-guide/SKILL.md")).toBe(accepted);
  });

  test.each([
    { optin: false, selector: "*" },
    { optin: true, selector: "*" },
    { optin: false, selector: "internal" }
  ])(
    "repo add rejects ambiguous discovery identities for $selector atomically with optin=$optin",
    async ({ optin, selector }) => {
      const { bin, repo, runtime, sandbox } = repoFixture();
      installInternalRootImporter(bin);
      runtime.env.INSTALL_INTERNAL_SKILLS = optin ? "1" : "";
      const publisher = createRepo(path.join(sandbox, "same-identity"), {
        "skills/public/SKILL.md": "---\nname: internal\ndescription: Child.\n---\nAccepted child.\n"
      });
      const add = ["skills", "add", `${publisher}#HEAD`, "--repo", "--skill", selector];
      await runCliAsync(add, runtime);
      const accepted = [
        read(repo, "monke.yml"),
        read(repo, "skills/.monke-restored.json"),
        read(repo, "skills/imported/internal/SKILL.md")
      ];
      write(
        publisher,
        "SKILL.md",
        "---\nname: internal\ndescription: Root.\nmetadata:\n  internal: true\n---\nDifferent root.\n"
      );
      git(publisher, ["add", "."]);
      git(publisher, ["commit", "-m", "Introduce ambiguous root"]);
      await expect(runCliAsync(add, runtime)).rejects.toThrow("Ambiguous Skill selector internal");
      expect([
        read(repo, "monke.yml"),
        read(repo, "skills/.monke-restored.json"),
        read(repo, "skills/imported/internal/SKILL.md")
      ]).toStrictEqual(accepted);
      const fresh = createRepo(path.join(sandbox, "fresh-ambiguous"), { "README.md": "Fresh.\n" });
      const freshRuntime = createTestRuntime({
        cwd: fresh,
        env: runtime.env,
        onStderr() {},
        onStdout() {}
      });
      await expect(runCliAsync(add, freshRuntime)).rejects.toThrow(
        "Ambiguous Skill selector internal"
      );
      expect(existsSync(path.join(fresh, "monke.yml"))).toBeFalsy();
      expect(existsSync(path.join(fresh, "skills/imported"))).toBeFalsy();
    }
  );

  test.each([false, true])(
    "recorded repo selections replay public children with ignored declarations=%s",
    async (declared) => {
      const { bin, repo, runtime, sandbox } = repoFixture();
      installInternalRootImporter(bin);
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);
      runtime.env.INSTALL_INTERNAL_SKILLS = "";
      const publisher = createRepo(path.join(sandbox, "replay-publisher"), {
        "SKILL.md":
          "---\nname: internal\ndescription: Internal skill.\nmetadata:\n  internal: true\n---\nInternal.\n",
        "skills/public/scripts/tool.sh": "Pinned support asset.\n",
        "skills/public/SKILL.md":
          "---\nname: public\ndescription: Public skill.\n---\nPinned public.\n",
        ...(declared
          ? {
              "monke.yml": "skills:\n  - source: owner/unavailable\n    skills: [must-not-follow]\n"
            }
          : {})
      });
      await runCliAsync(["skills", "add", `${publisher}#HEAD`, "--repo"], runtime);
      const accepted = read(repo, "monke.yml");
      const publicGuidance = read(repo, "skills/imported/public/SKILL.md");
      runtime.env.INSTALL_INTERNAL_SKILLS = "1";
      rmSync(path.join(repo, "skills/imported/public"), { recursive: true });
      rmSync(path.join(repo, "skills/.monke-restored.json"));
      await runCliAsync(["skills", "restore", "--repo"], runtime);
      expect(read(repo, "monke.yml")).toBe(accepted);
      expect(read(repo, "skills/imported/public/SKILL.md")).toBe(publicGuidance);
      expect(read(repo, "skills/imported/public/scripts/tool.sh")).toBe("Pinned support asset.\n");
      write(
        publisher,
        "skills/public/SKILL.md",
        "---\nname: public\ndescription: Public skill.\n---\nUpdated public.\n"
      );
      write(
        publisher,
        "skills/extra/SKILL.md",
        "---\nname: extra\ndescription: Extra skill.\n---\nUnselected.\n"
      );
      git(publisher, ["add", "."]);
      git(publisher, ["commit", "-m", "Advance publisher"]);
      const fresh = createRepo(path.join(sandbox, "fresh"), { "monke.yml": accepted });
      const freshRuntime = createTestRuntime({
        cwd: fresh,
        env: runtime.env,
        onStderr() {},
        onStdout() {}
      });
      await runCliAsync(["skills", "restore", "--repo"], freshRuntime);
      expect(read(fresh, "skills/imported/public/SKILL.md")).toBe(publicGuidance);
      expect(read(fresh, "skills/imported/public/scripts/tool.sh")).toBe("Pinned support asset.\n");
      expect(existsSync(path.join(fresh, "skills/imported/extra"))).toBeFalsy();
      await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);
      expect(read(repo, "skills/imported/public/SKILL.md")).toContain("Updated public.");
      expect(existsSync(path.join(repo, "skills/imported/extra"))).toBeFalsy();
      expect(existsSync(path.join(repo, "skills/imported/must-not-follow"))).toBeFalsy();
    }
  );

  test.each([
    { action: "update", change: "root" },
    { action: "readd", change: "declarations" }
  ])("$action retains public skills when a publisher adds $change", async ({ action, change }) => {
    const { bin, repo, runtime, sandbox, upstream } = repoFixture();
    installInternalRootImporter(bin);
    installFakeCodiff(bin);
    installFakeCodexSummary(bin);
    runtime.env.INSTALL_INTERNAL_SKILLS = "";
    const root =
      "---\nname: internal\ndescription: Internal skill.\nmetadata:\n  internal: true\n---\nInternal.\n";
    const declarations = stringify({
      skills: [
        { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["first"], source: upstream }
      ]
    });
    const publisher = createRepo(path.join(sandbox, "changing-publisher"), {
      "skills/public/SKILL.md":
        "---\nname: public\ndescription: Public skill.\n---\nRetained public guidance.\n",
      ...(change === "root" ? { "monke.yml": declarations } : { "SKILL.md": root })
    });
    const add = ["skills", "add", `${publisher}#HEAD`, "--project"];
    const projected = path.join(repo, ".agents/skills/monke-tools/imported");
    await runCliAsync(add, runtime);
    const acceptedPublic = read(projected, "public/SKILL.md");
    write(
      publisher,
      change === "root" ? "SKILL.md" : "monke.yml",
      change === "root" ? root : declarations
    );
    git(publisher, ["add", "."]);
    git(publisher, ["commit", "-m", `Add publisher ${change}`]);
    await runCliAsync(
      action === "readd" ? add : ["skills", "update", "--project", "--adapter", "codiff"],
      runtime
    );
    expect(read(projected, "public/SKILL.md")).toBe(acceptedPublic);
    expect(read(projected, "first/SKILL.md")).toContain("Pinned first.");
    expect(existsSync(path.join(projected, "internal"))).toBeFalsy();
    const accepted: unknown = JSON.parse(
      read(repo, ".git/monke-tools/skill-registry/skills.lock.json")
    );
    expect(accepted).toMatchObject({
      recipes: [{ selection: ["*"], skills: ["first", "public"] }]
    });
  });

  test.each(["*", "first"])(
    "internal roots do not hide authored collisions from selection %s",
    async (selection) => {
      const { bin, repo, runtime, sandbox, upstream } = repoFixture();
      installInternalRootImporter(bin);
      runtime.env.INSTALL_INTERNAL_SKILLS = "";
      const publisher = createRepo(path.join(sandbox, "colliding-internal-publisher"), {
        "monke.yml": stringify({
          skills: [
            { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["first"], source: upstream }
          ]
        }),
        "SKILL.md":
          "---\nname: internal\ndescription: Internal skill.\nmetadata:\n  internal: true\n---\nInternal.\n",
        "skills/first/SKILL.md":
          "---\nname: first\ndescription: Authored skill.\n---\nAuthored collision.\n"
      });
      await expect(
        runCliAsync(
          ["skills", "add", `${publisher}#HEAD`, "--project", "--skill", selection],
          runtime
        )
      ).rejects.toThrow(/first.*collides/u);
      const accepted: unknown = JSON.parse(
        read(repo, ".git/monke-tools/skill-registry/skills.lock.json")
      );
      expect(accepted).toStrictEqual({ recipes: [], version: 4 });
      expect(existsSync(path.join(repo, ".agents/skills/monke-tools/imported/first"))).toBeFalsy();
    }
  );

  test.each([
    { action: "add", alias: "symlink" },
    { action: "restore", alias: "symlink" },
    { action: "update", alias: "symlink" },
    { action: "remove", alias: "symlink" },
    { action: "policy", alias: "symlink" },
    { action: "add", alias: "hardlink" }
  ])(
    "$action rejects a $alias .gitignore before changing accepted state",
    async ({ action, alias }) => {
      const { bin, repo, runtime, sandbox, upstream } = repoFixture();
      await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
      const acceptedConfig = read(repo, "monke.yml");
      const acceptedSkill = read(repo, "skills/imported/first/SKILL.md");
      const external = path.join(sandbox, "external-ignore");
      write(sandbox, "external-ignore", "External ignores must survive.\n");
      renameSync(path.join(repo, ".gitignore"), path.join(repo, "original-ignore"));
      if (alias === "hardlink") {
        linkSync(external, path.join(repo, ".gitignore"));
      } else {
        symlinkSync(external, path.join(repo, ".gitignore"));
      }
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);
      const args = ["skills", action];
      if (["add", "remove", "policy"].includes(action)) {
        args.push(upstream);
      }
      args.push("--repo");
      if (action === "add") {
        args.push("--skill", "second");
      }
      if (action === "policy") {
        args.push("--model-invocation", "deny");
      }
      if (action === "update") {
        args.push("--adapter", "codiff");
      }
      await expect(runCliAsync(args, runtime)).rejects.toThrow(/\.gitignore.*regular file/u);
      expect(read(sandbox, "external-ignore")).toBe("External ignores must survive.\n");
      expect(read(repo, "monke.yml")).toBe(acceptedConfig);
      expect(read(repo, "skills/imported/first/SKILL.md")).toBe(acceptedSkill);
      expect(existsSync(path.join(repo, "skills/imported/second"))).toBeFalsy();
    }
  );

  test.each(["skills.lock.json", "skills/imported/.monke-imports.json"])(
    "repo restore and update obey YAML over %s",
    async (legacyFile) => {
      const { bin, repo, runtime, upstream } = repoFixture();
      const commit = git(upstream, ["rev-parse", "HEAD"]);
      const legacy = JSON.stringify({
        recipes: [
          {
            commit,
            skills: ["first"],
            source: upstream
          }
        ],
        version: 4
      });
      write(repo, legacyFile, legacy);
      const config = stringify({
        skills: [
          {
            commit,
            skills: [
              {
                description: "YAML trigger.",
                modelInvocation: "deny",
                slug: "second"
              }
            ],
            source: upstream
          }
        ]
      });
      write(repo, "monke.yml", config);
      await runCliAsync(["skills", "restore", "--repo"], runtime);
      expect(read(repo, "skills/imported/second/SKILL.md")).toContain("description: YAML trigger.");
      expect(read(repo, "skills/imported/second/SKILL.md")).toContain(
        "disable-model-invocation: true"
      );
      expect(existsSync(path.join(repo, "skills/imported/first"))).toBeFalsy();
      write(upstream, "skills/second/guide.md", "New accepted guide.\n");
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Advance YAML-selected guidance"]);
      const reviewLog = installFakeCodiff(bin);
      installFakeCodexSummary(bin);
      await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);
      expect(read(repo, "skills/imported/second/guide.md")).toBe("New accepted guide.\n");
      expect(read(repo, "monke.yml")).toContain("YAML trigger.");
      expect(read(repo, "monke.yml")).not.toContain("first");
      const [, reviewCommit = "", reviewRepo = ""] = read(bin, path.relative(bin, reviewLog))
        .trim()
        .split("\n");
      const reviewedStore = git(reviewRepo, ["show", `${reviewCommit}:skills.lock.json`]);
      expect(reviewedStore).toContain("second");
      expect(reviewedStore).not.toContain("first");
      write(repo, "monke.yml", "# No repo imports remain.\n");
      await runCliAsync(["skills", "restore", "--repo"], runtime);
      expect(existsSync(path.join(repo, "skills/imported/second"))).toBeFalsy();
      await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);
      expect(read(repo, "monke.yml")).toBe("# No repo imports remain.\n");
      expect(existsSync(path.join(repo, "skills/imported/first"))).toBeFalsy();
    }
  );

  test.each([
    { action: "add", kind: "skill" },
    { action: "restore", kind: "skill" },
    { action: "update", kind: "skill" },
    { action: "add", kind: "reference" },
    { action: "restore", kind: "reference" },
    { action: "update", kind: "reference" }
  ] as const)(
    "$action rejects a symlinked $kind root before changing external files",
    async ({ action, kind }) => {
      const { bin, repo, runtime, sandbox, upstream } = repoFixture();
      const config = stringify({
        skills: [
          {
            commit: git(upstream, ["rev-parse", "HEAD"]),
            skills: [{ kind, slug: "first" }],
            source: upstream
          }
        ]
      });
      write(repo, "monke.yml", config);
      const external = path.join(sandbox, "external");
      const entry = `first/${kind === "reference" ? "MAIN.md" : "SKILL.md"}`;
      write(external, entry, "External content must survive.\n");
      const root = path.join(
        repo,
        kind === "reference" ? "skills/references/imported" : "skills/imported"
      );
      mkdirSync(path.dirname(root), { recursive: true });
      symlinkSync(external, root, "dir");
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);
      const args =
        action === "add"
          ? [
              "skills",
              action,
              upstream,
              "--repo",
              "--skill",
              "first",
              ...(kind === "reference" ? ["--ref"] : [])
            ]
          : ["skills", action, "--repo", ...(action === "update" ? ["--adapter", "codiff"] : [])];
      await expect(runCliAsync(args, runtime)).rejects.toThrow(/root must be a regular directory/u);
      expect(read(external, entry)).toBe("External content must survive.\n");
      expect(read(repo, "monke.yml")).toBe(config);
    }
  );

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

  test("update accepts a handwritten selection first published after its recorded pin", async () => {
    const { bin, repo, runtime, sandbox } = repoFixture();
    const upstream = createRepo(path.join(sandbox, "expanded-source"), {
      "skills/first/SKILL.md": "---\nname: first\ndescription: First skill.\n---\nOriginal first.\n"
    });
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
    const originalPin = git(upstream, ["rev-parse", "HEAD"]);
    const originalFirst = read(repo, "skills/imported/first/SKILL.md");
    write(
      upstream,
      "skills/first/SKILL.md",
      "---\nname: first\ndescription: First skill.\n---\nUpdated first.\n"
    );
    write(
      upstream,
      "skills/second/SKILL.md",
      "---\nname: second\ndescription: Second skill.\n---\nNew second.\n"
    );
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Publish second skill"]);
    write(
      repo,
      "monke.yml",
      stringify({
        skills: [{ commit: originalPin, skills: ["first", "second"], source: upstream }]
      })
    );
    const reviewLog = installFakeCodiff(bin);
    installFakeCodexSummary(bin);

    await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);

    expect(read(repo, "monke.yml")).toContain(git(upstream, ["rev-parse", "HEAD"]));
    expect(read(repo, "skills/imported/first/SKILL.md")).toContain("Updated first.");
    expect(read(repo, "skills/imported/second/SKILL.md")).toContain("New second.");
    const [, reviewCommit = "", reviewRepo = ""] = read(bin, path.relative(bin, reviewLog))
      .trim()
      .split("\n");
    expect(git(reviewRepo, ["show", `${reviewCommit}^:skills/imported/first/SKILL.md`])).toBe(
      originalFirst.trimEnd()
    );
    expect(
      git(reviewRepo, ["ls-tree", "--name-only", `${reviewCommit}^`, "skills/imported/second"])
    ).toBe("");
    expect(git(reviewRepo, ["show", `${reviewCommit}:skills/imported/second/SKILL.md`])).toContain(
      "New second."
    );
  });

  test("a failed expanded selection retains its recorded pin and accepted files", async () => {
    const { bin, repo, runtime, upstream } = repoFixture();
    await runCliAsync(["skills", "add", upstream, "--repo", "--skill", "first"], runtime);
    const originalPin = git(upstream, ["rev-parse", "HEAD"]);
    const originalFirst = read(repo, "skills/imported/first/SKILL.md");
    write(
      upstream,
      "skills/first/SKILL.md",
      "---\nname: first\ndescription: First skill.\n---\nCandidate first.\n"
    );
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Advance without the selected skill"]);
    const config = stringify({
      skills: [{ commit: originalPin, skills: ["first", "unpublished"], source: upstream }]
    });
    write(repo, "monke.yml", config);
    installFakeCodiff(bin);
    installFakeCodexSummary(bin);

    await expect(
      runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime)
    ).rejects.toThrow("unpublished");

    expect(read(repo, "monke.yml")).toBe(config);
    expect(read(repo, "skills/imported/first/SKILL.md")).toBe(originalFirst);
    expect(existsSync(path.join(repo, "skills/imported/unpublished"))).toBeFalsy();
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
    expect(parseDocument(read(repo, "monke.yml")).toJS()).toStrictEqual({ skills: [] });
  });

  test.each(["remove", "restore", "selection", "update", "empty", "policy"] as const)(
    "%s rejects pruning a reference used by retained repo guidance",
    async (action) => {
      const { bin, repo, runtime, sandbox, upstream } = repoFixture();
      write(upstream, "skills/first/assets/accepted.txt", "Accepted reference asset.\n");
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Publish reference asset"]);
      await runCliAsync(
        ["skills", "add", upstream, "--repo", "--ref", "--skill", "first"],
        runtime
      );
      const consumer =
        "---\nname: consumer\ndescription: Consumer.\n---\nLoad [first](../../references/imported/first/MAIN.md).\n";
      const sameSource = action === "selection";
      const source = sameSource
        ? upstream
        : createRepo(path.join(sandbox, "reference-consumer"), {
            "skills/consumer/SKILL.md": consumer
          });
      if (sameSource) {
        write(upstream, "skills/consumer/SKILL.md", consumer);
        git(upstream, ["add", "."]);
        git(upstream, ["commit", "-m", "Publish consuming skill"]);
      }
      const consumerFolder = action === "empty" ? "skills/internal" : "skills/imported";
      if (action === "empty") {
        write(repo, `${consumerFolder}/consumer/SKILL.md`, consumer);
      } else {
        await runCliAsync(
          [
            "skills",
            "add",
            source,
            "--repo",
            "--skill",
            ...(sameSource ? ["first"] : []),
            "consumer"
          ],
          runtime
        );
      }
      if (action !== "remove") {
        write(
          repo,
          "monke.yml",
          stringify({
            skills:
              action === "empty"
                ? []
                : [
                    {
                      commit: git(source, ["rev-parse", "HEAD"]),
                      skills: ["consumer"],
                      source
                    }
                  ]
          })
        );
      }
      const config = read(repo, "monke.yml");
      const reference = read(repo, "skills/references/imported/first/MAIN.md");
      const referenceAsset = read(repo, "skills/references/imported/first/assets/accepted.txt");
      const marker = read(repo, "skills/.monke-restored.json");
      const acceptedConsumer = read(repo, `${consumerFolder}/consumer/SKILL.md`);
      const command =
        action === "remove"
          ? ["skills", "remove", upstream, "--repo"]
          : action === "policy"
            ? ["skills", "policy", source, "consumer", "--repo", "--description", "Changed."]
            : ["skills", action === "update" ? "update" : "restore", "--repo"];
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);

      await expect(runCliAsync(command, runtime)).rejects.toThrow(
        /Cannot replace Imported reference first; it is used by/u
      );

      expect(read(repo, "monke.yml")).toBe(config);
      expect(read(repo, "skills/references/imported/first/MAIN.md")).toBe(reference);
      expect(read(repo, "skills/references/imported/first/assets/accepted.txt")).toBe(
        referenceAsset
      );
      expect(read(repo, `${consumerFolder}/consumer/SKILL.md`)).toBe(acceptedConsumer);
      expect(read(repo, "skills/.monke-restored.json")).toBe(marker);
      expect(
        existsSync(
          path.resolve(repo, consumerFolder, "consumer", "../../references/imported/first/MAIN.md")
        )
      ).toBeTruthy();
    }
  );

  test.each(["remove", "restore", "update"] as const)(
    "%s prunes references together with every obsolete consumer",
    async (action) => {
      const { bin, repo, runtime, upstream } = repoFixture();
      write(
        upstream,
        "skills/second/SKILL.md",
        "---\nname: second\ndescription: Consumer.\n---\nLoad ../../references/imported/first/MAIN.md.\n"
      );
      write(
        upstream,
        "skills/third/SKILL.md",
        "---\nname: third\ndescription: Reference consumer.\n---\nLoad ../first/MAIN.md.\n"
      );
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Publish skill and reference consumers"]);
      await runCliAsync(
        ["skills", "add", upstream, "--repo", "--ref", "--skill", "first", "third"],
        runtime
      );
      await runCliAsync(
        ["skills", "add", upstream, "--repo", "--skill", "first", "second", "third"],
        runtime
      );
      expect(existsSync(path.join(repo, "skills/imported/second/SKILL.md"))).toBeTruthy();
      expect(existsSync(path.join(repo, "skills/references/imported/third/MAIN.md"))).toBeTruthy();
      installFakeCodiff(bin);
      installFakeCodexSummary(bin);
      if (action !== "remove") {
        write(repo, "monke.yml", "skills: []\n");
      }
      await runCliAsync(
        ["skills", action, ...(action === "remove" ? [upstream] : []), "--repo"],
        runtime
      );
      expect(existsSync(path.join(repo, "skills/imported/second"))).toBeFalsy();
      expect(existsSync(path.join(repo, "skills/references/imported/first"))).toBeFalsy();
      expect(existsSync(path.join(repo, "skills/references/imported/third"))).toBeFalsy();
    }
  );

  test("repo reference choices remain authoritative for a source's own skills", async () => {
    const { bin, repo, runtime, sandbox, upstream } = repoFixture();
    const publisher = createRepo(path.join(sandbox, "reference-publisher"), {
      "monke.yml": stringify({
        skills: [
          {
            commit: git(upstream, ["rev-parse", "HEAD"]),
            skills: ["first"],
            source: upstream
          }
        ]
      }),
      "skills/own/SKILL.md": "---\nname: own\ndescription: Own skill.\n---\nOwn instructions.\n"
    });
    await runCliAsync(
      ["skills", "add", `${publisher}#HEAD`, "--repo", "--ref", "--skill", "own"],
      runtime
    );
    write(publisher, "README.md", "Publisher advances.\n");
    git(publisher, ["add", "."]);
    git(publisher, ["commit", "-m", "Advance publisher"]);
    installFakeCodiff(bin);
    installFakeCodexSummary(bin);
    await runCliAsync(["skills", "update", "--repo", "--adapter", "codiff"], runtime);
    expect(read(repo, "skills/references/imported/own/MAIN.md")).toBe("Own instructions.\n");
    expect(existsSync(path.join(repo, "skills/imported/own"))).toBeFalsy();
    await expect(
      runCliAsync(["skills", "add", `${publisher}#HEAD`, "--ref"], runtime)
    ).rejects.toThrow("--ref requires --repo");
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
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const selector = args[args.indexOf("--skill") + 1];
const slug = selector === "*" ? readdirSync(path.join(args[3], "skills"))[0] : selector;
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

  test("restore publishes healthy siblings when reference conversion fails without pruning", async () => {
    const { repo, runtime, sandbox, upstream } = repoFixture();
    const malformed = createRepo(path.join(sandbox, "malformed-reference"), {
      "skills/base/MAIN.md": "Conflicting reference entry.\n",
      "skills/base/SKILL.md": "---\nname: base\ndescription: Base.\n---\nReference body.\n"
    });
    writeRepoImportRecipeStore(repo, {
      recipes: [
        {
          commit: git(upstream, ["rev-parse", "HEAD"]),
          skills: [{ kind: "skill", selector: "first", slug: "first" }],
          source: upstream
        },
        {
          commit: git(malformed, ["rev-parse", "HEAD"]),
          skills: [{ kind: "reference", selector: "base", slug: "base" }],
          source: malformed
        }
      ],
      version: 4
    });
    const config = read(repo, "monke.yml");
    write(repo, "skills/imported/obsolete/SKILL.md", "Retain until every source succeeds.\n");

    await expect(runCliAsync(["skills", "restore", "--repo"], runtime)).rejects.toThrow(
      "upstream guidance already contains MAIN.md"
    );

    expect(read(repo, "skills/imported/first/SKILL.md")).toContain("Pinned first.");
    expect(read(repo, "skills/.monke-restored.json")).toContain(upstream);
    expect(read(repo, "skills/.monke-restored.json")).not.toContain(malformed);
    expect(read(repo, "monke.yml")).toBe(config);
    expect(read(repo, "skills/imported/obsolete/SKILL.md")).toBe(
      "Retain until every source succeeds.\n"
    );
    expect(existsSync(path.join(repo, "skills/references/imported/base"))).toBeFalsy();
    expect(readdirSync(path.join(repo, "tmp"))).toStrictEqual([]);
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
