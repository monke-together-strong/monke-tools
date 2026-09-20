import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { getExpectedWorktreePath } from "../src/git.ts";
import { loadSessionState } from "../src/session-state-store.ts";
import {
  createRepo,
  git,
  installGitShim,
  makeTempDir,
  read,
  runMonke,
  runMonkeCapturingFailure,
  write
} from "./helpers.ts";

describe("spawn from worktrees", () => {
  test("spawn from a Session worktree carries its HEAD and edits while retaining canonical configuration", () => {
    const sandbox = makeTempDir("spawn-from-worktree");
    const home = path.join(sandbox, "home");
    const dep = createRepo(path.join(sandbox, "dep"), {
      ".env.local": "PORT=5432\n",
      "dep.txt": "dependency\n",
      "monke.yml":
        "apps:\n  db:\n    path: .\n    envFile: .env.local\n    mappings:\n      - port: DEP_PORT\n        env: PORT\n"
    });
    const root = createRepo(path.join(sandbox, "root"), {
      ".env.local": "PORT=5432\n",
      "monke.yml":
        "apps:\n  api:\n    path: .\n    envFile: .env.local\n    mappings: []\nexternal:\n  dep:\n    path: ../dep\n    pathEnv: DEP_DIR\n    mappings:\n      - port: DEP_PORT\n        app: api\n        env: PORT\n",
      "src/tracked.txt": "base\n"
    });
    runMonke({ args: ["spawn", "feature-a"], cwd: root, monkeHome: home });
    const donor = getExpectedWorktreePath(home, root, "feature-a");
    write(donor, "committed.txt", "donor commit\n");
    git(donor, ["add", "committed.txt"]);
    git(donor, ["commit", "-m", "Donor commit"]);
    const donorHead = git(donor, ["rev-parse", "HEAD"]);
    write(donor, "src/tracked.txt", "staged\n");
    git(donor, ["add", "src/tracked.txt"]);
    write(donor, "src/tracked.txt", "unstaged\n");
    write(donor, "notes.txt", "donor notes\n");
    write(donor, "monke.yml", "apps: {}\n");
    write(root, "src/tracked.txt", "source-only edit\n");
    write(dep, "dep.txt", "dependency source edit\n");
    write(getExpectedWorktreePath(home, dep, "feature-a"), "dep.txt", "old session edit\n");
    const donorIndex = git(donor, ["diff", "--cached", "--binary"]);
    const donorStatus = git(donor, ["status", "--porcelain"]);

    runMonke({ args: ["spawn", "feature-b"], cwd: path.join(donor, "src"), monkeHome: home });

    const target = getExpectedWorktreePath(home, root, "feature-b");
    const targetDep = getExpectedWorktreePath(home, dep, "feature-b");
    expect(git(target, ["rev-parse", "HEAD"])).toBe(donorHead);
    expect(read(target, "committed.txt")).toBe("donor commit\n");
    expect(read(target, "src/tracked.txt")).toBe("unstaged\n");
    expect(read(target, "notes.txt")).toBe("donor notes\n");
    expect(read(target, "monke.yml")).toBe("apps: {}\n");
    expect(read(target, ".env")).toContain("DEP_DIR=../../dep/feature-b");
    expect(read(targetDep, "dep.txt")).toBe("dependency source edit\n");
    expect(git(donor, ["diff", "--cached", "--binary"])).toBe(donorIndex);
    expect(git(donor, ["status", "--porcelain"])).toBe(donorStatus);
    expect(read(donor, "src/tracked.txt")).toBe("unstaged\n");
    expect(read(root, "src/tracked.txt")).toBe("source-only edit\n");
    const state = loadSessionState(home, root, "feature-b");
    expect(state.rootSourceRoot).toBe(root);
    expect(state.repos.map((repo) => repo.sourceRoot).toSorted()).toStrictEqual(
      [dep, root].toSorted()
    );
    expect(state.repos.find((repo) => repo.sourceRoot === root)?.diffBaseRef).toBe(
      "refs/heads/feature-a"
    );
  });

  test.each([true, false])(
    "interrupted worktree dirty carry retains its donor (configured: %s)",
    (configured) => {
      const { donor, home, root, sandbox } = createWorktreeFixture(configured);
      const target = getExpectedWorktreePath(home, root, "interrupted");
      write(donor, "tracked.txt", "donor edits\n");
      write(donor, "notes.txt", "donor notes\n");
      const originalHead = git(donor, ["rev-parse", "HEAD"]).trim();
      const binDirectory = path.join(sandbox, "bin");
      installGitShim(binDirectory, {
        afterCommand: {
          args: `worktree add ${target} interrupted`,
          cwd: root,
          script: 'kill -KILL "$PPID"'
        }
      });
      const interrupted = runMonkeCapturingFailure({
        args: ["spawn", "interrupted"],
        binDirectory,
        cwd: donor,
        monkeHome: home
      });
      expect(interrupted.error).not.toBeNull();
      expect(loadSessionState(home, root, "interrupted").repos[0]).toMatchObject({
        dirtyCarrySource: { checkoutRoot: donor, headCommit: originalHead },
        dirtyCarryStatus: "pending"
      });
      expect(() =>
        runMonke({ args: ["spawn", "interrupted"], cwd: root, monkeHome: home })
      ).toThrow(/dirty carry.*checkout/isu);
      git(donor, ["commit", "--allow-empty", "-m", "Moved donor"]);
      expect(() =>
        runMonke({ args: ["spawn", "interrupted"], cwd: donor, monkeHome: home })
      ).toThrow(/dirty carry.*HEAD/isu);
      git(donor, ["reset", "--soft", originalHead]);
      git(target, ["commit", "--allow-empty", "-m", "Moved destination"]);
      expect(() =>
        runMonke({ args: ["spawn", "interrupted"], cwd: donor, monkeHome: home })
      ).toThrow(/carrying dirty changes onto a diverged branch is unsafe/u);
      git(target, ["reset", "--soft", originalHead]);
      expect(read(target, "tracked.txt")).toBe("base\n");
      const resumed = runMonkeCapturingFailure({
        args: ["spawn", "interrupted"],
        cwd: donor,
        monkeHome: home
      });
      expect(resumed.error === null).toBe(configured);
      expect(resumed.stderr).toContain(
        configured ? "Spawned or updated session" : "Prepared Root repo Session worktree"
      );
      expect(read(target, "tracked.txt")).toBe("donor edits\n");
      expect(read(target, "notes.txt")).toBe("donor notes\n");
      expect(loadSessionState(home, root, "interrupted").repos[0]?.dirtyCarryStatus).toBe(
        "complete"
      );
    }
  );

  test.each([false, true])("--no-dirty checks the invoking checkout (detached: %s)", (detached) => {
    const { donor, home, root } = createWorktreeFixture();
    if (detached) {
      git(donor, ["checkout", "--detach"]);
    }
    write(root, "tracked.txt", "unrelated source edit\n");
    runMonke({ args: ["spawn", "clean-donor", "--no-dirty"], cwd: donor, monkeHome: home });
    const target = getExpectedWorktreePath(home, root, "clean-donor");
    expect(git(target, ["rev-parse", "HEAD"])).toBe(git(donor, ["rev-parse", "HEAD"]));
    expect(read(target, "tracked.txt")).toBe("base\n");
    write(donor, "notes.txt", "dirty donor\n");
    expect(() =>
      runMonke({ args: ["spawn", "dirty-donor", "--no-dirty"], cwd: donor, monkeHome: home })
    ).toThrow(`Content checkout is dirty: ${donor}`);
    expect(existsSync(getExpectedWorktreePath(home, root, "dirty-donor"))).toBeFalsy();
  });

  test.each([["--main"], ["--main", "--no-dirty"]])(
    "default-branch mode from a worktree ignores donor edits: %j",
    (...flags) => {
      const { donor, home, root } = createWorktreeFixture();
      write(donor, "tracked.txt", "dirty donor\n");
      write(donor, "notes.txt", "donor notes\n");
      runMonke({ args: ["spawn", "fresh-main", ...flags], cwd: donor, monkeHome: home });
      const target = getExpectedWorktreePath(home, root, "fresh-main");
      expect(git(target, ["rev-parse", "HEAD"])).toBe(git(root, ["rev-parse", "HEAD"]));
      expect(read(target, "tracked.txt")).toBe("base\n");
      expect(existsSync(path.join(target, "committed.txt"))).toBeFalsy();
      expect(existsSync(path.join(target, "notes.txt"))).toBeFalsy();
      expect(read(donor, "tracked.txt")).toBe("dirty donor\n");
    }
  );

  test("dirty carry compares an existing branch against donor HEAD and preserves existing destinations", () => {
    const { donor, home, root } = createWorktreeFixture();
    const target = getExpectedWorktreePath(home, root, "existing");
    git(root, ["branch", "existing"]);
    write(donor, "tracked.txt", "donor edits\n");
    expect(() => runMonke({ args: ["spawn", "existing"], cwd: donor, monkeHome: home })).toThrow(
      /carrying dirty changes onto a diverged branch is unsafe/u
    );
    expect(existsSync(target)).toBeFalsy();
    git(root, ["branch", "-f", "existing", "donor"]);
    runMonke({ args: ["spawn", "existing"], cwd: donor, monkeHome: home });
    expect(read(target, "tracked.txt")).toBe("donor edits\n");
    write(target, "tracked.txt", "destination edits\n");
    write(donor, "tracked.txt", "new donor edits\n");
    const result = runMonke({ args: ["spawn", "existing"], cwd: donor, monkeHome: home });
    expect(result.stderr).toContain("were not carried into it");
    expect(read(target, "tracked.txt")).toBe("destination edits\n");
    expect(read(donor, "tracked.txt")).toBe("new donor edits\n");
  });
});

function createWorktreeFixture(configured = true) {
  const sandbox = makeTempDir("spawn-worktree-modes");
  const home = path.join(sandbox, "home");
  const root = createRepo(path.join(sandbox, "root"), {
    ...(configured ? { "monke.yml": "apps: {}\n" } : {}),
    "tracked.txt": "base\n"
  });
  const donor = path.join(sandbox, "ordinary");
  git(root, ["worktree", "add", "-b", "donor", donor]);
  write(donor, "committed.txt", "donor commit\n");
  git(donor, ["add", "committed.txt"]);
  git(donor, ["commit", "-m", "Donor commit"]);
  return { donor, home, root, sandbox };
}
