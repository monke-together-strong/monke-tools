import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync
} from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { inferSessionName, getExpectedWorktreePath } from "../src/git.ts";
import { spawnSessionFromSourceRootLocked } from "../src/monke.ts";
import { createRuntime } from "../src/runtime.ts";
import {
  getSessionStateFilePath,
  loadSessionState,
  saveSessionState
} from "../src/session-state-store.ts";
import { SessionStateSchema } from "../src/state-schema.ts";
import {
  completeSessionState,
  createRepo,
  git,
  installCodexUrlOpenShim,
  installGitShim,
  installShShim,
  installWindowsCmdShim,
  makeTempDir,
  materializedRepoState,
  read,
  readSingleYamlFile,
  runMonke,
  runMonkeCapturingFailure,
  withPlatform,
  write
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
`
    });

    const result = runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      extraEnv: { HOME: path.join(sandbox, "os-home") },
      monkeHome: home
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    expect(result.stdout).toBe(`${worktreeRoot}\n`);
    expect(result.stderr).toBe(
      `Spawned or updated session banana\nSwitch to ${worktreeRoot}\nEnable automatic switching with: mt shell install\n`
    );
    expect(read(worktreeRoot, ".env.shared")).toBe("ROOT_ONLY=true\n");
    expect(read(worktreeRoot, "apps/api/.env.local")).toBe(
      "PORT=10000\nDATABASE_URL=postgres://localhost:10001/app\nOTHER=keep\n"
    );
    expect(read(repoRoot, "apps/api/.env.local")).toBe(
      "PORT=3000\nDATABASE_URL=postgres://localhost:5432/app\nOTHER=keep\n"
    );
    expect(read(worktreeRoot, ".env")).toBe("API_PORT=10000\nDB_PORT=10001\n");

    const sessionState = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    expect(sessionState.repos).toHaveLength(1);
    expect(sessionState.repos[0]?.sourceRoot).toBe(repoRoot);
    expect(sessionState.repos[0]?.worktreePath).toBe(worktreeRoot);
    expect(existsSync(path.join(sandbox, ".monke-worktrees"))).toBeFalsy();
  });

  test("spawn --codex opens the Root repo's Session worktree as a Codex workspace", () => {
    const sandbox = makeTempDir("single-repo-codex");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "apps: {}\n",
      "README.md": "hello\n"
    });
    const openLogPath = installCodexUrlOpenShim(binDirectory);

    const result = runMonke({
      args: ["spawn", "banana", "--codex"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    const codexWorkspaceUrl = `codex://threads/new?path=${encodeURIComponent(worktreeRoot)}`;
    expect(result.stdout).toBe(`${worktreeRoot}\n`);
    expect(result.stderr).toContain(`Spawned or updated session banana`);
    expect(result.stderr).toContain(`Switch to ${worktreeRoot}`);
    expect(result.stderr).toContain(`Opened Codex workspace: ${worktreeRoot}`);
    expect(readFileSync(openLogPath, "utf-8")).toBe(`${codexWorkspaceUrl}\n`);
  });

  test("spawn --codex escapes percent-encoded URLs for the Windows launcher", () => {
    const sandbox = makeTempDir("single-repo-codex-windows");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "apps: {}\n",
      "README.md": "hello\n"
    });
    const cmdLogPath = installWindowsCmdShim(binDirectory);

    const result = withPlatform("win32", () =>
      runMonke({
        args: ["spawn", "banana", "--codex"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home
      })
    );

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    const codexWorkspaceUrl = `codex://threads/new?path=${encodeURIComponent(worktreeRoot)}`;
    expect(result.stdout).toBe(`${worktreeRoot}\n`);
    expect(result.stderr).toContain(`Opened Codex workspace: ${worktreeRoot}`);
    expect(readFileSync(cmdLogPath, "utf-8")).toBe(
      `/c\nstart\n\n${codexWorkspaceUrl.replaceAll("%", "^%")}\n`
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
`
    });

    const result = runMonke({
      args: ["spawn", "root-app"],
      binDirectory,
      cwd: repoRoot,
      extraEnv: { HOME: path.join(sandbox, "os-home") },
      monkeHome: home
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
      "README.md": "hello\n"
    });

    const result = runMonkeCapturingFailure({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    expect(read(worktreeRoot, "README.md")).toBe("hello\n");
    expect(git(worktreeRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("banana");
    expect(result.stderr).toContain(
      `Warning: no monke.yml found for ${repoRoot}; prepared session worktree without materializing it.`
    );
    expect(result.error?.message).toContain(
      "Session materialization failed after all runnable work settled."
    );
    expect(result.error?.message).toContain(`Prepared Root worktree: ${worktreeRoot}`);
    expect(result.error?.message).toContain("Retry: mt spawn banana");
    expect(result.stderr).not.toContain("Spawned or updated session banana");
    expect(result.stderr).not.toContain(`Switch to ${worktreeRoot}`);
    expect(result.stdout).toBe("");

    const sessionState = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    expect(sessionState.graphSource).toBeUndefined();
    expect(sessionState.repos).toStrictEqual([
      {
        assignedPorts: [],
        cleanupEligible: false,
        diffBaseRef: "refs/heads/main",
        materializationStatus: "pending",
        preparationStatus: "prepared",
        sourceRoot: repoRoot,
        worktreePath: worktreeRoot
      }
    ]);
  });

  test("spawn --codex without monke.yml does not navigate or launch Codex", () => {
    const sandbox = makeTempDir("single-repo-no-config-codex");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });
    const openLogPath = installCodexUrlOpenShim(binDirectory);

    const result = runMonkeCapturingFailure({
      args: ["spawn", "banana", "--codex"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(`Switch to ${worktreeRoot}`);
    expect(result.stderr).not.toContain(`Opened Codex workspace: ${worktreeRoot}`);
    expect(existsSync(openLogPath)).toBeFalsy();
    expect(loadSessionState(home, repoRoot, "banana").repos[0]).toMatchObject({
      materializationStatus: "pending",
      preparationStatus: "prepared"
    });
  });

  test("spawn without monke.yml carries dirty state by default", () => {
    const sandbox = makeTempDir("single-repo-no-config-dirty");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "clean\n"
    });
    write(repoRoot, "README.md", "dirty\n");
    write(repoRoot, "notes.txt", "untracked\n");

    runMonkeCapturingFailure({
      args: ["spawn", "dirty-no-config"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "dirty-no-config");
    expect(read(worktreeRoot, "README.md")).toBe("dirty\n");
    expect(read(worktreeRoot, "notes.txt")).toBe("untracked\n");
  });

  test("configured Spawn retries dirty carry after interruption immediately after worktree creation", () => {
    const sandbox = makeTempDir("single-repo-dirty-carry-interruption");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "apps: {}\n",
      "README.md": "clean\n"
    });
    write(repoRoot, "README.md", "dirty\n");
    write(repoRoot, "notes.txt", "untracked\n");
    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "interrupted-carry");
    installGitShim(binDirectory, {
      afterCommand: {
        args: `worktree add ${worktreeRoot} interrupted-carry`,
        cwd: repoRoot,
        script: 'kill -KILL "$PPID"'
      }
    });

    const interrupted = runMonkeCapturingFailure({
      args: ["spawn", "interrupted-carry"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    expect(interrupted.error).not.toBeNull();
    expect(loadSessionState(home, repoRoot, "interrupted-carry").repos[0]).toMatchObject({
      dirtyCarryStatus: "pending",
      preparationStatus: "pending"
    });

    runMonke({ args: ["spawn", "interrupted-carry"], cwd: repoRoot, monkeHome: home });

    expect(read(worktreeRoot, "README.md")).toBe("dirty\n");
    expect(read(worktreeRoot, "notes.txt")).toBe("untracked\n");
    expect(loadSessionState(home, repoRoot, "interrupted-carry").repos[0]).toMatchObject({
      dirtyCarryStatus: "complete",
      preparationStatus: "prepared"
    });
  });

  test("configured Spawn preserves Session-local edits after interrupted dirty carry", () => {
    const { home, repoRoot, worktreeRoot } = interruptDirtyCarryAfterWorktreeCreation({
      configured: true,
      name: "single-repo-dirty-carry-local-edit"
    });
    write(worktreeRoot, "session-tracked.txt", "Session-local tracked\n");
    write(worktreeRoot, "session-only.txt", "keep me\n");
    write(worktreeRoot, "ignored.local", "ignored but important\n");

    runMonke({ args: ["spawn", "interrupted-carry"], cwd: repoRoot, monkeHome: home });

    expect(read(worktreeRoot, "README.md")).toBe("dirty\n");
    expect(read(worktreeRoot, "notes.txt")).toBe("untracked\n");
    expect(read(worktreeRoot, "session-tracked.txt")).toBe("Session-local tracked\n");
    expect(read(worktreeRoot, "session-only.txt")).toBe("keep me\n");
    expect(read(worktreeRoot, "ignored.local")).toBe("ignored but important\n");
    expect(loadSessionState(home, repoRoot, "interrupted-carry").repos[0]).toMatchObject({
      dirtyCarryStatus: "complete",
      preparationStatus: "prepared"
    });
  });

  test("configured Spawn preserves ignored Session-local files while resuming dirty carry", () => {
    const { home, repoRoot, worktreeRoot } = interruptDirtyCarryAfterWorktreeCreation({
      configured: true,
      name: "single-repo-dirty-carry-ignored-local"
    });
    write(worktreeRoot, "ignored.local", "ignored but important\n");

    runMonke({ args: ["spawn", "interrupted-carry"], cwd: repoRoot, monkeHome: home });

    expect(read(worktreeRoot, "ignored.local")).toBe("ignored but important\n");
    expect(read(worktreeRoot, "README.md")).toBe("dirty\n");
    expect(read(worktreeRoot, "notes.txt")).toBe("untracked\n");
  });

  test("configured Spawn refuses to overwrite a conflicting Session-local tracked edit", () => {
    const { home, repoRoot, worktreeRoot } = interruptDirtyCarryAfterWorktreeCreation({
      configured: true,
      name: "single-repo-dirty-carry-tracked-conflict"
    });
    write(worktreeRoot, "README.md", "Session-local README\n");

    expect(() =>
      runMonke({ args: ["spawn", "interrupted-carry"], cwd: repoRoot, monkeHome: home })
    ).toThrow(/without overwriting Session-local tracked changes/u);
    expect(read(worktreeRoot, "README.md")).toBe("Session-local README\n");
  });

  test("configured Spawn preserves a branch-switched worktree after interrupted dirty carry", () => {
    const { home, repoRoot, worktreeRoot } = interruptDirtyCarryAfterWorktreeCreation({
      configured: true,
      name: "single-repo-dirty-carry-branch-switch"
    });
    git(worktreeRoot, ["switch", "-c", "session-local"]);

    expect(() =>
      runMonke({ args: ["spawn", "interrupted-carry"], cwd: repoRoot, monkeHome: home })
    ).toThrow(/to be on branch interrupted-carry, found session-local/u);
    expect(git(worktreeRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("session-local");

    git(worktreeRoot, ["switch", "interrupted-carry"]);
    runMonke({ args: ["spawn", "interrupted-carry"], cwd: repoRoot, monkeHome: home });

    expect(read(worktreeRoot, "README.md")).toBe("dirty\n");
    expect(read(worktreeRoot, "notes.txt")).toBe("untracked\n");
    expect(git(repoRoot, ["branch", "--list", "session-local"])).not.toBe("");
  });

  test("configured Spawn resumes after interruption between tracked and untracked dirty carry", () => {
    const { home, repoRoot, worktreeRoot } = interruptDirtyCarryAfterTrackedPatch({
      configured: true,
      name: "single-repo-dirty-carry-partial"
    });

    runMonke({ args: ["spawn", "interrupted-carry"], cwd: repoRoot, monkeHome: home });

    expect(read(worktreeRoot, "README.md")).toBe("dirty\n");
    expect(read(worktreeRoot, "notes.txt")).toBe("untracked\n");
  });

  test("configured Spawn resumes a partially copied untracked dirty carry", () => {
    const { home, repoRoot, worktreeRoot } = interruptDirtyCarryAfterPartialUntrackedCopy({
      configured: true,
      name: "single-repo-dirty-carry-partial-untracked"
    });

    runMonke({ args: ["spawn", "interrupted-carry"], cwd: repoRoot, monkeHome: home });

    expect(read(worktreeRoot, "a-first.txt")).toBe("first\n");
    expect(read(worktreeRoot, "z-last.txt")).toBe("last\n");
  });

  test("config-less Spawn retries dirty carry after interruption immediately after worktree creation", () => {
    const sandbox = makeTempDir("single-repo-configless-dirty-carry-interruption");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "clean\n"
    });
    write(repoRoot, "README.md", "dirty\n");
    write(repoRoot, "notes.txt", "untracked\n");
    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "interrupted-carry");
    installGitShim(binDirectory, {
      afterCommand: {
        args: `worktree add ${worktreeRoot} interrupted-carry`,
        cwd: repoRoot,
        script: 'kill -KILL "$PPID"'
      }
    });

    const interrupted = runMonkeCapturingFailure({
      args: ["spawn", "interrupted-carry"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    expect(interrupted.error).not.toBeNull();
    expect(loadSessionState(home, repoRoot, "interrupted-carry").repos[0]).toMatchObject({
      dirtyCarryStatus: "pending",
      preparationStatus: "pending"
    });

    const retried = runMonkeCapturingFailure({
      args: ["spawn", "interrupted-carry"],
      cwd: repoRoot,
      monkeHome: home
    });

    expect(retried.error?.message).toContain(`Prepared Root worktree: ${worktreeRoot}`);
    expect(read(worktreeRoot, "README.md")).toBe("dirty\n");
    expect(read(worktreeRoot, "notes.txt")).toBe("untracked\n");
    expect(loadSessionState(home, repoRoot, "interrupted-carry").repos[0]).toMatchObject({
      dirtyCarryStatus: "complete",
      preparationStatus: "prepared"
    });
  });

  test("config-less Spawn preserves Session-local edits after interrupted dirty carry", () => {
    const { home, repoRoot, worktreeRoot } = interruptDirtyCarryAfterWorktreeCreation({
      configured: false,
      name: "single-repo-configless-dirty-carry-local-edit"
    });
    write(worktreeRoot, "session-tracked.txt", "Session-local tracked\n");
    write(worktreeRoot, "session-only.txt", "keep me\n");
    write(worktreeRoot, "ignored.local", "ignored but important\n");

    const retried = runMonkeCapturingFailure({
      args: ["spawn", "interrupted-carry"],
      cwd: repoRoot,
      monkeHome: home
    });

    expect(retried.error?.message).toContain(
      "Session materialization failed after all runnable work settled"
    );
    expect(read(worktreeRoot, "README.md")).toBe("dirty\n");
    expect(read(worktreeRoot, "notes.txt")).toBe("untracked\n");
    expect(read(worktreeRoot, "session-tracked.txt")).toBe("Session-local tracked\n");
    expect(read(worktreeRoot, "session-only.txt")).toBe("keep me\n");
    expect(read(worktreeRoot, "ignored.local")).toBe("ignored but important\n");
    expect(loadSessionState(home, repoRoot, "interrupted-carry").repos[0]).toMatchObject({
      dirtyCarryStatus: "complete",
      preparationStatus: "prepared"
    });
  });

  test("config-less Spawn preserves ignored Session-local files while resuming dirty carry", () => {
    const { home, repoRoot, worktreeRoot } = interruptDirtyCarryAfterWorktreeCreation({
      configured: false,
      name: "single-repo-configless-dirty-carry-ignored-local"
    });
    write(worktreeRoot, "ignored.local", "ignored but important\n");

    runMonkeCapturingFailure({
      args: ["spawn", "interrupted-carry"],
      cwd: repoRoot,
      monkeHome: home
    });

    expect(read(worktreeRoot, "ignored.local")).toBe("ignored but important\n");
    expect(read(worktreeRoot, "README.md")).toBe("dirty\n");
    expect(read(worktreeRoot, "notes.txt")).toBe("untracked\n");
  });

  test("config-less Spawn refuses to overwrite a conflicting Session-local untracked file", () => {
    const { home, repoRoot, worktreeRoot } = interruptDirtyCarryAfterWorktreeCreation({
      configured: false,
      name: "single-repo-configless-dirty-carry-untracked-conflict"
    });
    write(worktreeRoot, "notes.txt", "Session-local notes\n");

    expect(() =>
      runMonke({ args: ["spawn", "interrupted-carry"], cwd: repoRoot, monkeHome: home })
    ).toThrow(/Refusing to overwrite Session-local path during dirty carry/u);
    expect(read(worktreeRoot, "notes.txt")).toBe("Session-local notes\n");
  });

  test("config-less Spawn preserves a branch-switched worktree after interrupted dirty carry", () => {
    const { home, repoRoot, worktreeRoot } = interruptDirtyCarryAfterWorktreeCreation({
      configured: false,
      name: "single-repo-configless-dirty-carry-branch-switch"
    });
    git(worktreeRoot, ["switch", "-c", "session-local"]);

    expect(() =>
      runMonke({ args: ["spawn", "interrupted-carry"], cwd: repoRoot, monkeHome: home })
    ).toThrow(/to be on branch interrupted-carry, found session-local/u);
    expect(git(worktreeRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("session-local");

    git(worktreeRoot, ["switch", "interrupted-carry"]);
    runMonkeCapturingFailure({
      args: ["spawn", "interrupted-carry"],
      cwd: repoRoot,
      monkeHome: home
    });

    expect(read(worktreeRoot, "README.md")).toBe("dirty\n");
    expect(read(worktreeRoot, "notes.txt")).toBe("untracked\n");
    expect(git(repoRoot, ["branch", "--list", "session-local"])).not.toBe("");
  });

  test("config-less Spawn resumes after interruption between tracked and untracked dirty carry", () => {
    const { home, repoRoot, worktreeRoot } = interruptDirtyCarryAfterTrackedPatch({
      configured: false,
      name: "single-repo-configless-dirty-carry-partial"
    });

    runMonkeCapturingFailure({
      args: ["spawn", "interrupted-carry"],
      cwd: repoRoot,
      monkeHome: home
    });

    expect(read(worktreeRoot, "README.md")).toBe("dirty\n");
    expect(read(worktreeRoot, "notes.txt")).toBe("untracked\n");
    expect(loadSessionState(home, repoRoot, "interrupted-carry").repos[0]).toMatchObject({
      dirtyCarryStatus: "complete",
      preparationStatus: "prepared"
    });
  });

  test("config-less Spawn resumes a partially copied untracked dirty carry", () => {
    const { home, repoRoot, worktreeRoot } = interruptDirtyCarryAfterPartialUntrackedCopy({
      configured: false,
      name: "single-repo-configless-dirty-carry-partial-untracked"
    });

    runMonkeCapturingFailure({
      args: ["spawn", "interrupted-carry"],
      cwd: repoRoot,
      monkeHome: home
    });

    expect(read(worktreeRoot, "a-first.txt")).toBe("first\n");
    expect(read(worktreeRoot, "z-last.txt")).toBe("last\n");
    expect(loadSessionState(home, repoRoot, "interrupted-carry").repos[0]).toMatchObject({
      dirtyCarryStatus: "complete",
      preparationStatus: "prepared"
    });
  });

  test("spawn without monke.yml rejects changing retained dirty policy", () => {
    const sandbox = makeTempDir("single-repo-no-config-existing-no-dirty");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "clean\n"
    });

    runMonkeCapturingFailure({
      args: ["spawn", "existing-no-config"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });
    write(repoRoot, "README.md", "dirty\n");

    expect(() =>
      runMonke({
        args: ["spawn", "existing-no-config", "--no-dirty"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home
      })
    ).toThrow(/incomplete Spawn using current HEAD with dirty carry/u);
  });

  test("spawn carries tracked modifications by default", () => {
    const sandbox = makeTempDir("single-repo-dirty-modified");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "apps: {}\n",
      "README.md": "clean\n"
    });
    write(repoRoot, "README.md", "dirty\n");

    runMonke({
      args: ["spawn", "dirty-copy"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    expect(read(getExpectedWorktreePath(home, repoRoot, "dirty-copy"), "README.md")).toBe(
      "dirty\n"
    );
  });

  test("dirty spawn onto an existing diverged session branch fails before creating the worktree", () => {
    const sandbox = makeTempDir("single-repo-dirty-diverged-branch");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "apps: {}\n",
      "README.md": "clean\n"
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
        monkeHome: home
      })
    ).toThrow(
      /Session branch "banana" already exists.*carrying dirty changes onto a diverged branch is unsafe.*--no-dirty.*align the branch/su
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
      "monke.yml": "apps: {}\n",
      "README.md": "clean\n"
    });

    git(repoRoot, ["branch", "banana", "HEAD"]);
    write(repoRoot, "README.md", "dirty source\n");

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    expect(read(getExpectedWorktreePath(home, repoRoot, "banana"), "README.md")).toBe(
      "dirty source\n"
    );
  });

  test("spawn carries staged changes by default", () => {
    const sandbox = makeTempDir("single-repo-dirty-staged");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "apps: {}\n",
      "README.md": "clean\n"
    });
    write(repoRoot, "README.md", "staged\n");
    git(repoRoot, ["add", "README.md"]);

    runMonke({
      args: ["spawn", "dirty-staged"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    expect(read(getExpectedWorktreePath(home, repoRoot, "dirty-staged"), "README.md")).toBe(
      "staged\n"
    );
  });

  test("spawn carries staged and unstaged edits to the same file", () => {
    const sandbox = makeTempDir("single-repo-dirty-layered");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "apps: {}\n",
      "README.md": "a\n"
    });
    write(repoRoot, "README.md", "b\n");
    git(repoRoot, ["add", "README.md"]);
    write(repoRoot, "README.md", "c\n");

    runMonke({
      args: ["spawn", "dirty-layered"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    expect(read(getExpectedWorktreePath(home, repoRoot, "dirty-layered"), "README.md")).toBe("c\n");
  });

  test("spawn carries tracked deletions by default", () => {
    const sandbox = makeTempDir("single-repo-dirty-delete");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "apps: {}\n",
      "README.md": "clean\n"
    });
    rmSync(path.join(repoRoot, "README.md"));

    runMonke({
      args: ["spawn", "dirty-delete"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    expect(
      existsSync(path.join(getExpectedWorktreePath(home, repoRoot, "dirty-delete"), "README.md"))
    ).toBeFalsy();
  });

  test("spawn carries untracked non-ignored files by default", () => {
    const sandbox = makeTempDir("single-repo-dirty-untracked");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "apps: {}\n",
      "README.md": "clean\n"
    });
    write(repoRoot, "notes/nested.txt", "carry me\n");

    runMonke({
      args: ["spawn", "dirty-untracked"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    expect(
      read(getExpectedWorktreePath(home, repoRoot, "dirty-untracked"), "notes/nested.txt")
    ).toBe("carry me\n");
  });

  test("spawn preserves untracked symlinks without copying linked contents", () => {
    const sandbox = makeTempDir("single-repo-dirty-untracked-symlink");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "apps: {}\n",
      "README.md": "clean\n"
    });
    const outsideFile = path.join(sandbox, "outside-secret.txt");
    write(sandbox, "outside-secret.txt", "do not copy\n");
    symlinkSync(outsideFile, path.join(repoRoot, "secret-link"));

    runMonke({
      args: ["spawn", "dirty-untracked-link"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    const copiedLink = path.join(
      getExpectedWorktreePath(home, repoRoot, "dirty-untracked-link"),
      "secret-link"
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
      "monke.yml": "apps: {}\n",
      "README.md": "clean\n"
    });
    write(repoRoot, "ignored.txt", "leave behind\n");

    runMonke({
      args: ["spawn", "dirty-ignored"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    expect(
      existsSync(path.join(getExpectedWorktreePath(home, repoRoot, "dirty-ignored"), "ignored.txt"))
    ).toBeFalsy();
  });

  test("spawn --no-dirty rejects dirty source checkouts", () => {
    const sandbox = makeTempDir("single-repo-no-dirty");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "apps: {}\n",
      "README.md": "clean\n"
    });
    write(repoRoot, "README.md", "dirty\n");

    expect(() =>
      runMonke({
        args: ["spawn", "reject-dirty", "--no-dirty"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home
      })
    ).toThrow(`Source checkout is dirty: ${repoRoot}`);
    expect(existsSync(getExpectedWorktreePath(home, repoRoot, "reject-dirty"))).toBeFalsy();
  });

  test("spawn does not carry source dirt into existing Session worktrees", () => {
    const sandbox = makeTempDir("single-repo-existing-dirty");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "apps: {}\n",
      "README.md": "clean\n"
    });

    runMonke({
      args: ["spawn", "existing"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });
    write(repoRoot, "README.md", "dirty\n");
    const result = runMonke({
      args: ["spawn", "existing"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    expect(read(getExpectedWorktreePath(home, repoRoot, "existing"), "README.md")).toBe("clean\n");
    expect(result.stderr).toContain(
      `Warning: Session worktree for existing at ${repoRoot} already exists; dirty Source checkout changes were not carried into it.`
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
`
    };
    const firstRepo = createRepo(path.join(sandbox, "client-a", "api"), repoFiles);
    const secondRepo = createRepo(path.join(sandbox, "client-b", "api"), repoFiles);

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: firstRepo,
      monkeHome: home
    });
    git(firstRepo, [
      "worktree",
      "remove",
      "--force",
      getExpectedWorktreePath(home, firstRepo, "banana")
    ]);

    expect(() =>
      runMonke({
        args: ["spawn", "banana"],
        binDirectory,
        cwd: secondRepo,
        monkeHome: home
      })
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
`
    });
    git(repoRoot, ["switch", "-c", "feature"]);
    write(repoRoot, "apps/api/.env.local", "PORT=10000\nBRANCH_DIRTY=1\n");

    runMonke({
      args: ["spawn", "fresh", "-m"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
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
      "monke.yml": "apps: {}\n",
      "README.md": "main\n"
    });
    git(repoRoot, ["switch", "-c", "feature"]);
    write(repoRoot, "README.md", "dirty feature\n");
    write(repoRoot, "notes.txt", "untracked\n");

    runMonke({
      args: ["spawn", "fresh-main", "-m"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
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
      "monke.yml": "apps: {}\n",
      "README.md": "main\n"
    });
    git(repoRoot, ["switch", "-c", "feature"]);
    write(repoRoot, "README.md", "dirty feature\n");

    runMonke({
      args: ["spawn", "fresh-main-no-dirty", "--no-dirty", "-m"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    expect(read(getExpectedWorktreePath(home, repoRoot, "fresh-main-no-dirty"), "README.md")).toBe(
      "main\n"
    );
  });

  test("spawn -m without monke.yml creates an unmaterialized default-branch worktree", () => {
    const sandbox = makeTempDir("single-repo-main-no-config");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "main\n"
    });
    git(repoRoot, ["switch", "-c", "feature"]);
    write(repoRoot, "README.md", "feature\n");

    const result = runMonkeCapturingFailure({
      args: ["spawn", "fresh", "-m"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "fresh");
    expect(read(worktreeRoot, "README.md")).toBe("main\n");
    expect(git(worktreeRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("fresh");
    expect(result.stderr).toContain(
      `Warning: no monke.yml found for ${repoRoot}; prepared session worktree without materializing it.`
    );

    const sessionState = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    expect(sessionState.graphSource).toBe("session-branch");
    expect(sessionState.generation).toStrictEqual({ number: 0, status: "not-started" });
    expect(sessionState.spawnSource).toBe("default-branch");
    expect(sessionState.repos[0]).toMatchObject({
      materializationStatus: "pending",
      sourceRoot: repoRoot,
      worktreePath: worktreeRoot
    });

    const retry = runMonkeCapturingFailure({
      args: ["spawn", "fresh", "-m"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });
    expect(retry.error?.message).toContain("Retry: mt spawn fresh -m");
    expect(loadSessionState(home, repoRoot, "fresh").spawnSource).toBe("default-branch");
  });

  test("config-less default-branch retry recreates a missing branch and worktree from retained pinnedRef", () => {
    const sandbox = makeTempDir("single-repo-main-no-config-pinned-recovery");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "version.txt": "pinned\n"
    });

    runMonkeCapturingFailure({
      args: ["spawn", "retained", "-m"],
      cwd: repoRoot,
      monkeHome: home
    });
    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "retained");
    const pinnedRef = loadSessionState(home, repoRoot, "retained").repos[0]?.pinnedRef;
    git(repoRoot, ["worktree", "remove", "--force", worktreeRoot]);
    git(repoRoot, ["branch", "-D", "retained"]);
    write(repoRoot, "version.txt", "advanced\n");
    git(repoRoot, ["add", "version.txt"]);
    git(repoRoot, ["commit", "-m", "advance main"]);

    const retried = runMonkeCapturingFailure({
      args: ["spawn", "retained"],
      cwd: repoRoot,
      monkeHome: home
    });

    expect(retried.error?.message).toContain(`Prepared Root worktree: ${worktreeRoot}`);
    expect(read(worktreeRoot, "version.txt")).toBe("pinned\n");
    expect(git(worktreeRoot, ["rev-parse", "HEAD"])).toBe(pinnedRef);
    expect(loadSessionState(home, repoRoot, "retained").repos[0]?.pinnedRef).toBe(pinnedRef);
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
`
    });
    git(repoRoot, ["switch", "-c", "feature"]);
    write(repoRoot, "local-only.txt", "dirty source only\n");

    runMonke({
      args: ["spawn", "fresh", "-m"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
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
`
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
      monkeHome: home
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
`
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
      monkeHome: home
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
`
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
      monkeHome: home
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
`
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
      monkeHome: home
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "local-default");
    expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10000\nLOCAL_MAIN=1\n");
  });

  test("spawn -m retains a failed fresh preparation at its pinned ref for retry", () => {
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
`
    });

    expect(() =>
      runMonke({
        args: ["spawn", "retryable", "-m"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home
      })
    ).toThrow(/Expected managed env file to exist/u);

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "retryable");
    expect(existsSync(worktreeRoot)).toBeTruthy();
    expect(existsSync(getSessionStateFilePath(home, repoRoot, "retryable"))).toBeTruthy();
    expect(git(repoRoot, ["show-ref", "--verify", "refs/heads/retryable"])).not.toBe("");
    const failedState = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    expect(failedState.generation.status).toBe("incomplete");
    expect(failedState.repos[0]?.pinnedRef).toBe(git(worktreeRoot, ["rev-parse", "HEAD"]));

    write(repoRoot, "apps/api/.env.local", "PORT=3000\n");
    git(repoRoot, ["add", "apps/api/.env.local"]);
    git(repoRoot, ["commit", "-m", "add api env"]);
    write(worktreeRoot, "apps/api/.env.local", "PORT=3000\n");

    runMonke({
      args: ["spawn", "retryable", "-m"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10000\n");
  });

  test("spawn -m finalizes an interrupted generation whose repo checkpoints all completed", () => {
    const sandbox = makeTempDir("single-repo-main-final-checkpoint-retry");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": `bootstrapCommand: printf x >> bootstrap-runs
apps: {}
`
    });

    runMonke({ args: ["spawn", "interrupted", "-m"], cwd: repoRoot, monkeHome: home });
    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "interrupted");
    const complete = loadSessionState(home, repoRoot, "interrupted");
    saveSessionState(home, {
      ...complete,
      generation: { ...complete.generation, status: "incomplete" }
    });

    runMonke({ args: ["spawn", "interrupted", "-m"], cwd: repoRoot, monkeHome: home });

    expect(read(worktreeRoot, "bootstrap-runs")).toBe("x");
    expect(loadSessionState(home, repoRoot, "interrupted").generation).toStrictEqual({
      number: 1,
      status: "complete"
    });
  });

  test("Spawn does not reuse a materialized Root repo whose Session worktree is missing", () => {
    const sandbox = makeTempDir("single-repo-missing-materialized-root");
    const home = path.join(sandbox, "home");
    const bootstrapRuns = path.join(sandbox, "bootstrap-runs");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": `bootstrapCommand: printf x >> "${bootstrapRuns}"
apps: {}
`
    });

    runMonke({ args: ["spawn", "interrupted", "-m"], cwd: repoRoot, monkeHome: home });
    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "interrupted");
    const complete = loadSessionState(home, repoRoot, "interrupted");
    saveSessionState(home, {
      ...complete,
      generation: { ...complete.generation, status: "incomplete" }
    });
    git(repoRoot, ["worktree", "remove", "--force", worktreeRoot]);

    const retried = runMonkeCapturingFailure({
      args: ["spawn", "interrupted", "-m"],
      cwd: repoRoot,
      monkeHome: home
    });

    expect(retried.error?.message).toContain(`Expected worktree to exist at ${worktreeRoot}`);
    expect(retried.stdout).toBe("");
    expect(existsSync(worktreeRoot)).toBeFalsy();
    expect(loadSessionState(home, repoRoot, "interrupted").repos[0]).toMatchObject({
      failure: { phase: "worktree-preparation" },
      materializationStatus: "materialized",
      preparationStatus: "failed"
    });

    git(repoRoot, ["worktree", "add", worktreeRoot, "interrupted"]);
    runMonke({ args: ["spawn", "interrupted", "-m"], cwd: repoRoot, monkeHome: home });

    expect(read(sandbox, "bootstrap-runs")).toBe("x");
    expect(loadSessionState(home, repoRoot, "interrupted").generation.status).toBe("complete");
  });

  test("spawn -m retries an interruption before the Session branch exists at its pinned ref", () => {
    const sandbox = makeTempDir("single-repo-main-early-checkpoint-retry");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "apps: {}\n",
      "version.txt": "pinned\n"
    });
    const pinnedRef = git(repoRoot, ["rev-parse", "refs/heads/main"]);
    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "interrupted");
    installGitShim(binDirectory, {
      failCommand: {
        args: `worktree add -b interrupted ${worktreeRoot} ${pinnedRef}`,
        message: "injected early worktree failure"
      }
    });

    expect(() =>
      runMonke({
        args: ["spawn", "interrupted", "-m"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home
      })
    ).toThrow(/injected early worktree failure/u);
    expect(git(repoRoot, ["branch", "--list", "interrupted"])).toBe("");
    expect(loadSessionState(home, repoRoot, "interrupted").repos[0]?.pinnedRef).toBe(pinnedRef);

    write(repoRoot, "version.txt", "newer\n");
    git(repoRoot, ["add", "version.txt"]);
    git(repoRoot, ["commit", "-m", "advance main"]);

    runMonke({ args: ["spawn", "interrupted", "-m"], cwd: repoRoot, monkeHome: home });

    expect(read(worktreeRoot, "version.txt")).toBe("pinned\n");
    expect(loadSessionState(home, repoRoot, "interrupted").generation.status).toBe("complete");
  });

  test("spawn -m retry retains its pinned generation after origin main advances", () => {
    const sandbox = makeTempDir("single-repo-remote-default-retry-pin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "bootstrapCommand: test -f allow-bootstrap\napps: {}\n",
      "version.txt": "pinned\n"
    });
    const origin = path.join(sandbox, "origin.git");
    git(repoRoot, ["init", "--bare", origin]);
    git(repoRoot, ["remote", "add", "origin", origin]);
    git(repoRoot, ["push", "-u", "origin", "main"]);
    const pinnedRef = git(repoRoot, ["rev-parse", "HEAD"]);

    expect(() =>
      runMonke({ args: ["spawn", "retained", "-m"], cwd: repoRoot, monkeHome: home })
    ).toThrow(/Bootstrap command failed/u);

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "retained");
    const failedState = loadSessionState(home, repoRoot, "retained");
    expect(failedState.repos[0]).toMatchObject({
      materializationStatus: "failed",
      pinnedRef,
      preparationStatus: "prepared"
    });
    write(repoRoot, "version.txt", "advanced remote\n");
    git(repoRoot, ["add", "version.txt"]);
    git(repoRoot, ["commit", "-m", "advance remote main"]);
    git(repoRoot, ["push", "origin", "main"]);
    const advancedRemoteRef = git(repoRoot, ["rev-parse", "refs/remotes/origin/main"]);
    expect(advancedRemoteRef).not.toBe(pinnedRef);
    git(repoRoot, ["reset", "--hard", pinnedRef]);
    write(worktreeRoot, "allow-bootstrap", "yes\n");

    runMonke({ args: ["spawn", "retained", "-m"], cwd: repoRoot, monkeHome: home });

    const completeState = loadSessionState(home, repoRoot, "retained");
    expect(completeState.repos[0]?.pinnedRef).toBe(pinnedRef);
    expect(git(worktreeRoot, ["rev-parse", "HEAD"])).toBe(pinnedRef);
    expect(read(worktreeRoot, "version.txt")).toBe("pinned\n");
  });

  test("Materialize rejects malformed pinned state before reading advanced Source config", () => {
    const sandbox = makeTempDir("single-repo-malformed-pinned-materialize");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "bootstrapCommand: exit 9\napps: {}\n"
    });

    expect(() =>
      runMonke({ args: ["spawn", "malformed", "-m"], cwd: repoRoot, monkeHome: home })
    ).toThrow(/Bootstrap command failed/u);

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "malformed");
    const statePath = getSessionStateFilePath(home, repoRoot, "malformed");
    write(
      home,
      path.relative(home, statePath),
      readFileSync(statePath, "utf-8").replace("graphSource: session-branch\n", "")
    );
    write(repoRoot, "monke.yml", "bootstrapCommand: touch live-source-config-ran\napps: {}\n");
    git(repoRoot, ["add", "monke.yml"]);
    git(repoRoot, ["commit", "-m", "advance Source config"]);

    const result = runMonkeCapturingFailure({
      args: ["materialize"],
      cwd: worktreeRoot,
      monkeHome: home
    });

    expect(result.error?.message).toMatch(/graphSource|graph source/u);
    expect(existsSync(path.join(worktreeRoot, "live-source-config-ran"))).toBeFalsy();
  });

  test("plain spawn retry preserves a retained default-branch source policy", () => {
    const sandbox = makeTempDir("single-repo-main-plain-retry");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "bootstrapCommand: test -f allow-bootstrap\napps: {}\n",
      "version.txt": "pinned\n"
    });
    const pinnedRef = git(repoRoot, ["rev-parse", "refs/heads/main"]);

    expect(() =>
      runMonke({ args: ["spawn", "retained-main", "-m"], cwd: repoRoot, monkeHome: home })
    ).toThrow(/Retry: mt spawn retained-main -m/u);

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "retained-main");
    write(worktreeRoot, "allow-bootstrap", "yes\n");
    write(repoRoot, "version.txt", "advanced\n");
    git(repoRoot, ["add", "version.txt"]);
    git(repoRoot, ["commit", "-m", "advance main"]);

    runMonke({ args: ["spawn", "retained-main"], cwd: repoRoot, monkeHome: home });

    const state = loadSessionState(home, repoRoot, "retained-main");
    expect(state.spawnSource).toBe("default-branch");
    expect(state.repos[0]?.pinnedRef).toBe(pinnedRef);
    expect(read(worktreeRoot, "version.txt")).toBe("pinned\n");
    expect(state.generation.status).toBe("complete");
  });

  test("plain spawn cannot replace a completed default-branch Session identity", () => {
    const sandbox = makeTempDir("single-repo-complete-main-policy");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "apps: {}\n",
      "version.txt": "main\n"
    });

    runMonke({ args: ["spawn", "retained-main", "-m"], cwd: repoRoot, monkeHome: home });
    const before = loadSessionState(home, repoRoot, "retained-main");

    expect(() =>
      runMonke({ args: ["spawn", "retained-main"], cwd: repoRoot, monkeHome: home })
    ).toThrow(/completed Session.*pinned default branch.*use a new Session/u);
    expect(() =>
      runMonke({ args: ["spawn", "retained-main", "-m"], cwd: repoRoot, monkeHome: home })
    ).toThrow(/completed Session.*pinned default branch.*use a new Session/u);
    expect(loadSessionState(home, repoRoot, "retained-main")).toStrictEqual(before);
  });

  test("plain spawn retry preserves --no-dirty and reports the exact retry command", () => {
    const sandbox = makeTempDir("single-repo-no-dirty-policy-retry");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "bootstrapCommand: test -f allow-bootstrap\napps: {}\n",
      "README.md": "clean\n"
    });

    expect(() =>
      runMonke({
        args: ["spawn", "retained-clean", "--no-dirty"],
        cwd: repoRoot,
        monkeHome: home
      })
    ).toThrow(/Retry: mt spawn retained-clean --no-dirty/u);

    write(repoRoot, "README.md", "dirty\n");
    write(getExpectedWorktreePath(home, repoRoot, "retained-clean"), "allow-bootstrap", "yes\n");

    expect(() =>
      runMonke({ args: ["spawn", "retained-clean"], cwd: repoRoot, monkeHome: home })
    ).toThrow(`Source checkout is dirty: ${repoRoot}`);
    expect(loadSessionState(home, repoRoot, "retained-clean").generation.status).toBe("incomplete");
  });

  test("spawn -m pins graph discovery before a movable default ref advances", () => {
    const sandbox = makeTempDir("single-repo-main-graph-pin");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "apps: {}\n",
      "version.txt": "pinned\n"
    });
    const pinnedRef = git(repoRoot, ["rev-parse", "refs/heads/main"]);
    git(repoRoot, ["switch", "-c", "newer"]);
    write(repoRoot, "version.txt", "newer\n");
    git(repoRoot, ["add", "version.txt"]);
    git(repoRoot, ["commit", "-m", "newer default content"]);
    const newerRef = git(repoRoot, ["rev-parse", "HEAD"]);
    git(repoRoot, ["switch", "main"]);
    installGitShim(binDirectory, {
      afterCommand: {
        args: `show ${pinnedRef}:monke.yml`,
        cwd: repoRoot,
        script: `"$MONKE_TEST_REAL_GIT" update-ref refs/heads/main ${newerRef}`
      }
    });

    runMonke({
      args: ["spawn", "pinned-graph", "-m"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "pinned-graph");
    expect(git(repoRoot, ["rev-parse", "refs/heads/main"])).toBe(newerRef);
    expect(read(worktreeRoot, "version.txt")).toBe("pinned\n");
    expect(loadSessionState(home, repoRoot, "pinned-graph").repos[0]?.pinnedRef).toBe(pinnedRef);
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
`
    });
    saveSessionState(
      home,
      completeSessionState({
        repos: [
          materializedRepoState({
            sourceRoot: repoRoot,
            worktreePath: getExpectedWorktreePath(home, repoRoot, "fresh")
          })
        ],
        rootSourceRoot: repoRoot,
        session: "fresh"
      })
    );

    expect(() =>
      runMonke({
        args: ["spawn", "fresh", "-m"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home
      })
    ).toThrow(/completed Session.*current HEAD.*use a new Session/u);
  });

  test("Spawn rejects v1 Session state through the production loader", () => {
    const sandbox = makeTempDir("single-repo-v1-session-state");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "apps: {}\n"
    });
    const statePath = getSessionStateFilePath(home, repoRoot, "legacy");
    write(
      home,
      path.relative(home, statePath),
      `version: 1
rootSourceRoot: ${repoRoot}
session: legacy
repos: []
`
    );

    expect(() => runMonke({ args: ["spawn", "legacy"], cwd: repoRoot, monkeHome: home })).toThrow(
      /Unsupported Session state version 1.*requires strict v2 Session state/su
    );
  });

  test("spawn -m does not resume an incomplete current-head Session", () => {
    const sandbox = makeTempDir("single-repo-main-current-head-state");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\n",
      "monke.yml": `bootstrapCommand: exit 9
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`
    });

    expect(() =>
      runMonke({
        args: ["spawn", "current-head-failure"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home
      })
    ).toThrow(/Bootstrap command failed/u);

    expect(() =>
      runMonke({
        args: ["spawn", "current-head-failure", "-m"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home
      })
    ).toThrow(/incomplete Spawn using current HEAD with dirty carry/u);
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
`
    });
    git(repoRoot, ["branch", "fresh"]);

    expect(() =>
      runMonke({
        args: ["spawn", "fresh", "-m"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home
      })
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
`
    });

    for (const [session, flag, env] of [
      ["main-alias", "--main", "API_PORT=10000\n"],
      ["master-alias", "--master", "API_PORT=10001\n"]
    ] as const) {
      runMonke({
        args: ["spawn", session, flag],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home
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
`
    });

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
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
`
    });

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      extraEnv: { USER: "ada" },
      monkeHome: home
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10000\nOTHER=keep\n");
    expect(read(worktreeRoot, ".env")).toBe(
      "API_PORT=10000\nDISCORD_CHANNEL=mt-ada-banana\nSTATIC_HANDLE=fixed-banana\n"
    );

    const initialState = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    expect(initialState.repos[0]?.resourceValues).toStrictEqual([
      { env: "DISCORD_CHANNEL", value: "mt-ada-banana" },
      { env: "STATIC_HANDLE", value: "fixed-banana" }
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
`
    );

    runMonke({
      args: ["materialize"],
      binDirectory,
      cwd: worktreeRoot,
      extraEnv: { USER: "ada" },
      monkeHome: home
    });

    expect(read(worktreeRoot, ".env")).toBe("API_PORT=10000\nDISCORD_CHANNEL=mt-ada-banana\n");

    const nextState = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    expect(nextState.repos[0]?.resourceValues).toStrictEqual([
      { env: "DISCORD_CHANNEL", value: "mt-ada-banana" }
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
`
    });

    runMonke({
      args: ["spawn", "first"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    const message = captureThrowMessage(() => {
      runMonke({
        args: ["spawn", "second"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home
      });
    });
    expect(message).toContain("Resource value collision for DISCORD_CHANNEL=<redacted length=6>");
    expect(message).toContain(`in ${repoRoot}; retained session first already owns that value`);
    expect(message).not.toContain("DISCORD_CHANNEL=shared");
    expect(message).not.toContain("shared");
  });

  test("Materialize rejects Source checkout context and reuses Assigned ports inside a valid Session worktree", () => {
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
`
    });

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    expect(() => {
      runMonke({
        args: ["materialize"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home
      });
    }).toThrow(/must run inside a session worktree/u);

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    expect(inferSessionName(home, repoRoot, worktreeRoot, "banana")).toBe("banana");
    expect(() => inferSessionName(home, repoRoot, worktreeRoot, "wrong")).toThrow(
      /match current branch/u
    );

    const before = read(worktreeRoot, ".env");
    expect(before).toBe("API_PORT=10000\nDB_PORT=10001\n");

    runMonke({
      args: ["materialize"],
      binDirectory,
      cwd: worktreeRoot,
      monkeHome: home
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
`
    });

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    expect(read(worktreeRoot, "bootstrap-runs")).toBe(`${worktreeRoot}\n`);
    expect(
      readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema).generation
    ).toStrictEqual({
      number: 1,
      status: "complete"
    });

    runMonke({
      args: ["materialize"],
      binDirectory,
      cwd: worktreeRoot,
      monkeHome: home
    });

    expect(read(worktreeRoot, "bootstrap-runs")).toBe(`${worktreeRoot}\n${worktreeRoot}\n`);
    expect(
      readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema).generation
    ).toStrictEqual({
      number: 2,
      status: "complete"
    });
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
      "scripts/bootstrap.sh": "#!/bin/sh\necho seeded\n"
    });

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    expect(read(worktreeRoot, "apps/frostbite-crawler/data/sessions/hoangbn/Preferences")).toBe(
      '{ "theme": "dark" }\n'
    );
    expect(read(worktreeRoot, "apps/frostbite-crawler/data/sessions/hoangbn/Cookies")).toBe(
      "cookie-jar\n"
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
`
    });
    write(repoRoot, "apps/frostbite-crawler/data/sessions/hoangbn/Cookies", "cookie-jar\n");

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    expect(read(worktreeRoot, "apps/frostbite-crawler/data/sessions/.gitkeep")).toBe("");
    expect(read(worktreeRoot, "apps/frostbite-crawler/data/sessions/hoangbn/Preferences")).toBe(
      '{ "theme": "dark" }\n'
    );
    expect(read(worktreeRoot, "apps/frostbite-crawler/data/sessions/hoangbn/Cookies")).toBe(
      "cookie-jar\n"
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
`
    });

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    write(
      worktreeRoot,
      "apps/frostbite-crawler/data/sessions/hoangbn/Preferences",
      '{ "theme": "light" }\n'
    );

    runMonke({
      args: ["materialize"],
      binDirectory,
      cwd: worktreeRoot,
      monkeHome: home
    });

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    expect(read(worktreeRoot, "apps/frostbite-crawler/data/sessions/hoangbn/Preferences")).toBe(
      '{ "theme": "light" }\n'
    );
  });

  test("materialize fills newly missing Seed material without mirroring source deletions", () => {
    const sandbox = makeTempDir("single-seedpaths-fill-missing");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      ".gitignore": "seed-data/\n",
      "apps/api/.env.local": "PORT=3000\n",
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
      "seed-data/original.txt": "source original\n"
    });

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    write(worktreeRoot, "seed-data/original.txt", "Session-local original\n");
    rmSync(path.join(repoRoot, "seed-data/original.txt"));
    write(repoRoot, "seed-data/new.txt", "new source material\n");

    runMonke({
      args: ["materialize"],
      binDirectory,
      cwd: worktreeRoot,
      monkeHome: home
    });

    expect(read(worktreeRoot, "seed-data/original.txt")).toBe("Session-local original\n");
    expect(read(worktreeRoot, "seed-data/new.txt")).toBe("new source material\n");
  });

  test("materialize retries preparation after a Seed copy error is repaired", () => {
    const sandbox = makeTempDir("single-seedpaths-copy-retry");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      ".gitignore": "seed-data/\n",
      "apps/api/.env.local": "PORT=3000\n",
      "monke.yml": `bootstrapCommand: printf x >> bootstrap-runs
seedPaths:
  - seed-data
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
      "seed-data/fixture.txt": "fixture\n"
    });

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    expect(read(worktreeRoot, "bootstrap-runs")).toBe("x");
    const completedGeneration = loadSessionState(home, repoRoot, "banana");
    saveSessionState(home, {
      ...completedGeneration,
      generation: { ...completedGeneration.generation, status: "incomplete" }
    });
    const protectedSourcePath = path.join(repoRoot, "seed-data/protected");
    write(repoRoot, "seed-data/protected/fixture.txt", "protected fixture\n");
    chmodSync(protectedSourcePath, 0o000);

    expect(() =>
      runMonke({
        args: ["materialize"],
        binDirectory,
        cwd: worktreeRoot,
        monkeHome: home
      })
    ).toThrow(/Worktree preparation failed/u);
    expect(read(worktreeRoot, "bootstrap-runs")).toBe("x");
    const failedState = loadSessionState(home, repoRoot, "banana");
    chmodSync(protectedSourcePath, 0o700);
    expect(failedState.repos[0]).toMatchObject({
      failure: { phase: "worktree-preparation" },
      materializationStatus: "materialized",
      preparationStatus: "failed"
    });

    runMonke({
      args: ["materialize"],
      binDirectory,
      cwd: worktreeRoot,
      monkeHome: home
    });

    expect(read(worktreeRoot, "seed-data/protected/fixture.txt")).toBe("protected fixture\n");
    expect(read(worktreeRoot, "bootstrap-runs")).toBe("x");
  });

  test("materialize does not follow a nested dangling Session-local Seed symlink", () => {
    const sandbox = makeTempDir("single-seedpaths-dangling-symlink");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      ".gitignore": "seed-data/\n",
      "apps/api/.env.local": "PORT=3000\n",
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
      "seed-data/profile": "source profile\n"
    });

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    const outsidePath = path.join(sandbox, "outside-profile");
    const targetPath = path.join(worktreeRoot, "seed-data/profile");
    rmSync(targetPath);
    symlinkSync(outsidePath, targetPath);

    runMonke({
      args: ["materialize"],
      binDirectory,
      cwd: worktreeRoot,
      monkeHome: home
    });

    expect(lstatSync(targetPath).isSymbolicLink()).toBeTruthy();
    expect(readlinkSync(targetPath)).toBe(outsidePath);
    expect(existsSync(outsidePath)).toBeFalsy();
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
`
    });

    const result = runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    expect(result.stderr).toContain(
      "Warning: seedPath apps/frostbite-crawler/data/sessions is missing"
    );
    expect(result.stderr).toContain("Spawned or updated session banana");
  });

  test("setup creates the Source checkout root .env with direct external path env defaults", () => {
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
      "services/db/.env.local": "PORT=5432\n"
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
`
    });

    runMonke({
      args: ["setup"],
      cwd: root,
      monkeHome: home
    });

    expect(read(root, ".env")).toBe("DEP_DIR=../dep\n");
  });

  test("setup overwrites stale external path env values and preserves unrelated Source checkout root env entries", () => {
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
      "services/db/.env.local": "PORT=5432\n"
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
`
    });

    runMonke({
      args: ["setup"],
      cwd: root,
      monkeHome: home
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
      "services/db/.env.local": "PORT=5432\n"
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
`
    });

    runMonke({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    expect(() =>
      runMonke({
        args: ["setup"],
        binDirectory,
        cwd: getExpectedWorktreePath(home, root, "banana"),
        monkeHome: home
      })
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
      "tracked.txt": "committed\n"
    });
    write(repoRoot, "tracked.txt", "dirty\n");

    runMonke({
      args: ["spawn", "fresh-seeds", "-m"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "fresh-seeds");
    expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10000\n");
    expect(read(worktreeRoot, ".env")).toBe("API_PORT=10000\n");
    expect(read(worktreeRoot, "seed-data/fixture.txt")).toBe("fixture\n");
    expect(read(worktreeRoot, "tracked.txt")).toBe("committed\n");
    expect(read(repoRoot, "apps/api/.env.local")).toBe("PORT=3000\n");
  });

  test("session-branch respawn seeds untracked env files from the source checkout", async () => {
    const sandbox = makeTempDir("single-repo-session-branch-seeds");
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
      "seed-data/fixture.txt": "fixture\n"
    });

    git(repoRoot, ["branch", "respawned"]);
    const runtime = createRuntime({
      cwd: repoRoot,
      env: { MONKE_HOME: home, PATH: process.env.PATH ?? "" },
      onStderr() {},
      onStdout() {}
    });
    await spawnSessionFromSourceRootLocked(runtime, home, repoRoot, "respawned", {
      mode: "session-branch"
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "respawned");
    git(repoRoot, ["worktree", "remove", "--force", worktreeRoot]);

    await spawnSessionFromSourceRootLocked(runtime, home, repoRoot, "respawned", {
      mode: "session-branch"
    });

    expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10000\n");
    expect(read(worktreeRoot, ".env")).toBe("API_PORT=10000\n");
    expect(read(worktreeRoot, "seed-data/fixture.txt")).toBe("fixture\n");
  });
});

function interruptDirtyCarryAfterWorktreeCreation(options: { configured: boolean; name: string }) {
  const sandbox = makeTempDir(options.name);
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(
    path.join(sandbox, "root"),
    options.configured
      ? {
          ".gitignore": "ignored.local\n",
          "monke.yml": "apps: {}\n",
          "README.md": "clean\n",
          "session-tracked.txt": "clean Session content\n"
        }
      : {
          ".gitignore": "ignored.local\n",
          "README.md": "clean\n",
          "session-tracked.txt": "clean Session content\n"
        }
  );
  write(repoRoot, "README.md", "dirty\n");
  write(repoRoot, "notes.txt", "untracked\n");
  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "interrupted-carry");
  installGitShim(binDirectory, {
    afterCommand: {
      args: `worktree add ${worktreeRoot} interrupted-carry`,
      cwd: repoRoot,
      script: 'kill -KILL "$PPID"'
    }
  });

  const interrupted = runMonkeCapturingFailure({
    args: ["spawn", "interrupted-carry"],
    binDirectory,
    cwd: repoRoot,
    monkeHome: home
  });
  expect(interrupted.error).not.toBeNull();
  expect(loadSessionState(home, repoRoot, "interrupted-carry").repos[0]).toMatchObject({
    dirtyCarryStatus: "pending",
    preparationStatus: "pending"
  });
  return { home, repoRoot, worktreeRoot };
}

function interruptDirtyCarryAfterTrackedPatch(options: { configured: boolean; name: string }) {
  const sandbox = makeTempDir(options.name);
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(
    path.join(sandbox, "root"),
    options.configured
      ? { "monke.yml": "apps: {}\n", "README.md": "clean\n" }
      : { "README.md": "clean\n" }
  );
  write(repoRoot, "README.md", "dirty\n");
  write(repoRoot, "notes.txt", "untracked\n");
  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "interrupted-carry");
  installGitShim(binDirectory, {
    afterCommand: {
      args: "apply --3way",
      cwd: worktreeRoot,
      script: 'kill -KILL "$PPID"'
    }
  });

  const interrupted = runMonkeCapturingFailure({
    args: ["spawn", "interrupted-carry"],
    binDirectory,
    cwd: repoRoot,
    monkeHome: home
  });
  expect(interrupted.error).not.toBeNull();
  expect(read(worktreeRoot, "README.md")).toBe("dirty\n");
  expect(existsSync(path.join(worktreeRoot, "notes.txt"))).toBeFalsy();
  expect(loadSessionState(home, repoRoot, "interrupted-carry").repos[0]).toMatchObject({
    dirtyCarryStatus: "pending",
    preparationStatus: "pending"
  });
  return { home, repoRoot, worktreeRoot };
}

function interruptDirtyCarryAfterPartialUntrackedCopy(options: {
  configured: boolean;
  name: string;
}) {
  const sandbox = makeTempDir(options.name);
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(
    path.join(sandbox, "root"),
    options.configured
      ? { "monke.yml": "apps: {}\n", "README.md": "clean\n" }
      : { "README.md": "clean\n" }
  );
  write(repoRoot, "README.md", "dirty\n");
  write(repoRoot, "a-first.txt", "first\n");
  write(repoRoot, "z-last.txt", "last\n");
  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "interrupted-carry");
  installGitShim(binDirectory, {
    afterCommand: {
      args: "apply --3way",
      cwd: worktreeRoot,
      script: `rm "${path.join(repoRoot, "z-last.txt")}"`
    }
  });

  const interrupted = runMonkeCapturingFailure({
    args: ["spawn", "interrupted-carry"],
    binDirectory,
    cwd: repoRoot,
    monkeHome: home
  });
  expect(interrupted.error).not.toBeNull();
  expect(read(worktreeRoot, "a-first.txt")).toBe("first\n");
  expect(existsSync(path.join(worktreeRoot, "z-last.txt"))).toBeFalsy();
  write(repoRoot, "z-last.txt", "last\n");
  return { home, repoRoot, worktreeRoot };
}

function captureThrowMessage(action: () => void) {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("Expected action to throw");
}
