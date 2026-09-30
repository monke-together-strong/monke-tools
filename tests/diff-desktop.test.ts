import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createConfiguredRepo,
  git,
  installFakeCodiff,
  makeTempDir,
  runMonkeAsync
} from "./helpers.ts";

describe("Desktop Diff", () => {
  function fixture() {
    const sandbox = makeTempDir("diff-sources");
    const home = path.join(sandbox, "home");
    const binDirectory = path.join(sandbox, "bin");
    const repo = createConfiguredRepo(path.join(sandbox, "repo"), { "README.md": "common\n" });
    writeFileSync(path.join(repo, "base-only.txt"), "base\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "base-only"]);
    git(repo, ["checkout", "-b", "feature", "HEAD~"]);
    writeFileSync(path.join(repo, "feature-only.txt"), "feature\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "feature-only change"]);
    const log = installFakeCodiff(binDirectory);
    return { binDirectory, home, log, repo, sandbox };
  }

  test("keeps hex-named branches and capitalization variants of HEAD as branch reviews with local edits", async () => {
    const { binDirectory, home, log, repo } = fixture();
    writeFileSync(path.join(repo, "local.txt"), "local change\n");
    for (const branch of [
      "cafe",
      "dead",
      "abc123",
      "head",
      "heaD",
      "heAd",
      "heAD",
      "hEad",
      "hEaD",
      "hEAd",
      "hEAD",
      "Head",
      "HeaD",
      "HeAd",
      "HeAD",
      "HEad",
      "HEaD",
      "HEAd"
    ]) {
      git(repo, ["branch", branch, "main"]);
      writeFileSync(log, "");
      await runMonkeAsync({
        args: ["diff", branch],
        binDirectory,
        cwd: repo,
        monkeHome: home,
        onSelect() {
          throw new Error("explicit Diff prompted");
        }
      });
      expect(readFileSync(log, "utf-8")).toBe(`--branch\n${branch}\n${repo}\n`);
      expect(readFileSync(path.join(repo, "local.txt"), "utf-8")).toBe("local change\n");
      git(repo, ["branch", "-D", branch]);
    }
    expect(git(repo, ["branch", "--show-current"])).toBe("feature");
  });

  test.each([
    { args: ["--working-tree"], delivered: [] },
    { args: ["--commit", "HEAD"], delivered: ["--commit", "HEAD"] },
    { args: ["--branch", "main"], delivered: ["--branch", "main"] },
    { args: ["HEAD"], delivered: ["--commit", "HEAD"] },
    { args: ["main"], delivered: ["--branch", "main"] },
    { args: ["#42"], delivered: ["#42"] },
    { args: ["pr", "42"], delivered: ["pr", "42"] },
    { args: ["mr", "42"], delivered: ["mr", "42"] },
    {
      args: ["https://github.com/owner/repo/pull/42"],
      delivered: ["https://github.com/owner/repo/pull/42"]
    },
    {
      args: ["https://gitlab.example.com/group/repo/-/merge_requests/42"],
      delivered: ["https://gitlab.example.com/group/repo/-/merge_requests/42"]
    }
  ])(
    "delivers stock-supported selectors $args without range capabilities",
    async ({ args, delivered }) => {
      const { binDirectory, home, repo } = fixture();
      const log = installFakeCodiff(binDirectory, {
        capabilities: "unsupported",
        help: "Usage: codiff [ref] [--commit <ref>] [--branch <ref>] [pr|mr] [path]",
        version: "codiff v1.14.0"
      });
      const before = git(repo, ["status", "--porcelain"]);
      await runMonkeAsync({
        args: ["diff", ...args],
        binDirectory,
        cwd: repo,
        monkeHome: home,
        onSelect() {
          throw new Error("explicit Diff prompted");
        }
      });
      expect(readFileSync(log, "utf-8")).toBe([...delivered, repo, ""].join("\n"));
      expect(git(repo, ["status", "--porcelain"])).toBe(before);
      expect(git(repo, ["branch", "--show-current"])).toBe("feature");
    }
  );

  test.each(["HEAD^{/..}", "HEAD^{/.. }", "HEAD^{/.*.. .*}"])(
    "delivers single dotted revision %s as a commit in positional and explicit forms",
    async (ref) => {
      const { binDirectory, home, log, repo } = fixture();
      expect(git(repo, ["rev-parse", "--verify", `${ref}^{commit}`])).toBe(
        git(repo, ["rev-parse", "HEAD"])
      );
      writeFileSync(path.join(repo, "local.txt"), "not part of selected commit\n");
      const before = git(repo, ["status", "--porcelain"]);
      for (const targets of [[ref], ["--commit", ref]]) {
        writeFileSync(log, "");
        await runMonkeAsync({
          args: ["diff", ...targets],
          binDirectory,
          cwd: repo,
          monkeHome: home,
          onSelect() {
            throw new Error("explicit Diff prompted");
          }
        });
        expect(readFileSync(log, "utf-8")).toBe(`--commit\n${ref}\n${repo}\n`);
        expect(git(repo, ["status", "--porcelain"])).toBe(before);
      }
      expect(git(repo, ["branch", "--show-current"])).toBe("feature");
    }
  );

  test.each([
    { args: ["--working-tree"], delivered: [] },
    { args: ["--commit", "HEAD"], delivered: ["--commit", "HEAD"] },
    {
      args: ["--commit", "HEAD^{/feature-only change}"],
      delivered: ["--commit", "HEAD^{/feature-only change}"]
    },
    {
      args: ["HEAD^{/feature-only change}"],
      delivered: ["--commit", "HEAD^{/feature-only change}"]
    },
    { args: ["--branch", "main"], delivered: ["--branch", "main"] },
    { args: ["main..feature"], delivered: ["main..feature"] },
    { args: ["main...feature"], delivered: ["main...feature"] },
    { args: ["HEAD..HEAD"], delivered: ["HEAD..HEAD"] },
    { args: ["HEAD...HEAD"], delivered: ["HEAD...HEAD"] },
    { args: ["HEAD..HEAD^{/..}"], delivered: ["HEAD..HEAD^{/..}"] },
    { args: ["HEAD~1..HEAD^{/..}"], delivered: ["HEAD~1..HEAD^{/..}"] },
    { args: ["HEAD~1..HEAD^{/.. }"], delivered: ["HEAD~1..HEAD^{/.. }"] },
    { args: ["HEAD~1..HEAD^{/.*.. .*}"], delivered: ["HEAD~1..HEAD^{/.*.. .*}"] },
    { args: ["HEAD~1...HEAD^{/..}"], delivered: ["HEAD~1...HEAD^{/..}"] },
    { args: ["HEAD~1...HEAD^{/.. }"], delivered: ["HEAD~1...HEAD^{/.. }"] },
    { args: ["HEAD~1...HEAD^{/.*.. .*}"], delivered: ["HEAD~1...HEAD^{/.*.. .*}"] },
    { args: ["HEAD"], delivered: ["--commit", "HEAD"] },
    { args: ["main"], delivered: ["--branch", "main"] },
    { args: ["#42"], delivered: ["#42"] },
    { args: ["pr", "42"], delivered: ["pr", "42"] },
    { args: ["pr", "owner:feature"], delivered: ["pr", "owner:feature"] },
    { args: ["pr", "feature+diff"], delivered: ["pr", "feature+diff"] },
    { args: ["pr", "feature@review"], delivered: ["pr", "feature@review"] },
    { args: ["pr", "feature/đánh-giá"], delivered: ["pr", "feature/đánh-giá"] },
    { args: ["pr", "owner:feature+diff"], delivered: ["pr", "owner:feature+diff"] },
    { args: ["mr", "42"], delivered: ["mr", "42"] },
    {
      args: ["https://github.com/owner/repo/pull/42/files"],
      delivered: ["https://github.com/owner/repo/pull/42/files"]
    },
    {
      args: ["https://gitlab.example.com/group/repo/-/merge_requests/42"],
      delivered: ["https://gitlab.example.com/group/repo/-/merge_requests/42"]
    }
  ])(
    "delivers $args from the selected nested Checkout without mutation or selection",
    async ({ args, delivered }) => {
      const { binDirectory, home, log, repo, sandbox } = fixture();
      const selected = path.join(sandbox, "selected");
      git(repo, ["worktree", "add", "-b", "selected", selected, "feature"]);
      const nested = path.join(selected, "nested");
      mkdirSync(nested);
      const before = git(selected, ["status", "--porcelain"]);
      if (args[0]?.startsWith("HEAD~1..")) {
        git(selected, ["rev-parse", "--symbolic", args[0]]);
      }
      await runMonkeAsync({
        args: ["diff", ...args, "--path", nested],
        binDirectory,
        cwd: repo,
        monkeHome: home,
        onSelect() {
          throw new Error("explicit Diff prompted");
        }
      });
      expect(readFileSync(log, "utf-8")).toBe([...delivered, selected, ""].join("\n"));
      expect(git(selected, ["status", "--porcelain"])).toBe(before);
      expect(git(selected, ["branch", "--show-current"])).toBe("selected");
      expect(git(repo, ["branch", "--show-current"])).toBe("feature");
      expect(readFileSync(path.join(selected, "feature-only.txt"), "utf-8")).toBe("feature\n");
    }
  );

  test.each([
    ["--commit", "missing"],
    ["missing..HEAD"],
    ["HEAD^{/..}..HEAD"],
    ["HEAD....main"],
    ["HEAD.."],
    ["--commit", "HEAD", "--branch", "main"],
    ["--working-tree", "--pick"],
    ["--commit", "HEAD", "main..HEAD"],
    ["mr", "branch"],
    ["pr", "0"],
    ["https://example.com/owner/repo/pull/42"],
    ["--adapter", "lfv", "--working-tree"]
  ])("rejects invalid selectors %s without launching or prompting", async (...args) => {
    const { binDirectory, home, log, repo } = fixture();
    const before = git(repo, ["status", "--porcelain"]);
    await expect(
      runMonkeAsync({
        args: ["diff", ...args],
        binDirectory,
        cwd: repo,
        monkeHome: home,
        onSelect() {
          throw new Error("unexpected picker");
        }
      })
    ).rejects.toThrow(/Diff|Choose|Expected/u);
    expect(existsSync(log)).toBeFalsy();
    expect(git(repo, ["status", "--porcelain"])).toBe(before);
    expect(git(repo, ["branch", "--show-current"])).toBe("feature");
  });

  test.each(["main..feature", "main...feature"])(
    "rejects %s without advertised range forwarding or an alternate launch",
    async (range) => {
      for (const contract of [
        { help: "Usage: codiff --commit <ref>" },
        { capabilities: "not json" },
        { capabilities: '{"version":2,"sources":["range"]}' },
        { capabilities: '{"version":1,"sources":["working-tree"]}' }
      ]) {
        const { binDirectory, home, repo } = fixture();
        const log = installFakeCodiff(binDirectory, { ...contract, version: "codiff v9.0.0" });
        await expect(
          runMonkeAsync({
            args: ["diff", range],
            binDirectory,
            cwd: repo,
            monkeHome: home,
            onSelect() {
              throw new Error("unexpected picker");
            }
          })
        ).rejects.toThrow("safe range forwarding");
        expect(existsSync(log)).toBeFalsy();
      }
    }
  );

  test("adapter launch failure reports its failure without substituting another comparison", async () => {
    const { binDirectory, home, repo } = fixture();
    const log = installFakeCodiff(binDirectory, { exitCode: 9 });
    await expect(
      runMonkeAsync({ args: ["diff", "--working-tree"], binDirectory, cwd: repo, monkeHome: home })
    ).rejects.toThrow("Codiff launch failed");
    expect(readFileSync(log, "utf-8")).toBe(`${repo}\n`);
  });

  test("interactive configuration saves the selected adapter without needing a repository or executable", async () => {
    const sandbox = makeTempDir("diff-configure");
    const home = path.join(sandbox, "home");
    await runMonkeAsync({
      args: ["diff", "configure"],
      cwd: sandbox,
      monkeHome: home,
      selectValues: ["codiff"]
    });
    expect(readFileSync(path.join(home, "config.yml"), "utf-8")).toContain("diffAdapter: codiff");
  });

  test("desktop preference persists across invocations and explicit commit bypasses selection", async () => {
    const sandbox = makeTempDir("diff-desktop");
    const home = path.join(sandbox, "home");
    const binDirectory = path.join(sandbox, "bin");
    const repo = createConfiguredRepo(path.join(sandbox, "repo"), { "README.md": "initial\n" });
    const log = installFakeCodiff(binDirectory);
    await runMonkeAsync({
      args: ["diff", "configure", "--adapter", "codiff"],
      cwd: sandbox,
      monkeHome: home
    });
    const saved = readFileSync(path.join(home, "config.yml"), "utf-8");
    expect(saved).toContain("diffAdapter: codiff");
    await runMonkeAsync({
      args: ["diff", "--commit", "HEAD", "--adapter", "codiff", "--path", repo],
      binDirectory,
      cwd: sandbox,
      monkeHome: home,
      onSelect() {
        throw new Error("explicit Diff prompted");
      }
    });
    expect(readFileSync(log, "utf-8")).toBe(`--commit\nHEAD\n${repo}\n`);
    expect(readFileSync(path.join(home, "config.yml"), "utf-8")).toBe(saved);
    expect(existsSync(path.join(home, "sessions"))).toBeFalsy();
  });
});
