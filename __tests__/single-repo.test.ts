import { describe, expect, test } from "vite-plus/test";
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";

import { inferSessionName, getExpectedWorktreePath } from "../src/git.ts";
import { spawnSessionFromSourceRootLocked } from "../src/monke.ts";
import { createRuntime } from "../src/runtime.ts";
import { getSessionStateFilePath, saveSessionState } from "../src/registry.ts";
import {
  createRepo,
  git,
  installCodexUrlOpenShim,
  installShShim,
  installWindowsCmdShim,
  makeTempDir,
  read,
  readSingleYamlFile,
  runMonke,
  withPlatform,
  write,
} from "./helpers.ts";

describe("single-repo sessions", () => {
  test("spawn bootstraps a single-repo session and rewrites only mapped env vars", () => {
    const sandbox = makeTempDir("single-repo");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      ".env.shared": "ROOT_ONLY=true\n",
      "apps/api/.env.local": "PORT=3000\nDATABASE_URL=postgres://localhost:5432/app\nOTHER=keep\n",
      "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
      - port: DB_PORT
        env: DATABASE_URL
`,
    });

    const result = runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      extraEnv: { HOME: path.join(sandbox, "os-home") },
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    expect(result.stdout).toBe(`${worktreeRoot}\n`);
    expect(result.stderr).toBe(
      `Spawned or updated session banana\nSwitch to ${worktreeRoot}\nEnable automatic switching with: mt shell install\n`,
    );
    expect(read(worktreeRoot, ".env.shared")).toBe("ROOT_ONLY=true\n");
    expect(read(worktreeRoot, "apps/api/.env.local")).toBe(
      "PORT=10000\nDATABASE_URL=postgres://localhost:10001/app\nOTHER=keep\n",
    );
    expect(read(repoRoot, "apps/api/.env.local")).toBe(
      "PORT=3000\nDATABASE_URL=postgres://localhost:5432/app\nOTHER=keep\n",
    );
    expect(read(worktreeRoot, ".env")).toBe("API_PORT=10000\nDB_PORT=10001\n");

    const sessionState = readSingleYamlFile(path.join(home, "sessions")) as {
      repos: { sourceRoot: string; worktreePath: string }[];
    };
    expect(sessionState.repos).toHaveLength(1);
    expect(sessionState.repos[0]?.sourceRoot).toBe(repoRoot);
    expect(sessionState.repos[0]?.worktreePath).toBe(worktreeRoot);
    expect(existsSync(path.join(sandbox, ".monke-worktrees"))).toBeFalsy();
  });

  test("spawn --codex opens a Codex thread for the root Session worktree", () => {
    const sandbox = makeTempDir("single-repo-codex");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n",
    });
    const openLogPath = installCodexUrlOpenShim(binDirectory);

    const result = runMonke({
      args: ["spawn", "banana", "--codex"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    const codexThreadUrl = `codex://threads/new?path=${encodeURIComponent(worktreeRoot)}`;
    expect(result.stdout).toBe(`${worktreeRoot}\n`);
    expect(result.stderr).toContain(`Spawned or updated session banana`);
    expect(result.stderr).toContain(`Switch to ${worktreeRoot}`);
    expect(result.stderr).toContain(`Opened Codex thread for ${worktreeRoot}`);
    expect(readFileSync(openLogPath, "utf-8")).toBe(`${codexThreadUrl}\n`);
  });

  test("spawn --codex escapes percent-encoded URLs for the Windows launcher", () => {
    const sandbox = makeTempDir("single-repo-codex-windows");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n",
    });
    const cmdLogPath = installWindowsCmdShim(binDirectory);

    const result = withPlatform("win32", () =>
      runMonke({
        args: ["spawn", "banana", "--codex"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home,
      }),
    );

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    const codexThreadUrl = `codex://threads/new?path=${encodeURIComponent(worktreeRoot)}`;
    expect(result.stdout).toBe(`${worktreeRoot}\n`);
    expect(result.stderr).toContain(`Opened Codex thread for ${worktreeRoot}`);
    expect(readFileSync(cmdLogPath, "utf-8")).toBe(
      `/c\nstart\n\n${codexThreadUrl.replaceAll("%", "^%")}\n`,
    );
  });

  test("spawn supports an app whose path is the repo root", () => {
    const sandbox = makeTempDir("single-repo-root-app");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      ".env": "PORT=3000\nOTHER=keep\n",
      "monke.yml": `apps:
  web:
    path: .
    envFile: .env
    mappings:
      - port: WEB_PORT
        env: PORT
`,
    });

    const result = runMonke({
      args: ["spawn", "root-app"],
      binDirectory,
      cwd: repoRoot,
      extraEnv: { HOME: path.join(sandbox, "os-home") },
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "root-app");
    expect(result.stdout).toBe(`${worktreeRoot}\n`);
    expect(read(worktreeRoot, ".env")).toBe("PORT=10000\nOTHER=keep\nWEB_PORT=10000\n");
    expect(read(repoRoot, ".env")).toBe("PORT=3000\nOTHER=keep\n");
  });

  test("spawn without monke.yml creates an unmaterialized worktree and warns", () => {
    const sandbox = makeTempDir("single-repo-no-config");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n",
    });

    const result = runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    expect(read(worktreeRoot, "README.md")).toBe("hello\n");
    expect(git(worktreeRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("banana");
    expect(result.stderr).toContain(
      `Warning: no monke.yml found for ${repoRoot}; spawned session worktree without materializing it.`,
    );
    expect(result.stderr).toContain(`Spawned or updated session banana\nSwitch to ${worktreeRoot}`);
    expect(result.stdout).toBe(`${worktreeRoot}\n`);

    const sessionState = readSingleYamlFile(path.join(home, "sessions")) as {
      graphSource?: string;
      repos: {
        sourceRoot: string;
        worktreePath: string;
        assignedPorts: unknown[];
        materializationComplete?: boolean;
      }[];
    };
    expect(sessionState.graphSource).toBeUndefined();
    expect(sessionState.repos).toStrictEqual([
      {
        assignedPorts: [],
        materializationComplete: false,
        sourceRoot: repoRoot,
        worktreePath: worktreeRoot,
      },
    ]);
  });

  test("spawn without monke.yml carries dirty state by default", () => {
    const sandbox = makeTempDir("single-repo-no-config-dirty");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "clean\n",
    });
    write(repoRoot, "README.md", "dirty\n");
    write(repoRoot, "notes.txt", "untracked\n");

    runMonke({
      args: ["spawn", "dirty-no-config"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "dirty-no-config");
    expect(read(worktreeRoot, "README.md")).toBe("dirty\n");
    expect(read(worktreeRoot, "notes.txt")).toBe("untracked\n");
  });

  test("spawn --no-dirty without monke.yml rejects dirty source when worktree exists", () => {
    const sandbox = makeTempDir("single-repo-no-config-existing-no-dirty");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "clean\n",
    });

    runMonke({
      args: ["spawn", "existing-no-config"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });
    write(repoRoot, "README.md", "dirty\n");

    expect(() =>
      runMonke({
        args: ["spawn", "existing-no-config", "--no-dirty"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home,
      }),
    ).toThrow(`Source checkout is dirty: ${repoRoot}`);
  });

  test("spawn carries tracked modifications by default", () => {
    const sandbox = makeTempDir("single-repo-dirty-modified");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "clean\n",
      "monke.yml": "apps: {}\n",
    });
    write(repoRoot, "README.md", "dirty\n");

    runMonke({
      args: ["spawn", "dirty-copy"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    expect(read(getExpectedWorktreePath(home, repoRoot, "dirty-copy"), "README.md")).toBe(
      "dirty\n",
    );
  });

  test("dirty spawn onto an existing diverged session branch fails before creating the worktree", () => {
    const sandbox = makeTempDir("single-repo-dirty-diverged-branch");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "clean\n",
      "monke.yml": "apps: {}\n",
    });

    git(repoRoot, ["branch", "banana", "HEAD"]);
    git(repoRoot, ["switch", "banana"]);
    write(repoRoot, "README.md", "session branch\n");
    git(repoRoot, ["add", "README.md"]);
    git(repoRoot, ["commit", "-m", "diverge banana"]);
    const branchTip = git(repoRoot, ["rev-parse", "banana"]);
    git(repoRoot, ["switch", "main"]);
    write(repoRoot, "README.md", "dirty source\n");

    expect(() =>
      runMonke({
        args: ["spawn", "banana"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home,
      }),
    ).toThrow(
      /Session branch "banana" already exists.*carrying dirty changes onto a diverged branch is unsafe.*--no-dirty.*align the branch/su,
    );

    expect(existsSync(getExpectedWorktreePath(home, repoRoot, "banana"))).toBeFalsy();
    expect(existsSync(getSessionStateFilePath(home, repoRoot, "banana"))).toBeFalsy();
    expect(git(repoRoot, ["rev-parse", "banana"])).toBe(branchTip);
  });

  test("dirty spawn onto an existing session branch at HEAD carries dirty state", () => {
    const sandbox = makeTempDir("single-repo-dirty-same-tip-branch");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "clean\n",
      "monke.yml": "apps: {}\n",
    });

    git(repoRoot, ["branch", "banana", "HEAD"]);
    write(repoRoot, "README.md", "dirty source\n");

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    expect(read(getExpectedWorktreePath(home, repoRoot, "banana"), "README.md")).toBe(
      "dirty source\n",
    );
  });

  test("spawn carries staged changes by default", () => {
    const sandbox = makeTempDir("single-repo-dirty-staged");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "clean\n",
      "monke.yml": "apps: {}\n",
    });
    write(repoRoot, "README.md", "staged\n");
    git(repoRoot, ["add", "README.md"]);

    runMonke({
      args: ["spawn", "dirty-staged"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    expect(read(getExpectedWorktreePath(home, repoRoot, "dirty-staged"), "README.md")).toBe(
      "staged\n",
    );
  });

  test("spawn carries staged and unstaged edits to the same file", () => {
    const sandbox = makeTempDir("single-repo-dirty-layered");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "a\n",
      "monke.yml": "apps: {}\n",
    });
    write(repoRoot, "README.md", "b\n");
    git(repoRoot, ["add", "README.md"]);
    write(repoRoot, "README.md", "c\n");

    runMonke({
      args: ["spawn", "dirty-layered"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    expect(read(getExpectedWorktreePath(home, repoRoot, "dirty-layered"), "README.md")).toBe("c\n");
  });

  test("spawn carries tracked deletions by default", () => {
    const sandbox = makeTempDir("single-repo-dirty-delete");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "clean\n",
      "monke.yml": "apps: {}\n",
    });
    rmSync(path.join(repoRoot, "README.md"));

    runMonke({
      args: ["spawn", "dirty-delete"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    expect(
      existsSync(path.join(getExpectedWorktreePath(home, repoRoot, "dirty-delete"), "README.md")),
    ).toBeFalsy();
  });

  test("spawn carries untracked non-ignored files by default", () => {
    const sandbox = makeTempDir("single-repo-dirty-untracked");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "clean\n",
      "monke.yml": "apps: {}\n",
    });
    write(repoRoot, "notes/nested.txt", "carry me\n");

    runMonke({
      args: ["spawn", "dirty-untracked"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    expect(
      read(getExpectedWorktreePath(home, repoRoot, "dirty-untracked"), "notes/nested.txt"),
    ).toBe("carry me\n");
  });

  test("spawn preserves untracked symlinks without copying linked contents", () => {
    const sandbox = makeTempDir("single-repo-dirty-untracked-symlink");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "clean\n",
      "monke.yml": "apps: {}\n",
    });
    const outsideFile = path.join(sandbox, "outside-secret.txt");
    write(sandbox, "outside-secret.txt", "do not copy\n");
    symlinkSync(outsideFile, path.join(repoRoot, "secret-link"));

    runMonke({
      args: ["spawn", "dirty-untracked-link"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    const copiedLink = path.join(
      getExpectedWorktreePath(home, repoRoot, "dirty-untracked-link"),
      "secret-link",
    );
    expect(lstatSync(copiedLink).isSymbolicLink()).toBeTruthy();
    expect(readlinkSync(copiedLink)).toBe(outsideFile);
    expect(readFileSync(copiedLink, "utf-8")).toBe("do not copy\n");
  });

  test("spawn does not carry ignored files", () => {
    const sandbox = makeTempDir("single-repo-dirty-ignored");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      ".gitignore": "ignored.txt\n",
      "README.md": "clean\n",
      "monke.yml": "apps: {}\n",
    });
    write(repoRoot, "ignored.txt", "leave behind\n");

    runMonke({
      args: ["spawn", "dirty-ignored"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    expect(
      existsSync(
        path.join(getExpectedWorktreePath(home, repoRoot, "dirty-ignored"), "ignored.txt"),
      ),
    ).toBeFalsy();
  });

  test("spawn --no-dirty rejects dirty source checkouts", () => {
    const sandbox = makeTempDir("single-repo-no-dirty");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "clean\n",
      "monke.yml": "apps: {}\n",
    });
    write(repoRoot, "README.md", "dirty\n");

    expect(() =>
      runMonke({
        args: ["spawn", "reject-dirty", "--no-dirty"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home,
      }),
    ).toThrow(`Source checkout is dirty: ${repoRoot}`);
    expect(existsSync(getExpectedWorktreePath(home, repoRoot, "reject-dirty"))).toBeFalsy();
  });

  test("spawn does not carry source dirt into existing Session worktrees", () => {
    const sandbox = makeTempDir("single-repo-existing-dirty");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "clean\n",
      "monke.yml": "apps: {}\n",
    });

    runMonke({
      args: ["spawn", "existing"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });
    write(repoRoot, "README.md", "dirty\n");
    const result = runMonke({
      args: ["spawn", "existing"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    expect(read(getExpectedWorktreePath(home, repoRoot, "existing"), "README.md")).toBe("clean\n");
    expect(result.stderr).toContain(
      `Warning: Session worktree for existing at ${repoRoot} already exists; dirty Source checkout changes were not carried into it.`,
    );
  });

  test("spawn rejects stale repo-name session collisions from unrelated source roots", () => {
    const sandbox = makeTempDir("single-repo-global-path-collision");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoFiles = {
      "apps/api/.env.local": "PORT=3000\n",
      "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
    };
    const firstRepo = createRepo(path.join(sandbox, "client-a", "api"), repoFiles);
    const secondRepo = createRepo(path.join(sandbox, "client-b", "api"), repoFiles);

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: firstRepo,
      monkeHome: home,
    });
    git(firstRepo, [
      "worktree",
      "remove",
      "--force",
      getExpectedWorktreePath(home, firstRepo, "banana"),
    ]);

    expect(() =>
      runMonke({
        args: ["spawn", "banana"],
        binDirectory,
        cwd: secondRepo,
        monkeHome: home,
      }),
    ).toThrow(/Session worktree path collision.*already recorded/su);
  });

  test("spawn -m keeps default branch file content while avoiding source checkout baseline ports", () => {
    const sandbox = makeTempDir("single-repo-main-mode");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\nDEFAULT_ONLY=1\n",
      "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
    });
    git(repoRoot, ["switch", "-c", "feature"]);
    write(repoRoot, "apps/api/.env.local", "PORT=10000\nBRANCH_DIRTY=1\n");

    runMonke({
      args: ["spawn", "fresh", "-m"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "fresh");
    expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10001\nDEFAULT_ONLY=1\n");
    expect(read(worktreeRoot, ".env")).toBe("API_PORT=10001\n");
    expect(read(repoRoot, "apps/api/.env.local")).toBe("PORT=10000\nBRANCH_DIRTY=1\n");
  });

  test("spawn -m ignores dirty source content", () => {
    const sandbox = makeTempDir("single-repo-main-ignores-dirty");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "main\n",
      "monke.yml": "apps: {}\n",
    });
    git(repoRoot, ["switch", "-c", "feature"]);
    write(repoRoot, "README.md", "dirty feature\n");
    write(repoRoot, "notes.txt", "untracked\n");

    runMonke({
      args: ["spawn", "fresh-main", "-m"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "fresh-main");
    expect(read(worktreeRoot, "README.md")).toBe("main\n");
    expect(existsSync(path.join(worktreeRoot, "notes.txt"))).toBeFalsy();
  });

  test("spawn --no-dirty -m is accepted and behaves like default branch spawn", () => {
    const sandbox = makeTempDir("single-repo-main-no-dirty");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "main\n",
      "monke.yml": "apps: {}\n",
    });
    git(repoRoot, ["switch", "-c", "feature"]);
    write(repoRoot, "README.md", "dirty feature\n");

    runMonke({
      args: ["spawn", "fresh-main-no-dirty", "--no-dirty", "-m"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    expect(read(getExpectedWorktreePath(home, repoRoot, "fresh-main-no-dirty"), "README.md")).toBe(
      "main\n",
    );
  });

  test("spawn -m without monke.yml creates an unmaterialized default-branch worktree", () => {
    const sandbox = makeTempDir("single-repo-main-no-config");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "main\n",
    });
    git(repoRoot, ["switch", "-c", "feature"]);
    write(repoRoot, "README.md", "feature\n");

    const result = runMonke({
      args: ["spawn", "fresh", "-m"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "fresh");
    expect(read(worktreeRoot, "README.md")).toBe("main\n");
    expect(git(worktreeRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("fresh");
    expect(result.stderr).toContain(
      `Warning: no monke.yml found for ${repoRoot}; spawned session worktree without materializing it.`,
    );

    const sessionState = readSingleYamlFile(path.join(home, "sessions")) as {
      graphSource?: string;
      repos: { sourceRoot: string; worktreePath: string; materializationComplete?: boolean }[];
    };
    expect(sessionState.graphSource).toBe("session-branch");
    expect(sessionState.repos[0]).toMatchObject({
      materializationComplete: false,
      sourceRoot: repoRoot,
      worktreePath: worktreeRoot,
    });
  });

  test("spawn -m seeds configured paths from resolved default branch refs", () => {
    const sandbox = makeTempDir("single-repo-main-seed-default");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\n",
      "local-only.txt": "default seed\n",
      "monke.yml": `seedPaths:
  - local-only.txt
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
    });
    git(repoRoot, ["switch", "-c", "feature"]);
    write(repoRoot, "local-only.txt", "dirty source only\n");

    runMonke({
      args: ["spawn", "fresh", "-m"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "fresh");
    expect(read(worktreeRoot, "local-only.txt")).toBe("default seed\n");
  });

  test("spawn -m seeds untracked env files, keeps tracked default branch env content, and avoids source baseline ports", () => {
    const sandbox = makeTempDir("single-repo-main-local-env");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      ".gitignore": ".env.demo\n.envrc\napps/api/.env.demo\n",
      "apps/api/.env.local": "PORT=3000\nDEFAULT_ONLY=1\n",
      "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
    });
    git(repoRoot, ["switch", "-c", "feature"]);
    write(repoRoot, ".env.demo", "DEMO=true\n");
    write(repoRoot, ".envrc", "dotenv\n");
    write(repoRoot, "apps/api/.env.local", "PORT=10000\nLOCAL_ONLY=1\n");
    write(repoRoot, "apps/api/.env.demo", "API_DEMO=true\n");

    runMonke({
      args: ["spawn", "fresh", "-m"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "fresh");
    expect(read(worktreeRoot, ".env.demo")).toBe("DEMO=true\n");
    expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10001\nDEFAULT_ONLY=1\n");
    expect(read(worktreeRoot, "apps/api/.env.demo")).toBe("API_DEMO=true\n");
    expect(existsSync(path.join(worktreeRoot, ".envrc"))).toBeFalsy();
    expect(read(worktreeRoot, ".env")).toBe("API_PORT=10001\n");
  });

  test("spawn -m prefers fetched origin main over stale local main", () => {
    const sandbox = makeTempDir("single-repo-origin-main");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\nLOCAL_MAIN=1\n",
      "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
    });
    const origin = path.join(sandbox, "origin.git");
    git(repoRoot, ["init", "--bare", origin]);
    git(repoRoot, ["remote", "add", "origin", origin]);
    git(repoRoot, ["push", "-u", "origin", "main"]);
    const localMain = git(repoRoot, ["rev-parse", "HEAD"]);
    write(repoRoot, "apps/api/.env.local", "PORT=4000\nORIGIN_MAIN=1\n");
    git(repoRoot, ["add", "apps/api/.env.local"]);
    git(repoRoot, ["commit", "-m", "origin main update"]);
    git(repoRoot, ["push", "origin", "main"]);
    git(repoRoot, ["reset", "--hard", localMain]);
    git(repoRoot, ["switch", "-c", "feature"]);

    runMonke({
      args: ["spawn", "remote-default", "-m"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "remote-default");
    expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10000\nORIGIN_MAIN=1\n");
  });

  test("spawn -m prunes deleted origin main before choosing origin master", () => {
    const sandbox = makeTempDir("single-repo-pruned-origin-main");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\nLOCAL_MAIN=1\n",
      "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
    });
    const origin = path.join(sandbox, "origin.git");
    git(repoRoot, ["init", "--bare", origin]);
    git(repoRoot, ["remote", "add", "origin", origin]);
    git(repoRoot, ["push", "-u", "origin", "main"]);
    const staleOriginMain = git(repoRoot, ["rev-parse", "refs/remotes/origin/main"]);

    git(repoRoot, ["switch", "-c", "master"]);
    write(repoRoot, "apps/api/.env.local", "PORT=4000\nORIGIN_MASTER=1\n");
    git(repoRoot, ["add", "apps/api/.env.local"]);
    git(repoRoot, ["commit", "-m", "origin master default"]);
    git(repoRoot, ["push", "origin", "master"]);
    git(origin, ["symbolic-ref", "HEAD", "refs/heads/master"]);
    git(repoRoot, ["push", "origin", "--delete", "main"]);
    git(repoRoot, ["update-ref", "refs/remotes/origin/main", staleOriginMain]);
    git(repoRoot, ["switch", "main"]);
    git(repoRoot, ["switch", "-c", "feature"]);

    runMonke({
      args: ["spawn", "remote-master", "-m"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "remote-master");
    expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10000\nORIGIN_MASTER=1\n");
  });

  test("spawn -m falls back to local main when origin fetch fails", () => {
    const sandbox = makeTempDir("single-repo-fetch-fallback");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\nLOCAL_MAIN=1\n",
      "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
    });
    const origin = path.join(sandbox, "origin.git");
    git(repoRoot, ["init", "--bare", origin]);
    git(repoRoot, ["remote", "add", "origin", origin]);
    git(repoRoot, ["push", "-u", "origin", "main"]);
    const localMain = git(repoRoot, ["rev-parse", "HEAD"]);
    write(repoRoot, "apps/api/.env.local", "PORT=4000\nSTALE_ORIGIN_MAIN=1\n");
    git(repoRoot, ["add", "apps/api/.env.local"]);
    git(repoRoot, ["commit", "-m", "stale origin main update"]);
    git(repoRoot, ["push", "origin", "main"]);
    git(repoRoot, ["reset", "--hard", localMain]);
    git(repoRoot, ["remote", "set-url", "origin", path.join(sandbox, "missing-origin.git")]);
    git(repoRoot, ["switch", "-c", "feature"]);

    runMonke({
      args: ["spawn", "local-default", "-m"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "local-default");
    expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10000\nLOCAL_MAIN=1\n");
  });

  test("spawn -m rolls back failed fresh attempts so they can be retried", () => {
    const sandbox = makeTempDir("single-repo-main-rollback");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "apps/api/package.json": "{}\n",
      "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
    });

    expect(() =>
      runMonke({
        args: ["spawn", "retryable", "-m"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home,
      }),
    ).toThrow(/Expected managed env file to exist/u);

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "retryable");
    expect(existsSync(worktreeRoot)).toBeFalsy();
    expect(existsSync(getSessionStateFilePath(home, repoRoot, "retryable"))).toBeFalsy();
    expect(() =>
      git(repoRoot, ["show-ref", "--verify", "--quiet", "refs/heads/retryable"]),
    ).toThrow(/show-ref/u);

    write(repoRoot, "apps/api/.env.local", "PORT=3000\n");
    git(repoRoot, ["add", "apps/api/.env.local"]);
    git(repoRoot, ["commit", "-m", "add api env"]);

    runMonke({
      args: ["spawn", "retryable", "-m"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10000\n");
  });

  test("spawn -m fails when session state already exists", () => {
    const sandbox = makeTempDir("single-repo-main-existing-state");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\n",
      "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
    });
    saveSessionState(home, {
      repos: [],
      rootSourceRoot: repoRoot,
      session: "fresh",
      version: 1,
    });

    expect(() =>
      runMonke({
        args: ["spawn", "fresh", "-m"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home,
      }),
    ).toThrow(/Session state already exists for "fresh"/u);
  });

  test("spawn -m fails when the session branch already exists", () => {
    const sandbox = makeTempDir("single-repo-main-existing-branch");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\n",
      "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
    });
    git(repoRoot, ["branch", "fresh"]);

    expect(() =>
      runMonke({
        args: ["spawn", "fresh", "-m"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home,
      }),
    ).toThrow(/Session branch "fresh" already exists/u);
  });

  test("spawn --main and --master are aliases for default branch mode", () => {
    const sandbox = makeTempDir("single-repo-main-aliases");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\n",
      "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
    });

    for (const [session, flag, env] of [
      ["main-alias", "--main", "API_PORT=10000\n"],
      ["master-alias", "--master", "API_PORT=10001\n"],
    ] as const) {
      runMonke({
        args: ["spawn", session, flag],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home,
      });

      expect(read(getExpectedWorktreePath(home, repoRoot, session), ".env")).toBe(env);
    }
  });

  test("spawn rewrites one local port key into multiple same-repo app env files", () => {
    const sandbox = makeTempDir("single-repo-shared-port");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\n",
      "apps/web/.env.local": "API_URL=http://localhost:3000\n",
      "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
  web:
    path: apps/web
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: API_URL
`,
    });

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10000\n");
    expect(read(worktreeRoot, "apps/web/.env.local")).toBe("API_URL=http://localhost:10000\n");
    expect(read(worktreeRoot, ".env")).toBe("API_PORT=10000\n");
  });

  test("spawn and materialize resolve, reuse, write, and prune resource values", () => {
    const sandbox = makeTempDir("single-repo-resources");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\nOTHER=keep\n",
      "monke.yml": `resources:
  values:
    DISCORD_CHANNEL: mt-\${user}-\${session}
    STATIC_HANDLE: fixed-\${session}
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
    });

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      extraEnv: { USER: "ada" },
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10000\nOTHER=keep\n");
    expect(read(worktreeRoot, ".env")).toBe(
      "API_PORT=10000\nDISCORD_CHANNEL=mt-ada-banana\nSTATIC_HANDLE=fixed-banana\n",
    );

    const initialState = readSingleYamlFile(path.join(home, "sessions")) as {
      repos: { resourceValues?: { env: string; value: string }[] }[];
    };
    expect(initialState.repos[0]?.resourceValues).toStrictEqual([
      { env: "DISCORD_CHANNEL", value: "mt-ada-banana" },
      { env: "STATIC_HANDLE", value: "fixed-banana" },
    ]);

    write(
      repoRoot,
      "monke.yml",
      `resources:
  values:
    DISCORD_CHANNEL: changed-\${session}
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
    );

    runMonke({
      args: ["materialize"],
      binDirectory,
      cwd: worktreeRoot,
      extraEnv: { USER: "ada" },
      monkeHome: home,
    });

    expect(read(worktreeRoot, ".env")).toBe("API_PORT=10000\nDISCORD_CHANNEL=mt-ada-banana\n");

    const nextState = readSingleYamlFile(path.join(home, "sessions")) as {
      repos: { resourceValues?: { env: string; value: string }[] }[];
    };
    expect(nextState.repos[0]?.resourceValues).toStrictEqual([
      { env: "DISCORD_CHANNEL", value: "mt-ada-banana" },
    ]);
  });

  test("spawn rejects resource value collisions with retained sessions", () => {
    const sandbox = makeTempDir("single-repo-resource-collision");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\n",
      "monke.yml": `resources:
  values:
    DISCORD_CHANNEL: shared
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
    });

    runMonke({
      args: ["spawn", "first"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    const message = captureThrowMessage(() =>
      runMonke({
        args: ["spawn", "second"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home,
      }),
    );
    expect(message).toContain("Resource value collision for DISCORD_CHANNEL=<redacted length=6>");
    expect(message).toContain(`in ${repoRoot}; retained session first already owns that value`);
    expect(message).not.toContain("DISCORD_CHANNEL=shared");
    expect(message).not.toContain("shared");
  });

  test("materialize rejects source checkout context and reuses sticky ports inside a valid session worktree", () => {
    const sandbox = makeTempDir("single-materialize");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\nDATABASE_URL=postgres://localhost:5432/app\n",
      "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
      - port: DB_PORT
        env: DATABASE_URL
`,
    });

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    expect(() => {
      runMonke({
        args: ["materialize"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home,
      });
    }).toThrow(/must run inside a session worktree/u);

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    expect(inferSessionName(home, repoRoot, worktreeRoot, "banana")).toBe("banana");
    expect(() => inferSessionName(home, repoRoot, worktreeRoot, "wrong")).toThrow(
      /match current branch/u,
    );

    const before = read(worktreeRoot, ".env");
    expect(before).toBe("API_PORT=10000\nDB_PORT=10001\n");

    runMonke({
      args: ["materialize"],
      binDirectory,
      cwd: worktreeRoot,
      monkeHome: home,
    });

    expect(read(worktreeRoot, ".env")).toBe(before);
  });

  test("spawn and materialize run bootstrapCommand after env sync from the repo worktree root", () => {
    const sandbox = makeTempDir("single-bootstrap");
    const binDirectory = path.join(sandbox, "bin");
    const shLogPath = installShShim(binDirectory);
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\nDATABASE_URL=postgres://localhost:5432/app\n",
      "monke.yml": `bootstrapCommand: grep -q 'PORT=10000' apps/api/.env.local && grep -q 'DB_PORT=10001' .env && pwd >> bootstrap-runs
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
      - port: DB_PORT
        env: DATABASE_URL
`,
    });

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    expect(read(worktreeRoot, "bootstrap-runs")).toBe(`${worktreeRoot}\n`);

    runMonke({
      args: ["materialize"],
      binDirectory,
      cwd: worktreeRoot,
      monkeHome: home,
    });

    expect(read(worktreeRoot, "bootstrap-runs")).toBe(`${worktreeRoot}\n${worktreeRoot}\n`);
    const shellArgs = readFileSync(shLogPath, "utf-8").trim().split("\n");
    expect(shellArgs.filter((arg) => arg === "-c")).toHaveLength(2);
    expect(shellArgs).not.toContain("-lc");
  });

  test("spawn seeds configured directories and files into a new session worktree", () => {
    const sandbox = makeTempDir("single-seedpaths");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\n",
      "apps/frostbite-crawler/data/sessions/hoangbn/Cookies": "cookie-jar\n",
      "apps/frostbite-crawler/data/sessions/hoangbn/Preferences": '{ "theme": "dark" }\n',
      "monke.yml": `seedPaths:
  - apps/frostbite-crawler/data/sessions
  - scripts/bootstrap.sh
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
      "scripts/bootstrap.sh": "#!/bin/sh\necho seeded\n",
    });

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    expect(read(worktreeRoot, "apps/frostbite-crawler/data/sessions/hoangbn/Preferences")).toBe(
      '{ "theme": "dark" }\n',
    );
    expect(read(worktreeRoot, "apps/frostbite-crawler/data/sessions/hoangbn/Cookies")).toBe(
      "cookie-jar\n",
    );
    expect(read(worktreeRoot, "scripts/bootstrap.sh")).toBe("#!/bin/sh\necho seeded\n");
  });

  test("spawn merges seeded directories into tracked worktree directories without clobbering existing files", () => {
    const sandbox = makeTempDir("single-seedpaths-merge");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      ".gitignore": "apps/frostbite-crawler/data/sessions/hoangbn/Cookies\n",
      "apps/api/.env.local": "PORT=3000\n",
      "apps/frostbite-crawler/data/sessions/.gitkeep": "",
      "apps/frostbite-crawler/data/sessions/hoangbn/Preferences": '{ "theme": "dark" }\n',
      "monke.yml": `seedPaths:
  - apps/frostbite-crawler/data/sessions
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
    });
    write(repoRoot, "apps/frostbite-crawler/data/sessions/hoangbn/Cookies", "cookie-jar\n");

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    expect(read(worktreeRoot, "apps/frostbite-crawler/data/sessions/.gitkeep")).toBe("");
    expect(read(worktreeRoot, "apps/frostbite-crawler/data/sessions/hoangbn/Preferences")).toBe(
      '{ "theme": "dark" }\n',
    );
    expect(read(worktreeRoot, "apps/frostbite-crawler/data/sessions/hoangbn/Cookies")).toBe(
      "cookie-jar\n",
    );
  });

  test("repeated spawn and materialize do not clobber seeded paths already changed in the worktree", () => {
    const sandbox = makeTempDir("single-seedpaths-no-clobber");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\n",
      "apps/frostbite-crawler/data/sessions/hoangbn/Preferences": '{ "theme": "dark" }\n',
      "monke.yml": `seedPaths:
  - apps/frostbite-crawler/data/sessions
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
    });

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    write(
      worktreeRoot,
      "apps/frostbite-crawler/data/sessions/hoangbn/Preferences",
      '{ "theme": "light" }\n',
    );

    runMonke({
      args: ["materialize"],
      binDirectory,
      cwd: worktreeRoot,
      monkeHome: home,
    });

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    expect(read(worktreeRoot, "apps/frostbite-crawler/data/sessions/hoangbn/Preferences")).toBe(
      '{ "theme": "light" }\n',
    );
  });

  test("missing configured seedPaths warn and do not fail session creation", () => {
    const sandbox = makeTempDir("single-seedpaths-missing");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\n",
      "monke.yml": `seedPaths:
  - apps/frostbite-crawler/data/sessions
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
    });

    const result = runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    expect(result.stderr).toContain(
      "Warning: seedPath apps/frostbite-crawler/data/sessions is missing",
    );
    expect(result.stderr).toContain("Spawned or updated session banana");
  });

  test("setup creates the root .env with direct external path env defaults", () => {
    const sandbox = makeTempDir("setup-root-env");
    const home = path.join(sandbox, "home");
    createRepo(path.join(sandbox, "dep"), {
      "monke.yml": `apps:
  db:
    path: services/db
    envFile: .env.local
    mappings:
      - port: DEP_POSTGRES_PORT
        env: PORT
`,
      "services/db/.env.local": "PORT=5432\n",
    });
    const root = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "DATABASE_URL=postgres://localhost:5432/app\n",
      "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings: []
external:
  dep:
    path: ../dep
    pathEnv: DEP_DIR
    mappings:
      - port: DEP_POSTGRES_PORT
        app: api
        env: DATABASE_URL
`,
    });

    runMonke({
      args: ["setup"],
      cwd: root,
      monkeHome: home,
    });

    expect(read(root, ".env")).toBe("DEP_DIR=../dep\n");
  });

  test("setup overwrites stale external path env values and preserves unrelated root env entries", () => {
    const sandbox = makeTempDir("setup-root-env-refresh");
    const home = path.join(sandbox, "home");
    createRepo(path.join(sandbox, "dep"), {
      "monke.yml": `apps:
  db:
    path: services/db
    envFile: .env.local
    mappings:
      - port: DEP_POSTGRES_PORT
        env: PORT
`,
      "services/db/.env.local": "PORT=5432\n",
    });
    const root = createRepo(path.join(sandbox, "root"), {
      ".env": "KEEP_ME=1\nDEP_DIR=../old-location\n",
      "apps/api/.env.local": "DATABASE_URL=postgres://localhost:5432/app\n",
      "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings: []
external:
  dep:
    path: ../dep
    pathEnv: DEP_DIR
    mappings:
      - port: DEP_POSTGRES_PORT
        app: api
        env: DATABASE_URL
`,
    });

    runMonke({
      args: ["setup"],
      cwd: root,
      monkeHome: home,
    });

    expect(read(root, ".env")).toBe("KEEP_ME=1\nDEP_DIR=../dep\n");
  });

  test("setup must run from the source checkout", () => {
    const sandbox = makeTempDir("setup-source-checkout-only");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    createRepo(path.join(sandbox, "dep"), {
      "monke.yml": `apps:
  db:
    path: services/db
    envFile: .env.local
    mappings:
      - port: DEP_POSTGRES_PORT
        env: PORT
`,
      "services/db/.env.local": "PORT=5432\n",
    });
    const root = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "DATABASE_URL=postgres://localhost:5432/app\n",
      "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings: []
external:
  dep:
    path: ../dep
    pathEnv: DEP_DIR
    mappings:
      - port: DEP_POSTGRES_PORT
        app: api
        env: DATABASE_URL
`,
    });

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: root,
      monkeHome: home,
    });

    expect(() =>
      runMonke({
        args: ["setup"],
        binDirectory,
        cwd: getExpectedWorktreePath(home, root, "banana"),
        monkeHome: home,
      }),
    ).toThrow(/must run from the source checkout/u);
  });

  test("spawn -m seeds untracked env files and seedPaths from the source checkout", () => {
    const sandbox = makeTempDir("single-repo-main-untracked-seeds");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      ".gitignore": ".env\n.env.local\nseed-data/\n",
      "apps/api/.env.local": "PORT=3000\n",
      "apps/api/index.js": "// api\n",
      "monke.yml": `seedPaths:
  - seed-data
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
      "seed-data/fixture.txt": "fixture\n",
      "tracked.txt": "committed\n",
    });
    write(repoRoot, "tracked.txt", "dirty\n");

    runMonke({
      args: ["spawn", "fresh-seeds", "-m"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "fresh-seeds");
    expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10000\n");
    expect(read(worktreeRoot, ".env")).toBe("API_PORT=10000\n");
    expect(read(worktreeRoot, "seed-data/fixture.txt")).toBe("fixture\n");
    expect(read(worktreeRoot, "tracked.txt")).toBe("committed\n");
    expect(read(repoRoot, "apps/api/.env.local")).toBe("PORT=3000\n");
  });

  test("session-branch respawn seeds untracked env files from the source checkout", () => {
    const sandbox = makeTempDir("single-repo-session-branch-seeds");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      ".gitignore": ".env\n.env.local\nseed-data/\n",
      "apps/api/.env.local": "PORT=3000\n",
      "apps/api/index.js": "// api\n",
      "monke.yml": `seedPaths:
  - seed-data
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
      "seed-data/fixture.txt": "fixture\n",
    });

    runMonke({
      args: ["spawn", "respawned", "-m"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "respawned");
    git(repoRoot, ["worktree", "remove", "--force", worktreeRoot]);

    const runtime = createRuntime({
      cwd: repoRoot,
      env: { MONKE_HOME: home, PATH: process.env.PATH ?? "" },
      onStderr() {},
      onStdout() {},
    });
    spawnSessionFromSourceRootLocked(runtime, home, repoRoot, "respawned", {
      mode: "session-branch",
    });

    expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10000\n");
    expect(read(worktreeRoot, ".env")).toBe("API_PORT=10000\n");
    expect(read(worktreeRoot, "seed-data/fixture.txt")).toBe("fixture\n");
  });
});

function captureThrowMessage(action: () => void): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("Expected action to throw");
}
