import { ok } from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import pc from "picocolors";
import { describe, expect, test, vi } from "vite-plus/test";
import { parse } from "yaml";

import {
  buildGroupedSkillOptions,
  extractSecurityRiskAssessment,
  parseAvailableSkillGroups,
  runImportSkills
} from "../scripts/import-skills.ts";
import { runReviewSkills } from "../scripts/review-skills.ts";
import {
  mergeImportedGuidanceIntoRecipeStore,
  readImportRecipeStore,
  writeImportRecipeStore
} from "../scripts/skill-import-recipes.ts";
import { restoreLockedImports } from "../scripts/skill-lock.ts";
import { runUpdateSkills } from "../scripts/update-skills.ts";
import { createRepo, git, makeTempDir, read, write } from "./helpers.ts";

describe("locked skill command workflows", () => {
  test("annotated discovery tags pin commits without overriding same-named branches", async () => {
    const sandbox = makeTempDir("skill-lock-annotated-tag");
    const upstream = createRepo(path.join(sandbox, "upstream"), {
      "alpha/SKILL.md": "---\nname: alpha\ndescription: Tagged fixture\n---\n\nTagged content.\n"
    });
    const commit = git(upstream, ["rev-parse", "HEAD"]);
    git(upstream, ["tag", "--annotate", "release", "--message", "Accepted release"]);
    git(upstream, ["tag", "--annotate", "main", "--message", "Older tag sharing branch name"]);
    const tagObject = git(upstream, ["rev-parse", "refs/tags/main"]);
    write(
      upstream,
      "alpha/SKILL.md",
      "---\nname: alpha\ndescription: Later fixture\n---\n\nLater content.\n"
    );
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Advance branch beyond release"]);
    const branchCommit = git(upstream, ["rev-parse", "HEAD"]);
    const originalCwd = process.cwd();
    const originalHome = process.env.MONKE_HOME;
    try {
      process.env.MONKE_HOME = path.join(sandbox, "home");
      for (const [index, selection] of [
        { content: "Tagged content.", pin: commit, ref: "release" },
        { content: "Later content.", pin: branchCommit, ref: "main" },
        { content: "Tagged content.", pin: commit, ref: "refs/tags/main" },
        { content: "Tagged content.", pin: commit, ref: tagObject },
        { content: "Later content.", pin: branchCommit, ref: branchCommit }
      ].entries()) {
        const consumer = path.join(sandbox, `consumer-${index}`);
        mkdirSync(consumer);
        process.chdir(consumer);
        await runImportSkills([`${upstream}#${selection.ref}`], {
          selectSkills: () => ["alpha"],
          writeMessage() {}
        });
        expect(readImportRecipeStore(consumer).recipes[0]?.lock?.commit).toBe(selection.pin);
        expect(read(consumer, "skills/imported/alpha/SKILL.md")).toContain(selection.content);
      }
    } finally {
      process.chdir(originalCwd);
      process.env.MONKE_HOME = originalHome;
    }
  }, 30_000);

  test("locked imports retain accepted bytes across host collation locales", async () => {
    const sandbox = makeTempDir("skill-lock-host-collation");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath: path.join(sandbox, "skills-cwd.log"),
      skillsLogPath: path.join(sandbox, "skills.log")
    });
    const nativeLocaleCompare = String.prototype.localeCompare;
    const compare = vi.spyOn(String.prototype, "localeCompare");
    try {
      compare.mockImplementation(function englishComparison(this: string, other: string) {
        return nativeLocaleCompare.call(this, other, "en");
      });
      await withFakeNpx(sandbox, fakeBinDirectory, async () => {
        await runImportSkills(["owner/aa"], {
          selectSkills: () => ["aa", "z"],
          writeMessage() {}
        });
        await runImportSkills(["owner/z"], {
          selectSkills: () => ["other"],
          writeMessage() {}
        });
        const acceptedLock = read(sandbox, "skills.lock.json");
        compare.mockImplementation(function danishComparison(this: string, other: string) {
          return nativeLocaleCompare.call(this, other, "da");
        });
        rmSync(path.join(sandbox, "skills/imported"), { recursive: true });
        expect(() => {
          restoreLockedImports(sandbox);
        }).not.toThrow();
        expect(read(sandbox, "skills/imported/aa/SKILL.md")).toBe("new aa");
        expect(read(sandbox, "skills/imported/z/SKILL.md")).toBe("new z");
        writeImportRecipeStore(sandbox, readImportRecipeStore(sandbox));
        expect(read(sandbox, "skills.lock.json")).toBe(acceptedLock);
      });
    } finally {
      compare.mockRestore();
    }
  });

  test("rejects host-dependent upstream links before the published importer copies them", async () => {
    const sandbox = makeTempDir("skill-lock-source-links");
    const upstream = createRepo(path.join(sandbox, "upstream"), {
      "alpha/SKILL.md": "---\nname: alpha\ndescription: Shared fixture\n---\n\nAlpha.\n",
      "shared/details.md": "Shared checkout content.\n"
    });
    symlinkSync("../shared/details.md", path.join(upstream, "alpha/shared.md"));
    symlinkSync("../shared", path.join(upstream, "alpha/assets"));
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Confined shared assets"]);
    const originalCwd = process.cwd();
    const originalHome = process.env.MONKE_HOME;
    const originalPath = process.env.PATH;
    try {
      process.chdir(sandbox);
      process.env.MONKE_HOME = path.join(sandbox, "home");
      process.env.PATH = `${installReviewViewer(sandbox)}${path.delimiter}${originalPath}`;
      await runImportSkills([upstream], { selectSkills: () => ["alpha"], writeMessage() {} });
      expect(read(sandbox, "skills/imported/alpha/shared.md")).toBe("Shared checkout content.\n");
      expect(read(sandbox, "skills/imported/alpha/assets/details.md")).toBe(
        "Shared checkout content.\n"
      );
      const acceptedLock = read(sandbox, "skills.lock.json");
      const outside = path.join(sandbox, "host-specific.txt");
      writeFileSync(outside, "Host-dependent content.\n");
      symlinkSync(outside, path.join(upstream, "alpha/host.md"));
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Escaping source link"]);
      await expect(runUpdateSkills([], { writeMessage() {} })).rejects.toThrow(
        /upstream symlink escapes/iu
      );
      expect(read(sandbox, "skills.lock.json")).toBe(acceptedLock);
      expect(existsSync(path.join(sandbox, "skills/imported/alpha/host.md"))).toBeFalsy();
      expect(read(sandbox, "skills/imported/alpha/shared.md")).toBe("Shared checkout content.\n");
    } finally {
      process.chdir(originalCwd);
      process.env.MONKE_HOME = originalHome;
      process.env.PATH = originalPath;
    }
  }, 30_000);

  test("pins and restores exact published-importer content before deliberately updating a supporting file", async () => {
    const sandbox = makeTempDir("skill-lock-published");
    const monkeHome = path.join(sandbox, "home $USER `literal` $(printf expanded) 'quote'");
    const upstream = createRepo(path.join(sandbox, "upstream"), {
      "alpha/references/details.md": "Reference one.\n",
      "alpha/SKILL.md": "---\nname: alpha\ndescription: Fixture skill\n---\n\nVersion one.\n"
    });
    const commit = git(upstream, ["rev-parse", "HEAD"]).trim();
    const originalCwd = process.cwd();
    const originalHome = process.env.MONKE_HOME;
    const originalPath = process.env.PATH;
    try {
      process.chdir(sandbox);
      process.env.MONKE_HOME = monkeHome;
      await runImportSkills([upstream], { selectSkills: () => ["alpha"], writeMessage() {} });
      expect(readImportRecipeStore(sandbox).recipes[0]).toMatchObject({ lock: { commit } });
      expect(read(sandbox, "skills/imported/alpha/references/details.md")).toBe("Reference one.\n");
      const originalLock = read(sandbox, "skills.lock.json");
      write(upstream, "alpha/references/details.md", "Reference two.\n");
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Supporting file update"]);
      rmSync(path.join(sandbox, "skills/imported"), { recursive: true });
      const restore = () =>
        Bun.spawnSync(
          [process.execPath, path.resolve(import.meta.dirname, "../scripts/restore-skills.ts")],
          { cwd: sandbox, env: process.env }
        );
      const restored = restore();
      expect(restored.exitCode).toBe(0);
      expect(read(sandbox, "skills/imported/alpha/references/details.md")).toBe("Reference one.\n");
      expect(read(sandbox, "skills.lock.json")).toBe(originalLock);

      const imported = path.join(sandbox, "skills/imported/alpha");
      const external = path.join(sandbox, "external-alpha");
      renameSync(imported, external);
      symlinkSync(external, imported);
      expect(restore().exitCode).toBe(0);
      expect(lstatSync(imported).isDirectory()).toBeTruthy();
      expect(read(sandbox, "skills/imported/alpha/references/details.md")).toBe("Reference one.\n");
      expect(read(sandbox, "skills.lock.json")).toBe(originalLock);

      const invalidLock = readImportRecipeStore(sandbox);
      const invalidPin = invalidLock.recipes[0]?.lock;
      ok(invalidPin);
      invalidPin.digest = "0".repeat(64);
      writeImportRecipeStore(sandbox, invalidLock);
      const rejectedLock = read(sandbox, "skills.lock.json");
      const rejected = restore();
      expect(rejected.exitCode).toBe(1);
      expect(rejected.stderr.toString()).toContain("digest mismatch");
      expect(read(sandbox, "skills.lock.json")).toBe(rejectedLock);
      expect(read(sandbox, "skills/imported/alpha/references/details.md")).toBe("Reference one.\n");
      write(sandbox, "skills.lock.json", originalLock);

      const viewer = installReviewViewer(sandbox);
      process.env.PATH = `${viewer}${path.delimiter}${originalPath}`;
      let output = "";
      await runUpdateSkills([], {
        writeMessage: (message) => {
          output += message;
        }
      });
      expect(readImportRecipeStore(sandbox).recipes[0]?.lock?.commit).toBe(
        git(upstream, ["rev-parse", "HEAD"]).trim()
      );
      const { commit: candidate, repository } = readDeliveredComparison(sandbox);
      expect(
        git(repository, ["diff", "--name-only", `${candidate}^`, candidate])
          .trim()
          .split("\n")
      ).toStrictEqual(["skills.lock.json", "skills/imported/alpha/references/details.md"]);
      expect(
        git(repository, ["show", `${candidate}^:skills/imported/alpha/references/details.md`])
      ).toBe("Reference one.");
      expect(
        git(repository, ["show", `${candidate}:skills/imported/alpha/references/details.md`])
      ).toBe("Reference two.");
      writeFileSync(
        path.join(viewer, "mt"),
        `#!/bin/sh\nprintf '%s\\n' "$@" > '${path.join(sandbox, "reopen-arguments")}'\n`
      );
      chmodSync(path.join(viewer, "mt"), 0o755);
      const reopen = output
        .split("\n")
        .find((line) => line.startsWith("Complete skill review: "))
        ?.slice("Complete skill review: ".length);
      ok(reopen);
      expect(Bun.spawnSync(["sh", "-c", reopen], { cwd: sandbox, env: process.env }).exitCode).toBe(
        0
      );
      expect(read(sandbox, "reopen-arguments").trim().split("\n")).toStrictEqual([
        "diff",
        "--commit",
        candidate,
        "--path",
        repository
      ]);
      write(upstream, "alpha/references/details.md", "Reference three.\n");
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Next supporting-file update"]);
      writeFileSync(
        path.join(viewer, "codiff"),
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'codiff v1.14.0'; else echo 'Viewer failed' >&2; exit 7; fi\n"
      );
      await expect(runUpdateSkills([], { writeMessage() {} })).rejects.toThrow(
        /changes remain applied; review delivery failed.*Reopen with:/su
      );
      expect(read(sandbox, "skills/imported/alpha/references/details.md")).toBe(
        "Reference three.\n"
      );
      expect(readImportRecipeStore(sandbox).recipes[0]?.lock?.commit).toBe(
        git(upstream, ["rev-parse", "HEAD"])
      );
      writeFileSync(
        path.join(viewer, "lfv"),
        `#!/bin/sh\nprintf '%s\\n' "$@" > '${path.join(sandbox, "lfv-delivery")}'\nprintf '%s\\n' '{"version":1,"ok":true,"command":"review.create","data":{"url":"https://viewer.example.test/complete-skills"}}'\n`
      );
      chmodSync(path.join(viewer, "lfv"), 0o755);
      writeFileSync(path.join(monkeHome, "config.yml"), "version: 1\ndiffAdapter: lfv\n");
      write(upstream, "alpha/references/details.md", "Reference four.\n");
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Configured LFV update"]);
      let lfvOutput = "";
      await runUpdateSkills([], {
        writeMessage: (message) => {
          lfvOutput += message;
        }
      });
      const delivered = read(sandbox, "lfv-delivery").trim().split("\n");
      expect(delivered.slice(0, 3)).toStrictEqual(["--json", "review", "create"]);
      expect(delivered.slice(4, 7)).toStrictEqual(["--source", "commit", "--ref"]);
      const { 3: reviewPath, 7: reviewCommit } = delivered;
      ok(reviewPath && reviewCommit);
      expect(reviewPath).toBe(repository);
      expect(
        git(reviewPath, ["show", `${reviewCommit}^:skills/imported/alpha/references/details.md`])
      ).toBe("Reference three.");
      expect(
        git(reviewPath, ["show", `${reviewCommit}:skills/imported/alpha/references/details.md`])
      ).toBe("Reference four.");
      expect(lfvOutput).toContain("https://viewer.example.test/complete-skills");
    } finally {
      process.chdir(originalCwd);
      process.env.MONKE_HOME = originalHome;
      process.env.PATH = originalPath;
    }
  }, 30_000);

  test("reviews the entire ignored collection, reconstructs history, and reclaims all but three comparisons", async () => {
    const sandbox = makeTempDir("skill-lock-complete-review");
    const upstream = createRepo(path.join(sandbox, "upstream"), {
      "alpha/.hidden": "Hidden one.\n",
      "alpha/references/deleted.md": "Removed content.\n",
      "alpha/references/details.md": "Details one.\n",
      "alpha/references/old-name.md": "The renamed content remains identical.\n",
      "alpha/scripts/run.sh": "#!/bin/sh\necho one\n",
      "alpha/SKILL.md": "---\nname: alpha\ndescription: Fixture skill\n---\n\nVersion one.\n",
      "bravo/references/details.md": "Bravo details one.\n",
      "bravo/SKILL.md": "---\nname: bravo\ndescription: Fixture reference\n---\n\nReference one.\n"
    });
    writeFileSync(path.join(upstream, "alpha/image.bin"), Buffer.from([0, 1, 2, 3]));
    chmodSync(path.join(upstream, "alpha/scripts/run.sh"), 0o755);
    symlinkSync("details.md", path.join(upstream, "alpha/references/alias.md"));
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Complete asset baseline"]);
    const consumer = createRepo(path.join(sandbox, "consumer"), {
      ".gitignore": "skills/imported/\nskills/references/imported/\ntmp/\n"
    });
    const originalCwd = process.cwd();
    const originalHome = process.env.MONKE_HOME;
    const originalPath = process.env.PATH;
    try {
      process.chdir(consumer);
      process.env.MONKE_HOME = path.join(sandbox, "home");
      process.env.PATH = `${installReviewViewer(sandbox)}${path.delimiter}${originalPath}`;
      await runImportSkills([upstream], { selectSkills: () => ["alpha"], writeMessage() {} });
      await runImportSkills([upstream, "--ref"], {
        selectSkills: () => ["bravo"],
        writeMessage() {}
      });
      git(consumer, ["add", "."]);
      git(consumer, ["commit", "-m", "Accept baseline lock"]);
      const beforeSourceCommit = git(consumer, ["rev-parse", "HEAD"]);
      const sourceRevisions = [beforeSourceCommit];
      expect(git(consumer, ["ls-files", "skills/imported", "skills/references/imported"])).toBe("");

      write(
        upstream,
        "alpha/SKILL.md",
        "---\nname: alpha\ndescription: Fixture skill\n---\n\nVersion two.\n"
      );
      write(upstream, "alpha/references/details.md", "Details two.\n");
      renameSync(
        path.join(upstream, "alpha/references/old-name.md"),
        path.join(upstream, "alpha/references/new-name.md")
      );
      rmSync(path.join(upstream, "alpha/references/deleted.md"));
      rmSync(path.join(upstream, "alpha/references/alias.md"));
      symlinkSync("new-name.md", path.join(upstream, "alpha/references/alias.md"));
      write(upstream, "alpha/references/added.md", "Added content.\n");
      write(upstream, "alpha/scripts/run.sh", "#!/bin/sh\necho two\n");
      chmodSync(path.join(upstream, "alpha/scripts/run.sh"), 0o644);
      write(upstream, "alpha/.hidden", "Hidden two.\n");
      writeFileSync(path.join(upstream, "alpha/image.bin"), Buffer.from([0, 4, 5, 6]));
      write(
        upstream,
        "bravo/SKILL.md",
        "---\nname: bravo\ndescription: Fixture reference\n---\n\nReference two.\n"
      );
      write(upstream, "bravo/references/details.md", "Bravo details two.\n");
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Complete collection update"]);
      await runUpdateSkills([], { writeMessage() {} });
      const first = readDeliveredComparison(sandbox);
      const changed = git(first.repository, [
        "diff",
        "--no-renames",
        "--name-only",
        `${first.commit}^`,
        first.commit
      ]).split("\n");
      expect(changed).toStrictEqual([
        "skills.lock.json",
        "skills/imported/alpha/.hidden",
        "skills/imported/alpha/SKILL.md",
        "skills/imported/alpha/image.bin",
        "skills/imported/alpha/references/added.md",
        "skills/imported/alpha/references/alias.md",
        "skills/imported/alpha/references/deleted.md",
        "skills/imported/alpha/references/details.md",
        "skills/imported/alpha/references/new-name.md",
        "skills/imported/alpha/references/old-name.md",
        "skills/imported/alpha/scripts/run.sh",
        "skills/references/imported/bravo/MAIN.md",
        "skills/references/imported/bravo/references/details.md"
      ]);
      expect(
        git(first.repository, [
          "ls-tree",
          `${first.commit}^`,
          "skills/imported/alpha/scripts/run.sh"
        ])
      ).toContain("100755");
      expect(
        git(first.repository, ["ls-tree", first.commit, "skills/imported/alpha/scripts/run.sh"])
      ).toContain("100644");
      // The published importer dereferences upstream links; review includes the delivered bytes.
      expect(
        git(first.repository, ["show", `${first.commit}:skills/imported/alpha/references/alias.md`])
      ).toBe("The renamed content remains identical.");
      const image = Bun.spawnSync(
        ["git", "show", `${first.commit}:skills/imported/alpha/image.bin`],
        { cwd: first.repository }
      );
      expect([...image.stdout]).toStrictEqual([0, 4, 5, 6]);
      expect(git(consumer, ["status", "--short"])).toBe("M skills.lock.json");
      git(consumer, ["add", "."]);
      git(consumer, ["commit", "-m", "Accept upgraded lock"]);
      const afterSourceCommit = git(consumer, ["rev-parse", "HEAD"]);
      sourceRevisions.push(afterSourceCommit);
      await runReviewSkills([beforeSourceCommit, afterSourceCommit]);
      expect(readDeliveredComparison(sandbox)).toStrictEqual(first);

      const retained: (typeof first)[] = [];
      for (const version of [3, 4, 5]) {
        write(upstream, "alpha/references/details.md", `Details ${version}.\n`);
        git(upstream, ["add", "."]);
        git(upstream, ["commit", "-m", `Update ${version}`]);
        await runUpdateSkills([], { writeMessage() {} });
        retained.push(readDeliveredComparison(sandbox));
        git(consumer, ["add", "skills.lock.json"]);
        git(consumer, ["commit", "-m", `Accept version ${version}`]);
        sourceRevisions.push(git(consumer, ["rev-parse", "HEAD"]));
      }
      const cacheRoot = path.dirname(first.repository);
      const cacheFiles = readdirSync(cacheRoot)
        .map((entry) => path.join(cacheRoot, entry))
        .filter((entry) => lstatSync(entry).isFile());
      const commitsBeforeFailure = git(first.repository, ["log", "--all", "--format=%H"])
        .split("\n")
        .toSorted();
      write(upstream, "alpha/references/details.md", "Details 6.\n");
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Applied update with failed review publication"]);
      for (const entry of cacheFiles) {
        chmodSync(entry, 0o400);
      }
      chmodSync(cacheRoot, 0o500);
      try {
        await expect(runUpdateSkills([], { writeMessage() {} })).rejects.toThrow(/EACCES/u);
        expect(
          git(first.repository, ["log", "--all", "--format=%H"]).split("\n").toSorted()
        ).toStrictEqual(commitsBeforeFailure);
      } finally {
        chmodSync(cacheRoot, 0o755);
        for (const entry of cacheFiles) {
          chmodSync(entry, 0o644);
        }
      }
      expect(read(consumer, "skills/imported/alpha/references/details.md")).toBe("Details 6.\n");
      await runUpdateSkills([], { writeMessage() {} });
      write(upstream, "alpha/references/details.md", "Details 7.\n");
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Applied update with interrupted review publication"]);
      const interruptedBin = path.join(sandbox, "interrupted-git");
      mkdirSync(interruptedBin);
      const realGit = Bun.which("git");
      ok(realGit);
      writeFileSync(
        path.join(interruptedBin, "git"),
        `#!/bin/sh\nif [ "$1" = update-ref ] && [ "$2" = --stdin ]; then\n  transaction=$(cat)\n  printf '%s\\n' "$transaction" | '${realGit}' "$@" || exit $?\n  case "$transaction" in *'delete '*)\n    printf 'interrupted\\n' > '${path.join(sandbox, "interrupted-publication")}'\n    kill -KILL "$PPID"\n  esac\nelse\n  exec '${realGit}' "$@"\nfi\n`
      );
      chmodSync(path.join(interruptedBin, "git"), 0o755);
      const interrupted = Bun.spawnSync(
        [process.execPath, path.resolve(import.meta.dirname, "../scripts/update-skills.ts")],
        {
          cwd: consumer,
          env: { ...process.env, PATH: `${interruptedBin}${path.delimiter}${process.env.PATH}` }
        }
      );
      expect(interrupted.exitCode).not.toBe(0);
      expect(read(sandbox, "interrupted-publication")).toBe("interrupted\n");
      expect(read(consumer, "skills/imported/alpha/references/details.md")).toBe("Details 7.\n");
      await runReviewSkills([beforeSourceCommit, beforeSourceCommit]);
      expect(
        git(first.repository, ["log", "--all", "--format=%H"]).split("\n").toSorted()
      ).toStrictEqual(commitsBeforeFailure);
      expect(
        readdirSync(cacheRoot)
          .map((entry) => path.join(cacheRoot, entry))
          .filter((entry) => lstatSync(entry).isFile())
          .toSorted()
      ).toStrictEqual(cacheFiles.toSorted());
      for (const revision of sourceRevisions) {
        await runReviewSkills([revision, revision]);
      }
      expect(git(first.repository, ["fsck", "--no-reflogs", "--unreachable"])).toBe("");
      const oldest = Bun.spawnSync(["git", "cat-file", "-e", `${first.commit}^{commit}`], {
        cwd: first.repository
      });
      expect(oldest.exitCode).not.toBe(0);
      expect(new Set(retained.map((review) => review.repository))).toStrictEqual(
        new Set([first.repository])
      );
      const [oldestRetained, , latestRetained] = retained;
      ok(oldestRetained && latestRetained);
      expect(
        git(oldestRetained.repository, [
          "show",
          `${oldestRetained.commit}:skills/imported/alpha/references/details.md`
        ])
      ).toBe("Details 3.");
      expect(
        git(latestRetained.repository, [
          "show",
          `${latestRetained.commit}:skills/imported/alpha/references/details.md`
        ])
      ).toBe("Details 5.");
      const lockBeforeClear = read(consumer, "skills.lock.json");
      await runReviewSkills(["clear"]);
      expect(existsSync(first.repository)).toBeFalsy();
      expect(read(consumer, "skills.lock.json")).toBe(lockBeforeClear);
      expect(read(consumer, "skills/imported/alpha/references/details.md")).toBe("Details 7.\n");
      await runReviewSkills([beforeSourceCommit, afterSourceCommit]);
      const reconstructed = readDeliveredComparison(sandbox);
      expect(
        git(reconstructed.repository, [
          "show",
          `${reconstructed.commit}:skills/imported/alpha/references/details.md`
        ])
      ).toBe("Details two.");
    } finally {
      process.chdir(originalCwd);
      process.env.MONKE_HOME = originalHome;
      process.env.PATH = originalPath;
    }
  }, 30_000);
});

function installReviewViewer(sandbox: string) {
  const directory = path.join(sandbox, "viewer-bin");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "codiff"),
    `#!/bin/sh\nif [ "$1" = --version ]; then echo 'codiff v1.14.0'; else printf '%s\\n' "$@" > '${path.join(sandbox, "review-delivery")}' ; fi\n`
  );
  chmodSync(path.join(directory, "codiff"), 0o755);
  return directory;
}

function readDeliveredComparison(sandbox: string) {
  const [selector, commit, repository] = read(sandbox, "review-delivery").trim().split("\n");
  expect(selector).toBe("--commit");
  ok(commit && repository);
  return { commit, repository };
}

describe("skill importing", () => {
  test("parseAvailableSkillGroups preserves group headings from skills list output", () => {
    const output = [
      "\u001B[?25l\u2502",
      "\u25C7  Available Skills",
      "\u2502",
      "Engineering",
      "\u2502",
      "\u2502    alpha-skill",
      "\u2502",
      "\u2502      Alpha skill description.",
      "Personal Tools",
      "\u2502",
      "\u2502    Bravo Skill",
      "\u2502",
      "\u2502      Bravo skill description.",
      "\u2502",
      "\u2514  Use --skill <name> to install specific skills"
    ].join("\n");

    expect(parseAvailableSkillGroups(output)).toStrictEqual([
      {
        name: "Engineering",
        skills: ["alpha-skill"]
      },
      {
        name: "Personal Tools",
        skills: ["Bravo Skill"]
      }
    ]);
  });

  test("buildGroupedSkillOptions keeps Clack group labels separate from skill values", () => {
    expect(
      buildGroupedSkillOptions([
        {
          name: "Engineering",
          skills: ["alpha", "bravo"]
        },
        {
          name: "Writing",
          skills: ["charlie"]
        }
      ])
    ).toStrictEqual({
      Engineering: [
        {
          label: "alpha",
          value: "alpha"
        },
        {
          label: "bravo",
          value: "bravo"
        }
      ],
      Writing: [
        {
          label: "charlie",
          value: "charlie"
        }
      ]
    });
  });

  test("parseAvailableSkillGroups fails when skills list output is unrecognized", () => {
    expect(() => parseAvailableSkillGroups("No skills here")).toThrow(/Could not parse/u);
  });

  test("extractSecurityRiskAssessment filters upstream install output down to security details", () => {
    const output = [
      "\u25C7  Installation Summary",
      "\u2502  ./.agents/skills/alpha",
      "\u25C7  Security Risk Assessments",
      "\u2502  alpha  Safe  0 alerts  Low Risk",
      "\u2502  Details: https://skills.sh/owner/repo",
      "\u251C\u2500\u2500\u2500\u256F",
      "\u2502",
      "\u25C7  Installation complete",
      "\u25C7  Installed 1 skill",
      "\u2502  \u2192 ./.agents/skills/alpha"
    ].join("\n");

    const assessment = extractSecurityRiskAssessment(output);
    const plainAssessment = stripAnsiForTest(assessment ?? "");

    expect(plainAssessment).toContain("Security Risk Assessments");
    expect(plainAssessment).toContain("alpha");
    expect(plainAssessment).toContain("Safe");
    expect(plainAssessment).toContain("0 alerts");
    expect(plainAssessment).toContain("Low Risk");
    expect(plainAssessment).toContain("Details: https://skills.sh/owner/repo");
    expect(assessment).toContain(pc.cyan("alpha"));
    expect(assessment).toContain(pc.green("Safe"));
    expect(assessment).toContain(pc.green("0 alerts"));
    expect(assessment).toContain(pc.green("Low Risk"));
    expect(assessment).not.toContain("Installation Summary");
    expect(assessment).not.toContain("Installed 1 skill");
    expect(assessment).not.toContain(".agents/skills");
  });

  test("skill import recipe store writes sorted deterministic output", () => {
    const sandbox = makeTempDir("skill-import-recipes");

    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          acceptOpenClawRisks: true,
          skills: [
            {
              disableModelInvocation: false,
              kind: "skill",
              selector: "bravo",
              slug: "bravo"
            },
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "z-owner/z-repo"
        },
        {
          skills: [
            {
              kind: "skill",
              selector: "zulu",
              slug: "zulu"
            }
          ],
          source: "a-owner/a-repo"
        }
      ],
      version: 3
    });

    expect(read(sandbox, "skills.lock.json")).toBe(`{
  "recipes": [
    {
      "skills": [
        {
          "kind": "skill",
          "selector": "zulu",
          "slug": "zulu"
        }
      ],
      "source": "a-owner/a-repo"
    },
    {
      "acceptOpenClawRisks": true,
      "skills": [
        {
          "kind": "skill",
          "selector": "alpha",
          "slug": "alpha"
        },
        {
          "disableModelInvocation": false,
          "kind": "skill",
          "selector": "bravo",
          "slug": "bravo"
        }
      ],
      "source": "z-owner/z-repo"
    }
  ],
  "version": 3
}
`);
    expect(recipeChoices(sandbox)).toStrictEqual({
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "zulu",
              slug: "zulu"
            }
          ],
          source: "a-owner/a-repo"
        },
        {
          acceptOpenClawRisks: true,
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            },
            {
              disableModelInvocation: false,
              kind: "skill",
              selector: "bravo",
              slug: "bravo"
            }
          ],
          source: "z-owner/z-repo"
        }
      ],
      version: 3
    });
  });

  test("skill import recipe store rejects duplicate recipe sources", () => {
    const sandbox = makeTempDir("skill-import-recipes-duplicate-source");
    write(
      sandbox,
      "skills.lock.json",
      JSON.stringify({
        recipes: [
          {
            skills: [
              {
                kind: "skill",
                selector: "alpha",
                slug: "alpha"
              }
            ],
            source: "owner/repo"
          },
          {
            skills: [
              {
                kind: "skill",
                selector: "bravo",
                slug: "bravo"
              }
            ],
            source: "owner/repo"
          }
        ],
        version: 3
      })
    );

    expect(() => recipeChoices(sandbox)).toThrow(
      /Duplicate skill import recipe source: owner\/repo/u
    );
  });

  test("skill import recipe store rejects unknown future versions", () => {
    const sandbox = makeTempDir("skill-import-recipes-future-version");
    write(sandbox, "skills.lock.json", JSON.stringify({ recipes: [], version: 4 }));

    expect(() => recipeChoices(sandbox)).toThrow(/version.*must be 3/u);
  });

  test("skill import recipe store rejects non-boolean model invocation overrides", () => {
    const sandbox = makeTempDir("skill-import-recipes-invalid-invocation-override");
    write(
      sandbox,
      "skills.lock.json",
      JSON.stringify({
        recipes: [
          {
            skills: [
              {
                disableModelInvocation: "yes",
                kind: "skill",
                selector: "alpha",
                slug: "alpha"
              }
            ],
            source: "owner/repo"
          }
        ],
        version: 3
      })
    );

    expect(() => recipeChoices(sandbox)).toThrow(/disableModelInvocation.*boolean/u);
  });

  test("skill import recipe store rejects duplicate selectors in one recipe", () => {
    const sandbox = makeTempDir("skill-import-recipes-duplicate-selector");
    write(
      sandbox,
      "skills.lock.json",
      JSON.stringify({
        recipes: [
          {
            skills: [
              {
                kind: "skill",
                selector: "alpha",
                slug: "alpha"
              },
              {
                kind: "skill",
                selector: "alpha",
                slug: "alpha-v2"
              }
            ],
            source: "owner/repo"
          }
        ],
        version: 3
      })
    );

    expect(() => recipeChoices(sandbox)).toThrow(
      /Duplicate skill selector in recipe owner\/repo: alpha/u
    );
  });

  test("skill import recipe store rejects duplicate imported skill owners", () => {
    const sandbox = makeTempDir("skill-import-recipes-duplicate-owner");
    write(
      sandbox,
      "skills.lock.json",
      JSON.stringify({
        recipes: [
          {
            skills: [
              {
                kind: "skill",
                selector: "alpha",
                slug: "alpha"
              }
            ],
            source: "owner/first"
          },
          {
            skills: [
              {
                kind: "skill",
                selector: "other-alpha",
                slug: "alpha"
              }
            ],
            source: "owner/second"
          }
        ],
        version: 3
      })
    );

    expect(() => recipeChoices(sandbox)).toThrow(
      /Imported skill slug alpha is owned by both owner\/first and owner\/second/u
    );
  });

  test("skill import recipe store allows one slug to be owned once per Import kind", () => {
    const sandbox = makeTempDir("skill-import-recipes-kind-scoped-owner");
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [{ kind: "reference", selector: "alpha-reference", slug: "alpha" }],
          source: "owner/reference"
        },
        {
          skills: [{ kind: "skill", selector: "alpha-skill", slug: "alpha" }],
          source: "owner/skill"
        }
      ],
      version: 3
    });

    expect(recipeChoices(sandbox).recipes).toStrictEqual([
      {
        skills: [{ kind: "reference", selector: "alpha-reference", slug: "alpha" }],
        source: "owner/reference"
      },
      {
        skills: [{ kind: "skill", selector: "alpha-skill", slug: "alpha" }],
        source: "owner/skill"
      }
    ]);
  });

  test("skill import recipe recording rejects one source mapping two selectors to one slug", () => {
    const sandbox = makeTempDir("skill-import-recipes-source-slug");
    const store = mergeImportedGuidanceIntoRecipeStore(
      { recipes: [], version: 3 },
      {
        acceptOpenClawRisks: false,
        kind: "reference",
        skills: [{ selector: "alpha-reference", slug: "alpha" }],
        source: "owner/repo"
      }
    );

    expect(() => {
      const nextStore = mergeImportedGuidanceIntoRecipeStore(store, {
        acceptOpenClawRisks: false,
        kind: "skill",
        skills: [{ selector: "alpha-skill", slug: "alpha" }],
        source: "owner/repo"
      });
      writeImportRecipeStore(sandbox, nextStore);
    }).toThrow(/Duplicate imported slug in recipe owner\/repo: alpha/u);
  });

  test("skill import recipe recording rejects duplicate imported skill owners", () => {
    const store = {
      recipes: [
        {
          skills: [{ kind: "skill" as const, selector: "alpha", slug: "alpha" }],
          source: "owner/first"
        }
      ],
      version: 3 as const
    };

    expect(() => {
      mergeImportedGuidanceIntoRecipeStore(store, {
        acceptOpenClawRisks: false,
        kind: "skill",
        skills: [{ selector: "other-alpha", slug: "alpha" }],
        source: "owner/second"
      });
    }).toThrow(/alpha is already owned by recipe owner\/first/u);
  });

  test.each([
    { repository: "https://github.com/owner/repo.git", source: "owner/repo" },
    { repository: "https://github.com/owner/repo.git", source: "owner/repo/skills" },
    { repository: "git@github.com:owner/repo.git", source: "git@github.com:owner/repo.git" }
  ])(
    "skills import preserves repository transport for $source while copying staged universal skills",
    async ({ repository, source }) => {
      const sandbox = makeTempDir("skill-import-script");
      const skillsLogPath = path.join(sandbox, "skills.log");
      const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
      let stdout = "";
      const fakeBinDirectory = installFakeNpx(sandbox, {
        expectedGitRepository: repository,
        skillsCwdLogPath,
        skillsLogPath
      });
      write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

      await withFakeNpx(sandbox, fakeBinDirectory, async () => {
        await runImportSkills([source], {
          selectSkills(availableSkillGroups) {
            expect(availableSkillGroups).toStrictEqual([
              {
                name: "Engineering",
                skills: ["alpha"]
              },
              {
                name: "Productivity",
                skills: ["bravo"]
              }
            ]);
            return ["alpha", "bravo"];
          },
          writeMessage(message) {
            stdout += message;
          }
        });
      });

      const plainStdout = stripAnsiForTest(stdout);
      expect(plainStdout).toContain("Security Risk Assessments");
      expect(plainStdout).toContain("alpha");
      expect(plainStdout).toContain("Safe");
      expect(plainStdout).toContain("0 alerts");
      expect(plainStdout).toContain("Low Risk");
      expect(stdout).toContain(pc.cyan("alpha"));
      expect(stdout).toContain(pc.green("Safe"));
      expect(stdout).not.toContain("Installation Summary");
      expect(stdout).not.toContain("Installed 2 skills");
      expect(stdout).not.toContain(".agents/skills");
      expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("new alpha");
      expect(read(sandbox, "skills/imported/bravo/SKILL.md")).toBe("new bravo");
      expect(existsSync(path.join(sandbox, ".agents"))).toBeFalsy();
      expect(existsSync(path.join(sandbox, "skills-lock.json"))).toBeFalsy();

      const skillsLog = readFileSync(skillsLogPath, "utf-8");
      const importedSource = source.startsWith("git@") ? `${source}#${"1".repeat(40)}` : source;
      expect(skillsLog).toContain(`--yes skills@1.7.0 add ${importedSource} -l`);
      expect(skillsLog).toContain(
        `--yes skills@1.7.0 add ${importedSource} --skill alpha --skill bravo --agent universal --copy --yes`
      );
      expect(readImportRecipeStore(sandbox).recipes[0]?.lock).toMatchObject({
        repository,
        subpath: source === "owner/repo/skills" ? "skills" : ""
      });

      const stagingCwds = readFileSync(skillsCwdLogPath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(stagingCwds).toHaveLength(2);
      expect(stagingCwds.every((cwd) => cwd !== sandbox)).toBeTruthy();
      expect(stagingCwds.every((cwd) => !existsSync(cwd))).toBeTruthy();
    }
  );

  test("interactive skill import rejects an empty selection and submits a selected skill", async () => {
    const sandbox = makeTempDir("skill-import-interactive");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath: path.join(sandbox, "skills-cwd.log"),
      skillsLogPath: path.join(sandbox, "skills.log")
    });
    const decoder = new TextDecoder();
    let output = "";
    let submittedEmptySelection = false;
    let selectedSkill = false;
    const child = Bun.spawn(
      [
        process.execPath,
        path.resolve(import.meta.dirname, "../scripts/import-skills.ts"),
        "owner/repo"
      ],
      {
        cwd: sandbox,
        env: {
          ...process.env,
          ACCESSIBLE: "0",
          PATH: [fakeBinDirectory, process.env.PATH].filter(Boolean).join(path.delimiter)
        },
        terminal: {
          cols: 100,
          data(terminal, data) {
            output += decoder.decode(data, { stream: true });
            if (!submittedEmptySelection && output.includes("Select skills to import")) {
              submittedEmptySelection = true;
              terminal.write("\r");
            } else if (!selectedSkill && output.includes("Please select at least one skill.")) {
              selectedSkill = true;
              terminal.write(" \r");
            }
          },
          rows: 24
        },
        timeout: 4000
      }
    );

    try {
      await expect(child.exited).resolves.toBe(0);
      expect(output).toContain("Please select at least one skill.");
      expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("new alpha");
      expect(recipeChoices(sandbox).recipes[0]?.skills).toStrictEqual([
        { kind: "skill", selector: "alpha", slug: "alpha" }
      ]);
      expect(existsSync(path.join(sandbox, "skills/imported/bravo"))).toBeFalsy();
    } finally {
      child.kill();
      child.terminal?.close();
    }
  });

  test("skills import --ref creates a non-discoverable Imported reference and records its kind", async () => {
    const sandbox = makeTempDir("skill-import-reference");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stageReferenceFixture: true
    });

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await runImportSkills(["owner/repo", "--ref"], {
        selectSkills() {
          return ["alpha"];
        },
        writeMessage() {}
      });
    });

    expect(existsSync(path.join(sandbox, "skills/references/imported/alpha/SKILL.md"))).toBeFalsy();
    expect(read(sandbox, "skills/references/imported/alpha/MAIN.md")).toBe(
      "\n# Alpha\n\nReference body.\n"
    );
    expect(read(sandbox, "skills/references/imported/alpha/references/details.md")).toBe(
      "supporting details\n"
    );
    expect(recipeChoices(sandbox)).toStrictEqual({
      recipes: [
        {
          skills: [
            {
              kind: "reference",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
  });

  test("reference import rejects a symlinked root entry without writing through it", async () => {
    const sandbox = makeTempDir("skill-import-reference-symlink");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const outsideEntryPath = path.join(sandbox, "outside-entry.md");
    const outsideEntry = `---
name: outside-entry
---

# Must stay unchanged
`;
    writeFileSync(outsideEntryPath, outsideEntry, "utf-8");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stagedSkillEntrySymlinkTarget: outsideEntryPath,
      stageReferenceFixture: true
    });

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await expect(
        runImportSkills(["owner/repo", "--ref"], {
          selectSkills() {
            return ["alpha"];
          },
          writeMessage() {}
        })
      ).rejects.toThrow(/regular file/u);
    });

    expect(readFileSync(outsideEntryPath, "utf-8")).toBe(outsideEntry);
    expect(existsSync(path.join(sandbox, "skills/references/imported/alpha"))).toBeFalsy();
    expect(existsSync(path.join(sandbox, "skills.lock.json"))).toBeFalsy();
  });

  test("reference import preserves relative symlinks between supporting files", async () => {
    const sandbox = makeTempDir("skill-import-reference-supporting-symlink");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stageReferenceFixture: true,
      stageSupportingSymlink: true
    });

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await runImportSkills(["owner/repo", "--ref"], {
        selectSkills() {
          return ["alpha"];
        },
        writeMessage() {}
      });
    });

    const importedLink = path.join(
      sandbox,
      "skills/references/imported/alpha/references/details-link.md"
    );
    expect(readlinkSync(importedLink)).toBe("details.md");
    expect(readFileSync(importedLink, "utf-8")).toBe("supporting details\n");
  });

  test("re-importing one selector with the opposite Import kind migrates its managed copy", async () => {
    const sandbox = makeTempDir("skill-import-kind-migration");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stageReferenceFixture: true
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [{ kind: "skill", selector: "alpha", slug: "alpha" }],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old skill");

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await runImportSkills(["owner/repo", "--ref"], {
        selectSkills() {
          return ["alpha"];
        },
        writeMessage() {}
      });
      expect(existsSync(path.join(sandbox, "skills/imported/alpha"))).toBeFalsy();
      expect(read(sandbox, "skills/references/imported/alpha/MAIN.md")).toBe(
        "\n# Alpha\n\nReference body.\n"
      );

      await runImportSkills(["owner/repo"], {
        selectSkills() {
          return ["alpha"];
        },
        writeMessage() {}
      });
    });

    expect(existsSync(path.join(sandbox, "skills/references/imported/alpha"))).toBeFalsy();
    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toMatch(/^---\nname: alpha\n/u);
    expect(recipeChoices(sandbox).recipes[0]?.skills).toStrictEqual([
      { kind: "skill", selector: "alpha", slug: "alpha" }
    ]);
  });

  test.each(["internal", "codex"])(
    "re-import rejects migrating an Imported reference used by a %s skill",
    async (skillFolder) => {
      const sandbox = makeTempDir("skill-import-consumed-reference");
      const skillsLogPath = path.join(sandbox, "skills.log");
      const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
      const originalStore = {
        recipes: [
          {
            skills: [{ kind: "reference" as const, selector: "alpha", slug: "alpha" }],
            source: "owner/repo"
          }
        ],
        version: 3 as const
      };
      const fakeBinDirectory = installFakeNpx(sandbox, { skillsCwdLogPath, skillsLogPath });
      writeImportRecipeStore(sandbox, originalStore);
      write(sandbox, "skills/references/imported/alpha/MAIN.md", "old reference");
      write(
        sandbox,
        `skills/${skillFolder}/reviewer/SKILL.md`,
        "[Base](../../references/imported/alpha/MAIN.md)\n"
      );

      await withFakeNpx(sandbox, fakeBinDirectory, async () => {
        await expect(
          runImportSkills(["owner/repo"], {
            selectSkills() {
              return ["alpha"];
            },
            writeMessage() {}
          })
        ).rejects.toThrow(`used by skills/${skillFolder}/reviewer/SKILL.md`);
      });

      expect(read(sandbox, "skills/references/imported/alpha/MAIN.md")).toBe("old reference");
      expect(existsSync(path.join(sandbox, "skills/imported/alpha"))).toBeFalsy();
      expect(recipeChoices(sandbox)).toStrictEqual(originalStore);
    }
  );

  test("a reference MAIN.md collision leaves every selected managed copy and recipe unchanged", async () => {
    const sandbox = makeTempDir("skill-import-reference-collision");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      mainCollisionSelector: "bravo",
      skillsCwdLogPath,
      skillsLogPath,
      stageReferenceFixture: true
    });
    const originalStore = {
      recipes: [
        {
          skills: [
            { kind: "skill" as const, selector: "alpha", slug: "alpha" },
            { kind: "skill" as const, selector: "bravo", slug: "bravo" }
          ],
          source: "owner/repo"
        }
      ],
      version: 3 as const
    };
    writeImportRecipeStore(sandbox, originalStore);
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");
    write(sandbox, "skills/imported/bravo/SKILL.md", "old bravo");

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await expect(
        runImportSkills(["owner/repo", "--ref"], {
          selectSkills() {
            return ["alpha", "bravo"];
          },
          writeMessage() {}
        })
      ).rejects.toThrow(/already contains MAIN\.md/u);
    });

    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("old alpha");
    expect(read(sandbox, "skills/imported/bravo/SKILL.md")).toBe("old bravo");
    expect(existsSync(path.join(sandbox, "skills/references/imported/alpha"))).toBeFalsy();
    expect(existsSync(path.join(sandbox, "skills/references/imported/bravo"))).toBeFalsy();
    expect(recipeChoices(sandbox)).toStrictEqual(originalStore);
  });

  test("skills import script records selected skills and merges compatible same-source recipes", async () => {
    const sandbox = makeTempDir("skill-import-script-recipes");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const fakeBinDirectory = installFakeNpx(sandbox, { skillsCwdLogPath, skillsLogPath });

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await runImportSkills(["owner/repo"], {
        selectSkills() {
          return ["alpha"];
        },
        writeMessage() {}
      });
      await runImportSkills(["owner/repo"], {
        selectSkills() {
          return ["bravo"];
        },
        writeMessage() {}
      });
    });

    expect(recipeChoices(sandbox)).toStrictEqual({
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            },
            {
              kind: "skill",
              selector: "bravo",
              slug: "bravo"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
  });

  test("skills import script resolves multiple selector slug aliases", async () => {
    const sandbox = makeTempDir("skill-import-script-aliases");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "renamed-alpha",
        bravo: "renamed-bravo"
      }
    });

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await runImportSkills(["owner/repo"], {
        selectSkills() {
          return ["alpha", "bravo"];
        },
        writeMessage() {}
      });
    });

    expect(read(sandbox, "skills/imported/renamed-alpha/SKILL.md")).toBe("new renamed-alpha");
    expect(read(sandbox, "skills/imported/renamed-bravo/SKILL.md")).toBe("new renamed-bravo");
    expect(recipeChoices(sandbox)).toStrictEqual({
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "renamed-alpha"
            },
            {
              kind: "skill",
              selector: "bravo",
              slug: "renamed-bravo"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });

    const skillsLog = readFileSync(skillsLogPath, "utf-8");
    expect(skillsLog).toContain(
      "--yes skills@1.7.0 add owner/repo --skill alpha --skill bravo --agent universal --copy --yes"
    );
    expect(skillsLog).toContain(
      "--yes skills@1.7.0 add owner/repo --skill alpha --agent universal --copy --yes"
    );
    expect(skillsLog).toContain(
      "--yes skills@1.7.0 add owner/repo --skill bravo --agent universal --copy --yes"
    );
  });

  test("skills import script records explicit OpenClaw risk acceptance", async () => {
    const sandbox = makeTempDir("skill-import-openclaw");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const fakeBinDirectory = installFakeNpx(sandbox, { skillsCwdLogPath, skillsLogPath });

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await runImportSkills(["openclaw/agent-skills", "--accept-openclaw-risks"], {
        selectSkills() {
          return ["autoreview"];
        },
        writeMessage() {}
      });
    });

    const skillsLog = readFileSync(skillsLogPath, "utf-8");
    expect(skillsLog).toContain("--yes skills@1.7.0 add openclaw/agent-skills -l");
    expect(skillsLog).toContain(
      "--yes skills@1.7.0 add openclaw/agent-skills --skill autoreview --agent universal --copy --yes"
    );
    expect(recipeChoices(sandbox)).toStrictEqual({
      recipes: [
        {
          acceptOpenClawRisks: true,
          skills: [
            {
              kind: "skill",
              selector: "autoreview",
              slug: "autoreview"
            }
          ],
          source: "openclaw/agent-skills"
        }
      ],
      version: 3
    });
  });

  test("reference import preserves security, OpenClaw risk, and optional-install behavior", async () => {
    const sandbox = makeTempDir("skill-import-reference-openclaw-install");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const installCalls: string[] = [];
    let stdout = "";
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stageReferenceFixture: true
    });

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await runImportSkills(
        ["openclaw/agent-skills", "--ref", "--accept-openclaw-risks", "--install"],
        {
          runInstallCommand(repoRoot) {
            installCalls.push(repoRoot);
            expect(read(sandbox, "skills/references/imported/alpha/MAIN.md")).toBe(
              "\n# Alpha\n\nReference body.\n"
            );
          },
          selectSkills() {
            return ["alpha"];
          },
          writeMessage(message) {
            stdout += message;
          }
        }
      );
    });

    expect(stripAnsiForTest(stdout)).toContain("Security Risk Assessments");
    expect(installCalls).toStrictEqual([sandbox]);
    expect(recipeChoices(sandbox).recipes[0]).toStrictEqual({
      acceptOpenClawRisks: true,
      skills: [{ kind: "reference", selector: "alpha", slug: "alpha" }],
      source: "openclaw/agent-skills"
    });
  });

  test("skills import script rejects local slug ownership conflicts before copying", async () => {
    const sandbox = makeTempDir("skill-import-script-conflict");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const fakeBinDirectory = installFakeNpx(sandbox, { skillsCwdLogPath, skillsLogPath });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/first"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await expect(
        runImportSkills(["owner/second"], {
          selectSkills() {
            return ["alpha"];
          },
          writeMessage() {}
        })
      ).rejects.toThrow(/alpha is already owned by recipe owner\/first/u);
    });

    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("old alpha");
    expect(recipeChoices(sandbox)).toStrictEqual({
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/first"
        }
      ],
      version: 3
    });
  });

  test("skills import script can run local skill install after importing with -i", async () => {
    const sandbox = makeTempDir("skill-import-script-install");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const installCalls: string[] = [];
    const fakeBinDirectory = installFakeNpx(sandbox, { skillsCwdLogPath, skillsLogPath });

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await runImportSkills(["owner/repo", "-i"], {
        runInstallCommand(repoRoot) {
          installCalls.push(repoRoot);
          expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("new alpha");
        },
        selectSkills() {
          return ["alpha"];
        },
        writeMessage() {}
      });
    });

    expect(installCalls).toStrictEqual([sandbox]);
  });

  test("skills update reruns recorded recipes without prompting for selection", async () => {
    const sandbox = makeTempDir("skill-update-script");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    let stdout = "";
    const fakeBinDirectory = installFakeNpx(sandbox, { skillsCwdLogPath, skillsLogPath });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            },
            {
              kind: "skill",
              selector: "bravo",
              slug: "bravo"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");
    write(sandbox, "skills/imported/bravo/SKILL.md", "old bravo");

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await runUpdateSkills([], {
        writeMessage(message) {
          stdout += message;
        }
      });
    });

    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("new alpha");
    expect(read(sandbox, "skills/imported/bravo/SKILL.md")).toBe("new bravo");
    expect(stripAnsiForTest(stdout)).toContain("Security Risk Assessments");
    const skillsLog = readFileSync(skillsLogPath, "utf-8");
    expect(skillsLog).toContain(
      "--yes skills@1.7.0 add owner/repo --skill alpha --skill bravo --agent universal --copy --yes"
    );
    expect(skillsLog).not.toContain("-l");
  });

  test("skills update preserves upstream invocation metadata when no override is recorded", async () => {
    const sandbox = makeTempDir("skill-update-invocation-preserve");
    const skillMarkdown = `---
name: alpha
disable-model-invocation: true
metadata:
  owner: upstream
---

# Alpha
`;
    const openaiYaml = `interface:
  display_name: Alpha
policy:
  allow_implicit_invocation: false
`;
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath: path.join(sandbox, "skills-cwd.log"),
      skillsLogPath: path.join(sandbox, "skills.log"),
      stagedGuidance: {
        alpha: {
          "agents/openai.yaml": openaiYaml,
          "SKILL.md": skillMarkdown
        }
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [{ kind: "skill", selector: "alpha", slug: "alpha" }],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

    await withFakeNpx(sandbox, fakeBinDirectory, () => runUpdateSkills([], { writeMessage() {} }));

    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe(skillMarkdown);
    expect(read(sandbox, "skills/imported/alpha/agents/openai.yaml")).toBe(openaiYaml);
  });

  test("skills update disables model invocation on Claude and Codex when explicitly requested", async () => {
    const sandbox = makeTempDir("skill-update-invocation-disabled");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath: path.join(sandbox, "skills-cwd.log"),
      skillsLogPath: path.join(sandbox, "skills.log"),
      stagedGuidance: {
        alpha: {
          "agents/openai.yaml": `interface:
  display_name: Alpha
  short_description: Upstream description
policy:
  allow_implicit_invocation: true
  network: false
`,
          "SKILL.md": `---
name: alpha
disable-model-invocation: false
user-invocable: true
metadata:
  owner: upstream
---

# Alpha
`
        }
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              disableModelInvocation: true,
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

    await withFakeNpx(sandbox, fakeBinDirectory, () => runUpdateSkills([], { writeMessage() {} }));

    const skillMarkdown = read(sandbox, "skills/imported/alpha/SKILL.md");
    expect(skillMarkdown).toContain("disable-model-invocation: true");
    expect(skillMarkdown).toContain("user-invocable: true");
    expect(skillMarkdown).toContain("owner: upstream");
    expect(skillMarkdown).toContain("# Alpha");
    expect(parse(read(sandbox, "skills/imported/alpha/agents/openai.yaml"))).toStrictEqual({
      interface: {
        display_name: "Alpha",
        short_description: "Upstream description"
      },
      policy: {
        allow_implicit_invocation: false,
        network: false
      }
    });
  });

  test("skills update enables model invocation on Claude and Codex when explicitly requested", async () => {
    const sandbox = makeTempDir("skill-update-invocation-enabled");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath: path.join(sandbox, "skills-cwd.log"),
      skillsLogPath: path.join(sandbox, "skills.log"),
      stagedGuidance: {
        alpha: {
          "agents/openai.yaml": `policy:
  allow_implicit_invocation: false
`,
          "SKILL.md": `---
name: alpha
disable-model-invocation: true
---

# Alpha
`
        }
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              disableModelInvocation: false,
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

    await withFakeNpx(sandbox, fakeBinDirectory, () => runUpdateSkills([], { writeMessage() {} }));

    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toContain(
      "disable-model-invocation: false"
    );
    expect(parse(read(sandbox, "skills/imported/alpha/agents/openai.yaml"))).toStrictEqual({
      policy: { allow_implicit_invocation: true }
    });
  });

  test("skills update creates canonical Codex metadata for an explicit invocation override", async () => {
    const sandbox = makeTempDir("skill-update-invocation-create-codex");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath: path.join(sandbox, "skills-cwd.log"),
      skillsLogPath: path.join(sandbox, "skills.log"),
      stagedGuidance: {
        alpha: {
          "SKILL.md": `---
name: alpha
---

# Alpha
`
        }
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              disableModelInvocation: true,
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

    await withFakeNpx(sandbox, fakeBinDirectory, () => runUpdateSkills([], { writeMessage() {} }));

    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toContain(
      "disable-model-invocation: true"
    );
    expect(read(sandbox, "skills/imported/alpha/agents/openai.yaml")).toBe(
      "policy:\n  allow_implicit_invocation: false\n"
    );
  });

  test("skills update normalizes legacy Codex metadata before applying an invocation override", async () => {
    const sandbox = makeTempDir("skill-update-invocation-normalize-codex");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath: path.join(sandbox, "skills-cwd.log"),
      skillsLogPath: path.join(sandbox, "skills.log"),
      stagedGuidance: {
        alpha: {
          "agents/openai.yml": `interface:
  display_name: Legacy Alpha
policy:
  network: false
`,
          "SKILL.md": `---
name: alpha
---

# Alpha
`
        }
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              disableModelInvocation: false,
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

    await withFakeNpx(sandbox, fakeBinDirectory, () => runUpdateSkills([], { writeMessage() {} }));

    expect(existsSync(path.join(sandbox, "skills/imported/alpha/agents/openai.yml"))).toBeFalsy();
    expect(parse(read(sandbox, "skills/imported/alpha/agents/openai.yaml"))).toStrictEqual({
      interface: { display_name: "Legacy Alpha" },
      policy: {
        allow_implicit_invocation: true,
        network: false
      }
    });
  });

  test("skills update removes duplicate legacy Codex metadata", async () => {
    const sandbox = makeTempDir("skill-update-invocation-remove-legacy-codex");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath: path.join(sandbox, "skills-cwd.log"),
      skillsLogPath: path.join(sandbox, "skills.log"),
      stagedGuidance: {
        alpha: {
          "agents/openai.yaml": `interface:
  display_name: Canonical Alpha
`,
          "agents/openai.yml": `interface:
  display_name: Legacy Alpha
`,
          "SKILL.md": `---
name: alpha
---

# Alpha
`
        }
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              disableModelInvocation: true,
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

    await withFakeNpx(sandbox, fakeBinDirectory, () => runUpdateSkills([], { writeMessage() {} }));

    expect(existsSync(path.join(sandbox, "skills/imported/alpha/agents/openai.yml"))).toBeFalsy();
    expect(parse(read(sandbox, "skills/imported/alpha/agents/openai.yaml"))).toStrictEqual({
      interface: { display_name: "Canonical Alpha" },
      policy: { allow_implicit_invocation: false }
    });
  });

  test("skills update refreshes an Imported reference without recreating an Imported skill", async () => {
    const sandbox = makeTempDir("skill-update-reference");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stageReferenceFixture: true
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              disableModelInvocation: true,
              kind: "reference",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/references/imported/alpha/MAIN.md", "old reference");

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await runUpdateSkills([], {
        writeMessage() {}
      });
    });

    expect(existsSync(path.join(sandbox, "skills/imported/alpha"))).toBeFalsy();
    expect(read(sandbox, "skills/references/imported/alpha/MAIN.md")).toBe(
      "\n# Alpha\n\nReference body.\n"
    );
    expect(read(sandbox, "skills/references/imported/alpha/references/details.md")).toBe(
      "supporting details\n"
    );
    expect(existsSync(path.join(sandbox, "skills/references/imported/alpha/agents"))).toBeFalsy();
  });

  test("skills update keeps previous guidance and its recipe when invocation metadata is invalid", async () => {
    const sandbox = makeTempDir("skill-update-invocation-atomic-failure");
    const originalStore = {
      recipes: [
        {
          skills: [
            {
              disableModelInvocation: true,
              kind: "skill" as const,
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3 as const
    };
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath: path.join(sandbox, "skills-cwd.log"),
      skillsLogPath: path.join(sandbox, "skills.log"),
      stagedGuidance: {
        alpha: {
          "agents/openai.yaml": "interface:\n  display_name: Alpha\n",
          "SKILL.md": `---
name: alpha
metadata: [unterminated
---

# Alpha
`
        }
      }
    });
    writeImportRecipeStore(sandbox, originalStore);
    write(sandbox, "skills/imported/alpha/SKILL.md", "previous alpha");

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await expect(runUpdateSkills([], { writeMessage() {} })).rejects.toThrow(
        /Invalid Skill frontmatter/u
      );
    });

    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("previous alpha");
    expect(recipeChoices(sandbox)).toStrictEqual(originalStore);
  });

  test("skills update continues through later recipes after one recipe fails", async () => {
    const sandbox = makeTempDir("skill-update-script-failure");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stageReferenceFixture: true
    });
    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await runImportSkills(["owner/fails"], { selectSkills: () => ["alpha"], writeMessage() {} });
      await runImportSkills(["owner/works", "--ref"], {
        selectSkills: () => ["bravo"],
        writeMessage() {}
      });
    });
    const previousPins = readImportRecipeStore(sandbox);
    const previousAlpha = read(sandbox, "skills/imported/alpha/SKILL.md");
    installFakeNpx(sandbox, {
      failInstallSources: ["owner/fails"],
      resolvedCommit: "2".repeat(40),
      skillsCwdLogPath,
      skillsLogPath,
      stageReferenceFixture: true
    });
    let output = "";
    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await expect(
        runUpdateSkills([], {
          writeMessage: (message) => {
            output += message;
          }
        })
      ).rejects.toThrow(/owner\/fails/u);
    });
    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe(previousAlpha);
    expect(
      readImportRecipeStore(sandbox).recipes.find((recipe) => recipe.source === "owner/fails")?.lock
    ).toStrictEqual(previousPins.recipes.find((recipe) => recipe.source === "owner/fails")?.lock);
    expect(
      readImportRecipeStore(sandbox).recipes.find((recipe) => recipe.source === "owner/works")?.lock
        ?.commit
    ).toBe("2".repeat(40));
    expect(output).toContain("Skill source failed: owner/fails");
    const comparison = readDeliveredComparison(sandbox);
    expect(
      git(comparison.repository, [
        "diff",
        "--name-only",
        `${comparison.commit}^`,
        comparison.commit
      ])
    ).toBe("skills.lock.json");
  });

  test("an incomplete initial migration retains its preceding files and recipes", async () => {
    const sandbox = makeTempDir("skill-update-initial-failure");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      failInstallSources: ["owner/fails"],
      skillsCwdLogPath,
      skillsLogPath,
      stageReferenceFixture: true
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/fails"
        },
        {
          skills: [
            {
              kind: "reference",
              selector: "bravo",
              slug: "bravo"
            }
          ],
          source: "owner/works"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");
    write(sandbox, "skills/references/imported/bravo/MAIN.md", "old bravo");
    git(sandbox, ["init", "-b", "main"]);
    git(sandbox, ["config", "user.name", "Fixture"]);
    git(sandbox, ["config", "user.email", "fixture@example.com"]);
    git(sandbox, ["add", "skills.lock.json", "skills/imported", "skills/references/imported"]);
    git(sandbox, ["commit", "-m", "Committed migration baseline"]);

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await expect(
        runUpdateSkills([], {
          writeMessage() {}
        })
      ).rejects.toThrow(/owner\/fails/u);
    });

    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("old alpha");
    expect(read(sandbox, "skills/references/imported/bravo/MAIN.md")).toBe(
      "\n# Alpha\n\nReference body.\n"
    );
    const skillsLog = readFileSync(skillsLogPath, "utf-8");
    expect(skillsLog).toContain(
      "--yes skills@1.7.0 add owner/fails --skill alpha --agent universal --copy --yes"
    );
    expect(skillsLog).toContain(
      "--yes skills@1.7.0 add owner/works --skill bravo --agent universal --copy --yes"
    );
    const partial = readDeliveredComparison(sandbox);
    installFakeNpx(sandbox, { skillsCwdLogPath, skillsLogPath, stageReferenceFixture: true });
    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await runUpdateSkills([], { writeMessage() {} });
    });
    const complete = readDeliveredComparison(sandbox);
    expect(complete.repository).toBe(partial.repository);
    expect(
      git(complete.repository, ["show", `${complete.commit}^:skills/imported/alpha/SKILL.md`])
    ).toBe("old alpha");
    expect(
      git(complete.repository, [
        "show",
        `${complete.commit}^:skills/references/imported/bravo/MAIN.md`
      ])
    ).toBe("old bravo");
    expect(readImportRecipeStore(sandbox).recipes.every((recipe) => recipe.lock)).toBeTruthy();
  });

  test("skills update rejects untracked imported skill directories before invoking upstream", async () => {
    const sandbox = makeTempDir("skill-update-script-untracked");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const fakeBinDirectory = installFakeNpx(sandbox, { skillsCwdLogPath, skillsLogPath });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");
    write(sandbox, "skills/imported/orphan/SKILL.md", "unknown");

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await expect(
        runUpdateSkills([], {
          writeMessage() {}
        })
      ).rejects.toThrow(/Untracked imported skill directories: orphan/u);
    });

    expect(existsSync(skillsLogPath)).toBeFalsy();
    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("old alpha");
    expect(read(sandbox, "skills/imported/orphan/SKILL.md")).toBe("unknown");
  });

  test("skills update rejects staged slug mismatches non-interactively without mutating the recipe", async () => {
    const sandbox = makeTempDir("skill-update-script-slug-mismatch");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "renamed-alpha"
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await expect(
        runUpdateSkills([], {
          writeMessage() {}
        })
      ).rejects.toThrow(/recorded alpha but staged renamed-alpha/u);
    });

    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("old alpha");
    expect(existsSync(path.join(sandbox, "skills/imported/renamed-alpha"))).toBeFalsy();
    expect(recipeChoices(sandbox)).toStrictEqual({
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
  });

  test("skills update can interactively accept a staged slug rename", async () => {
    const sandbox = makeTempDir("skill-update-script-slug-accept");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const confirmations: { recordedSlug: string; stagedSlug: string }[] = [];
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "renamed-alpha"
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await runUpdateSkills(["--interactive"], {
        confirmSlugReplacement(request) {
          confirmations.push({
            recordedSlug: request.recordedSlug,
            stagedSlug: request.stagedSlug
          });
          return true;
        },
        writeMessage() {}
      });
    });

    expect(confirmations).toStrictEqual([
      {
        recordedSlug: "alpha",
        stagedSlug: "renamed-alpha"
      }
    ]);
    expect(existsSync(path.join(sandbox, "skills/imported/alpha"))).toBeFalsy();
    expect(read(sandbox, "skills/imported/renamed-alpha/SKILL.md")).toBe("new renamed-alpha");
    expect(recipeChoices(sandbox)).toStrictEqual({
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "renamed-alpha"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
  });

  test("skills update preserves reference transformation across an accepted slug rename", async () => {
    const sandbox = makeTempDir("skill-update-reference-slug-accept");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "renamed-alpha"
      },
      stageReferenceFixture: true
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [{ kind: "reference", selector: "alpha", slug: "alpha" }],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/references/imported/alpha/MAIN.md", "old reference");

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await runUpdateSkills(["--interactive"], {
        confirmSlugReplacement() {
          return true;
        },
        writeMessage() {}
      });
    });

    expect(existsSync(path.join(sandbox, "skills/references/imported/alpha"))).toBeFalsy();
    expect(
      existsSync(path.join(sandbox, "skills/references/imported/renamed-alpha/SKILL.md"))
    ).toBeFalsy();
    expect(read(sandbox, "skills/references/imported/renamed-alpha/MAIN.md")).toBe(
      "\n# Alpha\n\nReference body.\n"
    );
    expect(recipeChoices(sandbox).recipes[0]?.skills).toStrictEqual([
      { kind: "reference", selector: "alpha", slug: "renamed-alpha" }
    ]);
  });

  test("skills update rejects renaming an Imported reference used by a Reference-backed skill", async () => {
    const sandbox = makeTempDir("skill-update-consumed-reference");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalStore = {
      recipes: [
        {
          skills: [{ kind: "reference" as const, selector: "alpha", slug: "alpha" }],
          source: "owner/repo"
        }
      ],
      version: 3 as const
    };
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "renamed-alpha"
      },
      stageReferenceFixture: true
    });
    writeImportRecipeStore(sandbox, originalStore);
    write(sandbox, "skills/references/imported/alpha/MAIN.md", "old reference");
    write(
      sandbox,
      "skills/internal/reviewer/SKILL.md",
      "[Base](../../references/imported/alpha/MAIN.md)\n"
    );

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await expect(
        runUpdateSkills(["--interactive"], {
          confirmSlugReplacement() {
            return true;
          },
          writeMessage() {}
        })
      ).rejects.toThrow(/used by skills\/internal\/reviewer\/SKILL\.md/u);
    });

    expect(read(sandbox, "skills/references/imported/alpha/MAIN.md")).toBe("old reference");
    expect(existsSync(path.join(sandbox, "skills/references/imported/renamed-alpha"))).toBeFalsy();
    expect(recipeChoices(sandbox)).toStrictEqual(originalStore);
  });

  test("skills update detects a supporting document that consumes a reference support file", async () => {
    const sandbox = makeTempDir("skill-update-consumed-reference-support");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalStore = {
      recipes: [
        {
          skills: [{ kind: "reference" as const, selector: "alpha", slug: "alpha" }],
          source: "owner/repo"
        }
      ],
      version: 3 as const
    };
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "renamed-alpha"
      },
      stageReferenceFixture: true
    });
    writeImportRecipeStore(sandbox, originalStore);
    write(sandbox, "skills/references/imported/alpha/MAIN.md", "old reference");
    write(sandbox, "skills/internal/reviewer/SKILL.md", "# Reviewer\n");
    write(
      sandbox,
      "skills/internal/reviewer/references/checklist.md",
      "[Details](../../../references/imported/alpha/references/details.md)\n"
    );

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await expect(
        runUpdateSkills(["--interactive"], {
          confirmSlugReplacement() {
            return true;
          },
          writeMessage() {}
        })
      ).rejects.toThrow(/used by skills\/internal\/reviewer\/references\/checklist\.md/u);
    });

    expect(read(sandbox, "skills/references/imported/alpha/MAIN.md")).toBe("old reference");
    expect(existsSync(path.join(sandbox, "skills/references/imported/renamed-alpha"))).toBeFalsy();
    expect(recipeChoices(sandbox)).toStrictEqual(originalStore);
  });

  test("skills update detects a supporting symlink that consumes a reference file", async () => {
    const sandbox = makeTempDir("skill-update-consumed-reference-symlink");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalStore = {
      recipes: [
        {
          skills: [{ kind: "reference" as const, selector: "alpha", slug: "alpha" }],
          source: "owner/repo"
        }
      ],
      version: 3 as const
    };
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "renamed-alpha"
      },
      stageReferenceFixture: true
    });
    writeImportRecipeStore(sandbox, originalStore);
    write(sandbox, "skills/references/imported/alpha/MAIN.md", "old reference");
    write(sandbox, "skills/internal/reviewer/SKILL.md", "# Reviewer\n");
    const supportingSymlink = path.join(sandbox, "skills/internal/reviewer/references/base.md");
    mkdirSync(path.dirname(supportingSymlink), { recursive: true });
    symlinkSync("../../../references/imported/alpha/MAIN.md", supportingSymlink);

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await expect(
        runUpdateSkills(["--interactive"], {
          confirmSlugReplacement() {
            return true;
          },
          writeMessage() {}
        })
      ).rejects.toThrow(/used by skills\/internal\/reviewer\/references\/base\.md/u);
    });

    expect(read(sandbox, "skills/references/imported/alpha/MAIN.md")).toBe("old reference");
    expect(existsSync(path.join(sandbox, "skills/references/imported/renamed-alpha"))).toBeFalsy();
    expect(recipeChoices(sandbox)).toStrictEqual(originalStore);
  });

  test("skills update detects reference documents and symlinks that consume another reference", async () => {
    const sandbox = makeTempDir("skill-update-reference-consumer");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const originalStore = {
      recipes: [
        {
          skills: [{ kind: "reference" as const, selector: "alpha", slug: "alpha" }],
          source: "owner/a-alpha"
        },
        {
          skills: [{ kind: "reference" as const, selector: "bravo", slug: "bravo" }],
          source: "owner/z-bravo"
        }
      ],
      version: 3 as const
    };
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "renamed-alpha"
      },
      stageReferenceFixture: true
    });
    writeImportRecipeStore(sandbox, originalStore);
    write(sandbox, "skills/references/imported/alpha/MAIN.md", "old reference");
    write(sandbox, "skills/references/imported/bravo/MAIN.md", "[Alpha](../alpha/MAIN.md)\n");

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await expect(
        runUpdateSkills(["--interactive"], {
          confirmSlugReplacement() {
            return true;
          },
          writeMessage() {}
        })
      ).rejects.toThrow(/used by skills\/references\/imported\/bravo\/MAIN\.md/u);

      write(sandbox, "skills/references/imported/bravo/MAIN.md", "# Bravo\n");
      const internalReferenceSymlink = path.join(
        sandbox,
        "skills/references/internal/reviewer/alpha.md"
      );
      mkdirSync(path.dirname(internalReferenceSymlink), { recursive: true });
      symlinkSync("../../imported/alpha/MAIN.md", internalReferenceSymlink);

      await expect(
        runUpdateSkills(["--interactive"], {
          confirmSlugReplacement() {
            return true;
          },
          writeMessage() {}
        })
      ).rejects.toThrow(/used by skills\/references\/internal\/reviewer\/alpha\.md/u);
    });

    expect(read(sandbox, "skills/references/imported/alpha/MAIN.md")).toBe("old reference");
    expect(existsSync(path.join(sandbox, "skills/references/imported/renamed-alpha"))).toBeFalsy();
    expect(recipeChoices(sandbox)).toStrictEqual(originalStore);
  });

  test("skills update can interactively accept multiple staged slug renames", async () => {
    const sandbox = makeTempDir("skill-update-script-multiple-slug-accept");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const confirmations: { recordedSlug: string; selector: string; stagedSlug: string }[] = [];
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "renamed-alpha",
        bravo: "renamed-bravo"
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            },
            {
              kind: "skill",
              selector: "bravo",
              slug: "bravo"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");
    write(sandbox, "skills/imported/bravo/SKILL.md", "old bravo");

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await runUpdateSkills(["--interactive"], {
        confirmSlugReplacement(request) {
          confirmations.push({
            recordedSlug: request.recordedSlug,
            selector: request.selector,
            stagedSlug: request.stagedSlug
          });
          return true;
        },
        writeMessage() {}
      });
    });

    expect(confirmations).toStrictEqual([
      {
        recordedSlug: "alpha",
        selector: "alpha",
        stagedSlug: "renamed-alpha"
      },
      {
        recordedSlug: "bravo",
        selector: "bravo",
        stagedSlug: "renamed-bravo"
      }
    ]);
    expect(existsSync(path.join(sandbox, "skills/imported/alpha"))).toBeFalsy();
    expect(existsSync(path.join(sandbox, "skills/imported/bravo"))).toBeFalsy();
    expect(read(sandbox, "skills/imported/renamed-alpha/SKILL.md")).toBe("new renamed-alpha");
    expect(read(sandbox, "skills/imported/renamed-bravo/SKILL.md")).toBe("new renamed-bravo");
    expect(recipeChoices(sandbox)).toStrictEqual({
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "renamed-alpha"
            },
            {
              kind: "skill",
              selector: "bravo",
              slug: "renamed-bravo"
            }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });

    const skillsLog = readFileSync(skillsLogPath, "utf-8");
    expect(skillsLog).toContain(
      "--yes skills@1.7.0 add owner/repo --skill alpha --skill bravo --agent universal --copy --yes"
    );
    expect(skillsLog).toContain(
      "--yes skills@1.7.0 add owner/repo --skill alpha --agent universal --copy --yes"
    );
    expect(skillsLog).toContain(
      "--yes skills@1.7.0 add owner/repo --skill bravo --agent universal --copy --yes"
    );
  });

  test("skills update validates accepted slug renames against projected ownership", async () => {
    const sandbox = makeTempDir("skill-update-projected-slug-ownership");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "bravo",
        bravo: "charlie"
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            { kind: "skill", selector: "alpha", slug: "alpha" },
            { kind: "skill", selector: "bravo", slug: "bravo" }
          ],
          source: "owner/repo"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");
    write(sandbox, "skills/imported/bravo/SKILL.md", "old bravo");

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await runUpdateSkills(["--interactive"], {
        confirmSlugReplacement() {
          return true;
        },
        writeMessage() {}
      });
    });

    expect(existsSync(path.join(sandbox, "skills/imported/alpha"))).toBeFalsy();
    expect(read(sandbox, "skills/imported/bravo/SKILL.md")).toBe("new bravo");
    expect(read(sandbox, "skills/imported/charlie/SKILL.md")).toBe("new charlie");
    expect(recipeChoices(sandbox).recipes[0]?.skills).toStrictEqual([
      { kind: "skill", selector: "alpha", slug: "bravo" },
      { kind: "skill", selector: "bravo", slug: "charlie" }
    ]);
  });

  test("skills update rejects accepted slug renames that would duplicate another recipe owner", async () => {
    const sandbox = makeTempDir("skill-update-script-slug-duplicate");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const fakeBinDirectory = installFakeNpx(sandbox, {
      failInstallSources: ["z/other"],
      skillsCwdLogPath,
      skillsLogPath,
      stagedSlugBySelector: {
        alpha: "beta"
      }
    });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "a/renames"
        },
        {
          skills: [
            {
              kind: "skill",
              selector: "beta",
              slug: "beta"
            }
          ],
          source: "z/other"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");
    write(sandbox, "skills/imported/beta/SKILL.md", "old beta");

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await expect(
        runUpdateSkills(["--interactive"], {
          confirmSlugReplacement() {
            return true;
          },
          writeMessage() {}
        })
      ).rejects.toThrow(/beta is owned by both a\/renames and z\/other/u);
    });

    expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("old alpha");
    expect(read(sandbox, "skills/imported/beta/SKILL.md")).toBe("old beta");
    expect(recipeChoices(sandbox)).toStrictEqual({
      recipes: [
        {
          skills: [
            {
              kind: "skill",
              selector: "alpha",
              slug: "alpha"
            }
          ],
          source: "a/renames"
        },
        {
          skills: [
            {
              kind: "skill",
              selector: "beta",
              slug: "beta"
            }
          ],
          source: "z/other"
        }
      ],
      version: 3
    });
  });

  test.each([false, true])(
    "skills update installs applied guidance when viewer failure is %s",
    async (viewerFails) => {
      const sandbox = makeTempDir("skill-update-script-install");
      const skillsLogPath = path.join(sandbox, "skills.log");
      const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
      const installCalls: string[] = [];
      const fakeBinDirectory = installFakeNpx(sandbox, { skillsCwdLogPath, skillsLogPath });
      if (viewerFails) {
        writeFileSync(
          path.join(fakeBinDirectory, "codiff"),
          "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'codiff v1.14.0'; else exit 9; fi\n"
        );
      }
      writeImportRecipeStore(sandbox, {
        recipes: [
          {
            skills: [
              {
                kind: "skill",
                selector: "alpha",
                slug: "alpha"
              }
            ],
            source: "owner/repo"
          }
        ],
        version: 3
      });
      write(sandbox, "skills/imported/alpha/SKILL.md", "old alpha");

      await withFakeNpx(sandbox, fakeBinDirectory, async () => {
        const update = runUpdateSkills(["--install"], {
          runInstallCommand(repoRoot) {
            installCalls.push(repoRoot);
            expect(read(sandbox, "skills/imported/alpha/SKILL.md")).toBe("new alpha");
          },
          writeMessage() {}
        });
        const failed = await update.then(
          () => false,
          () => true
        );
        expect(failed).toBe(viewerFails);
      });

      expect(installCalls).toStrictEqual([sandbox]);
    }
  );

  test("skills update preserves recorded OpenClaw risk acceptance", async () => {
    const sandbox = makeTempDir("skill-update-script-openclaw");
    const skillsLogPath = path.join(sandbox, "skills.log");
    const skillsCwdLogPath = path.join(sandbox, "skills-cwd.log");
    const fakeBinDirectory = installFakeNpx(sandbox, { skillsCwdLogPath, skillsLogPath });
    writeImportRecipeStore(sandbox, {
      recipes: [
        {
          acceptOpenClawRisks: true,
          skills: [
            {
              kind: "skill",
              selector: "autoreview",
              slug: "autoreview"
            }
          ],
          source: "openclaw/agent-skills"
        }
      ],
      version: 3
    });
    write(sandbox, "skills/imported/autoreview/SKILL.md", "old autoreview");

    await withFakeNpx(sandbox, fakeBinDirectory, async () => {
      await runUpdateSkills([], {
        writeMessage() {}
      });
    });

    const skillsLog = readFileSync(skillsLogPath, "utf-8");
    expect(skillsLog).toContain(
      "--yes skills@1.7.0 add openclaw/agent-skills --skill autoreview --agent universal --copy --yes"
    );
    expect(read(sandbox, "skills/imported/autoreview/SKILL.md")).toBe("new autoreview");
  });
});

async function withFakeNpx(sandbox: string, fakeBinDirectory: string, action: () => Promise<void>) {
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const originalMonkeHome = process.env.MONKE_HOME;
  try {
    process.env.MONKE_HOME = path.join(sandbox, "home");
    process.env.PATH = [fakeBinDirectory, originalPath].filter(Boolean).join(path.delimiter);
    process.chdir(sandbox);
    await action();
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    process.env.MONKE_HOME = originalMonkeHome;
  }
}

function recipeChoices(sandbox: string) {
  const store = readImportRecipeStore(sandbox);
  return { ...store, recipes: store.recipes.map(({ lock: _lock, ...recipe }) => recipe) };
}

function installFakeNpx(
  sandbox: string,
  options: {
    expectedGitRepository?: string;
    failInstallSources?: string[];
    mainCollisionSelector?: string;
    resolvedCommit?: string;
    skillsCwdLogPath: string;
    skillsLogPath: string;
    stagedGuidance?: Record<string, Record<string, string>>;
    stagedSkillEntrySymlinkTarget?: string;
    stagedSlugBySelector?: Record<string, string>;
    stageReferenceFixture?: boolean;
    stageSupportingSymlink?: boolean;
  }
) {
  const binDirectory = path.join(sandbox, "fake-bin");
  const guidanceFixturesDirectory = path.join(sandbox, "fake-upstream-guidance");
  mkdirSync(binDirectory, { recursive: true });
  const realGit = Bun.which("git");
  writeFileSync(
    path.join(binDirectory, "git"),
    `#!/bin/sh
${
  options.expectedGitRepository
    ? `case "$1" in
  ls-remote) git_source=$3 ;;
  fetch) git_source=$6 ;;
  *) git_source='' ;;
esac
if [ -n "$git_source" ] && [ "$git_source" != '${options.expectedGitRepository}' ]; then
  echo "Repository transport rejected: $git_source" >&2
  exit 42
fi`
    : ""
}
if [ "$1" = ls-remote ]; then printf '${options.resolvedCommit ?? "1".repeat(40)}\\tHEAD\\n'; else
  case "$PWD:$1" in */upstream-validation:fetch|*/upstream-validation:checkout) exit 0 ;; esac
  exec '${realGit}' "$@"
fi
`
  );
  chmodSync(path.join(binDirectory, "git"), 0o755);
  writeFileSync(
    path.join(binDirectory, "codiff"),
    `#!/bin/sh\nif [ "$1" = --version ]; then echo codiff v1.14.0; else printf '%s\\n' "$@" > '${path.join(sandbox, "review-delivery")}'; fi\nexit 0\n`
  );
  chmodSync(path.join(binDirectory, "codiff"), 0o755);
  for (const [selector, files] of Object.entries(options.stagedGuidance ?? {})) {
    for (const [relativePath, contents] of Object.entries(files)) {
      write(sandbox, path.join("fake-upstream-guidance", selector, relativePath), contents);
    }
  }
  const scriptPath = path.join(binDirectory, "npx");
  writeFileSync(
    scriptPath,
    `#!/bin/sh
set -eu
printf '%s\\n' "$PWD" >> '${options.skillsCwdLogPath}'
for arg in "$@"; do
  display_arg=$(printf '%s' "$arg" | sed 's|https://github.com/||; s|/tree/[12]\\{40\\}||')
  printf '%s ' "$display_arg" >> '${options.skillsLogPath}'
done
printf '\\n' >> '${options.skillsLogPath}'

is_list=0
for arg in "$@"; do
  if [ "$arg" = "-l" ]; then
    is_list=1
  fi
done

if [ "$is_list" = "1" ]; then
  cat <<'OUT'
\u2502
\u25C7  Available Skills
\u2502
Engineering
\u2502
\u2502    alpha
\u2502
\u2502      Alpha description.
\u2502
Productivity
\u2502
\u2502    bravo
\u2502
\u2502      Bravo description.
\u2502
\u2514  Use --skill <name> to install specific skills
OUT
  exit 0
fi

source_arg=""
previous_was_add=0
for arg in "$@"; do
  if [ "$previous_was_add" = "1" ]; then
    source_arg="$arg"
    previous_was_add=0
    continue
  fi
  if [ "$arg" = "add" ]; then
    previous_was_add=1
  fi
done
source_arg=$(printf '%s' "$source_arg" | sed 's|https://github.com/||; s|/tree/[12]\\{40\\}||')
case "$source_arg" in
${options.failInstallSources?.map((source) => `  ${source}) echo "failed $source" >&2; exit 42 ;;`).join("\n") ?? ""}
  *) ;;
esac

cat <<'OUT'
Installation Summary
./.agents/skills/alpha
Security Risk Assessments
alpha Safe 0 alerts Low Risk
Details: https://skills.sh/owner/repo
Installation complete
Installed 2 skills
./.agents/skills/alpha
OUT
selected_skills=""
previous_was_skill=0
for arg in "$@"; do
  if [ "$previous_was_skill" = "1" ]; then
    selected_skills="$selected_skills $arg"
    previous_was_skill=0
    continue
  fi
  if [ "$arg" = "--skill" ]; then
    previous_was_skill=1
  fi
done
if [ -z "$selected_skills" ]; then
  selected_skills=" alpha bravo"
fi
for skill in $selected_skills; do
  staged_slug="$skill"
  case "$skill" in
${Object.entries(options.stagedSlugBySelector ?? {})
  .map(([selector, slug]) => `    ${selector}) staged_slug="${slug}" ;;`)
  .join("\n")}
    *) ;;
  esac
  mkdir -p ".agents/skills/$staged_slug"
  if [ -d '${guidanceFixturesDirectory}'/"$skill" ]; then
    cp -R '${guidanceFixturesDirectory}'/"$skill"/. ".agents/skills/$staged_slug/"
  else
${
  options.stageReferenceFixture === true
    ? `  cat > ".agents/skills/$staged_slug/SKILL.md" <<'SKILL'
---
name: alpha
description: Reference fixture
metadata:
  owner: upstream
---

# Alpha

Reference body.
SKILL
  mkdir -p ".agents/skills/$staged_slug/references"
  printf 'supporting details\\n' > ".agents/skills/$staged_slug/references/details.md"
${
  options.stageSupportingSymlink === true
    ? `  ln -s 'details.md' ".agents/skills/$staged_slug/references/details-link.md"`
    : ""
}`
    : `  printf 'new %s' "$staged_slug" > ".agents/skills/$staged_slug/SKILL.md"`
}
  fi
${
  options.mainCollisionSelector
    ? `  if [ "$skill" = "${options.mainCollisionSelector}" ]; then
    printf 'upstream collision\\n' > ".agents/skills/$staged_slug/MAIN.md"
  fi`
    : ""
}
${
  options.stagedSkillEntrySymlinkTarget
    ? `  rm ".agents/skills/$staged_slug/SKILL.md"
  ln -s '${options.stagedSkillEntrySymlinkTarget}' ".agents/skills/$staged_slug/SKILL.md"`
    : ""
}
done
printf '{"version":1}' > skills-lock.json
exit 0
`,
    "utf-8"
  );
  chmodSync(scriptPath, 0o755);
  return binDirectory;
}

function stripAnsiForTest(value: string) {
  const escapeCharacter = String.fromCodePoint(27);
  return value.replaceAll(new RegExp(`${escapeCharacter}\\[[0-9;]*m`, "gu"), "");
}
