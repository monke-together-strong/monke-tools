import { describe, expect, test } from "vite-plus/test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getExpectedWorktreePath } from "../src/git.ts";
import { getSessionStateFilePath, loadSessionState, saveSessionState } from "../src/registry.ts";
import { SHELL_DIRECTORY_DIRECTIVE_ENV } from "../src/shell.ts";
import { createRepo, git, installGitShim, makeTempDir, runMonke, write } from "./helpers.ts";

interface OrdinaryFixture {
  home: string;
  sandbox: string;
  sourceRoot: string;
  worktreePath: string;
}

interface MultiRepoSessionFixture {
  binDirectory: string;
  cleanupLog: string;
  depRoot: string;
  depWorktree: string;
  home: string;
  root: string;
  rootWorktree: string;
  sandbox: string;
  session: string;
  statePath: string;
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

function createMultiRepoSessionFixture(
  prefix: string,
  session = "banana",
): MultiRepoSessionFixture {
  const sandbox = makeTempDir(prefix);
  const binDirectory = path.join(sandbox, "bin");
  mkdirSync(binDirectory);
  const home = path.join(sandbox, "home");
  const cleanupLog = path.join(sandbox, "cleanup.log");
  const depRoot = createRepo(path.join(sandbox, "dep"), {
    "README.md": "dependency\n",
  });
  const root = createRepo(path.join(sandbox, "root"), {
    "README.md": "root\n",
  });
  const depWorktree = getExpectedWorktreePath(home, depRoot, session);
  const rootWorktree = getExpectedWorktreePath(home, root, session);
  git(depRoot, ["branch", session]);
  git(depRoot, ["worktree", "add", depWorktree, session]);
  git(root, ["branch", session]);
  git(root, ["worktree", "add", rootWorktree, session]);
  saveSessionState(home, {
    repos: [
      {
        assignedPorts: [],
        cleanupCommand: `printf "dep|%s|%s|%s\\n" "$PWD" "$DEP_RESOURCE" "$MONKE_SESSION" >> "${cleanupLog}"`,
        resourceValues: [{ env: "DEP_RESOURCE", value: `dep-${session}` }],
        sourceRoot: depRoot,
        worktreePath: depWorktree,
      },
      {
        assignedPorts: [],
        cleanupCommand: `printf "root|%s|%s|%s|%s\\n" "$PWD" "$ROOT_RESOURCE" "$ROOT_DYNAMIC" "$MONKE_SESSION" >> "${cleanupLog}"`,
        resourceCommandOutputs: [
          {
            name: "root-dynamic",
            outputs: [{ env: "ROOT_DYNAMIC", value: `dynamic-${session}` }],
          },
        ],
        resourceValues: [{ env: "ROOT_RESOURCE", value: `root-${session}` }],
        sourceRoot: root,
        worktreePath: rootWorktree,
      },
    ],
    rootSourceRoot: root,
    session,
    version: 1,
  });

  return {
    binDirectory,
    cleanupLog,
    depRoot,
    depWorktree,
    home,
    root,
    rootWorktree,
    sandbox,
    session,
    statePath: getSessionStateFilePath(home, root, session),
  };
}

describe("chop", () => {
  test("removes the current single-repo Session and preserves its branch", () => {
    const sandbox = makeTempDir("chop-current-session");
    const home = path.join(sandbox, "home");
    const root = createRepo(path.join(sandbox, "root"), {
      "README.md": "source\n",
    });
    runMonke({ args: ["spawn", "banana"], cwd: root, monkeHome: home });
    const worktree = getExpectedWorktreePath(home, root, "banana");

    const result = runMonke({
      args: ["chop"],
      cwd: worktree,
      monkeHome: home,
    });

    expect(existsSync(worktree)).toBeFalsy();
    expect(existsSync(getSessionStateFilePath(home, root, "banana"))).toBeFalsy();
    expect(git(root, ["rev-parse", "--verify", "refs/heads/banana"])).not.toBe("");
    expect(result.stdout).toBe(`${root}\n`);
    expect(result.stderr).toContain("Chopped Session banana");
  });

  test("an explicit Session target wins over the invoking Session", () => {
    const sandbox = makeTempDir("chop-explicit-session");
    const home = path.join(sandbox, "home");
    const root = createRepo(path.join(sandbox, "root"), {
      "README.md": "source\n",
    });
    runMonke({ args: ["spawn", "alpha"], cwd: root, monkeHome: home });
    runMonke({ args: ["spawn", "beta"], cwd: root, monkeHome: home });
    const alpha = getExpectedWorktreePath(home, root, "alpha");
    const beta = getExpectedWorktreePath(home, root, "beta");

    runMonke({
      args: ["chop", "beta"],
      cwd: alpha,
      monkeHome: home,
    });

    expect(existsSync(alpha)).toBeTruthy();
    expect(existsSync(beta)).toBeFalsy();
    expect(existsSync(getSessionStateFilePath(home, root, "alpha"))).toBeTruthy();
    expect(existsSync(getSessionStateFilePath(home, root, "beta"))).toBeFalsy();
  });

  test("dependency-invoked Session Chop removes the invoker last and finalizes Root first", () => {
    const fixture = createMultiRepoSessionFixture("chop-session-dependency");
    const gitLog = installGitShim(fixture.binDirectory);
    const directivePath = path.join(fixture.sandbox, "directive");
    writeFileSync(directivePath, "", "utf-8");

    runMonke({
      args: ["chop"],
      binDirectory: fixture.binDirectory,
      cwd: fixture.depWorktree,
      extraEnv: {
        [SHELL_DIRECTORY_DIRECTIVE_ENV]: directivePath,
      },
      monkeHome: fixture.home,
    });

    expect(existsSync(fixture.rootWorktree)).toBeFalsy();
    expect(existsSync(fixture.depWorktree)).toBeFalsy();
    expect(existsSync(fixture.statePath)).toBeFalsy();
    expect(readFileSync(directivePath, "utf-8")).toBe(fixture.depRoot);
    expect(readFileSync(fixture.cleanupLog, "utf-8")).toBe(
      `root|${fixture.root}|root-${fixture.session}|dynamic-${fixture.session}|${fixture.session}\n` +
        `dep|${fixture.depRoot}|dep-${fixture.session}|${fixture.session}\n`,
    );
    const removals = readFileSync(gitLog, "utf-8")
      .split("\n")
      .filter((line) => line.startsWith("worktree remove"));
    expect(removals).toStrictEqual([
      `worktree remove ${fixture.rootWorktree}`,
      `worktree remove ${fixture.depWorktree}`,
    ]);
  });

  test("Session preflight reports every participating-repo failure without mutation", () => {
    const fixture = createMultiRepoSessionFixture("chop-session-preflight");
    const gitLog = installGitShim(fixture.binDirectory);
    write(fixture.rootWorktree, "dirty.txt", "dirty\n");
    git(fixture.depRoot, [
      "worktree",
      "lock",
      "--reason",
      "dependency in use",
      fixture.depWorktree,
    ]);

    let thrown: unknown;
    try {
      runMonke({
        args: ["chop", fixture.session],
        binDirectory: fixture.binDirectory,
        cwd: fixture.root,
        monkeHome: fixture.home,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error("expected Session Chop to fail");
    }
    expect(thrown.message).toContain(fixture.depWorktree);
    expect(thrown.message).toContain("dependency in use");
    expect(thrown.message).toContain(fixture.rootWorktree);
    expect(thrown.message).toContain("dirty worktree");
    expect(existsSync(fixture.depWorktree)).toBeTruthy();
    expect(existsSync(fixture.rootWorktree)).toBeTruthy();
    expect(existsSync(fixture.statePath)).toBeTruthy();
    expect(existsSync(fixture.cleanupLog)).toBeFalsy();
    expect(readFileSync(gitLog, "utf-8")).not.toContain("worktree remove");
  });

  test("a partial Session uses only recorded repos and saved Cleanup commands", () => {
    const sandbox = makeTempDir("chop-partial-session");
    const home = path.join(sandbox, "home");
    const cleanupLog = path.join(sandbox, "current-config-cleanup.log");
    const depRoot = createRepo(path.join(sandbox, "dep"), {
      "monke.yml": `cleanupCommand: 'touch "${cleanupLog}"'
apps: {}
`,
    });
    const unrecordedRoot = createRepo(path.join(sandbox, "unrecorded"), {
      "README.md": "unrecorded\n",
    });
    const root = createRepo(path.join(sandbox, "root"), {
      "monke.yml": `apps: {}
external:
  unrecorded:
    path: ../unrecorded
    pathEnv: UNRECORDED_DIR
    mappings:
      - port: UNRECORDED_PORT
        app: missing
        env: PORT
`,
    });
    const worktree = getExpectedWorktreePath(home, depRoot, "partial");
    git(depRoot, ["branch", "partial"]);
    git(depRoot, ["worktree", "add", worktree, "partial"]);
    saveSessionState(home, {
      repos: [
        {
          assignedPorts: [],
          sourceRoot: depRoot,
          worktreePath: worktree,
        },
      ],
      rootSourceRoot: root,
      session: "partial",
      version: 1,
    });

    runMonke({
      args: ["chop", "partial"],
      cwd: root,
      monkeHome: home,
    });

    expect(existsSync(worktree)).toBeFalsy();
    expect(existsSync(getExpectedWorktreePath(home, unrecordedRoot, "partial"))).toBeFalsy();
    expect(existsSync(cleanupLog)).toBeFalsy();
    expect(existsSync(getSessionStateFilePath(home, root, "partial"))).toBeFalsy();
  });

  test("failed Session finalization retains state for an isolated explicit retry", () => {
    const sandbox = makeTempDir("chop-finalization-retry");
    const home = path.join(sandbox, "home");
    const root = createRepo(path.join(sandbox, "root"), {
      "README.md": "root\n",
    });
    const worktree = getExpectedWorktreePath(home, root, "retry");
    const attempts = path.join(sandbox, "attempts.log");
    const allow = path.join(sandbox, "allow-cleanup");
    git(root, ["branch", "retry"]);
    git(root, ["worktree", "add", worktree, "retry"]);
    saveSessionState(home, {
      repos: [
        {
          assignedPorts: [],
          cleanupCommand: `printf "retry\\n" >> "${attempts}"; test -f "${allow}"`,
          sourceRoot: root,
          worktreePath: worktree,
        },
      ],
      rootSourceRoot: root,
      session: "retry",
      version: 1,
    });
    const otherStatePath = getSessionStateFilePath(home, root, "other");
    const otherCleanup = path.join(sandbox, "other-cleanup");
    saveSessionState(home, {
      repos: [
        {
          assignedPorts: [],
          cleanupCommand: `touch "${otherCleanup}"`,
          sourceRoot: root,
          worktreePath: getExpectedWorktreePath(home, root, "other"),
        },
      ],
      rootSourceRoot: root,
      session: "other",
      version: 1,
    });

    expect(() => {
      runMonke({
        args: ["chop", "retry"],
        cwd: root,
        monkeHome: home,
      });
    }).toThrow(/Cleanup command failed/u);
    expect(existsSync(worktree)).toBeFalsy();
    expect(existsSync(getSessionStateFilePath(home, root, "retry"))).toBeTruthy();
    expect(existsSync(otherStatePath)).toBeTruthy();
    expect(existsSync(otherCleanup)).toBeFalsy();

    writeFileSync(allow, "", "utf-8");
    runMonke({
      args: ["chop", "retry"],
      cwd: root,
      monkeHome: home,
    });

    expect(readFileSync(attempts, "utf-8")).toBe("retry\nretry\n");
    expect(existsSync(getSessionStateFilePath(home, root, "retry"))).toBeFalsy();
    expect(existsSync(otherStatePath)).toBeTruthy();
    expect(existsSync(otherCleanup)).toBeFalsy();
  });

  test("explicit Session Chop rejects ownership recorded by another Session", () => {
    const sandbox = makeTempDir("chop-cross-session-ownership");
    const home = path.join(sandbox, "home");
    const root = createRepo(path.join(sandbox, "root"), {
      "README.md": "root\n",
    });
    const worktree = getExpectedWorktreePath(home, root, "selected");
    git(root, ["branch", "selected"]);
    git(root, ["worktree", "add", worktree, "selected"]);
    saveSessionState(home, {
      repos: [{ assignedPorts: [], sourceRoot: root, worktreePath: worktree }],
      rootSourceRoot: root,
      session: "selected",
      version: 1,
    });
    saveSessionState(home, {
      repos: [{ assignedPorts: [], sourceRoot: root, worktreePath: worktree }],
      rootSourceRoot: root,
      session: "conflicting",
      version: 1,
    });

    expect(() => {
      runMonke({
        args: ["chop", "selected"],
        cwd: root,
        monkeHome: home,
      });
    }).toThrow(/also recorded by Session conflicting/u);
    expect(existsSync(worktree)).toBeTruthy();
    expect(existsSync(getSessionStateFilePath(home, root, "selected"))).toBeTruthy();
  });

  test("Session preflight aggregates invalid Root order with duplicate records", () => {
    const fixture = createMultiRepoSessionFixture("chop-invalid-session-order");
    const state = loadSessionState(fixture.home, fixture.root, fixture.session);
    saveSessionState(fixture.home, {
      ...state,
      repos: [state.repos[1], state.repos[0], state.repos[0]],
    });

    let thrown: unknown;
    try {
      runMonke({
        args: ["chop", fixture.session],
        cwd: fixture.root,
        monkeHome: fixture.home,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error("expected invalid Session state to fail");
    }
    expect(thrown.message).toContain("more than once");
    expect(thrown.message).toContain("before its dependencies");
    expect(existsSync(fixture.depWorktree)).toBeTruthy();
    expect(existsSync(fixture.rootWorktree)).toBeTruthy();
    expect(existsSync(fixture.cleanupLog)).toBeFalsy();
  });

  test("broad Cleanup reuses saved-state-only Root-first Session finalization", () => {
    const sandbox = makeTempDir("cleanup-targeted-finalization");
    const home = path.join(sandbox, "home");
    const cleanupLog = path.join(sandbox, "cleanup.log");
    const depRoot = createRepo(path.join(sandbox, "dep"), {
      "monke.yml": `cleanupCommand: 'printf "current-dep\\n" >> "${cleanupLog}"'
apps: {}
`,
    });
    const root = createRepo(path.join(sandbox, "root"), {
      "monke.yml": `cleanupCommand: 'printf "current-root\\n" >> "${cleanupLog}"'
apps: {}
`,
    });
    saveSessionState(home, {
      repos: [
        {
          assignedPorts: [],
          cleanupCommand: `printf "saved-dep\\n" >> "${cleanupLog}"`,
          sourceRoot: depRoot,
          worktreePath: getExpectedWorktreePath(home, depRoot, "dead"),
        },
        {
          assignedPorts: [],
          cleanupCommand: `printf "saved-root\\n" >> "${cleanupLog}"`,
          sourceRoot: root,
          worktreePath: getExpectedWorktreePath(home, root, "dead"),
        },
      ],
      rootSourceRoot: root,
      session: "dead",
      version: 1,
    });

    runMonke({
      args: ["cleanup"],
      cwd: root,
      monkeHome: home,
    });

    expect(readFileSync(cleanupLog, "utf-8")).toBe("saved-root\nsaved-dep\n");
    expect(existsSync(getSessionStateFilePath(home, root, "dead"))).toBeFalsy();
  });

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
