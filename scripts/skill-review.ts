import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import * as z from "zod";

import { runDiffInteractive } from "../src/diff.ts";
import { MonkeError } from "../src/errors.ts";
import { createRuntime, getMonkeHome, withScopedLockAsync } from "../src/runtime.ts";
import { sha256 } from "../src/sha256.ts";
import { shellQuote } from "../src/shell-quote.ts";
import type { Runtime } from "../src/types.ts";
import {
  importedGuidancePath,
  IMPORTED_REFERENCES_ROOT,
  IMPORTED_SKILLS_ROOT
} from "./import-guidance.ts";
import { readImportRecipeStore, SKILL_LOCK_PATH } from "./skill-import-recipes.ts";
import type { SkillImportRecipeSkill } from "./skill-import-recipes.ts";
import { restoreSkillImports } from "./skill-lock.ts";

const ReviewSchema = z.strictObject({
  commit: z.string().regex(/^[a-f\d]{40}$/u),
  id: z.string().regex(/^[a-f\d]{64}$/u)
});
const ReviewsSchema = z.array(ReviewSchema).max(3);
const ACCEPTED_GUIDANCE_DIRECTORY = ".monke-skill-baseline";

/** Retain accepted bytes so externally edited linked Skills can also be reviewed. */
export function rememberSkillGuidance(
  repoRoot: string,
  changedGuidance?: readonly SkillImportRecipeSkill[]
) {
  const baseline = path.join(repoRoot, ACCEPTED_GUIDANCE_DIRECTORY);
  const next = `${baseline}.tmp`;
  rmSync(next, { force: true, recursive: true });
  if (changedGuidance && existsSync(baseline)) {
    cpSync(baseline, next, { recursive: true, verbatimSymlinks: true });
    replaceSnapshotGuidance(repoRoot, next, changedGuidance);
    writeFileSync(
      path.join(next, SKILL_LOCK_PATH),
      `${JSON.stringify(readImportRecipeStore(repoRoot), null, 2)}\n`
    );
  } else {
    snapshotSkillGuidance(repoRoot, next);
  }
  rmSync(baseline, { force: true, recursive: true });
  renameSync(next, baseline);
}

function replaceSnapshotGuidance(
  repoRoot: string,
  destination: string,
  guidance: readonly SkillImportRecipeSkill[]
) {
  const localSkills = new Set(
    readImportRecipeStore(repoRoot)
      .recipes.filter((recipe) => recipe.localSource)
      .flatMap((recipe) => recipe.skills.map((item) => item.slug))
  );
  for (const item of guidance) {
    const source = importedGuidancePath(repoRoot, item);
    const target = importedGuidancePath(destination, item);
    rmSync(target, { force: true, recursive: true });
    if (existsSync(source)) {
      copyGuidanceSnapshot(source, target, item.kind === "skill" && localSkills.has(item.slug));
    }
  }
}

function copyGuidanceSnapshot(source: string, target: string, dereference: boolean) {
  cpSync(source, target, {
    recursive: true,
    ...(dereference
      ? { dereference: true, filter: (entry) => existsSync(entry) }
      : { verbatimSymlinks: true })
  });
}

/** Capture complete guidance independently of source Git tracking and ignore rules. */
export function snapshotSkillGuidance(repoRoot: string, destination: string) {
  const store = readImportRecipeStore(repoRoot);
  mkdirSync(destination, { recursive: true });
  for (const root of [IMPORTED_SKILLS_ROOT, IMPORTED_REFERENCES_ROOT]) {
    if (existsSync(path.join(repoRoot, root))) {
      mkdirSync(path.dirname(path.join(destination, root)), { recursive: true });
      copyGuidanceSnapshot(path.join(repoRoot, root), path.join(destination, root), false);
    }
  }
  replaceSnapshotGuidance(
    repoRoot,
    destination,
    store.recipes.filter((recipe) => recipe.localSource).flatMap((recipe) => recipe.skills)
  );
  rmSync(path.join(destination, IMPORTED_SKILLS_ROOT, ".monke-imports.json"), { force: true });
  writeFileSync(path.join(destination, SKILL_LOCK_PATH), `${JSON.stringify(store, null, 2)}\n`);
}

/** Every incomplete migration retry compares against the original committed imported tree. */
export function snapshotSkillUpdateBaseline(
  repoRoot: string,
  destination: string,
  migrating: boolean
) {
  const accepted = path.join(repoRoot, ACCEPTED_GUIDANCE_DIRECTORY);
  if (existsSync(accepted)) {
    cpSync(accepted, destination, { recursive: true, verbatimSymlinks: true });
    // Installer updates compare against current editable bytes, including learned changes.
    // Plain links retain the accepted baseline so externally installed updates remain visible.
    for (const recipe of readImportRecipeStore(repoRoot).recipes) {
      if (!recipe.localSource?.command) {
        continue;
      }
      for (const item of recipe.skills) {
        const source = importedGuidancePath(repoRoot, item);
        const target = importedGuidancePath(destination, item);
        if (!existsSync(source)) {
          continue;
        }
        rmSync(target, { force: true, recursive: true });
        copyGuidanceSnapshot(source, target, true);
      }
    }
    return;
  }
  const runtime = createRuntime({ cwd: repoRoot });
  const trackedImports = migrating
    ? runtime.exec(
        "git",
        [
          "ls-tree",
          "-r",
          "--name-only",
          "HEAD",
          "--",
          IMPORTED_SKILLS_ROOT,
          IMPORTED_REFERENCES_ROOT
        ],
        { allowFailure: true }
      )
    : undefined;
  if (!trackedImports || trackedImports.exitCode !== 0 || !trackedImports.stdout.trim()) {
    snapshotSkillGuidance(repoRoot, destination);
    return;
  }
  mkdirSync(path.join(repoRoot, "tmp"), { recursive: true });
  const checkout = mkdtempSync(path.join(repoRoot, "tmp", "skill-migration-base-"));
  try {
    const commit = runtime.exec("git", ["rev-parse", "HEAD"]).stdout.trim();
    runtime.exec("git", [
      "clone",
      "--quiet",
      "--shared",
      "--no-checkout",
      "--",
      repoRoot,
      checkout
    ]);
    runtime.exec("git", ["checkout", "--quiet", "--detach", commit], { cwd: checkout });
    snapshotSkillGuidance(checkout, destination);
  } finally {
    rmSync(checkout, { force: true, recursive: true });
  }
}

function reviewPaths(runtime: Runtime) {
  const root = path.join(getMonkeHome(runtime), "skill-reviews");
  return {
    index: path.join(root, "comparisons.json"),
    repository: path.join(root, "repository"),
    root
  };
}

function readReviews(index: string) {
  return existsSync(index) ? ReviewsSchema.parse(JSON.parse(readFileSync(index, "utf-8"))) : [];
}

/** Publish independent commit pairs and retain three comparisons in one stable repository. */
export async function saveSkillComparison(
  before: string,
  after: string,
  runtime = createRuntime()
) {
  return await withScopedLockAsync(getMonkeHome(runtime), "skill-review-cache", () => {
    const paths = reviewPaths(runtime);
    mkdirSync(paths.root, { recursive: true });
    mkdirSync(paths.repository, { recursive: true });
    const git = (args: string[], stdin?: string) =>
      runtime.exec("git", args, { cwd: paths.repository, stdin }).stdout.trim();
    if (!existsSync(path.join(paths.repository, ".git"))) {
      git(["init", "--quiet"]);
    }
    git(["config", "user.name", "Monke skill review"]);
    git(["config", "user.email", "skill-review@localhost"]);
    git(["config", "core.logAllRefUpdates", "false"]);
    git(["config", "core.autocrlf", "false"]);
    git(["config", "core.filemode", "true"]);
    git(["config", "core.symlinks", "true"]);
    git(["config", "gc.auto", "0"]);
    mkdirSync(path.join(paths.repository, ".git", "info"), { recursive: true });
    writeFileSync(
      path.join(paths.repository, ".git", "info", "attributes"),
      "* -text -filter -ident\n"
    );
    const reviews = readReviews(paths.index);
    const replaceRetainedRefs = (from: typeof reviews, to: typeof reviews) => {
      const retainedIds = new Set(to.map((review) => review.id));
      git(
        ["update-ref", "--stdin"],
        [
          "start",
          ...to.map((review) => `update refs/heads/skill-review-${review.id} ${review.commit}`),
          ...from
            .filter((review) => !retainedIds.has(review.id))
            .map((review) => `delete refs/heads/skill-review-${review.id}`),
          "prepare",
          "commit",
          ""
        ].join("\n")
      );
    };
    // An interrupted publisher can leave a newer ref transaction with the old
    // ledger. Recover from the durable ledger before creating or pruning objects.
    const recordedRefs = git([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads/skill-review-*"
    ]);
    const actualReviews = recordedRefs
      ? recordedRefs.split("\n").map((row) => {
          const [ref, commit] = row.split(" ");
          return ReviewSchema.parse({ commit, id: ref?.slice("refs/heads/skill-review-".length) });
        })
      : [];
    replaceRetainedRefs(actualReviews, reviews);
    const previousHeadRef = reviews.at(-1)
      ? `refs/heads/skill-review-${reviews.at(-1)?.id}`
      : "refs/heads/main";
    git(["symbolic-ref", "HEAD", previousHeadRef]);
    for (const entry of readdirSync(paths.root)) {
      if (entry.startsWith(`${path.basename(paths.index)}.`) && entry.endsWith(".tmp")) {
        rmSync(path.join(paths.root, entry), { force: true });
      }
    }
    const clearWorkingTree = () => {
      for (const entry of readdirSync(paths.repository)) {
        if (entry !== ".git") {
          rmSync(path.join(paths.repository, entry), { force: true, recursive: true });
        }
      }
    };
    const tree = (snapshot: string) => {
      clearWorkingTree();
      for (const entry of readdirSync(snapshot)) {
        cpSync(path.join(snapshot, entry), path.join(paths.repository, entry), {
          recursive: true,
          verbatimSymlinks: true
        });
      }
      git(["read-tree", "--empty"]);
      git(["add", "--all", "--force", "--", "."]);
      return git(["write-tree"]);
    };
    try {
      const beforeTree = tree(before);
      const afterTree = tree(after);
      if (beforeTree === afterTree) {
        return;
      }
      const id = sha256(`${beforeTree}\0${afterTree}`);
      const previous = reviews.find((review) => review.id === id);
      const baseline = previous
        ? undefined
        : git(["commit-tree", beforeTree], "Imported guidance before update\n");
      const commit =
        previous?.commit ??
        git(["commit-tree", afterTree, "-p", baseline ?? ""], "Imported guidance update\n");
      const retained = [...reviews.filter((review) => review.id !== id), { commit, id }].slice(-3);
      const nextIndex = `${paths.index}.${crypto.randomUUID()}.tmp`;
      let refsChanged = false;
      try {
        // Prepare metadata before changing retention. A failed publication leaves
        // the previous ledger and all its commit pairs available for retry.
        writeFileSync(nextIndex, `${JSON.stringify(retained, null, 2)}\n`);
        replaceRetainedRefs(reviews, retained);
        refsChanged = true;
        git(["symbolic-ref", "HEAD", `refs/heads/skill-review-${id}`]);
        renameSync(nextIndex, paths.index);
      } catch (error) {
        if (refsChanged) {
          replaceRetainedRefs(retained, reviews);
          git(["symbolic-ref", "HEAD", previousHeadRef]);
        }
        throw error;
      } finally {
        rmSync(nextIndex, { force: true });
      }
      return { ...paths, commit, id };
    } finally {
      // The index also keeps objects alive. Restore only the selected retained commit
      // before reclaiming unpublished trees from no-op and failed comparisons.
      clearWorkingTree();
      git(["read-tree", "--empty"]);
      const head = runtime.exec("git", ["rev-parse", "--verify", "HEAD"], {
        allowFailure: true,
        cwd: paths.repository
      });
      if (head.exitCode === 0) {
        git(["reset", "--hard", "--quiet", head.stdout.trim()]);
      }
      git(["reflog", "expire", "--expire=now", "--all"]);
      git(["gc", "--prune=now", "--quiet"]);
    }
  });
}

export async function openSkillComparison(
  comparison: { commit: string; repository: string },
  options: { adapter?: string; runtime?: Runtime; writeMessage?: (message: string) => void } = {}
) {
  const runtime = options.runtime ?? createRuntime({ writeStdout: options.writeMessage });
  const reopen = `mt diff --commit ${shellQuote(comparison.commit)} --path ${shellQuote(comparison.repository)}${options.adapter ? ` --adapter ${shellQuote(options.adapter)}` : ""}`;
  (options.writeMessage ?? runtime.writeStdout)(`Complete skill review: ${reopen}\n`);
  try {
    await runDiffInteractive(runtime, {
      adapter: options.adapter,
      commit: comparison.commit,
      path: comparison.repository
    });
  } catch (error) {
    throw new MonkeError(
      `Skill changes remain applied; review delivery failed. Reopen with:\n${reopen}\n${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function clearSkillReviews(runtime = createRuntime()) {
  await withScopedLockAsync(getMonkeHome(runtime), "skill-review-cache", () => {
    rmSync(reviewPaths(runtime).root, { force: true, recursive: true });
  });
  runtime.writeStdout(
    "Cleared saved skill reviews. Existing review links and windows are invalidated.\n"
  );
}

export async function reviewSkillRevisions(
  base: string,
  head: string,
  options: { adapter?: string } = {}
) {
  const runtime = createRuntime();
  mkdirSync(path.join(runtime.cwd, "tmp"), { recursive: true });
  const temporaryRoot = mkdtempSync(path.join(runtime.cwd, "tmp", "skill-history-"));
  try {
    const endpoints = await Promise.all(
      [base, head].map(async (revision, index) => {
        const commit = runtime
          .exec("git", ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`])
          .stdout.trim();
        const checkout = path.join(temporaryRoot, `revision-${index}`);
        runtime.exec("git", [
          "clone",
          "--quiet",
          "--shared",
          "--no-checkout",
          "--",
          runtime.cwd,
          checkout
        ]);
        runtime.exec("git", ["checkout", "--quiet", "--detach", commit], { cwd: checkout });
        // Each source version owns its recorded materializer format; unsupported versions fail.
        await restoreSkillImports(checkout);
        const snapshot = path.join(temporaryRoot, `snapshot-${index}`);
        snapshotSkillGuidance(checkout, snapshot);
        return snapshot;
      })
    );
    const comparison = await saveSkillComparison(endpoints[0] ?? "", endpoints[1] ?? "", runtime);
    if (comparison) {
      await openSkillComparison(comparison, options);
    } else {
      runtime.writeStdout("No skill changes.\n");
    }
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}
