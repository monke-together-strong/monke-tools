import { ok } from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { inspectMatchingMergeDiff } from "../src/cleanup-diff-evidence.ts";
import { readOnlyCleanupRuntime } from "../src/cleanup-eligibility.ts";
import { createRepo, git, write } from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

const sandboxes: string[] = [];

function fixture() {
  mkdirSync("tmp", { recursive: true });
  const sandbox = mkdtempSync(path.resolve("tmp/cleanup-diff-"));
  sandboxes.push(sandbox);
  const source = createRepo(path.join(sandbox, "source"), {
    "delete.txt": "delete me\n",
    "file.txt": "old text\n",
    "old-name.txt": "rename me\n",
    "run.sh": "exit 0\n"
  });
  const base = git(source, ["rev-parse", "HEAD"]);
  const applyChange = () => {
    write(source, "file.txt", "new text\n");
    writeFileSync(path.join(source, "binary.bin"), Buffer.from([0, 255, 1, 0]));
    write(source, "odd\npath.txt", "unusual path\n");
    write(source, "new-name.txt", "rename me\n");
    rmSync(path.join(source, "old-name.txt"));
    rmSync(path.join(source, "delete.txt"));
    chmodSync(path.join(source, "run.sh"), 0o755);
    git(source, ["add", "."]);
  };
  git(source, ["switch", "-c", "original"]);
  applyChange();
  git(source, ["commit", "-m", "original feature"]);
  const head = git(source, ["rev-parse", "HEAD"]);
  git(source, ["switch", "main"]);
  write(source, "base-only.txt", "unrelated main advancement\n");
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "advance main"]);
  applyChange();
  git(source, ["commit", "-m", "land amended feature"]);
  const merge = git(source, ["rev-parse", "HEAD"]);
  const runtime = readOnlyCleanupRuntime(createTestRuntime({ cwd: source }));
  return { base, head, merge, runtime, source };
}

describe("complete merged change evidence", () => {
  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) {
      rmSync(sandbox, { force: true, recursive: true });
    }
  });

  test("matches complete path/object/mode changes despite unrelated base advancement and diff configuration", () => {
    const f = fixture();
    git(f.source, ["config", "diff.renames", "copies"]);
    git(f.source, ["config", "diff.relative", "true"]);
    git(f.source, ["config", "diff.external", "false"]);
    git(f.source, ["config", "diff.ignoreSubmodules", "all"]);
    const diff = inspectMatchingMergeDiff(f.runtime, f.source, f.head, f.merge, f.merge);
    ok(diff !== undefined && diff !== null && diff !== false, "Expected a matching complete diff");
    expect(diff.changeHash).toMatch(/^[\da-f]{64}$/u);
    expect(diff).toMatchObject({
      mergeBase: f.base,
      mergeParent: git(f.source, ["rev-parse", `${f.merge}^1`])
    });
  });

  test.each(["whitespace", "binary", "mode", "path", "extra-change"] as const)(
    "rejects a landed %s difference",
    (kind) => {
      const f = fixture();
      switch (kind) {
        case "whitespace": {
          write(f.source, "file.txt", "new  text\n");
          break;
        }
        case "binary": {
          writeFileSync(path.join(f.source, "binary.bin"), Buffer.from([0, 254, 1, 0]));
          break;
        }
        case "mode": {
          chmodSync(path.join(f.source, "run.sh"), 0o644);
          break;
        }
        case "path": {
          git(f.source, ["mv", "new-name.txt", "different-name.txt"]);
          break;
        }
        case "extra-change": {
          write(f.source, "extra.txt", "additional landed work\n");
          break;
        }
        default: {
          throw new Error("Unexpected diff variant");
        }
      }
      git(f.source, ["add", "."]);
      git(f.source, ["commit", "--amend", "--no-edit"]);
      const merge = git(f.source, ["rev-parse", "HEAD"]);
      expect(inspectMatchingMergeDiff(f.runtime, f.source, f.head, merge, merge)).toBeFalsy();
    }
  );

  test("distinguishes paths with different non-UTF-8 bytes", () => {
    const f = fixture();
    const blob = git(f.source, ["rev-parse", `${f.head}:file.txt`]);
    const addPath = (commit: string, byte: number) => {
      git(f.source, ["read-tree", commit]);
      const result = Bun.spawnSync(["git", "update-index", "-z", "--index-info"], {
        cwd: f.source,
        stdin: Buffer.concat([
          Buffer.from(`100644 ${blob}\t`),
          Buffer.from([byte]),
          Buffer.from(".txt\0")
        ])
      });
      expect(result.exitCode).toBe(0);
      const tree = git(f.source, ["write-tree"]);
      return git(f.source, ["commit-tree", tree, "-p", `${commit}^1`, "-m", "raw filename"]);
    };
    const merge = addPath(f.merge, 255);
    const head = addPath(f.head, 254);
    expect(inspectMatchingMergeDiff(f.runtime, f.source, head, merge, merge)).toBeFalsy();
  });

  test("rejects a divergent merge even when its net change matches the landed change", () => {
    const f = fixture();
    git(f.source, ["switch", "-c", "side", f.base]);
    write(f.source, "side.txt", "side work\n");
    git(f.source, ["add", "."]);
    git(f.source, ["commit", "-m", "side"]);
    git(f.source, ["switch", "original"]);
    git(f.source, ["merge", "--no-ff", "-s", "ours", "side", "-m", "divergent merge"]);
    const head = git(f.source, ["rev-parse", "HEAD"]);
    expect(inspectMatchingMergeDiff(f.runtime, f.source, head, f.merge, f.merge)).toBeFalsy();
  });

  test("does not accept two empty changes as completion proof", () => {
    const f = fixture();
    git(f.source, ["switch", "-c", "empty", f.base]);
    git(f.source, ["commit", "--allow-empty", "-m", "no work yet"]);
    const head = git(f.source, ["rev-parse", "HEAD"]);
    git(f.source, ["switch", "main"]);
    git(f.source, ["commit", "--allow-empty", "-m", "empty merge"]);
    const merge = git(f.source, ["rev-parse", "HEAD"]);
    expect(inspectMatchingMergeDiff(f.runtime, f.source, head, merge, merge)).toBeFalsy();
  });

  test("missing objects and shallow history remain unavailable", () => {
    const f = fixture();
    expect(
      inspectMatchingMergeDiff(f.runtime, f.source, f.head, f.merge, "a".repeat(40))
    ).toBeNull();
    writeFileSync(path.join(f.source, ".git/shallow"), `${f.base}\n`);
    expect(inspectMatchingMergeDiff(f.runtime, f.source, f.head, f.merge, f.merge)).toBeNull();
  });

  test("includes changed submodule commit IDs even when config hides submodule changes", () => {
    const f = fixture();
    git(f.source, ["config", "diff.ignoreSubmodules", "all"]);
    git(f.source, ["update-index", "--add", "--cacheinfo", `160000,${f.base},dependency`]);
    git(f.source, ["commit", "--amend", "--no-edit"]);
    const merge = git(f.source, ["rev-parse", "HEAD"]);
    expect(inspectMatchingMergeDiff(f.runtime, f.source, f.head, merge, merge)).toBeFalsy();
  });
});
