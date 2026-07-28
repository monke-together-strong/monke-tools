import { describe, expect, test } from "vite-plus/test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SHELL_DIRECTORY_DIRECTIVE_ENV } from "../src/shell.ts";
import { createRepo, git, installGitShim, makeTempDir, runMonke, write } from "./helpers.ts";

interface OrdinaryFixture {
  home: string;
  sandbox: string;
  sourceRoot: string;
  worktreePath: string;
}

function createOrdinaryFixture(
  prefix: string,
  options: {
    files?: Record<string, string>;
    worktreePath?: (fixture: Omit<OrdinaryFixture, "worktreePath">) => string;
  } = {},
): OrdinaryFixture {
  const sandbox = makeTempDir(prefix);
  const home = path.join(sandbox, "home");
  const sourceRoot = createRepo(
    path.join(sandbox, "root"),
    options.files ?? { "README.md": "source\n" },
  );
  const base = { home, sandbox, sourceRoot };
  const worktreePath = options.worktreePath?.(base) ?? path.join(sandbox, "ordinary");
  git(sourceRoot, ["branch", "feature"]);
  git(sourceRoot, ["worktree", "add", worktreePath, "feature"]);
  return { ...base, worktreePath };
}

describe("chop", () => {
  test("removes the current clean Ordinary worktree and preserves its branch", () => {
    const fixture = createOrdinaryFixture("chop-current-ordinary");

    const result = runMonke({
      args: ["chop"],
      cwd: fixture.worktreePath,
      monkeHome: fixture.home,
    });

    expect(existsSync(fixture.worktreePath)).toBeFalsy();
    expect(git(fixture.sourceRoot, ["rev-parse", "--verify", "refs/heads/feature"])).not.toBe("");
    expect(result.stdout).toBe(`${fixture.sourceRoot}\n`);
    expect(result.stderr).toContain(`Chopped Ordinary worktree ${fixture.worktreePath}`);
    expect(result.stderr).toContain(
      `WARNING: your shell is still in the removed worktree; switch to ${fixture.sourceRoot}`,
    );
  });

  test.each(["branch", "absolute path", "relative path"] as const)(
    "selects an Ordinary worktree by %s",
    (selector) => {
      const fixture = createOrdinaryFixture(`chop-select-${selector.replace(" ", "-")}`);
      const target =
        selector === "branch"
          ? "feature"
          : selector === "absolute path"
            ? fixture.worktreePath
            : path.relative(fixture.sourceRoot, fixture.worktreePath);

      runMonke({
        args: ["chop", target],
        cwd: fixture.sourceRoot,
        monkeHome: fixture.home,
      });

      expect(existsSync(fixture.worktreePath)).toBeFalsy();
      expect(existsSync(fixture.sourceRoot)).toBeTruthy();
      expect(git(fixture.sourceRoot, ["rev-parse", "--verify", "refs/heads/feature"])).not.toBe("");
    },
  );

  test("rejects a locked Ordinary worktree before removal", () => {
    const fixture = createOrdinaryFixture("chop-locked");
    const binDirectory = path.join(fixture.sandbox, "bin");
    mkdirSync(binDirectory);
    const gitLogPath = installGitShim(binDirectory);
    git(fixture.sourceRoot, ["worktree", "lock", "--reason", "still in use", fixture.worktreePath]);

    expect(() => {
      runMonke({
        args: ["chop", "feature"],
        binDirectory,
        cwd: fixture.sourceRoot,
        monkeHome: fixture.home,
      });
    }).toThrow(/locked.*still in use/u);

    expect(existsSync(fixture.worktreePath)).toBeTruthy();
    expect(readFileSync(gitLogPath, "utf-8")).not.toContain("worktree remove");
  });

  test.each(["staged", "modified", "untracked"] as const)(
    "rejects an Ordinary worktree with %s files",
    (dirtyKind) => {
      const fixture = createOrdinaryFixture(`chop-dirty-${dirtyKind}`);
      if (dirtyKind === "untracked") {
        write(fixture.worktreePath, "scratch.txt", "untracked\n");
      } else {
        write(fixture.worktreePath, "README.md", `${dirtyKind}\n`);
        if (dirtyKind === "staged") {
          git(fixture.worktreePath, ["add", "README.md"]);
        }
      }

      expect(() => {
        runMonke({
          args: ["chop", "feature"],
          cwd: fixture.sourceRoot,
          monkeHome: fixture.home,
        });
      }).toThrow(/dirty worktree/u);
      expect(existsSync(fixture.worktreePath)).toBeTruthy();
    },
  );

  test("rejects a registered path replaced by a checkout from another repository", () => {
    const fixture = createOrdinaryFixture("chop-wrong-repo");
    const binDirectory = path.join(fixture.sandbox, "bin");
    mkdirSync(binDirectory);
    const gitLogPath = installGitShim(binDirectory);
    rmSync(fixture.worktreePath, { recursive: true });
    createRepo(fixture.worktreePath, {
      "README.md": "unrelated\n",
    });

    expect(() => {
      runMonke({
        args: ["chop", "feature"],
        binDirectory,
        cwd: fixture.sourceRoot,
        monkeHome: fixture.home,
      });
    }).toThrow(/belongs to .* expected/u);

    expect(readFileSync(path.join(fixture.worktreePath, "README.md"), "utf-8")).toBe("unrelated\n");
    expect(readFileSync(gitLogPath, "utf-8")).not.toContain("worktree remove");
  });

  test("removes a clean worktree with an initialized submodule", () => {
    const sandbox = makeTempDir("chop-submodule");
    const home = path.join(sandbox, "home");
    const submoduleRoot = createRepo(path.join(sandbox, "submodule"), {
      "README.md": "submodule\n",
    });
    const sourceRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "source\n",
    });
    git(sourceRoot, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      submoduleRoot,
      "vendor/submodule",
    ]);
    git(sourceRoot, ["commit", "-am", "add submodule"]);
    const worktreePath = path.join(sandbox, "ordinary");
    git(sourceRoot, ["branch", "feature"]);
    git(sourceRoot, ["worktree", "add", worktreePath, "feature"]);
    git(worktreePath, ["-c", "protocol.file.allow=always", "submodule", "update", "--init"]);

    runMonke({
      args: ["chop", "feature"],
      cwd: sourceRoot,
      monkeHome: home,
    });

    expect(existsSync(worktreePath)).toBeFalsy();
    expect(git(sourceRoot, ["rev-parse", "--verify", "refs/heads/feature"])).not.toBe("");
  });

  test("protects Source checkouts and rejects a branch without a registered worktree", () => {
    const sandbox = makeTempDir("chop-protected-targets");
    const home = path.join(sandbox, "home");
    const sourceRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "source\n",
    });
    git(sourceRoot, ["branch", "branch-only"]);

    expect(() => {
      runMonke({ args: ["chop"], cwd: sourceRoot, monkeHome: home });
    }).toThrow(/Source checkout requires an explicit target/u);
    expect(() => {
      runMonke({ args: ["chop", sourceRoot], cwd: sourceRoot, monkeHome: home });
    }).toThrow(/Cannot Chop the Source checkout/u);
    expect(() => {
      runMonke({ args: ["chop", "branch-only"], cwd: sourceRoot, monkeHome: home });
    }).toThrow(/has no registered worktree to Chop/u);
    expect(existsSync(sourceRoot)).toBeTruthy();
  });

  test("does not treat a worktree in Monke's managed area as Ordinary", () => {
    const fixture = createOrdinaryFixture("chop-managed-area", {
      worktreePath: ({ home }) => path.join(home, "worktrees", "root", "feature"),
    });

    expect(() => {
      runMonke({
        args: ["chop", "feature"],
        cwd: fixture.sourceRoot,
        monkeHome: fixture.home,
      });
    }).toThrow(/managed worktree.*Ordinary/u);
    expect(existsSync(fixture.worktreePath)).toBeTruthy();
  });

  test.each(["current", "registered path"] as const)(
    "removes a detached Ordinary worktree selected by %s",
    (selector) => {
      const sandbox = makeTempDir(`chop-detached-${selector.replace(" ", "-")}`);
      const home = path.join(sandbox, "home");
      const sourceRoot = createRepo(path.join(sandbox, "root"), {
        "README.md": "source\n",
      });
      const worktreePath = path.join(sandbox, "detached");
      git(sourceRoot, ["worktree", "add", "--detach", worktreePath, "HEAD"]);

      runMonke({
        args: selector === "current" ? ["chop"] : ["chop", worktreePath],
        cwd: selector === "current" ? worktreePath : sourceRoot,
        monkeHome: home,
      });

      expect(existsSync(worktreePath)).toBeFalsy();
    },
  );

  test("rejects a path registered to an unrelated repository", () => {
    const sandbox = makeTempDir("chop-unrelated-target");
    const home = path.join(sandbox, "home");
    const sourceRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "source\n",
    });
    const otherRoot = createRepo(path.join(sandbox, "other"), {
      "README.md": "other\n",
    });
    const otherWorktree = path.join(sandbox, "other-worktree");
    git(otherRoot, ["branch", "other-feature"]);
    git(otherRoot, ["worktree", "add", otherWorktree, "other-feature"]);

    expect(() => {
      runMonke({
        args: ["chop", otherWorktree],
        cwd: sourceRoot,
        monkeHome: home,
      });
    }).toThrow(/No registered worktree in/u);
    expect(existsSync(otherWorktree)).toBeTruthy();
  });

  test("ignored files do not block removal and are deleted with the worktree", () => {
    const fixture = createOrdinaryFixture("chop-ignored", {
      files: {
        ".gitignore": "ignored/\n",
        "README.md": "source\n",
      },
    });
    write(fixture.worktreePath, "ignored/artifact.txt", "generated\n");

    runMonke({
      args: ["chop", "feature"],
      cwd: fixture.sourceRoot,
      monkeHome: fixture.home,
    });

    expect(existsSync(fixture.worktreePath)).toBeFalsy();
  });

  test("self-removal writes the Source checkout to an Active shell directive", () => {
    const fixture = createOrdinaryFixture("chop-active-shell");
    const directivePath = path.join(fixture.sandbox, "directive");
    writeFileSync(directivePath, "", "utf-8");

    const result = runMonke({
      args: ["chop"],
      cwd: fixture.worktreePath,
      extraEnv: {
        [SHELL_DIRECTORY_DIRECTIVE_ENV]: directivePath,
      },
      monkeHome: fixture.home,
    });

    expect(readFileSync(directivePath, "utf-8")).toBe(fixture.sourceRoot);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Switched to ${fixture.sourceRoot}`);
  });

  test("Ordinary Chop does not run Cleanup commands or mutate Session state", () => {
    const fixture = createOrdinaryFixture("chop-no-session-state", {
      files: {
        "README.md": "source\n",
        "monke.yml": "cleanupCommand: 'touch cleanup-ran'\n",
      },
    });
    const statePath = path.join(fixture.home, "sessions", "sentinel.yml");
    write(fixture.home, "sessions/sentinel.yml", "untouched\n");

    runMonke({
      args: ["chop", "feature"],
      cwd: fixture.sourceRoot,
      monkeHome: fixture.home,
    });

    expect(readFileSync(statePath, "utf-8")).toBe("untouched\n");
    expect(existsSync(path.join(fixture.sourceRoot, "cleanup-ran"))).toBeFalsy();
  });
});
