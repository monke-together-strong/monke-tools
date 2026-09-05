import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { getExpectedWorktreePath } from "../src/git.ts";
import { loadSessionState, saveSessionState } from "../src/session-state-store.ts";
import { SessionStateSchema } from "../src/state-schema.ts";
import type { SelectPrompt } from "../src/types.ts";
import {
  completeSessionState,
  createConfiguredRepo as createRepo,
  git,
  installBrewShim,
  installFakeCodiff,
  installGitShim,
  makeTempDir,
  materializedRepoState,
  readSingleYamlFile,
  runMonke,
  runMonkeAsync
} from "./helpers.ts";

describe("Diff", () => {
  test("diff verifies the official Codiff CLI before showing a picker", async () => {
    const sandbox = makeTempDir("diff-missing-codiff");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    installGitShim(binDirectory);
    let prompt: SelectPrompt | undefined;

    await expect(
      runMonkeAsync({
        args: ["diff"],
        cwd: repoRoot,
        extraEnv: { PATH: binDirectory },
        monkeHome: home,
        onSelect(value) {
          prompt = value;
        }
      })
    ).rejects.toThrow(
      "Codiff 1.9.0 or newer is required. Install it with: brew install --cask --require-sha nkzw-tech/tap/codiff"
    );
    expect(prompt).toBeUndefined();
  });

  test.each([
    {
      expected:
        "Codiff 1.9.0 or newer is required; found 1.8.9. Upgrade it with: brew upgrade --cask nkzw-tech/tap/codiff",
      name: "an old Codiff version",
      version: "codiff v1.8.9"
    },
    {
      expected:
        "Codiff 1.9.0 or newer is required. Install it with: brew install --cask --require-sha nkzw-tech/tap/codiff",
      name: "an unrelated executable",
      version: "different v9.0.0"
    },
    {
      expected:
        "Codiff 1.9.0 or newer is required. Install it with: brew install --cask --require-sha nkzw-tech/tap/codiff",
      name: "malformed version output",
      version: "codiff banana"
    }
  ])("diff rejects $name before interaction", async ({ expected, version }) => {
    const sandbox = makeTempDir("diff-codiff-version");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    installFakeCodiff(binDirectory, { version });
    let prompt: SelectPrompt | undefined;

    await expect(
      runMonkeAsync({
        args: ["diff"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home,
        onSelect(value) {
          prompt = value;
        }
      })
    ).rejects.toThrow(expected);
    expect(prompt).toBeUndefined();
  });

  test("diff accepts Codiff versions newer than the minimum", async () => {
    const sandbox = makeTempDir("diff-new-codiff");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    installFakeCodiff(binDirectory, { version: "codiff v2.4.1" });

    const result = await runMonkeAsync({
      args: ["diff"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    expect(result.stdout).toBe("No Diff base or local changes found for root.\n");
  });

  test("Diff overlaps Codiff verification with repository and candidate discovery", async () => {
    const sandbox = makeTempDir("diff-concurrent-startup");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    const codiffStarted = path.join(sandbox, "codiff-started");
    const discoveryReached = path.join(sandbox, "discovery-reached");
    installFakeCodiff(binDirectory, {
      versionCoordination: { discovery: discoveryReached, started: codiffStarted }
    });
    installGitShim(binDirectory, {
      afterCommand: {
        args: "rev-parse --path-format=absolute --show-toplevel",
        cwd: repoRoot,
        script: `count=0
while [ ! -f "${codiffStarted}" ]; do
  count=$((count + 1))
  [ "$count" -lt 200 ] || exit 92
  /bin/sleep 0.01
done
touch "${discoveryReached}"`
      }
    });

    const result = await runMonkeAsync({
      args: ["diff"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home
    });

    expect(result.stdout).toBe("No Diff base or local changes found for root.\n");
    expect(existsSync(codiffStarted)).toBeTruthy();
    expect(existsSync(discoveryReached)).toBeTruthy();
  });

  test("diff rejects positional targets and unsupported options", async () => {
    const sandbox = makeTempDir("diff-cli-shape");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });

    await expect(
      runMonkeAsync({ args: ["diff", "main"], cwd: repoRoot, monkeHome: home })
    ).rejects.toThrow(/too many arguments/u);
    await expect(
      runMonkeAsync({ args: ["diff", "--against", "main"], cwd: repoRoot, monkeHome: home })
    ).rejects.toThrow(/unknown option '--against'/u);
  });

  test("fresh attached Spawn records its full source ref and plain diff launches it from a nested directory", async () => {
    const sandbox = makeTempDir("diff-remembered-base");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    runMonke({ args: ["spawn", "banana"], cwd: repoRoot, monkeHome: home });
    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
    const nestedDirectory = path.join(worktreeRoot, "packages", "app");
    mkdirSync(nestedDirectory, { recursive: true });
    const codiffLog = installFakeCodiff(binDirectory);

    const state = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    expect(state.repos[0]?.diffBaseRef).toBe("refs/heads/main");

    await runMonkeAsync({
      args: ["diff"],
      binDirectory,
      cwd: nestedDirectory,
      monkeHome: home
    });

    expect(readFileSync(codiffLog, "utf-8")).toBe(`--branch\nrefs/heads/main\n${worktreeRoot}\n`);
  });

  test("plain Diff follows its remembered source branch after the Session is rebased onto its advanced tip", async () => {
    const sandbox = makeTempDir("diff-rebased-remembered-base");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");

    writeFileSync(path.join(sessionWorktree, "feature.txt"), "feature\n", "utf-8");
    git(sessionWorktree, ["add", "feature.txt"]);
    git(sessionWorktree, ["commit", "-m", "feature"]);
    writeFileSync(path.join(repoRoot, "upstream.txt"), "upstream\n", "utf-8");
    git(repoRoot, ["add", "upstream.txt"]);
    git(repoRoot, ["commit", "-m", "upstream"]);
    git(sessionWorktree, ["rebase", "main"]);

    const mainHead = git(repoRoot, ["rev-parse", "refs/heads/main"]);
    expect(git(sessionWorktree, ["merge-base", "refs/heads/main", "HEAD"])).toBe(mainHead);
    const codiffLog = installFakeCodiff(binDirectory);

    await runMonkeAsync({
      args: ["diff"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home
    });

    expect(readFileSync(codiffLog, "utf-8")).toBe(
      `--branch\nrefs/heads/main\n${sessionWorktree}\n`
    );
    expect(loadSessionState(home, repoRoot, "session").repos[0]?.diffBaseRef).toBe(
      "refs/heads/main"
    );
  });

  test("plain Diff infers main for an adopted Session rebased onto its advanced tip", async () => {
    const sandbox = makeTempDir("diff-rebased-adopted-session");
    const binDirectory = path.join(sandbox, "bin");
    const failingBinDirectory = path.join(sandbox, "failing-bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    git(repoRoot, ["branch", "session"]);
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");
    expect(loadSessionState(home, repoRoot, "session").repos[0]?.diffBaseRef).toBeUndefined();

    writeFileSync(path.join(sessionWorktree, "feature.txt"), "feature\n", "utf-8");
    git(sessionWorktree, ["add", "feature.txt"]);
    git(sessionWorktree, ["commit", "-m", "feature"]);
    writeFileSync(path.join(repoRoot, "upstream.txt"), "upstream\n", "utf-8");
    git(repoRoot, ["add", "upstream.txt"]);
    git(repoRoot, ["commit", "-m", "upstream"]);
    git(sessionWorktree, ["rebase", "main"]);

    installFakeCodiff(failingBinDirectory, { exitCode: 23 });
    await expect(
      runMonkeAsync({
        args: ["diff"],
        binDirectory: failingBinDirectory,
        cwd: sessionWorktree,
        monkeHome: home
      })
    ).rejects.toThrow("Codiff launch failed with exit code 23");
    expect(loadSessionState(home, repoRoot, "session").repos[0]?.diffBaseRef).toBeUndefined();

    const codiffLog = installFakeCodiff(binDirectory);
    let prompt: SelectPrompt | undefined;

    await runMonkeAsync({
      args: ["diff"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home,
      onSelect(value) {
        prompt = value;
      },
      selectValues: ["local"]
    });

    expect(prompt).toBeUndefined();
    expect(readFileSync(codiffLog, "utf-8")).toBe(
      `--branch\nrefs/heads/main\n${sessionWorktree}\n`
    );
    expect(loadSessionState(home, repoRoot, "session").repos[0]?.diffBaseRef).toBe(
      "refs/heads/main"
    );
  });

  test("plain Diff does not infer a base outside a Session", async () => {
    const sandbox = makeTempDir("diff-source-without-base");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    git(repoRoot, ["switch", "-c", "feature"]);
    git(repoRoot, ["commit", "--allow-empty", "-m", "feature"]);
    git(repoRoot, ["worktree", "add", path.join(sandbox, "main-worktree"), "main"]);
    const codiffLog = installFakeCodiff(binDirectory);
    let prompt: SelectPrompt | undefined;

    await runMonkeAsync({
      args: ["diff"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
      onSelect(value) {
        prompt = value;
      },
      selectValues: ["local"]
    });

    expect(prompt?.message).toBe("Diff base");
    expect(existsSync(codiffLog)).toBeFalsy();
  });

  test("plain Diff does not infer a default branch at the current checkout tip", async () => {
    const sandbox = makeTempDir("diff-default-tip");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    git(repoRoot, ["switch", "-c", "feature"]);
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "main");
    git(repoRoot, ["worktree", "add", sessionWorktree, "main"]);
    git(repoRoot, ["commit", "--allow-empty", "-m", "remote-main"]);
    git(repoRoot, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    saveSessionState(
      home,
      completeSessionState({
        repos: [
          materializedRepoState({
            sourceRoot: repoRoot,
            worktreePath: sessionWorktree
          })
        ],
        rootSourceRoot: repoRoot,
        session: "main"
      })
    );
    const codiffLog = installFakeCodiff(binDirectory);
    let prompt: SelectPrompt | undefined;

    await runMonkeAsync({
      args: ["diff"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home,
      onSelect(value) {
        prompt = value;
      },
      selectValues: ["local"]
    });

    expect(prompt?.message).toBe("Diff base");
    expect(existsSync(codiffLog)).toBeFalsy();
    expect(loadSessionState(home, repoRoot, "main").repos[0]?.diffBaseRef).toBeUndefined();
  });

  test("plain Diff does not infer a default branch from unrelated history", async () => {
    const sandbox = makeTempDir("diff-unrelated-default");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    const tree = git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
    const unrelated = git(repoRoot, ["commit-tree", tree, "-m", "unrelated"]);
    git(repoRoot, ["branch", "session", unrelated]);
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");
    const codiffLog = installFakeCodiff(binDirectory);
    let prompt: SelectPrompt | undefined;

    await runMonkeAsync({
      args: ["diff"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home,
      onSelect(value) {
        prompt = value;
      },
      selectValues: ["local"]
    });

    expect(prompt?.message).toBe("Diff base");
    expect(existsSync(codiffLog)).toBeFalsy();
    expect(loadSessionState(home, repoRoot, "session").repos[0]?.diffBaseRef).toBeUndefined();
  });

  test("plain Diff does not infer main for a Session stacked on another branch", async () => {
    const sandbox = makeTempDir("diff-stacked-session");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    git(repoRoot, ["switch", "-c", "parent"]);
    git(repoRoot, ["commit", "--allow-empty", "-m", "parent"]);
    git(repoRoot, ["branch", "session"]);
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");
    git(sessionWorktree, ["commit", "--allow-empty", "-m", "feature"]);
    const codiffLog = installFakeCodiff(binDirectory);
    let prompt: SelectPrompt | undefined;

    await runMonkeAsync({
      args: ["diff"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home,
      onSelect(value) {
        prompt = value;
      },
      selectValues: ["local"]
    });

    expect(prompt?.message).toBe("Diff base");
    expect(existsSync(codiffLog)).toBeFalsy();
    expect(loadSessionState(home, repoRoot, "session").repos[0]?.diffBaseRef).toBeUndefined();
  });

  test("plain Diff does not infer a default branch with multiple best merge bases", async () => {
    const sandbox = makeTempDir("diff-ambiguous-initial-default");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    git(repoRoot, ["branch", "session"]);
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");
    writeFileSync(path.join(repoRoot, "main.txt"), "main\n", "utf-8");
    git(repoRoot, ["add", "main.txt"]);
    git(repoRoot, ["commit", "-m", "main-side"]);
    const mainSide = git(repoRoot, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(sessionWorktree, "session.txt"), "session\n", "utf-8");
    git(sessionWorktree, ["add", "session.txt"]);
    git(sessionWorktree, ["commit", "-m", "session-side"]);
    const sessionSide = git(sessionWorktree, ["rev-parse", "HEAD"]);
    git(repoRoot, ["merge", sessionSide, "-m", "main-merge"]);
    git(sessionWorktree, ["merge", mainSide, "-m", "session-merge"]);
    expect(git(sessionWorktree, ["merge-base", "--all", "main", "HEAD"]).split("\n")).toHaveLength(
      2
    );
    const codiffLog = installFakeCodiff(binDirectory);
    let prompt: SelectPrompt | undefined;

    await runMonkeAsync({
      args: ["diff"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home,
      onSelect(value) {
        prompt = value;
      },
      selectValues: ["local"]
    });

    expect(prompt?.message).toBe("Diff base");
    expect(existsSync(codiffLog)).toBeFalsy();
    expect(loadSessionState(home, repoRoot, "session").repos[0]?.diffBaseRef).toBeUndefined();
  });

  test("forced Diff picker does not infer a base for an adopted Session", async () => {
    const sandbox = makeTempDir("diff-forced-picker-without-base");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    git(repoRoot, ["branch", "session"]);
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");
    writeFileSync(path.join(sessionWorktree, "feature.txt"), "feature\n", "utf-8");
    git(sessionWorktree, ["add", "feature.txt"]);
    git(sessionWorktree, ["commit", "-m", "feature"]);
    const codiffLog = installFakeCodiff(binDirectory);
    let prompt: SelectPrompt | undefined;

    await runMonkeAsync({
      args: ["diff", "--pick"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home,
      onSelect(value) {
        prompt = value;
      },
      selectValues: ["local"]
    });

    expect(prompt?.message).toBe("Diff base");
    expect(existsSync(codiffLog)).toBeFalsy();
    expect(loadSessionState(home, repoRoot, "session").repos[0]?.diffBaseRef).toBeUndefined();
  });

  test("Diff warns when a Session branch is checked out somewhere else", async () => {
    const sandbox = makeTempDir("diff-swapped-session-branch");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    git(repoRoot, ["branch", "session"]);
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");
    writeFileSync(path.join(sessionWorktree, "feature.txt"), "feature\n", "utf-8");
    git(sessionWorktree, ["add", "feature.txt"]);
    git(sessionWorktree, ["commit", "-m", "feature"]);
    git(sessionWorktree, ["switch", "--detach"]);
    git(repoRoot, ["switch", "session"]);
    git(sessionWorktree, ["switch", "main"]);
    installFakeCodiff(binDirectory);

    const result = await runMonkeAsync({
      args: ["diff", "--pick"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home,
      selectValues: ["local"]
    });

    expect(result.stderr).toContain(
      `Warning: Session session worktree ${sessionWorktree} is on branch main instead of session; branch session is checked out at ${repoRoot}. Diff reviews the current checkout only.`
    );
  });

  test("plain Diff replaces a stale remembered base after the Session is rebased onto newer upstream default-branch history", async () => {
    const sandbox = makeTempDir("diff-rebased-new-default-base");
    const binDirectory = path.join(sandbox, "bin");
    const failingBinDirectory = path.join(sandbox, "failing-bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    git(repoRoot, ["switch", "-c", "source-base"]);
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");

    writeFileSync(path.join(sessionWorktree, "feature.txt"), "feature\n", "utf-8");
    git(sessionWorktree, ["add", "feature.txt"]);
    git(sessionWorktree, ["commit", "-m", "feature"]);
    git(repoRoot, ["switch", "-c", "upstream-line", "main"]);
    writeFileSync(path.join(repoRoot, "upstream-before.txt"), "upstream before rebase\n", "utf-8");
    git(repoRoot, ["add", "upstream-before.txt"]);
    git(repoRoot, ["commit", "-m", "upstream-before"]);
    git(repoRoot, ["update-ref", "refs/remotes/upstream/master", "HEAD"]);
    git(sessionWorktree, ["rebase", "refs/remotes/upstream/master"]);
    writeFileSync(path.join(repoRoot, "upstream-after.txt"), "upstream after rebase\n", "utf-8");
    git(repoRoot, ["add", "upstream-after.txt"]);
    git(repoRoot, ["commit", "-m", "upstream-after"]);
    git(repoRoot, ["update-ref", "refs/remotes/upstream/master", "HEAD"]);

    installFakeCodiff(failingBinDirectory, { exitCode: 23 });
    await expect(
      runMonkeAsync({
        args: ["diff"],
        binDirectory: failingBinDirectory,
        cwd: sessionWorktree,
        monkeHome: home
      })
    ).rejects.toThrow("Codiff launch failed with exit code 23");
    expect(loadSessionState(home, repoRoot, "session").repos[0]?.diffBaseRef).toBe(
      "refs/heads/source-base"
    );

    const codiffLog = installFakeCodiff(binDirectory);
    await runMonkeAsync({
      args: ["diff"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home
    });

    expect(readFileSync(codiffLog, "utf-8")).toBe(
      `--branch\nrefs/remotes/upstream/master\n${sessionWorktree}\n`
    );
    expect(loadSessionState(home, repoRoot, "session").repos[0]?.diffBaseRef).toBe(
      "refs/remotes/upstream/master"
    );
  });

  test("plain Diff preserves its remembered base when the default branch has no newer shared history", async () => {
    const sandbox = makeTempDir("diff-equal-default-merge-base");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    git(repoRoot, ["switch", "-c", "source-base"]);
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");
    writeFileSync(path.join(sessionWorktree, "feature.txt"), "feature\n", "utf-8");
    git(sessionWorktree, ["add", "feature.txt"]);
    git(sessionWorktree, ["commit", "-m", "feature"]);
    git(repoRoot, ["switch", "main"]);
    writeFileSync(path.join(repoRoot, "upstream.txt"), "not in the Session\n", "utf-8");
    git(repoRoot, ["add", "upstream.txt"]);
    git(repoRoot, ["commit", "-m", "upstream"]);
    const codiffLog = installFakeCodiff(binDirectory);

    await runMonkeAsync({
      args: ["diff"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home
    });

    expect(readFileSync(codiffLog, "utf-8")).toBe(
      `--branch\nrefs/heads/source-base\n${sessionWorktree}\n`
    );
    expect(loadSessionState(home, repoRoot, "session").repos[0]?.diffBaseRef).toBe(
      "refs/heads/source-base"
    );
  });

  test("plain Diff preserves its remembered base when default-branch history is incomparable", async () => {
    const sandbox = makeTempDir("diff-incomparable-default-merge-base");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    git(repoRoot, ["switch", "-c", "source-base"]);
    writeFileSync(path.join(repoRoot, "parent.txt"), "parent feature\n", "utf-8");
    git(repoRoot, ["add", "parent.txt"]);
    git(repoRoot, ["commit", "-m", "parent-feature"]);
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");
    writeFileSync(path.join(sessionWorktree, "feature.txt"), "session feature\n", "utf-8");
    git(sessionWorktree, ["add", "feature.txt"]);
    git(sessionWorktree, ["commit", "-m", "session-feature"]);
    git(repoRoot, ["switch", "main"]);
    writeFileSync(path.join(repoRoot, "upstream.txt"), "upstream\n", "utf-8");
    git(repoRoot, ["add", "upstream.txt"]);
    git(repoRoot, ["commit", "-m", "upstream"]);
    git(sessionWorktree, ["merge", "main", "-m", "merge-main"]);
    const codiffLog = installFakeCodiff(binDirectory);

    await runMonkeAsync({
      args: ["diff"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home
    });

    expect(readFileSync(codiffLog, "utf-8")).toBe(
      `--branch\nrefs/heads/source-base\n${sessionWorktree}\n`
    );
    expect(loadSessionState(home, repoRoot, "session").repos[0]?.diffBaseRef).toBe(
      "refs/heads/source-base"
    );
  });

  test("plain Diff preserves its remembered base when default-branch history has multiple best merge bases", async () => {
    const sandbox = makeTempDir("diff-ambiguous-default-merge-base");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    git(repoRoot, ["switch", "-c", "source-base"]);
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");
    git(repoRoot, ["switch", "main"]);
    writeFileSync(path.join(repoRoot, "main.txt"), "main\n", "utf-8");
    git(repoRoot, ["add", "main.txt"]);
    git(repoRoot, ["commit", "-m", "main-side"]);
    const mainSide = git(repoRoot, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(sessionWorktree, "session.txt"), "session\n", "utf-8");
    git(sessionWorktree, ["add", "session.txt"]);
    git(sessionWorktree, ["commit", "-m", "session-side"]);
    const sessionSide = git(sessionWorktree, ["rev-parse", "HEAD"]);
    git(repoRoot, ["merge", sessionSide, "-m", "main-merge"]);
    git(sessionWorktree, ["merge", mainSide, "-m", "session-merge"]);
    git(repoRoot, ["branch", "master", mainSide]);
    expect(git(sessionWorktree, ["merge-base", "--all", "main", "HEAD"]).split("\n")).toHaveLength(
      2
    );
    expect(git(sessionWorktree, ["merge-base", "--all", "master", "HEAD"])).toBe(mainSide);
    const codiffLog = installFakeCodiff(binDirectory);

    await runMonkeAsync({
      args: ["diff"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home
    });

    expect(readFileSync(codiffLog, "utf-8")).toBe(
      `--branch\nrefs/heads/source-base\n${sessionWorktree}\n`
    );
    expect(loadSessionState(home, repoRoot, "session").repos[0]?.diffBaseRef).toBe(
      "refs/heads/source-base"
    );
  });

  test("forced Diff picker preserves local target ordering and launches the selected committed branch", async () => {
    const sandbox = makeTempDir("diff-picker-order");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    runMonke({ args: ["spawn", "managed-older"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "managed-older");
    const ordinaryWorktree = path.join(sandbox, "ordinary-worktrees", "ordinary-newer");
    git(repoRoot, ["branch", "ordinary-newer"]);
    git(repoRoot, ["worktree", "add", ordinaryWorktree, "ordinary-newer"]);
    git(ordinaryWorktree, ["commit", "--allow-empty", "-m", "newer"], {
      GIT_AUTHOR_DATE: "2035-01-02T00:00:00Z",
      GIT_COMMITTER_DATE: "2035-01-02T00:00:00Z"
    });
    const codiffLog = installFakeCodiff(binDirectory);
    let prompt: SelectPrompt | undefined;

    await runMonkeAsync({
      args: ["diff", "--pick"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
      onSelect(value) {
        prompt = value;
      },
      selectValues: [`worktree:${sessionWorktree}`]
    });

    expect(prompt?.message).toBe("Diff base");
    expect(prompt?.options.map((option) => option.label)).toStrictEqual([
      "ordinary-newer (committed branch base)",
      "managed-older (committed branch base)",
      "Local changes only"
    ]);
    expect(readFileSync(codiffLog, "utf-8")).toBe(
      `--branch\nrefs/heads/managed-older\n${repoRoot}\n`
    );
  });

  test("a Session picker combines target kinds in Swing order and persists only its selected Session", async () => {
    const sandbox = makeTempDir("diff-picker-persist");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    runMonke({ args: ["spawn", "base-session"], cwd: repoRoot, monkeHome: home });
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");
    const baseWorktree = getExpectedWorktreePath(home, repoRoot, "base-session");
    const ordinaryWorktree = path.join(sandbox, "ordinary-worktrees", "ordinary-newer");
    git(repoRoot, ["branch", "ordinary-newer"]);
    git(repoRoot, ["worktree", "add", ordinaryWorktree, "ordinary-newer"]);
    git(ordinaryWorktree, ["commit", "--allow-empty", "-m", "newer"], {
      GIT_AUTHOR_DATE: "2035-01-02T00:00:00Z",
      GIT_COMMITTER_DATE: "2035-01-02T00:00:00Z"
    });
    const codiffLog = installFakeCodiff(binDirectory);
    let prompt: SelectPrompt | undefined;

    await runMonkeAsync({
      args: ["diff", "-p"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home,
      onSelect(value) {
        prompt = value;
      },
      selectValues: [`worktree:${baseWorktree}`]
    });

    expect(prompt?.options.map((option) => option.label)).toStrictEqual([
      "refs/heads/main (current Diff base)",
      "Source checkout: main (committed branch base)",
      "ordinary-newer (committed branch base)",
      "base-session (committed branch base)",
      "Local changes only"
    ]);
    expect(readFileSync(codiffLog, "utf-8")).toBe(
      `--branch\nrefs/heads/base-session\n${sessionWorktree}\n`
    );
    const currentState = loadSessionState(home, repoRoot, "session");
    expect(currentState.repos[0]?.diffBaseRef).toBe("refs/heads/base-session");
  });

  test("Source, Ordinary, and local-only selections never replace a Session Diff base", async () => {
    const sandbox = makeTempDir("diff-non-session-persistence");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    git(repoRoot, ["branch", "original-base"]);
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");
    const ordinaryWorktree = path.join(sandbox, "ordinary-worktrees", "ordinary");
    git(repoRoot, ["branch", "ordinary"]);
    git(repoRoot, ["worktree", "add", ordinaryWorktree, "ordinary"]);
    const state = loadSessionState(home, repoRoot, "session");
    saveSessionState(home, {
      ...state,
      repos: state.repos.map((repo) => ({ ...repo, diffBaseRef: "refs/heads/original-base" }))
    });
    installFakeCodiff(binDirectory);

    for (const selection of [`worktree:${repoRoot}`, `worktree:${ordinaryWorktree}`]) {
      await runMonkeAsync({
        args: ["diff", "--pick"],
        binDirectory,
        cwd: sessionWorktree,
        monkeHome: home,
        selectValues: [selection]
      });
      expect(loadSessionState(home, repoRoot, "session").repos[0]?.diffBaseRef).toBe(
        "refs/heads/original-base"
      );
    }

    writeFileSync(path.join(sessionWorktree, "dirty.txt"), "change\n", "utf-8");
    await runMonkeAsync({
      args: ["diff", "--pick"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home,
      selectValues: ["local"]
    });
    expect(loadSessionState(home, repoRoot, "session").repos[0]?.diffBaseRef).toBe(
      "refs/heads/original-base"
    );
  });

  test("cancelling the standard Diff picker launches nothing and preserves Session state", async () => {
    const sandbox = makeTempDir("diff-cancel");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");
    const codiffLog = installFakeCodiff(binDirectory);

    await expect(
      runMonkeAsync({
        args: ["diff", "--pick"],
        binDirectory,
        cancelSelect: true,
        cwd: sessionWorktree,
        monkeHome: home
      })
    ).rejects.toThrow("Diff base cancelled");
    expect(existsSync(codiffLog)).toBeFalsy();
    expect(loadSessionState(home, repoRoot, "session").repos[0]?.diffBaseRef).toBe(
      "refs/heads/main"
    );
  });

  test("Diff from an Ordinary worktree stays in that checkout and performs no workflow side effects", async () => {
    const sandbox = makeTempDir("diff-ordinary-current");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    const ordinaryWorktree = path.join(sandbox, "ordinary-worktrees", "ordinary");
    git(repoRoot, ["branch", "ordinary"]);
    git(repoRoot, ["worktree", "add", ordinaryWorktree, "ordinary"]);
    writeFileSync(path.join(ordinaryWorktree, "dirty.txt"), "change\n", "utf-8");
    const codiffLog = installFakeCodiff(binDirectory);
    const brewLog = installBrewShim(binDirectory);
    const gitLog = installGitShim(binDirectory);
    const shellDirective = path.join(sandbox, "shell-directive");

    await runMonkeAsync({
      args: ["diff", "--pick"],
      binDirectory,
      cwd: ordinaryWorktree,
      extraEnv: { MONKE_SHELL_DIR_DIRECTIVE: shellDirective },
      monkeHome: home,
      selectValues: ["local"]
    });

    expect(readFileSync(codiffLog, "utf-8")).toBe(`${ordinaryWorktree}\n`);
    expect(existsSync(brewLog)).toBeFalsy();
    expect(existsSync(shellDirective)).toBeFalsy();
    expect(existsSync(path.join(home, "swing-history"))).toBeFalsy();
    expect(
      readFileSync(gitLog, "utf-8")
        .split("\n")
        .some((line) => line.startsWith("fetch"))
    ).toBeFalsy();
  });

  test("plain and forced remembered Diff warn when the attached base has local changes", async () => {
    const sandbox = makeTempDir("diff-dirty-remembered");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");
    writeFileSync(path.join(repoRoot, "dirty.txt"), "change\n", "utf-8");
    installFakeCodiff(binDirectory);

    const result = await runMonkeAsync({
      args: ["diff"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home
    });

    expect(result.stderr).toContain(
      "Warning: main has local changes; Diff uses its committed branch state only."
    );

    const forced = await runMonkeAsync({
      args: ["diff", "--pick"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home,
      selectValues: ["remembered:refs/heads/main"]
    });
    expect(forced.stderr).toContain(
      "Warning: main has local changes; Diff uses its committed branch state only."
    );
  });

  test("remembered Diff still launches when its base worktree is removed while picking", async () => {
    const sandbox = makeTempDir("diff-remembered-worktree-race");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");
    const baseWorktree = path.join(sandbox, "ordinary-worktrees", "base");
    git(repoRoot, ["worktree", "add", "-b", "base", baseWorktree]);
    const state = loadSessionState(home, repoRoot, "session");
    saveSessionState(home, {
      ...state,
      repos: state.repos.map((repo) => ({ ...repo, diffBaseRef: "refs/heads/base" }))
    });
    const codiffLog = installFakeCodiff(binDirectory);

    await runMonkeAsync({
      args: ["diff", "--pick"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home,
      onSelect() {
        git(repoRoot, ["worktree", "remove", baseWorktree]);
      },
      selectValues: ["remembered:refs/heads/base"]
    });

    expect(readFileSync(codiffLog, "utf-8")).toBe(
      `--branch\nrefs/heads/base\n${sessionWorktree}\n`
    );
    expect(loadSessionState(home, repoRoot, "session").repos[0]?.diffBaseRef).toBe(
      "refs/heads/base"
    );
  });

  test("local-only Diff skips a meaningless picker and avoids an empty Codiff window", async () => {
    const sandbox = makeTempDir("diff-local-only");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    const codiffLog = installFakeCodiff(binDirectory);
    let prompt: SelectPrompt | undefined;

    const clean = await runMonkeAsync({
      args: ["diff"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
      onSelect(value) {
        prompt = value;
      }
    });

    expect(clean.stdout).toBe("No Diff base or local changes found for root.\n");
    expect(prompt).toBeUndefined();
    expect(existsSync(codiffLog)).toBeFalsy();

    writeFileSync(path.join(repoRoot, "untracked.txt"), "change\n", "utf-8");
    await runMonkeAsync({ args: ["diff"], binDirectory, cwd: repoRoot, monkeHome: home });
    expect(readFileSync(codiffLog, "utf-8")).toBe(`${repoRoot}\n`);
  });

  test("a deleted remembered ref falls back to the picker without clearing Session state", async () => {
    const sandbox = makeTempDir("diff-invalid-remembered");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    git(repoRoot, ["branch", "deleted-base"]);
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    git(repoRoot, ["branch", "-D", "deleted-base"]);
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");
    const state = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    saveSessionState(home, {
      ...state,
      repos: state.repos.map((repo) => ({ ...repo, diffBaseRef: "refs/heads/deleted-base" }))
    });
    installFakeCodiff(binDirectory);
    let prompt: SelectPrompt | undefined;

    await runMonkeAsync({
      args: ["diff"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home,
      onSelect(value) {
        prompt = value;
      },
      selectValues: ["local"]
    });

    expect(prompt?.options[0]?.label).toBe("refs/heads/deleted-base (current Diff base)");
    const unchanged = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    expect(unchanged.repos[0]?.diffBaseRef).toBe("refs/heads/deleted-base");
  });

  test("a remembered ref with no merge base falls back without mutating Session state", async () => {
    const sandbox = makeTempDir("diff-unrelated-remembered");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    git(repoRoot, ["switch", "--orphan", "unrelated"]);
    writeFileSync(path.join(repoRoot, "unrelated.txt"), "unrelated\n", "utf-8");
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-m", "unrelated"]);
    git(repoRoot, ["switch", "main"]);
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");
    const state = loadSessionState(home, repoRoot, "session");
    saveSessionState(home, {
      ...state,
      repos: state.repos.map((repo) => ({ ...repo, diffBaseRef: "refs/heads/unrelated" }))
    });
    installFakeCodiff(binDirectory);
    let prompt: SelectPrompt | undefined;

    await runMonkeAsync({
      args: ["diff"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home,
      onSelect(value) {
        prompt = value;
      },
      selectValues: ["local"]
    });

    expect(prompt?.options[0]?.label).toBe("refs/heads/unrelated (current Diff base)");
    expect(loadSessionState(home, repoRoot, "session").repos[0]?.diffBaseRef).toBe(
      "refs/heads/unrelated"
    );
  });

  test("a failed Codiff launch leaves the remembered Session base unchanged", async () => {
    const sandbox = makeTempDir("diff-launch-failure");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");
    const baseWorktree = path.join(sandbox, "ordinary-worktrees", "failed-base");
    git(repoRoot, ["branch", "failed-base"]);
    git(repoRoot, ["worktree", "add", baseWorktree, "failed-base"]);
    installFakeCodiff(binDirectory, { exitCode: 23 });

    await expect(
      runMonkeAsync({
        args: ["diff", "--pick"],
        binDirectory,
        cwd: sessionWorktree,
        monkeHome: home,
        selectValues: [`worktree:${baseWorktree}`]
      })
    ).rejects.toThrow("Codiff launch failed with exit code 23");
    const state = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    expect(state.repos[0]?.diffBaseRef).toBe("refs/heads/main");
  });

  test("a selected base invalidated before launch reports the race and offers the picker again", async () => {
    const sandbox = makeTempDir("diff-selection-race");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");
    const racyWorktree = path.join(sandbox, "ordinary-worktrees", "racy");
    git(repoRoot, ["branch", "racy"]);
    git(repoRoot, ["worktree", "add", racyWorktree, "racy"]);
    installFakeCodiff(binDirectory);
    installGitShim(binDirectory, {
      afterCommand: {
        args: "rev-parse --verify --quiet refs/heads/racy^{commit}",
        cwd: sessionWorktree,
        script: `"$MONKE_TEST_REAL_GIT" -C "${repoRoot}" worktree remove --force "${racyWorktree}"
"$MONKE_TEST_REAL_GIT" -C "${repoRoot}" branch -D racy`
      }
    });
    const prompts: SelectPrompt[] = [];

    const result = await runMonkeAsync({
      args: ["diff", "--pick"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home,
      onSelect(value) {
        prompts.push(value);
      },
      selectValues: [`worktree:${racyWorktree}`, "local"]
    });

    expect(prompts).toHaveLength(2);
    expect(result.stderr).toContain(
      "Selected Diff base racy (committed branch base) is no longer valid; choose another Diff base."
    );
  });

  test("a selected checkout replaced by another repository fails same-repo preflight", async () => {
    const sandbox = makeTempDir("diff-cross-repo-race");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    const replacementRepo = createRepo(path.join(sandbox, "replacement"), {
      "README.md": "other\n"
    });
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");
    const racyWorktree = path.join(sandbox, "ordinary-worktrees", "racy");
    git(repoRoot, ["branch", "racy"]);
    git(repoRoot, ["worktree", "add", racyWorktree, "racy"]);
    installFakeCodiff(binDirectory);
    installGitShim(binDirectory, {
      afterCommand: {
        args: "rev-parse --path-format=absolute --show-toplevel",
        cwd: racyWorktree,
        script: `"$MONKE_TEST_REAL_GIT" -C "${repoRoot}" worktree remove --force "${racyWorktree}"
mv "${replacementRepo}" "${racyWorktree}"`
      }
    });
    const prompts: SelectPrompt[] = [];

    const result = await runMonkeAsync({
      args: ["diff", "--pick"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home,
      onSelect(prompt) {
        prompts.push(prompt);
      },
      selectValues: [`worktree:${racyWorktree}`, "local"]
    });

    expect(prompts).toHaveLength(2);
    expect(result.stderr).toContain(
      "Selected Diff base racy (committed branch base) is no longer valid; choose another Diff base."
    );
  });

  test("concurrent successful Session selections launch together and last completion wins", async () => {
    const sandbox = makeTempDir("diff-concurrent-persistence");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    runMonke({ args: ["spawn", "base-slow"], cwd: repoRoot, monkeHome: home });
    runMonke({ args: ["spawn", "base-fast"], cwd: repoRoot, monkeHome: home });
    runMonke({ args: ["spawn", "current"], cwd: repoRoot, monkeHome: home });
    const slowWorktree = getExpectedWorktreePath(home, repoRoot, "base-slow");
    const fastWorktree = getExpectedWorktreePath(home, repoRoot, "base-fast");
    const currentWorktree = getExpectedWorktreePath(home, repoRoot, "current");
    const codiffLog = installFakeCodiff(binDirectory, {
      delayByBase: { "refs/heads/base-slow": 0.25 },
      waitForBases: ["refs/heads/base-slow", "refs/heads/base-fast"]
    });

    await Promise.all([
      runDiffChild({
        baseWorktree: slowWorktree,
        binDirectory,
        currentWorktree,
        home
      }),
      runDiffChild({
        baseWorktree: fastWorktree,
        binDirectory,
        currentWorktree,
        home
      })
    ]);

    expect(readFileSync(codiffLog, "utf-8")).toBe(
      `--branch\nrefs/heads/base-fast\n${currentWorktree}\n--branch\nrefs/heads/base-slow\n${currentWorktree}\n`
    );
    expect(loadSessionState(home, repoRoot, "current").repos[0]?.diffBaseRef).toBe(
      "refs/heads/base-slow"
    );
  });

  test("a dirty detached target warns, launches its exact commit, and is never remembered", async () => {
    const sandbox = makeTempDir("diff-detached-base");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), { "README.md": "hello\n" });
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");
    const detachedWorktree = path.join(sandbox, "ordinary-worktrees", "detached");
    git(repoRoot, ["worktree", "add", "--detach", detachedWorktree, "HEAD"]);
    const detachedCommit = git(detachedWorktree, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(detachedWorktree, "dirty.txt"), "ignored by Diff\n", "utf-8");
    const codiffLog = installFakeCodiff(binDirectory);

    const result = await runMonkeAsync({
      args: ["diff", "--pick"],
      binDirectory,
      cwd: sessionWorktree,
      monkeHome: home,
      selectValues: [`worktree:${detachedWorktree}`]
    });

    expect(result.stderr).toContain(
      "has local changes; Diff uses its committed branch state only."
    );
    expect(readFileSync(codiffLog, "utf-8")).toBe(
      `--branch\n${detachedCommit}\n${sessionWorktree}\n`
    );
    const state = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    expect(state.repos[0]?.diffBaseRef).toBe("refs/heads/main");
  });

  test("Spawn records a Diff base only for fresh attached or default-branch creation", () => {
    const sandbox = makeTempDir("diff-spawn-base-rules");
    const home = path.join(sandbox, "home");

    const adoptedRoot = createRepo(path.join(sandbox, "adopted-root"), {
      "README.md": "hello\n"
    });
    git(adoptedRoot, ["branch", "adopted"]);
    runMonke({ args: ["spawn", "adopted"], cwd: adoptedRoot, monkeHome: home });
    const adoptedState = loadSessionState(home, adoptedRoot, "adopted");
    expect(adoptedState.repos[0]?.diffBaseRef).toBeUndefined();

    const detachedRoot = createRepo(path.join(sandbox, "detached-root"), {
      "README.md": "hello\n"
    });
    git(detachedRoot, ["switch", "--detach"]);
    runMonke({ args: ["spawn", "detached"], cwd: detachedRoot, monkeHome: home });
    const detachedStates = loadSessionState(home, detachedRoot, "detached");
    expect(detachedStates.repos[0]?.diffBaseRef).toBeUndefined();

    const defaultRoot = createRepo(path.join(sandbox, "default-root"), {
      "README.md": "hello\n"
    });
    runMonke({ args: ["spawn", "default", "--main"], cwd: defaultRoot, monkeHome: home });
    const defaultStates = loadSessionState(home, defaultRoot, "default");
    expect(defaultStates.repos[0]?.diffBaseRef).toBe("refs/heads/main");
  });

  test("repeated Spawn and Materialize preserve an existing Diff base", () => {
    const sandbox = makeTempDir("diff-lifecycle-preservation");
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": "apps: {}\n",
      "README.md": "hello\n"
    });
    git(repoRoot, ["branch", "custom-base"]);
    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    const sessionWorktree = getExpectedWorktreePath(home, repoRoot, "session");
    const state = loadSessionState(home, repoRoot, "session");
    saveSessionState(home, {
      ...state,
      repos: state.repos.map((repo) => ({ ...repo, diffBaseRef: "refs/heads/custom-base" }))
    });

    runMonke({ args: ["spawn", "session"], cwd: repoRoot, monkeHome: home });
    expect(loadSessionState(home, repoRoot, "session").repos[0]?.diffBaseRef).toBe(
      "refs/heads/custom-base"
    );

    runMonke({ args: ["materialize"], cwd: sessionWorktree, monkeHome: home });
    expect(loadSessionState(home, repoRoot, "session").repos[0]?.diffBaseRef).toBe(
      "refs/heads/custom-base"
    );
  });

  test("Diff launched in a dependency Session repo opens only that containing checkout", async () => {
    const sandbox = makeTempDir("diff-dependency-repo");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const root = createRepo(path.join(sandbox, "root"), { "README.md": "root\n" });
    const dependency = createRepo(path.join(sandbox, "dependency"), {
      "README.md": "dependency\n"
    });
    const rootWorktree = getExpectedWorktreePath(home, root, "session");
    const dependencyWorktree = getExpectedWorktreePath(home, dependency, "session");
    git(root, ["worktree", "add", "-b", "session", rootWorktree]);
    git(dependency, ["worktree", "add", "-b", "session", dependencyWorktree]);
    saveSessionState(
      home,
      completeSessionState({
        repos: [
          materializedRepoState({
            diffBaseRef: "refs/heads/main",
            sourceRoot: dependency,
            worktreePath: dependencyWorktree
          }),
          materializedRepoState({
            diffBaseRef: "refs/heads/main",
            sourceRoot: root,
            worktreePath: rootWorktree
          })
        ],
        rootSourceRoot: root,
        session: "session"
      })
    );
    const codiffLog = installFakeCodiff(binDirectory);

    await runMonkeAsync({
      args: ["diff"],
      binDirectory,
      cwd: dependencyWorktree,
      monkeHome: home
    });

    expect(readFileSync(codiffLog, "utf-8")).toBe(
      `--branch\nrefs/heads/main\n${dependencyWorktree}\n`
    );
  });
});

async function runDiffChild(options: {
  baseWorktree: string;
  binDirectory: string;
  currentWorktree: string;
  home: string;
}) {
  const indexUrl = new URL("../src/index.ts", import.meta.url).href;
  const runtimeUrl = new URL("runtime-fixture.ts", import.meta.url).href;
  const selected = `worktree:${options.baseWorktree}`;
  const childPath = [options.binDirectory, process.env.PATH ?? ""]
    .filter(Boolean)
    .join(path.delimiter);
  const script = `
import { runCliAsync } from ${JSON.stringify(indexUrl)};
import { createTestRuntime } from ${JSON.stringify(runtimeUrl)};
await runCliAsync(["diff", "--pick"], createTestRuntime({
  cwd: ${JSON.stringify(options.currentWorktree)},
  env: { MONKE_HOME: ${JSON.stringify(options.home)}, PATH: ${JSON.stringify(childPath)} },
  selectValues: [${JSON.stringify(selected)}]
}));
`;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--eval", script], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `Diff child exited with ${String(code)}`));
      }
    });
  });
}
