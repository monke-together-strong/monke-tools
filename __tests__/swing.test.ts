import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { getExpectedWorktreePath } from "../src/git.ts";
import { hashKey } from "../src/runtime.ts";
import { getSessionStateFilePath, loadSessionState } from "../src/session-state-store.ts";
import type { SelectPrompt } from "../src/types.ts";
import {
  createRepo as createTestRepo,
  git,
  installCodexUrlOpenShim,
  installWindowsCmdShim,
  makeTempDir,
  runMonke,
  runMonkeAsync,
  runMonkeCapturingFailure,
  withPlatform
} from "./helpers.ts";

describe("Swing", () => {
  test("swing navigates to an existing root repo Session worktree without creating one", () => {
    const sandbox = makeTempDir("swing-session");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });
    runMonke({ args: ["spawn", "banana"], cwd: repoRoot, monkeHome: home });

    const result = runMonke({ args: ["swing", "banana"], cwd: repoRoot, monkeHome: home });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    expect(result.stdout).toBe(`${worktreeRoot}\n`);
    expect(result.stderr).toContain(`Moved Swing target to ${worktreeRoot}`);
    expect(result.stderr).toContain(`Switch to ${worktreeRoot}`);
  });

  test("swing picker navigates to a Session worktree on another branch and warns", async () => {
    const sandbox = makeTempDir("swing-session-branch-mismatch");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });
    runMonke({ args: ["spawn", "banana"], cwd: repoRoot, monkeHome: home });
    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    git(worktreeRoot, ["switch", "-c", "unexpected"]);

    const result = await runMonkeAsync({
      args: ["swing"],
      cwd: repoRoot,
      monkeHome: home,
      selectValues: ["banana"]
    });

    expect(result.stdout.endsWith(`${worktreeRoot}\n`)).toBeTruthy();
    expect(result.stderr).toContain(
      `Session banana worktree ${worktreeRoot} is on branch unexpected instead of banana; swinging to it anyway`
    );
  });

  test("swing can leave a managed Session worktree after its branch changes", () => {
    const sandbox = makeTempDir("swing-current-session-branch-mismatch");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });
    runMonke({ args: ["spawn", "banana"], cwd: repoRoot, monkeHome: home });
    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    git(worktreeRoot, ["switch", "-c", "unexpected"]);

    const result = runMonke({ args: ["swing", "^"], cwd: worktreeRoot, monkeHome: home });

    expect(result.stdout).toBe(`${repoRoot}\n`);
    expect(result.stderr).toContain(`Switch to ${repoRoot}`);
  });

  test("swing without a target opens a Swing picker and selects a Session", async () => {
    const sandbox = makeTempDir("swing-picker-number");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });
    runMonke({ args: ["spawn", "banana"], cwd: repoRoot, monkeHome: home });

    const result = await runMonkeAsync({
      args: ["swing"],
      cwd: repoRoot,
      monkeHome: home,
      selectValues: ["banana"]
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    expect(result.stdout.endsWith(`${worktreeRoot}\n`)).toBeTruthy();
    expect(result.stderr).toContain(worktreeRoot);
  });

  test("swing detects a linked worktree outside Monke home by branch name", () => {
    const sandbox = makeTempDir("swing-linked-worktree");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });
    const worktreeRoot = path.join(sandbox, "ordinary-worktrees", "banana");
    git(repoRoot, ["branch", "banana"]);
    git(repoRoot, ["worktree", "add", worktreeRoot, "banana"]);

    const result = runMonke({ args: ["swing", "banana"], cwd: repoRoot, monkeHome: home });

    expect(result.stdout).toBe(`${worktreeRoot}\n`);
    expect(result.stderr).toContain(`Moved Swing target to ${worktreeRoot}`);
    expect(result.stderr).toContain(`Switch to ${worktreeRoot}`);
  });

  test("swing picker includes linked worktrees outside Monke home", async () => {
    const sandbox = makeTempDir("swing-picker-linked-worktree");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });
    runMonke({ args: ["spawn", "mango"], cwd: repoRoot, monkeHome: home });
    const worktreeRoot = path.join(sandbox, "ordinary-worktrees", "banana");
    git(repoRoot, ["branch", "banana"]);
    git(repoRoot, ["worktree", "add", worktreeRoot, "banana"]);
    let prompt: SelectPrompt | undefined;

    const result = await runMonkeAsync({
      args: ["swing"],
      cwd: repoRoot,
      monkeHome: home,
      onSelect(value) {
        prompt = value;
      },
      selectValues: ["banana"]
    });

    expect(prompt?.options.map((option) => option.value)).toStrictEqual(["mango", "banana"]);
    expect(prompt?.options.map((option) => option.label)).toStrictEqual(["mango", "banana"]);
    expect(result.stdout.endsWith(`${worktreeRoot}\n`)).toBeTruthy();
  });

  test("swing picker hides paths and lists recently updated Sessions first", async () => {
    const sandbox = makeTempDir("swing-picker-recency");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });
    runMonke({ args: ["spawn", "z-newer"], cwd: repoRoot, monkeHome: home });
    runMonke({ args: ["spawn", "a-older"], cwd: repoRoot, monkeHome: home });
    git(
      getExpectedWorktreePath(home, repoRoot, "z-newer"),
      ["commit", "--allow-empty", "-m", "newer"],
      {
        GIT_AUTHOR_DATE: "2035-01-02T00:00:00Z",
        GIT_COMMITTER_DATE: "2035-01-02T00:00:00Z"
      }
    );
    git(repoRoot, ["tag", "z-newer"]);
    const stateTime = new Date("2025-01-01T00:00:00Z");
    utimesSync(getSessionStateFilePath(home, repoRoot, "a-older"), stateTime, stateTime);
    utimesSync(getSessionStateFilePath(home, repoRoot, "z-newer"), stateTime, stateTime);
    let prompt: SelectPrompt | undefined;

    await runMonkeAsync({
      args: ["swing"],
      cwd: repoRoot,
      monkeHome: home,
      onSelect(value) {
        prompt = value;
      },
      selectValues: ["a-older"]
    });

    expect(prompt?.options.map((option) => option.value)).toStrictEqual(["z-newer", "a-older"]);
    expect(prompt?.options.every((option) => option.hint === undefined)).toBeTruthy();
  });

  test("swing picker sorts Sessions and ordinary worktrees by shared recency", async () => {
    const sandbox = makeTempDir("swing-picker-shared-recency");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });
    runMonke({ args: ["spawn", "managed-older"], cwd: repoRoot, monkeHome: home });
    const worktreeRoot = path.join(sandbox, "ordinary-worktrees", "ordinary-newer");
    git(repoRoot, ["branch", "ordinary-newer"]);
    git(repoRoot, ["worktree", "add", worktreeRoot, "ordinary-newer"]);
    git(worktreeRoot, ["commit", "--allow-empty", "-m", "newer"], {
      GIT_AUTHOR_DATE: "2035-01-02T00:00:00Z",
      GIT_COMMITTER_DATE: "2035-01-02T00:00:00Z"
    });
    let prompt: SelectPrompt | undefined;

    await runMonkeAsync({
      args: ["swing"],
      cwd: repoRoot,
      monkeHome: home,
      onSelect(value) {
        prompt = value;
      },
      selectValues: ["managed-older"]
    });

    expect(prompt?.options.map((option) => option.value)).toStrictEqual([
      "ordinary-newer",
      "managed-older"
    ]);
  });

  test("swing picker can select the Source checkout from a Session worktree", async () => {
    const sandbox = makeTempDir("swing-picker-source");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });
    runMonke({ args: ["spawn", "banana"], cwd: repoRoot, monkeHome: home });
    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");

    const result = await runMonkeAsync({
      args: ["swing"],
      cwd: worktreeRoot,
      monkeHome: home,
      selectValues: ["^"]
    });

    expect(result.stdout.endsWith(`${repoRoot}\n`)).toBeTruthy();
    expect(result.stderr).toContain(repoRoot);
  });

  test("swing picker omits the current target", async () => {
    const sandbox = makeTempDir("swing-picker-current-history");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });
    runMonke({ args: ["spawn", "banana"], cwd: repoRoot, monkeHome: home });
    runMonke({ args: ["spawn", "cherry"], cwd: repoRoot, monkeHome: home });
    const cherryWorktree = getExpectedWorktreePath(home, repoRoot, "cherry");
    runMonke({ args: ["swing", "banana"], cwd: repoRoot, monkeHome: home });
    runMonke({
      args: ["swing", "cherry"],
      cwd: getExpectedWorktreePath(home, repoRoot, "banana"),
      monkeHome: home
    });

    let prompt: SelectPrompt | undefined;
    const backToSource = await runMonkeAsync({
      args: ["swing"],
      cwd: cherryWorktree,
      monkeHome: home,
      onSelect(value) {
        prompt = value;
      },
      selectValues: ["^"]
    });

    expect(prompt?.options.map((option) => option.value)).toStrictEqual(["^", "banana"]);
    expect(backToSource.stdout.endsWith(`${repoRoot}\n`)).toBeTruthy();
  });

  test("swing picker rejects unknown selections", async () => {
    const sandbox = makeTempDir("swing-picker-invalid");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });
    runMonke({ args: ["spawn", "banana"], cwd: repoRoot, monkeHome: home });

    await expect(
      runMonkeAsync({
        args: ["swing"],
        cwd: repoRoot,
        monkeHome: home,
        selectValues: ["missing"]
      })
    ).rejects.toThrow(/Unknown selection: missing/u);
  });

  test("swing fails clearly when the Session does not exist", () => {
    const sandbox = makeTempDir("swing-missing");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });

    expect(() => runMonke({ args: ["swing", "missing"], cwd: repoRoot, monkeHome: home })).toThrow(
      `Worktree or Session "missing" does not exist for ${repoRoot}; mt swing only creates Session worktrees for pull request targets -- run mt spawn missing instead.`
    );
  });

  test("swing treats @ inside Session names as ordinary branch text", () => {
    const sandbox = makeTempDir("swing-at-session");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });
    runMonke({ args: ["spawn", "feature@alice"], cwd: repoRoot, monkeHome: home });

    const result = runMonke({ args: ["swing", "feature@alice"], cwd: repoRoot, monkeHome: home });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "feature@alice");
    expect(result.stdout).toBe(`${worktreeRoot}\n`);
    expect(result.stderr).toContain(`Switch to ${worktreeRoot}`);
  });

  test("swing caret returns from a Session worktree to the Source checkout", () => {
    const sandbox = makeTempDir("swing-source");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });
    runMonke({ args: ["spawn", "banana"], cwd: repoRoot, monkeHome: home });
    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");

    const result = runMonke({ args: ["swing", "^"], cwd: worktreeRoot, monkeHome: home });

    expect(result.stdout).toBe(`${repoRoot}\n`);
    expect(result.stderr).toContain(`Switch to ${repoRoot}`);
  });

  test("swing allows the current Session worktree to live outside Monke home with a warning", () => {
    const sandbox = makeTempDir("swing-external-worktree");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });
    const worktreeRoot = path.join(sandbox, "codex", "winters-echo");
    git(repoRoot, ["branch", "winters-echo"]);
    git(repoRoot, ["worktree", "add", worktreeRoot, "winters-echo"]);

    const result = runMonke({ args: ["swing", "^"], cwd: worktreeRoot, monkeHome: home });
    const backToExternal = runMonke({ args: ["swing", "-"], cwd: repoRoot, monkeHome: home });

    expect(result.stdout).toBe(`${repoRoot}\n`);
    expect(backToExternal.stdout).toBe(`${worktreeRoot}\n`);
    expect(result.stderr).toContain(
      `Linked worktree ${worktreeRoot} is outside ${path.join(home, "worktrees", "root")}`
    );
    expect(result.stderr).toContain(`Switch to ${repoRoot}`);
  });

  test("swing dash toggles to the Previous Swing target scoped by Root repo", () => {
    const sandbox = makeTempDir("swing-previous");
    const home = path.join(sandbox, "home");
    const firstRepo = createRepo(path.join(sandbox, "first"), {
      "README.md": "first\n"
    });
    const secondRepo = createRepo(path.join(sandbox, "second"), {
      "README.md": "second\n"
    });
    runMonke({ args: ["spawn", "banana"], cwd: firstRepo, monkeHome: home });
    const worktreeRoot = getExpectedWorktreePath(home, firstRepo, "banana");
    runMonke({ args: ["swing", "banana"], cwd: firstRepo, monkeHome: home });

    const backToSource = runMonke({ args: ["swing", "-"], cwd: worktreeRoot, monkeHome: home });
    const backToSession = runMonke({ args: ["swing", "-"], cwd: firstRepo, monkeHome: home });

    expect(backToSource.stdout).toBe(`${firstRepo}\n`);
    expect(backToSession.stdout).toBe(`${worktreeRoot}\n`);
    expect(() => runMonke({ args: ["swing", "-"], cwd: secondRepo, monkeHome: home })).toThrow(
      /No Previous Swing target/u
    );
  });

  test("swing rejects corrupt Previous Swing target history with its file and field path", () => {
    const sandbox = makeTempDir("swing-corrupt-history");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });
    runMonke({ args: ["spawn", "banana"], cwd: repoRoot, monkeHome: home });
    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    runMonke({ args: ["swing", "banana"], cwd: repoRoot, monkeHome: home });
    const historyDirectory = path.join(home, "swing-history");
    const [historyName] = readdirSync(historyDirectory);
    if (historyName === undefined) {
      throw new Error("expected Swing history file");
    }
    const historyPath = path.join(historyDirectory, historyName);
    writeFileSync(
      historyPath,
      `version: 1
previous:
  kind: session
`,
      "utf-8"
    );

    expect(() => runMonke({ args: ["swing", "-"], cwd: worktreeRoot, monkeHome: home })).toThrow(
      /Invalid .*swing-history.*previous\.session/su
    );
  });

  test.each([
    {
      contents: "version: 1\ntypo: true\n",
      expected: /typo/u,
      name: "unknown keys in Swing history"
    },
    {
      contents: "version: 2\n",
      expected: /version/u,
      name: "unknown future Swing history versions"
    }
  ])("swing rejects $name", ({ contents, expected }) => {
    const sandbox = makeTempDir("swing-history-versioning");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });
    const historyDirectory = path.join(home, "swing-history");
    mkdirSync(historyDirectory, { recursive: true });
    writeFileSync(path.join(historyDirectory, `${hashKey(repoRoot)}.yml`), contents, "utf-8");

    expect(() => runMonke({ args: ["swing", "-"], cwd: repoRoot, monkeHome: home })).toThrow(
      expected
    );
  });

  test("swing resolves same-repo GitHub PR numbers and URLs to existing Sessions", () => {
    const sandbox = makeTempDir("swing-pr");
    const home = path.join(sandbox, "home");
    const binDirectory = path.join(sandbox, "bin");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });
    installBareOrigin(sandbox, repoRoot);
    installSwingGhShim(binDirectory, {
      "123": {
        headRefName: "feature/pr-123",
        headRepository: { name: "root" },
        headRepositoryOwner: { login: "owner" }
      },
      "125": {
        headRefName: "feature/pr-125",
        headRepository: { name: "ROOT" },
        headRepositoryOwner: { login: "OWNER" }
      }
    });
    const openLogPath = installCodexUrlOpenShim(binDirectory);
    runMonke({ args: ["spawn", "feature/pr-123"], cwd: repoRoot, monkeHome: home });
    runMonke({ args: ["spawn", "feature/pr-125"], cwd: repoRoot, monkeHome: home });
    git(repoRoot, ["push", "origin", "refs/heads/feature/pr-123:refs/pull/123/head"]);
    git(repoRoot, ["push", "origin", "refs/heads/feature/pr-125:refs/pull/125/head"]);
    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "feature/pr-123");
    const caseFoldedWorktreeRoot = getExpectedWorktreePath(home, repoRoot, "feature/pr-125");
    const codexWorkspaceUrl = `codex://threads/new?path=${encodeURIComponent(worktreeRoot)}`;

    const byNumber = runMonke({
      args: ["swing", "pr:123"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });
    const byUrl = runMonke({
      args: ["swing", "https://github.com/owner/root/pull/123"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });
    const byCaseFoldedNumber = runMonke({
      args: ["swing", "pr:125"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });
    const byCodexPr = runMonke({
      args: ["swing", "pr:123", "--codex"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    expect(byNumber.stdout).toBe(`${worktreeRoot}\n`);
    expect(byUrl.stdout).toBe(`${worktreeRoot}\n`);
    expect(byCaseFoldedNumber.stdout).toBe(`${caseFoldedWorktreeRoot}\n`);
    expect(byCodexPr.stdout).toBe(`${worktreeRoot}\n`);
    expect(byCodexPr.stderr).toContain(`Opened Codex workspace: ${worktreeRoot}`);
    expect(readFileSync(openLogPath, "utf-8")).toBe(`${codexWorkspaceUrl}\n`);
  });

  test("swing reports malformed GitHub PR fields with the response field path", () => {
    const sandbox = makeTempDir("swing-pr-malformed");
    const home = path.join(sandbox, "home");
    const binDirectory = path.join(sandbox, "bin");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });
    installSwingGhShim(binDirectory, {
      "404": {
        headRefName: 404,
        headRepository: { name: "root" },
        headRepositoryOwner: { login: "owner" }
      }
    });

    expect(() =>
      runMonke({
        args: ["swing", "pr:404"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home
      })
    ).toThrow(/Invalid GitHub PR #404:[\s\S]*headRefName/u);
  });

  test("swing creates a missing same-repo GitHub PR Session and retains its source identity", () => {
    const sandbox = makeTempDir("swing-pr-create");
    const home = path.join(sandbox, "home");
    const binDirectory = path.join(sandbox, "bin");
    const prBranch = "feature/issue-81-flow-market-unit";
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "main\n"
    });
    installBareOrigin(sandbox, repoRoot);
    git(repoRoot, ["switch", "-c", prBranch]);
    writeFileSync(path.join(repoRoot, "README.md"), "pr head\n", "utf-8");
    mkdirSync(path.join(repoRoot, "apps/api"), { recursive: true });
    writeFileSync(path.join(repoRoot, "apps/api/.env.local"), "PORT=3000\n", "utf-8");
    writeFileSync(
      path.join(repoRoot, "monke.yml"),
      `bootstrapCommand: printf 'bootstrapped\\n' > bootstrap.log
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
      "utf-8"
    );
    git(repoRoot, ["add", "README.md"]);
    git(repoRoot, ["add", "apps/api/.env.local", "monke.yml"]);
    git(repoRoot, ["commit", "-m", "pr head"]);
    git(repoRoot, ["push", "origin", `${prBranch}:refs/pull/82/head`]);
    git(repoRoot, ["switch", "main"]);
    git(repoRoot, ["branch", "-D", prBranch]);
    installSwingGhShim(binDirectory, {
      "82": {
        headRefName: prBranch,
        headRepository: { name: "root" },
        headRepositoryOwner: { login: "owner" }
      }
    });
    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, prBranch);

    const result = runMonke({
      args: ["swing", "pr:82"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    expect(result.stdout).toBe(`${worktreeRoot}\n`);
    expect(readFileSync(path.join(worktreeRoot, "README.md"), "utf-8")).toBe("pr head\n");
    expect(readFileSync(path.join(worktreeRoot, "bootstrap.log"), "utf-8")).toBe("bootstrapped\n");
    expect(readFileSync(path.join(worktreeRoot, "apps/api/.env.local"), "utf-8")).toBe(
      "PORT=10000\n"
    );
    expect(readFileSync(path.join(worktreeRoot, ".env"), "utf-8")).toBe("API_PORT=10000\n");
    expect(result.stderr).toContain(`Bootstrapping ${repoRoot} in ${worktreeRoot}`);
    expect(result.stderr).toContain(`Spawned or updated session ${prBranch}`);
    expect(result.stderr).toContain(`Moved Swing target to ${worktreeRoot}`);
    expect(result.stderr).toContain(`Switch to ${worktreeRoot}`);
    expect(loadSessionState(home, repoRoot, prBranch).repos[0]?.diffBaseRef).toBeUndefined();

    const completed = loadSessionState(home, repoRoot, prBranch);
    expect(() => runMonke({ args: ["spawn", prBranch], cwd: repoRoot, monkeHome: home })).toThrow(
      /completed Session.*retained Session branch.*use a new Session/u
    );
    expect(loadSessionState(home, repoRoot, prBranch)).toStrictEqual(completed);
  });

  test("swing refuses to navigate to a newly prepared config-less PR Session", () => {
    const sandbox = makeTempDir("swing-pr-config-less");
    const home = path.join(sandbox, "home");
    const binDirectory = path.join(sandbox, "bin");
    const prBranch = "feature/config-less";
    const repoRoot = createTestRepo(path.join(sandbox, "root"), {
      "README.md": "main\n"
    });
    installBareOrigin(sandbox, repoRoot);
    pushReadmePullRequestHead(repoRoot, {
      branch: prBranch,
      contents: "pr head\n",
      message: "config-less pr head",
      number: 87
    });
    installSwingGhShim(binDirectory, {
      "87": {
        headRefName: prBranch,
        headRepository: { name: "root" },
        headRepositoryOwner: { login: "owner" }
      }
    });
    const openLogPath = installCodexUrlOpenShim(binDirectory);

    const result = runMonkeCapturingFailure({
      args: ["swing", "pr:87", "--codex"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, prBranch);
    expect(result.error?.message).toContain(
      "Session materialization failed after all runnable work settled."
    );
    expect(result.error?.message).toContain(`Prepared Root worktree: ${worktreeRoot}`);
    expect(result.error?.message).toContain(`Retry: mt spawn ${prBranch}`);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(`Moved Swing target to ${worktreeRoot}`);
    expect(result.stderr).not.toContain(`Opened Codex workspace: ${worktreeRoot}`);
    expect(existsSync(openLogPath)).toBeFalsy();
    expect(loadSessionState(home, repoRoot, prBranch).repos[0]).toMatchObject({
      materializationStatus: "pending",
      preparationStatus: "prepared"
    });
  });

  test("swing rejects an invalid existing PR Session path without creating the PR branch", () => {
    const sandbox = makeTempDir("swing-pr-invalid-path");
    const home = path.join(sandbox, "home");
    const binDirectory = path.join(sandbox, "bin");
    const prBranch = "feature/invalid-path";
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "main\n"
    });
    installBareOrigin(sandbox, repoRoot);
    pushReadmePullRequestHead(repoRoot, {
      branch: prBranch,
      contents: "pr head\n",
      message: "pr head",
      number: 86
    });
    installSwingGhShim(binDirectory, {
      "86": {
        headRefName: prBranch,
        headRepository: { name: "root" },
        headRepositoryOwner: { login: "owner" }
      }
    });
    mkdirSync(getExpectedWorktreePath(home, repoRoot, prBranch), { recursive: true });

    expect(() =>
      runMonke({
        args: ["swing", "pr:86"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home
      })
    ).toThrow(/not a git repository/u);
    expect(localBranchExists(repoRoot, prBranch)).toBeFalsy();
  });

  test("swing rejects an existing PR Session whose branch diverged from the PR head", () => {
    const sandbox = makeTempDir("swing-pr-stale-existing");
    const home = path.join(sandbox, "home");
    const binDirectory = path.join(sandbox, "bin");
    const prBranch = "feature/stale-existing";
    const upstreamBranch = "feature/stale-existing-upstream";
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "main\n"
    });
    installBareOrigin(sandbox, repoRoot);
    pushReadmePullRequestHead(repoRoot, {
      branch: prBranch,
      contents: "pr head\n",
      message: "pr head",
      number: 84
    });
    installSwingGhShim(binDirectory, {
      "84": {
        headRefName: prBranch,
        headRepository: { name: "root" },
        headRepositoryOwner: { login: "owner" }
      }
    });
    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, prBranch);

    runMonke({
      args: ["swing", "pr:84"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });
    const originalHead = git(worktreeRoot, ["rev-parse", "HEAD"]);
    git(repoRoot, ["switch", "-c", upstreamBranch, prBranch]);
    writeFileSync(path.join(repoRoot, "README.md"), "updated pr head\n", "utf-8");
    git(repoRoot, ["add", "README.md"]);
    git(repoRoot, ["commit", "-m", "advance pr head"]);
    git(repoRoot, ["push", "origin", `${upstreamBranch}:refs/pull/84/head`]);
    git(repoRoot, ["switch", "main"]);

    expect(() =>
      runMonke({
        args: ["swing", "pr:84"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home
      })
    ).toThrow(`Local branch "${prBranch}" differs from PR #84 head`);
    expect(git(worktreeRoot, ["rev-parse", "HEAD"])).toBe(originalHead);
    expect(readFileSync(path.join(worktreeRoot, "README.md"), "utf-8")).toBe("pr head\n");
  });

  test("swing navigates to an existing in-sync PR Session after re-fetching", () => {
    const sandbox = makeTempDir("swing-pr-existing-in-sync");
    const home = path.join(sandbox, "home");
    const binDirectory = path.join(sandbox, "bin");
    const prBranch = "feature/in-sync-pr";
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "main\n"
    });
    installBareOrigin(sandbox, repoRoot);
    pushReadmePullRequestHead(repoRoot, {
      branch: prBranch,
      contents: "pr head\n",
      message: "pr head",
      number: 85
    });
    installSwingGhShim(binDirectory, {
      "85": {
        headRefName: prBranch,
        headRepository: { name: "root" },
        headRepositoryOwner: { login: "owner" }
      }
    });
    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, prBranch);

    runMonke({
      args: ["swing", "pr:85"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });
    const secondSwing = runMonke({
      args: ["swing", "pr:85"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    expect(secondSwing.stdout).toBe(`${worktreeRoot}\n`);
    expect(secondSwing.stderr).toContain(`Moved Swing target to ${worktreeRoot}`);
  });

  test("swing rejects missing PR Session when a local PR branch diverges", () => {
    const sandbox = makeTempDir("swing-pr-stale-local");
    const home = path.join(sandbox, "home");
    const binDirectory = path.join(sandbox, "bin");
    const prBranch = "feature/stale-local";
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "main\n"
    });
    installBareOrigin(sandbox, repoRoot);
    pushReadmePullRequestHead(repoRoot, {
      branch: prBranch,
      contents: "pr head\n",
      message: "pr head",
      number: 83
    });
    git(repoRoot, ["branch", prBranch, "main"]);
    installSwingGhShim(binDirectory, {
      "83": {
        headRefName: prBranch,
        headRepository: { name: "root" },
        headRepositoryOwner: { login: "owner" }
      }
    });

    expect(() =>
      runMonke({
        args: ["swing", "pr:83"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home
      })
    ).toThrow(`Local branch "${prBranch}" differs from PR #83 head`);
    expect(existsSync(getExpectedWorktreePath(home, repoRoot, prBranch))).toBeFalsy();
  });

  test("swing --codex escapes percent-encoded URLs for the Windows launcher", () => {
    const sandbox = makeTempDir("swing-codex-windows");
    const home = path.join(sandbox, "home");
    const binDirectory = path.join(sandbox, "bin");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });
    const cmdLogPath = installWindowsCmdShim(binDirectory);
    runMonke({ args: ["spawn", "banana"], cwd: repoRoot, monkeHome: home });
    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    const codexWorkspaceUrl = `codex://threads/new?path=${encodeURIComponent(worktreeRoot)}`;

    const result = withPlatform("win32", () =>
      runMonke({
        args: ["swing", "banana", "--codex"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home
      })
    );

    expect(result.stdout).toBe(`${worktreeRoot}\n`);
    expect(result.stderr).toContain(`Opened Codex workspace: ${worktreeRoot}`);
    expect(readFileSync(cmdLogPath, "utf-8")).toBe(
      `/c\nstart\n\n${codexWorkspaceUrl.replaceAll("%", "^%")}\n`
    );
  });

  test("swing rejects unsupported PR and target forms clearly", () => {
    const sandbox = makeTempDir("swing-unsupported");
    const home = path.join(sandbox, "home");
    const binDirectory = path.join(sandbox, "bin");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "README.md": "hello\n"
    });
    installSwingGhShim(binDirectory, {
      "124": {
        headRefName: "fork/pr-124",
        headRepository: { name: "root" },
        headRepositoryOwner: { login: "contributor" }
      }
    });

    expect(() =>
      runMonke({ args: ["swing", "pr:124"], binDirectory, cwd: repoRoot, monkeHome: home })
    ).toThrow(/Fork PR targets are not supported/u);
    expect(() =>
      runMonke({
        args: ["swing", "https://github.com/other/root/pull/124"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home
      })
    ).toThrow(/Cross-repo PR URLs are not supported/u);
    expect(() => runMonke({ args: ["swing", "mr:12"], cwd: repoRoot, monkeHome: home })).toThrow(
      /Merge request Swing targets are out of scope/u
    );
    expect(() => runMonke({ args: ["swing", "@"], cwd: repoRoot, monkeHome: home })).toThrow(
      /@ Swing targets are not supported/u
    );
  });
});

function createRepo(root: string, files: Record<string, string>) {
  return createTestRepo(root, { "monke.yml": "apps: {}\n", ...files });
}

function installBareOrigin(sandbox: string, repoRoot: string) {
  const originRoot = path.join(sandbox, "origin.git");
  mkdirSync(originRoot, { recursive: true });
  git(originRoot, ["init", "--bare"]);
  git(repoRoot, ["remote", "add", "origin", originRoot]);
}

function pushReadmePullRequestHead(
  repoRoot: string,
  options: {
    branch: string;
    contents: string;
    message: string;
    number: number;
  }
) {
  git(repoRoot, ["switch", "-c", options.branch]);
  writeFileSync(path.join(repoRoot, "README.md"), options.contents, "utf-8");
  git(repoRoot, ["add", "README.md"]);
  git(repoRoot, ["commit", "-m", options.message]);
  git(repoRoot, ["push", "origin", `${options.branch}:refs/pull/${options.number}/head`]);
  git(repoRoot, ["switch", "main"]);
  git(repoRoot, ["branch", "-D", options.branch]);
}

function localBranchExists(repoRoot: string, branch: string) {
  try {
    git(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

interface SwingGhResponse {
  headRefName: number | string;
  headRepository: { name: string } | null;
  headRepositoryOwner: { login: string } | null;
}

function installSwingGhShim(binDirectory: string, prs: Record<string, SwingGhResponse>) {
  mkdirSync(binDirectory, { recursive: true });
  const cases = Object.entries(prs)
    .map(([number, pr]) => `    ${number}) printf '%s\\n' '${JSON.stringify(pr)}'; exit 0 ;;`)
    .join("\n");
  const script = `#!/bin/sh
set -eu
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  printf '%s\\n' '{"nameWithOwner":"owner/root"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  case "$3" in
${cases}
  esac
fi
echo "unsupported gh invocation: $*" >&2
exit 1
`;
  const targetPath = path.join(binDirectory, "gh");
  writeFileSync(targetPath, script, "utf-8");
  chmodSync(targetPath, 0o755);
}
