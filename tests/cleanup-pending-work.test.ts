import { ok } from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { readOnlyCleanupRuntime } from "../src/cleanup-eligibility.ts";
import {
  inspectDefaultTree,
  inspectPendingWork,
  provePendingWork
} from "../src/cleanup-pending-work.ts";
import { isPnpmBootstrapDeletion } from "../src/cleanup-pnpm-bootstrap.ts";
import { createRepo, git, write } from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

const sandboxes: string[] = [];
// Raw text fixtures preserve the exact pnpm bytes required by this recognizer.
const before = readFileSync(
  new URL("fixtures/cleanup-pnpm-bootstrap-before.txt", import.meta.url),
  "utf-8"
);
const after = readFileSync(
  new URL("fixtures/cleanup-pnpm-bootstrap-after.txt", import.meta.url),
  "utf-8"
);
const manifest = { packageManager: "pnpm@12.1.0" };

function fixture(files: Record<string, string> = { "a.txt": "old a\n", "b.txt": "old b\n" }) {
  mkdirSync("tmp", { recursive: true });
  const sandbox = mkdtempSync(path.resolve("tmp/cleanup-pending-"));
  sandboxes.push(sandbox);
  const source = createRepo(path.join(sandbox, "source"), files);
  const head = git(source, ["rev-parse", "HEAD"]);
  const root = path.join(sandbox, "member");
  git(source, ["worktree", "add", "-b", "member", root, head]);
  const runtime = readOnlyCleanupRuntime(createTestRuntime({ cwd: source }));
  const commit = () => {
    git(source, ["add", "."]);
    git(source, ["commit", "-m", "advance default"]);
    return git(source, ["rev-parse", "HEAD"]);
  };
  const proof = () => {
    const pending = inspectPendingWork(runtime, root, head);
    ok(pending, "Expected supported pending work");
    return provePendingWork(
      runtime,
      source,
      root,
      head,
      git(source, ["rev-parse", "HEAD"]),
      pending
    );
  };
  return { commit, head, proof, root, runtime, source };
}

describe("cleanup preservation proofs", () => {
  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) {
      rmSync(sandbox, { force: true, recursive: true });
    }
  });

  describe("pending work preservation", () => {
    test("finds one forward commit preserving the complete bundle, including deleted directories, renames, modes and symlinks", () => {
      const f = fixture({
        "a.txt": "old a\n",
        "b.txt": "old b\n",
        "nested/deleted.txt": "gone\n",
        "run.sh": "exit 0\n"
      });
      for (const root of [f.source, f.root]) {
        write(root, "a.txt", "new a\n");
        write(root, "renamed.txt", "old b\n");
        rmSync(path.join(root, "b.txt"));
        rmSync(path.join(root, "nested"), { recursive: true });
        write(root, "run.sh", "exit 1\n");
        chmodSync(path.join(root, "run.sh"), 0o755);
        symlinkSync("a.txt", path.join(root, "link"));
      }
      const witness = f.commit();
      git(f.root, ["add", "a.txt", "renamed.txt", "b.txt"]);
      expect(f.proof()).toMatchObject({ kind: "forward-bundle", witness });
      chmodSync(path.join(f.root, "run.sh"), 0o644);
      expect(f.proof()).toBeFalsy();
    });

    test("rejects separate witnesses and content found only before HEAD", () => {
      const f = fixture();
      write(f.source, "a.txt", "new a\n");
      f.commit();
      write(f.source, "a.txt", "old a\n");
      write(f.source, "b.txt", "new b\n");
      f.commit();
      write(f.root, "a.txt", "new a\n");
      write(f.root, "b.txt", "new b\n");
      expect(f.proof()).toBeFalsy();
      git(f.root, ["reset", "--hard", "main"]);
      write(f.root, "a.txt", "new a\n");
      const head = git(f.root, ["rev-parse", "HEAD"]);
      const pending = inspectPendingWork(f.runtime, f.root, head);
      ok(pending);
      expect(provePendingWork(f.runtime, f.source, f.root, head, head, pending)).toBeFalsy();
    });

    test("rejects staged content distinct from both HEAD and disk, intent-to-add, and hidden index entries", () => {
      const f = fixture();
      write(f.root, "a.txt", "staged\n");
      git(f.root, ["add", "a.txt"]);
      write(f.root, "a.txt", "unstaged\n");
      expect(inspectPendingWork(f.runtime, f.root, f.head)).toBeNull();
      git(f.root, ["reset", "--hard"]);
      write(f.root, "intent.txt", "intent\n");
      git(f.root, ["add", "--intent-to-add", "intent.txt"]);
      expect(inspectPendingWork(f.runtime, f.root, f.head)).toBeNull();
      git(f.root, ["reset", "--hard"]);
      git(f.root, ["update-index", "--assume-unchanged", "a.txt"]);
      write(f.root, "b.txt", "visible change\n");
      expect(inspectPendingWork(f.runtime, f.root, f.head)).toBeNull();
    });

    test("fingerprints changes with the same porcelain status and detects executable changes despite local config", () => {
      const f = fixture();
      write(f.root, "a.txt", "first\n");
      const first = inspectPendingWork(f.runtime, f.root, f.head);
      write(f.root, "a.txt", "second\n");
      const second = inspectPendingWork(f.runtime, f.root, f.head);
      ok(first && second);
      expect(first.fingerprint).not.toBe(second.fingerprint);
      git(f.root, ["config", "core.fileMode", "false"]);
      chmodSync(path.join(f.root, "b.txt"), 0o755);
      expect(
        inspectPendingWork(f.runtime, f.root, f.head)?.paths.find((entry) => entry.path === "b.txt")
          ?.disk?.mode
      ).toBe("100755");
    });

    test("rejects paths beneath symlinks and invalid UTF-8 filenames", () => {
      const f = fixture({ "a.txt": "old\n", "nested/file": "data\n" });
      rmSync(path.join(f.root, "nested"), { recursive: true });
      symlinkSync(f.source, path.join(f.root, "nested"));
      expect(inspectPendingWork(f.runtime, f.root, f.head)).toBeNull();
      git(f.root, ["reset", "--hard"]);
      // macOS rejects invalid UTF-8 disk names; put the actual raw filename in a Git tree.
      const blob = git(f.source, ["rev-parse", "HEAD:a.txt"]);
      const invalidTree = Bun.spawnSync(["git", "mktree", "-z"], {
        cwd: f.source,
        stdin: Buffer.concat([Buffer.from(`100644 blob ${blob}\tbad-`), Buffer.from([255, 0])])
      });
      expect(invalidTree.exitCode).toBe(0);
      const invalidHead = git(f.source, [
        "commit-tree",
        invalidTree.stdout.toString().trim(),
        "-m",
        "raw invalid filename"
      ]);
      write(f.root, "a.txt", "pending\n");
      expect(inspectPendingWork(f.runtime, f.root, invalidHead)).toBeNull();
    });

    test("rejects an unresolved merge index", () => {
      const f = fixture();
      write(f.root, "a.txt", "member edit\n");
      git(f.root, ["add", "."]);
      git(f.root, ["commit", "-m", "member edit"]);
      write(f.source, "a.txt", "default edit\n");
      f.commit();
      expect(() => git(f.root, ["merge", "main"])).toThrow(/CONFLICT/u);
      expect(inspectPendingWork(f.runtime, f.root, git(f.root, ["rev-parse", "HEAD"]))).toBeNull();
    });

    test("requires pnpm to be the only dirty path and rejects staged/disk disagreement", () => {
      const f = fixture({ "package.json": JSON.stringify(manifest), "pnpm-lock.yaml": before });
      write(f.root, "pnpm-lock.yaml", after);
      expect(f.proof()).toMatchObject({ kind: "pnpm-bootstrap", witness: null });
      write(f.root, "package.json", JSON.stringify({ packageManager: "pnpm@12.2.0" }));
      expect(f.proof()).toBeFalsy();
      git(f.root, ["checkout", "--", "package.json"]);
      write(f.root, "pnpm-lock.yaml", `${before}\n`);
      git(f.root, ["add", "pnpm-lock.yaml"]);
      write(f.root, "pnpm-lock.yaml", after);
      expect(inspectPendingWork(f.runtime, f.root, f.head)).toBeNull();
    });
  });

  describe("exact pnpm bootstrap deletion", () => {
    test("accepts the reproduced deletion with application bytes intact", () => {
      expect(isPnpmBootstrapDeletion(before, after, manifest)).toBeTruthy();
    });

    test.each([
      [after, before, manifest],
      [before, `${after}\n`, manifest],
      [before, after.replace("specifier: 1.0.0", "specifier: 2.0.0"), manifest],
      [before, after, { packageManager: "pnpm@12.0.0" }],
      [
        before.replace("packageManagerDependencies:", "dependencies:"),
        after.replace("packageManagerDependencies:", "dependencies:"),
        manifest
      ],
      [before.replace("---\n", ""), after.replace("---\n", ""), manifest],
      [
        `---\nlockfileVersion: '9.0'\n\nimporters: {}\n${before}`,
        `---\nlockfileVersion: '9.0'\n\nimporters: {}\n${after}`,
        manifest
      ]
    ])("rejects reverse, application, version, importer, and document changes", (a, b, pin) => {
      expect(isPnpmBootstrapDeletion(a, b, pin)).toBeFalsy();
    });
  });

  test("replacement objects cannot make a unique HEAD tree equal default history", () => {
    const f = fixture();
    write(f.root, "a.txt", "unique committed work\n");
    git(f.root, ["add", "."]);
    git(f.root, ["commit", "-m", "unique"]);
    const head = git(f.root, ["rev-parse", "HEAD"]);
    git(f.source, ["replace", head, f.head]);
    expect(git(f.source, ["rev-parse", `${head}^{tree}`])).toBe(
      git(f.source, ["rev-parse", `${f.head}^{tree}`])
    );
    expect(inspectDefaultTree(f.runtime, f.source, head, f.head)).toBeFalsy();
  });

  test("whole tree equality includes path and mode, and records the historical witness", () => {
    const f = fixture();
    git(f.root, ["commit", "--allow-empty", "-m", "different commit same tree"]);
    const head = git(f.root, ["rev-parse", "HEAD"]);
    write(f.source, "a.txt", "later change\n");
    const latest = f.commit();
    expect(inspectDefaultTree(f.runtime, f.source, head, latest)).toStrictEqual({
      tree: git(f.root, ["rev-parse", "HEAD^{tree}"]),
      witness: f.head
    });
    chmodSync(path.join(f.root, "b.txt"), 0o755);
    git(f.root, ["add", "."]);
    git(f.root, ["commit", "-m", "unique mode"]);
    expect(
      inspectDefaultTree(f.runtime, f.source, git(f.root, ["rev-parse", "HEAD"]), latest)
    ).toBeFalsy();
  });
});
