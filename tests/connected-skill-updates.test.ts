import { cpSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { stringify } from "yaml";

import {
  readImportRecipeStore,
  readRepoImportRecipeStore
} from "../scripts/skill-import-recipes.ts";
import { saveGlobalMonkeConfig } from "../src/global-config.ts";
import { runCliAsync } from "../src/index.ts";
import {
  createRepo,
  git,
  installFakeCodexSummary,
  installFakeCodiff,
  makeTempDir,
  read,
  write,
  writeExecutable,
  writeGlobalInstructionsSource
} from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

function fixture(installKind: "local" | "release" = "local") {
  const sandbox = makeTempDir("connected-skill-updates");
  const monkeHome = path.join(sandbox, "monke");
  const home = path.join(sandbox, "home");
  const install = path.join(monkeHome, "installs", "fixture");
  const checkout = createRepo(path.join(sandbox, "monke-source"), {
    "skills/internal/core/SKILL.md": "---\nname: core\ndescription: Core.\n---\nCore.\n"
  });
  writeGlobalInstructionsSource(checkout, "Team instructions.\n");
  const upstream = createRepo(path.join(sandbox, "upstream"), {
    "skills/base/SKILL.md": "---\nname: base\ndescription: Base.\n---\nFirst version.\n",
    "skills/extra/SKILL.md": "---\nname: extra\ndescription: Extra.\n---\nExtra first.\n"
  });
  const caller = createRepo(path.join(sandbox, "caller"), {
    "monke.yml": "# Unconnected caller.\nskills: []\n"
  });
  write(
    install,
    "install-manifest.json",
    JSON.stringify({
      createdAt: "2026-10-14T12:00:00.000Z",
      ...(installKind === "local"
        ? {
            createdBy: "bun run install:local",
            installId: "fixture",
            sourceCheckout: checkout,
            sourceDirty: false
          }
        : {
            artifactDigest: "0".repeat(64),
            artifactName: "monke-tools-v1.2.3-linux-x64.tar.gz",
            guidanceHashes: {},
            releaseTag: "monke-tools-v1.2.3",
            releaseVersion: "1.2.3"
          }),
      installKind,
      minimumCodiffVersion: "1.14.0",
      platform: "linux-x64",
      schemaVersion: 1,
      sourceCommit: git(checkout, ["rev-parse", "HEAD"]),
      toolBuildIdentity: "fixture"
    })
  );
  if (installKind === "release") {
    cpSync(path.join(checkout, "skills"), path.join(install, "skills"), { recursive: true });
    writeGlobalInstructionsSource(install, "Team instructions.\n");
  }
  symlinkSync(path.join("installs", "fixture"), path.join(monkeHome, "current"), "dir");
  saveGlobalMonkeConfig(monkeHome, {
    diffAdapter: "codiff",
    skillInstallPreference: { targets: [{ kind: "codex" }] },
    version: 1
  });
  const bin = path.join(sandbox, "bin");
  const reviewLog = installFakeCodiff(bin);
  installFakeCodexSummary(bin);
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
  let output = "";
  const runtime = createTestRuntime({
    cwd: caller,
    env: { HOME: home, MONKE_HOME: monkeHome, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    onStderr() {},
    onStdout(message) {
      output += message;
    }
  });
  function advance() {
    write(
      upstream,
      "skills/base/SKILL.md",
      "---\nname: base\ndescription: Base.\n---\nSecond version.\n"
    );
    write(
      upstream,
      "skills/extra/SKILL.md",
      "---\nname: extra\ndescription: Extra.\n---\nExtra second.\n"
    );
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Advance upstream"]);
    return git(upstream, ["rev-parse", "HEAD"]);
  }
  return {
    advance,
    bin,
    caller,
    checkout,
    home,
    install,
    monkeHome,
    output: () => output,
    reviewLog,
    runtime,
    sandbox,
    upstream
  };
}

function reviewDiff(log: string) {
  const launch = readFileSync(log, "utf-8").trim().split("\n");
  expect(launch).toHaveLength(3);
  return git(launch[2] ?? "", ["diff", `${launch[1]}^`, launch[1] ?? ""]);
}

describe("updates through connected local repositories", () => {
  test("bare update advances the local Monke checkout and its installed imports", async () => {
    const f = fixture();
    await runCliAsync(["skills", "add", f.upstream, "--repo", "--skill", "base", "extra"], {
      ...f.runtime,
      cwd: f.checkout
    });
    await runCliAsync(
      ["skills", "policy", f.upstream, "base", "--description", "Personal trigger."],
      f.runtime
    );
    const callerYaml = read(f.caller, "monke.yml");
    const commit = f.advance();

    await runCliAsync(["skills", "update"], f.runtime);

    expect(readRepoImportRecipeStore(f.checkout).recipes[0]?.commit).toBe(commit);
    expect(readImportRecipeStore(path.join(f.monkeHome, "skill-registry")).recipes[0]?.commit).toBe(
      commit
    );
    expect(read(f.checkout, "skills/imported/base/SKILL.md")).toContain("Second version.");
    expect(read(f.home, ".codex/skills/monke-tools/imported/base/SKILL.md")).toContain(
      "Second version."
    );
    expect(read(f.home, ".codex/skills/monke-tools/imported/base/SKILL.md")).toContain(
      "Personal trigger."
    );
    expect(read(f.checkout, "skills/imported/base/SKILL.md")).toContain("description: Base.");
    expect(read(f.caller, "monke.yml")).toBe(callerYaml);
    const diff = reviewDiff(f.reviewLog);
    expect(diff).toContain("monke.yml");
    expect(diff).toContain("Second version.");
  });

  test.each([false, true])("updates linked publishers once with project=%s", async (project) => {
    const f = fixture();
    const publisher = createRepo(path.join(f.sandbox, "publisher"), {
      "skills/own/SKILL.md": "---\nname: own\ndescription: Own.\n---\nOwn.\n"
    });
    write(
      publisher,
      "monke.yml",
      `# Keep publisher settings.\n${stringify({
        apps: {},
        skills: [
          {
            commit: git(f.upstream, ["rev-parse", "HEAD"]),
            skills: [
              "base",
              {
                description: "Publisher reference.",
                kind: "reference",
                modelInvocation: "deny",
                selector: "extra",
                slug: "extra"
              }
            ],
            source: f.upstream
          }
        ]
      })}`
    );
    await runCliAsync(["skills", "restore", "--repo"], { ...f.runtime, cwd: publisher });
    const [previous] = readRepoImportRecipeStore(publisher).recipes;
    const scope = project ? ["--project"] : [];
    await runCliAsync(
      ["skills", "add", publisher, "--name", "publisher", ...scope, "--skill", "base"],
      f.runtime
    );
    await runCliAsync(
      [
        "skills",
        "add",
        path.join(publisher, "skills/own"),
        "--name",
        "authored",
        ...scope,
        "--skill",
        "own"
      ],
      f.runtime
    );
    const commit = f.advance();

    await runCliAsync(["skills", "update", ...scope], f.runtime);

    expect(readRepoImportRecipeStore(publisher).recipes[0]).toStrictEqual({ ...previous, commit });
    expect(read(publisher, "monke.yml")).toContain("# Keep publisher settings.\napps: {}");
    expect(read(publisher, "skills/references/imported/extra/MAIN.md")).toContain("Extra second.");
    const installed = project
      ? path.join(f.caller, ".agents/skills")
      : path.join(f.home, ".codex/skills");
    expect(read(installed, "monke-tools/imported/base/SKILL.md")).toContain("Second version.");
    expect(f.output().split(`Updating repo imports: ${publisher}\n`)).toHaveLength(2);
    const diff = reviewDiff(f.reviewLog);
    expect(diff).toContain("Extra second.");
    expect(diff).toContain("monke.yml");
  });

  test("a missing link does not stop connected healthy imports", async () => {
    const f = fixture();
    await runCliAsync(["skills", "add", f.upstream, "--repo", "--skill", "base"], {
      ...f.runtime,
      cwd: f.checkout
    });
    const missing = createRepo(path.join(f.sandbox, "missing"), {
      "skills/missing/SKILL.md": "---\nname: missing\ndescription: Missing.\n---\nMissing.\n"
    });
    await runCliAsync(["skills", "add", missing], f.runtime);
    rmSync(missing, { recursive: true });
    const commit = f.advance();

    await expect(runCliAsync(["skills", "update"], f.runtime)).rejects.toThrow(/missing/u);

    expect(readRepoImportRecipeStore(f.checkout).recipes[0]?.commit).toBe(commit);
    expect(read(f.home, ".codex/skills/monke-tools/imported/base/SKILL.md")).toContain(
      "Second version."
    );
    expect(reviewDiff(f.reviewLog)).toContain("Second version.");
  });

  test("failed publisher imports keep accepted pins while healthy imports reach consumers", async () => {
    const f = fixture();
    const broken = createRepo(path.join(f.sandbox, "broken-upstream"), {
      "skills/broken/SKILL.md": "---\nname: broken\ndescription: Broken.\n---\nAccepted broken.\n"
    });
    const publisher = createRepo(path.join(f.sandbox, "publisher"), {
      "monke.yml": "skills: []\n"
    });
    const publisherRuntime = { ...f.runtime, cwd: publisher };
    await runCliAsync(["skills", "add", f.upstream, "--repo", "--skill", "base"], publisherRuntime);
    await runCliAsync(["skills", "add", broken, "--repo", "--skill", "broken"], publisherRuntime);
    await runCliAsync(["skills", "add", publisher, "--skill", "base"], f.runtime);
    const previous = readRepoImportRecipeStore(publisher).recipes.find(
      (recipe) => recipe.source === broken
    );
    rmSync(path.join(broken, "skills/broken"), { recursive: true });
    git(broken, ["add", "."]);
    git(broken, ["commit", "-m", "Remove selected skill"]);
    const commit = f.advance();

    await expect(runCliAsync(["skills", "update"], f.runtime)).rejects.toThrow(/broken-upstream/u);

    const { recipes } = readRepoImportRecipeStore(publisher);
    expect(recipes.find((recipe) => recipe.source === broken)).toStrictEqual(previous);
    expect(recipes.find((recipe) => recipe.source === f.upstream)?.commit).toBe(commit);
    expect(read(publisher, "skills/imported/broken/SKILL.md")).toContain("Accepted broken.");
    expect(read(f.home, ".codex/skills/monke-tools/imported/base/SKILL.md")).toContain(
      "Second version."
    );
    expect(reviewDiff(f.reviewLog)).toContain("Second version.");
  });

  test("consumer rejection preserves the publisher's advanced YAML and generated bytes", async () => {
    const f = fixture();
    const publisher = createRepo(path.join(f.sandbox, "publisher"), {
      "monke.yml": "skills: []\n"
    });
    await runCliAsync(["skills", "add", f.upstream, "--repo", "--skill", "base"], {
      ...f.runtime,
      cwd: publisher
    });
    await runCliAsync(["skills", "add", publisher], f.runtime);
    write(
      publisher,
      "skills/base/SKILL.md",
      "---\nname: base\ndescription: Collision.\n---\nConflicting base.\n"
    );
    const commit = f.advance();

    await expect(runCliAsync(["skills", "update"], f.runtime)).rejects.toThrow(/base.*collides/u);

    expect(readRepoImportRecipeStore(publisher).recipes[0]?.commit).toBe(commit);
    expect(read(publisher, "skills/imported/base/SKILL.md")).toContain("Second version.");
    expect(read(f.home, ".codex/skills/monke-tools/imported/base/SKILL.md")).toContain(
      "First version."
    );
    expect(reviewDiff(f.reviewLog)).toContain("Second version.");
  });

  test("release installs and Git-only imports do not connect editable checkouts", async () => {
    const f = fixture("release");
    await runCliAsync(["skills", "add", f.upstream, "--repo", "--skill", "base"], {
      ...f.runtime,
      cwd: f.checkout
    });
    const yaml = read(f.checkout, "monke.yml");
    await runCliAsync(["skills", "add", `${f.upstream}#HEAD`, "--skill", "base"], f.runtime);
    const commit = f.advance();

    await runCliAsync(["skills", "update"], f.runtime);

    expect(read(f.checkout, "monke.yml")).toBe(yaml);
    expect(read(f.checkout, "skills/imported/base/SKILL.md")).toContain("First version.");
    expect(readImportRecipeStore(path.join(f.monkeHome, "skill-registry")).recipes[0]?.commit).toBe(
      commit
    );
    expect(read(f.home, ".codex/skills/monke-tools/imported/base/SKILL.md")).toContain(
      "Second version."
    );
    expect(f.output()).not.toContain("Updating repo imports:");
  });

  test("identical relative source declarations resolve in each connected checkout", async () => {
    const f = fixture();
    const publishers = [];
    for (const slug of ["alpha", "beta"]) {
      const upstream = createRepo(path.join(f.sandbox, slug, "upstream"), {
        [`skills/${slug}/SKILL.md`]: `---\nname: ${slug}\ndescription: ${slug}.\n---\nFirst ${slug}.\n`
      });
      const publisher = createRepo(path.join(f.sandbox, slug, "publisher"), {
        "monke.yml": stringify({
          skills: [
            {
              commit: git(upstream, ["rev-parse", "HEAD"]),
              skills: [slug],
              source: "../upstream#HEAD"
            }
          ]
        })
      });
      await runCliAsync(["skills", "add", publisher, "--name", slug], f.runtime);
      write(
        upstream,
        `skills/${slug}/SKILL.md`,
        `---\nname: ${slug}\ndescription: ${slug}.\n---\nSecond ${slug}.\n`
      );
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", `Update ${slug}`]);
      publishers.push({ commit: git(upstream, ["rev-parse", "HEAD"]), publisher, slug });
    }

    await runCliAsync(["skills", "update"], f.runtime);

    for (const { commit, publisher, slug } of publishers) {
      expect(readRepoImportRecipeStore(publisher).recipes[0]?.commit).toBe(commit);
      expect(read(f.home, `.codex/skills/monke-tools/imported/${slug}/SKILL.md`)).toContain(
        `Second ${slug}.`
      );
    }
  });

  test("failed comparison saving retains the previous baseline for retry", async () => {
    const f = fixture();
    await runCliAsync(["skills", "add", f.upstream, "--skill", "base"], f.runtime);
    f.advance();
    write(f.monkeHome, "skill-reviews", "Obstructed comparison storage.\n");

    await expect(runCliAsync(["skills", "update"], f.runtime)).rejects.toThrow(/skill-reviews/u);
    rmSync(path.join(f.monkeHome, "skill-reviews"));
    await runCliAsync(["skills", "update"], f.runtime);

    const diff = reviewDiff(f.reviewLog);
    expect(diff).toContain("-First version.");
    expect(diff).toContain("+Second version.");
  });
});
