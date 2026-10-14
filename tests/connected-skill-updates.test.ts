import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync
} from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { parseDocument, stringify } from "yaml";

import {
  readImportRecipeStore,
  readRepoImportRecipeStore
} from "../scripts/skill-import-recipes.ts";
import { saveGlobalMonkeConfig } from "../src/global-config.ts";
import { runCliAsync } from "../src/index.ts";
import { shellQuote } from "../src/shell-quote.ts";
import type { Runtime } from "../src/types.ts";
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

function pauseCommand(runtime: Runtime, command = "codex") {
  const entered = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  return {
    entered: entered.promise,
    release: () => {
      released.resolve(undefined);
    },
    runtime: {
      ...runtime,
      async execAsync(...args: Parameters<Runtime["execAsync"]>) {
        if (args[0] === command) {
          entered.resolve(undefined);
          await released.promise;
        }
        return await runtime.execAsync(...args);
      }
    }
  };
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

  test.each([
    ["missing", false],
    ["file", false],
    ["missing", true],
    ["file", true]
  ] as const)(
    "a %s link does not stop connected healthy imports in project=%s",
    async (kind, project) => {
      const f = fixture();
      await runCliAsync(["skills", "add", f.upstream, "--repo", "--skill", "base"], {
        ...f.runtime,
        cwd: f.checkout
      });
      const scope = project ? ["--project"] : [];
      if (project) {
        await runCliAsync(["skills", "add", f.checkout, "--project", "--skill", "base"], f.runtime);
      }
      const missing = createRepo(path.join(f.sandbox, "missing"), {
        "skills/missing/SKILL.md": "---\nname: missing\ndescription: Missing.\n---\nMissing.\n"
      });
      await runCliAsync(["skills", "add", missing, ...scope], f.runtime);
      rmSync(missing, { recursive: true });
      if (kind === "file") {
        write(f.sandbox, "missing", "The linked checkout was replaced by a file.\n");
      }
      const commit = f.advance();

      await expect(runCliAsync(["skills", "update", ...scope], f.runtime)).rejects.toThrow(
        /missing/u
      );

      expect(readRepoImportRecipeStore(f.checkout).recipes[0]?.commit).toBe(commit);
      const installed = project
        ? path.join(f.caller, ".agents/skills")
        : path.join(f.home, ".codex/skills");
      expect(read(installed, "monke-tools/imported/base/SKILL.md")).toContain("Second version.");
      expect(reviewDiff(f.reviewLog)).toContain("Second version.");
    }
  );

  test.each([
    { firstFails: false, secondFails: false },
    { firstFails: false, secondFails: true },
    { firstFails: true, secondFails: false }
  ])(
    "publisher comparisons serialize saving and retry baselines: %j",
    async ({ firstFails, secondFails }) => {
      const f = fixture();
      const repoRuntime = { ...f.runtime, cwd: f.checkout };
      await runCliAsync(
        ["skills", "add", f.upstream, "--repo", "--skill", "base", "extra"],
        repoRuntime
      );
      await runCliAsync(["skills", "list"], f.runtime);
      const original = readRepoImportRecipeStore(f.checkout).recipes[0]?.commit;
      const second = f.advance();
      const globalSummary = pauseCommand(f.runtime);
      const repoSummary = pauseCommand(repoRuntime);
      const globalUpdate = runCliAsync(["skills", "update"], globalSummary.runtime).then(
        () => "",
        String
      );
      let repoUpdate: Promise<string> | undefined;
      try {
        await globalSummary.entered;
        write(
          f.upstream,
          "skills/base/SKILL.md",
          "---\nname: base\ndescription: Base.\n---\nThird version.\n"
        );
        git(f.upstream, ["add", "."]);
        git(f.upstream, ["commit", "-m", "Advance during review"]);
        const current = git(f.upstream, ["rev-parse", "HEAD"]);
        repoUpdate = runCliAsync(["skills", "update", "--repo"], repoSummary.runtime).then(
          () => "",
          String
        );
        await expect(
          Promise.race([
            repoSummary.entered.then(() => "entered"),
            new Promise<string>((resolve) => {
              setTimeout(() => {
                resolve("waiting");
              }, 250);
            })
          ])
        ).resolves.toBe("waiting");
        expect(readRepoImportRecipeStore(f.checkout).recipes[0]?.commit).toBe(second);
        if (firstFails) {
          write(f.monkeHome, "skill-reviews", "Obstructed first comparison.\n");
        }
        globalSummary.release();
        await expect(globalUpdate).resolves.toMatch(firstFails ? /skill-reviews/u : /^$/u);
        if (firstFails) {
          rmSync(path.join(f.monkeHome, "skill-reviews"));
        } else {
          rmSync(f.reviewLog);
        }
        await repoSummary.entered;
        if (secondFails) {
          rmSync(path.join(f.monkeHome, "skill-reviews"), { force: true, recursive: true });
          write(f.monkeHome, "skill-reviews", "Obstructed second comparison.\n");
        }
        repoSummary.release();
        await expect(repoUpdate).resolves.toMatch(secondFails ? /skill-reviews/u : /^$/u);
        if (secondFails) {
          rmSync(path.join(f.monkeHome, "skill-reviews"));
          await runCliAsync(["skills", "update", "--repo"], repoRuntime);
        }
        const diff = reviewDiff(f.reviewLog);
        expect(diff).toContain(`-  - commit: ${second}`);
        expect(diff).toContain(`+  - commit: ${current}`);
        expect(diff).toContain("-Second version.");
        expect(diff).toContain("+Third version.");
        expect(diff).not.toContain("-Extra first.");
        let retried = diff;
        if (firstFails) {
          rmSync(f.reviewLog);
          await runCliAsync(["skills", "update"], f.runtime);
          retried = reviewDiff(f.reviewLog);
        }
        expect(retried).toContain(`-  - commit: ${firstFails ? original : second}`);
        expect(retried).toContain(`+  - commit: ${current}`);
        expect(retried.includes("-Extra first.")).toBe(firstFails);
        expect(retried.includes("+Extra second.")).toBe(firstFails);
      } finally {
        globalSummary.release();
        repoSummary.release();
        await Promise.allSettled([globalUpdate, ...(repoUpdate ? [repoUpdate] : [])]);
      }
    }
  );

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

  test.each(["nested", "alias"])(
    "project recovery preserves a %s publisher's accepted updates",
    async (kind) => {
      const f = fixture();
      const publisher = createRepo(
        path.join(f.caller, kind === "nested" ? ".agents/skills/publisher" : "publisher"),
        { "monke.yml": "skills: []\n" }
      );
      await runCliAsync(["skills", "add", f.upstream, "--repo", "--skill", "base"], {
        ...f.runtime,
        cwd: publisher
      });
      if (kind === "alias") {
        mkdirSync(path.join(f.caller, ".agents"), { recursive: true });
        symlinkSync(path.join(publisher, "skills"), path.join(f.caller, ".agents/skills"), "dir");
      }
      await runCliAsync(["skills", "add", publisher, "--project", "--skill", "base"], f.runtime);
      const missing = createRepo(path.join(f.sandbox, "missing"), {
        "skills/missing/SKILL.md": "---\nname: missing\ndescription: Missing.\n---\nMissing.\n"
      });
      await runCliAsync(["skills", "add", missing, "--project"], f.runtime);
      rmSync(missing, { recursive: true });
      const commit = f.advance();
      const exclude = path.join(f.caller, ".git/info/exclude");
      f.runtime.writeStderr = (message) => {
        if (message.startsWith("Linked monke-tools skills")) {
          chmodSync(exclude, 0o444);
        }
      };
      try {
        await expect(runCliAsync(["skills", "update", "--project"], f.runtime)).rejects.toThrow(
          /not writable/u
        );

        expect(readRepoImportRecipeStore(publisher).recipes[0]?.commit).toBe(commit);
        expect(read(publisher, "skills/imported/base/SKILL.md")).toContain("Second version.");
        expect(reviewDiff(f.reviewLog)).toContain("+Second version.");
      } finally {
        chmodSync(exclude, 0o644);
      }
    }
  );

  test.each(["nested", "alias"])(
    "concurrent publisher updates wait for %s project publication recovery",
    async (kind) => {
      const f = fixture();
      const publisher = createRepo(
        path.join(f.caller, kind === "nested" ? ".agents/skills/publisher" : "publisher"),
        { "monke.yml": "skills: []\n" }
      );
      const repoRuntime = { ...f.runtime, cwd: publisher };
      await runCliAsync(["skills", "add", f.upstream, "--repo", "--skill", "base"], repoRuntime);
      if (kind === "alias") {
        mkdirSync(path.join(f.caller, ".agents"), { recursive: true });
        symlinkSync(path.join(publisher, "skills"), path.join(f.caller, ".agents/skills"), "dir");
      }
      await runCliAsync(["skills", "add", publisher, "--project", "--skill", "base"], f.runtime);
      await runCliAsync(
        [
          "skills",
          "add",
          "--project",
          "--name",
          "installer",
          "--command",
          "true",
          "--cwd",
          f.upstream,
          "--skill",
          "extra"
        ],
        f.runtime
      );
      const accepted = f.advance();
      const installer = pauseCommand(f.runtime, "sh");
      const publisherSummary = pauseCommand(repoRuntime);
      const exclude = path.join(f.caller, ".git/info/exclude");
      installer.runtime.writeStderr = (message) => {
        if (message.startsWith("Linked monke-tools skills")) {
          chmodSync(exclude, 0o444);
        }
      };
      const projectUpdate = runCliAsync(["skills", "update", "--project"], installer.runtime).then(
        () => "",
        String
      );
      let publisherUpdate: Promise<string> | undefined;
      try {
        await installer.entered;
        expect(readRepoImportRecipeStore(publisher).recipes[0]?.commit).toBe(accepted);
        write(
          f.upstream,
          "skills/base/SKILL.md",
          "---\nname: base\ndescription: Base.\n---\nThird version.\n"
        );
        git(f.upstream, ["add", "."]);
        git(f.upstream, ["commit", "-m", "Concurrent accepted revision"]);
        const newest = git(f.upstream, ["rev-parse", "HEAD"]);
        publisherUpdate = runCliAsync(
          ["skills", "update", "--repo"],
          publisherSummary.runtime
        ).then(() => "", String);
        await expect(
          Promise.race([
            publisherSummary.entered.then(() => "entered"),
            new Promise<string>((resolve) => {
              setTimeout(() => {
                resolve("waiting");
              }, 250);
            })
          ])
        ).resolves.toBe("waiting");
        installer.release();
        await expect(projectUpdate).resolves.toMatch(/not writable/u);
        await publisherSummary.entered;
        expect(readRepoImportRecipeStore(publisher).recipes[0]?.commit).toBe(newest);
        expect(read(publisher, "skills/imported/base/SKILL.md")).toContain("Third version.");
        publisherSummary.release();
        await expect(publisherUpdate).resolves.toBe("");
      } finally {
        installer.release();
        publisherSummary.release();
        chmodSync(exclude, 0o644);
        await Promise.allSettled([projectUpdate, ...(publisherUpdate ? [publisherUpdate] : [])]);
      }
    }
  );

  test.each([
    { command: "restore", connected: false },
    { command: "restore", connected: true },
    { command: "update", connected: false }
  ])(
    "saved repo installers remain replayable: %j",
    async ({ command, connected }) => {
      const f = fixture();
      const publisher = createRepo(path.join(f.sandbox, "publisher"), {
        "monke.yml": "skills: []\n"
      });
      await runCliAsync(["skills", "add", f.upstream, "--repo", "--skill", "base", "extra"], {
        ...f.runtime,
        cwd: publisher
      });
      const original = readRepoImportRecipeStore(publisher).recipes[0]?.commit;
      writeExecutable(
        path.join(f.bin, "mt"),
        `#!/bin/sh
exec ${shellQuote(Bun.which("bun") ?? "bun")} ${shellQuote(path.resolve(import.meta.dirname, "../src/index.ts"))} "$@"
`
      );
      if (connected) {
        await runCliAsync(["skills", "add", publisher, "--project", "--skill", "base"], f.runtime);
      }
      await runCliAsync(
        [
          "skills",
          "add",
          "--project",
          "--name",
          "restorer",
          "--command",
          `mt skills ${command} --repo`,
          "--cwd",
          publisher,
          "--skill",
          "extra"
        ],
        f.runtime
      );
      const newest = f.advance();
      const advances = connected || command === "update";

      await runCliAsync(["skills", "update", "--project"], f.runtime);

      expect(readRepoImportRecipeStore(publisher).recipes[0]?.commit).toBe(
        advances ? newest : original
      );
      expect(read(publisher, "skills/imported/extra/SKILL.md")).toContain(
        advances ? "Extra second." : "Extra first."
      );
      expect(read(f.caller, ".agents/skills/monke-tools/imported/extra/SKILL.md")).toContain(
        advances ? "Extra second." : "Extra first."
      );
    },
    10_000
  );

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

  test("failed comparison saving retains publisher YAML and guidance for retry", async () => {
    const f = fixture();
    await runCliAsync(["skills", "add", f.upstream, "--repo", "--skill", "base"], {
      ...f.runtime,
      cwd: f.checkout
    });
    await runCliAsync(["skills", "list"], f.runtime);
    const previous = readRepoImportRecipeStore(f.checkout).recipes[0]?.commit;
    const commit = f.advance();
    write(f.monkeHome, "skill-reviews", "Obstructed comparison storage.\n");

    await expect(runCliAsync(["skills", "update"], f.runtime)).rejects.toThrow(/skill-reviews/u);
    expect(readRepoImportRecipeStore(f.checkout).recipes[0]?.commit).toBe(commit);
    rmSync(path.join(f.monkeHome, "skill-reviews"));
    await runCliAsync(["skills", "update"], f.runtime);

    const diff = reviewDiff(f.reviewLog);
    expect(diff).toContain(`-  - commit: ${previous}`);
    expect(diff).toContain(`+  - commit: ${commit}`);
    expect(diff).toContain("monke.yml");
    expect(diff).toContain("-First version.");
    expect(diff).toContain("+Second version.");
  });

  test.each(["consumer before", "publisher after"])(
    "incomplete %s snapshots retain baselines without publishing a comparison",
    async (phase) => {
      const f = fixture();
      await runCliAsync(["skills", "add", f.upstream, "--repo", "--skill", "base"], {
        ...f.runtime,
        cwd: f.checkout
      });
      await runCliAsync(["skills", "list"], f.runtime);
      const gate = path.join(f.sandbox, "corrupt-publisher");
      const yaml = path.join(f.checkout, "monke.yml");
      if (phase === "publisher after") {
        await runCliAsync(
          [
            "skills",
            "add",
            "--name",
            "installer",
            "--command",
            `if test -f ${shellQuote(gate)}; then cp ${shellQuote(yaml)} ${shellQuote(`${yaml}.accepted`)}; printf 'skills: [' > ${shellQuote(yaml)}; fi`,
            "--cwd",
            f.upstream,
            "--skill",
            "extra"
          ],
          f.runtime
        );
      }
      const previous = readRepoImportRecipeStore(f.checkout).recipes[0]?.commit;
      const commit = f.advance();
      const baseline = path.join(
        f.monkeHome,
        "skill-registry/.monke-skill-baseline/skills/imported/base/SKILL.md"
      );
      if (phase === "consumer before") {
        chmodSync(baseline, 0o000);
      } else {
        write(f.sandbox, "corrupt-publisher", "Corrupt YAML only during update.\n");
      }
      try {
        await expect(runCliAsync(["skills", "update"], f.runtime)).rejects.toThrow(
          phase === "consumer before" ? /EACCES/u : /monke\.yml/u
        );
        expect(existsSync(path.join(f.monkeHome, "skill-reviews/comparisons.json"))).toBeFalsy();
        expect(existsSync(f.reviewLog)).toBeFalsy();
      } finally {
        if (phase === "consumer before") {
          chmodSync(baseline, 0o644);
        } else {
          cpSync(`${yaml}.accepted`, yaml);
          rmSync(gate);
        }
      }
      expect(readRepoImportRecipeStore(f.checkout).recipes[0]?.commit).toBe(commit);
      await runCliAsync(["skills", "update"], f.runtime);

      const diff = reviewDiff(f.reviewLog);
      expect(diff).toContain(`-  - commit: ${previous}`);
      expect(diff).toContain(`+  - commit: ${commit}`);
      expect(diff).toContain("-First version.");
      expect(diff).toContain("+Second version.");
    }
  );

  test("the comparison includes publisher restoration performed by consumer refresh", async () => {
    const f = fixture();
    const publisher = createRepo(path.join(f.sandbox, "publisher"), {
      "monke.yml": "skills: []\n"
    });
    await runCliAsync(["skills", "add", f.upstream, "--repo", "--skill", "base"], {
      ...f.runtime,
      cwd: publisher
    });
    await runCliAsync(["skills", "add", publisher, "--name", "publisher"], f.runtime);
    await runCliAsync(
      ["skills", "policy", "publisher", "base", "--description", "Consumer trigger."],
      f.runtime
    );
    const document = parseDocument(read(publisher, "monke.yml"));
    document.setIn(
      ["skills", 0, "skills"],
      [{ description: "Updated publisher trigger.", slug: "base" }]
    );
    write(publisher, "monke.yml", document.toString());
    git(f.upstream, ["rm", "-r", "skills/base"]);
    git(f.upstream, ["commit", "-m", "Remove publisher selection"]);

    await expect(runCliAsync(["skills", "update"], f.runtime)).rejects.toThrow(/base/u);

    expect(read(publisher, "skills/imported/base/SKILL.md")).toContain(
      "Updated publisher trigger."
    );
    expect(read(f.home, ".codex/skills/monke-tools/imported/base/SKILL.md")).toContain(
      "Consumer trigger."
    );
    expect(reviewDiff(f.reviewLog)).toContain("+description: Updated publisher trigger.");
  });
});
