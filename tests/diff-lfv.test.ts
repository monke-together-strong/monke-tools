import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { getExpectedWorktreePath } from "../src/git.ts";
import { shellQuote } from "../src/shell-quote.ts";
import { SessionStateSchema } from "../src/state-schema.ts";
import {
  createConfiguredRepo,
  git,
  installFakeCodiff,
  makeTempDir,
  readSingleYamlFile,
  runMonke,
  runMonkeAsync,
  runMonkeCapturingFailure,
  writeExecutable
} from "./helpers.ts";

const reviewUrl = "https://viewer.example.test/repository-review/private-token";
const success = JSON.stringify({
  command: "review.create",
  data: { url: reviewUrl },
  ok: true,
  version: 1,
  warnings: []
});

function fixture(options: { exitCode?: number; stderr?: string; stdout?: string } = {}) {
  const sandbox = makeTempDir("diff-lfv");
  const home = path.join(sandbox, "home");
  const binDirectory = path.join(sandbox, "bin");
  const repo = createConfiguredRepo(path.join(sandbox, "repo"), { "README.md": "base\n" });
  const base = git(repo, ["rev-parse", "HEAD"]);
  writeFileSync(path.join(repo, "README.md"), "committed\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "committed change"]);
  writeFileSync(path.join(repo, "README.md"), "committed plus dirty\n");
  const log = path.join(sandbox, "lfv.log");
  writeExecutable(
    path.join(binDirectory, "lfv"),
    `#!/bin/sh
printf '%s\\n' "$PWD" "$@" >> ${shellQuote(log)}
printf '%s\\n' ${shellQuote(options.stdout ?? success)}
printf '%s' ${shellQuote(options.stderr ?? "")} >&2
exit ${options.exitCode ?? 0}
`
  );
  return { base, binDirectory, home, log, repo, sandbox };
}

describe("LFV Diff", () => {
  test.each([
    { exitCode: 0, expectedError: null },
    {
      exitCode: 1,
      expectedError:
        "LFV review create failed or returned an invalid response; no review URL was returned."
    }
  ])(
    "remembers a picked LFV base only after successful delivery (exit $exitCode)",
    async ({ exitCode, expectedError }) => {
      const { binDirectory, home, repo, sandbox } = fixture({ exitCode });
      git(repo, ["restore", "README.md"]);
      runMonke({ args: ["spawn", "feature"], cwd: repo, monkeHome: home });
      const session = getExpectedWorktreePath(home, repo, "feature");
      const baseWorktree = path.join(sandbox, "base");
      git(repo, ["worktree", "add", "-b", "base", baseWorktree]);
      const delivery = runMonkeAsync({
        args: ["diff", "--adapter", "lfv", "--pick"],
        binDirectory,
        cwd: session,
        monkeHome: home,
        selectValues: [`worktree:${baseWorktree}`]
      });
      let deliveryError: string | null = null;
      try {
        await delivery;
      } catch (error) {
        deliveryError = error instanceof Error ? error.message : String(error);
      }
      expect(deliveryError).toBe(expectedError);
      const state = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
      expect(state.repos[0]?.diffBaseRef).toBe(
        exitCode === 0 ? "refs/heads/base" : "refs/heads/main"
      );
    }
  );

  test.each([
    { stdout: "not JSON" },
    { stdout: JSON.stringify({ ...JSON.parse(success), version: 2 }) },
    { stdout: JSON.stringify({ ...JSON.parse(success), command: "review.show" }) },
    { stdout: JSON.stringify({ ...JSON.parse(success), data: {} }) },
    { stdout: JSON.stringify({ ...JSON.parse(success), data: { url: "file:///tmp/review" } }) },
    { stdout: JSON.stringify({ ...JSON.parse(success), data: { url: `${reviewUrl}\n` } }) },
    { stdout: JSON.stringify({ ...JSON.parse(success), data: { url: `${reviewUrl}\u0000` } }) },
    {
      stdout: JSON.stringify({
        ...JSON.parse(success),
        data: { url: `${reviewUrl}\u001B]52;c;AA==\u0007` }
      })
    },
    { stdout: JSON.stringify({ ...JSON.parse(success), data: { url: `${reviewUrl}\u007F` } }) },
    { stdout: JSON.stringify({ ...JSON.parse(success), data: { url: `${reviewUrl}\u009B2J` } }) },
    {
      stdout: JSON.stringify({
        ...JSON.parse(success),
        data: { url: "https://user:password@viewer.example.test/review" }
      })
    },
    { exitCode: 1, stdout: success }
  ])(
    "fails closed on an invalid LFV envelope without a desktop fallback: $stdout",
    ({ exitCode, stdout }) => {
      const { binDirectory, home, repo } = fixture({ exitCode, stdout });
      const desktopLog = installFakeCodiff(binDirectory);
      const result = runMonkeCapturingFailure({
        args: ["diff", "--adapter", "lfv", "--working-tree"],
        binDirectory,
        cwd: repo,
        monkeHome: home
      });
      expect(result.error).not.toBeNull();
      expect(result.stdout).toBe("");
      expect(existsSync(desktopLog)).toBeFalsy();
    }
  );

  test("does not invoke LFV when provider resolution fails", () => {
    const { binDirectory, home, log, repo } = fixture();
    writeExecutable(
      path.join(binDirectory, "gh"),
      "#!/bin/sh\nprintf 'Provider sign-in required\\n' >&2\nexit 1\n"
    );
    const result = runMonkeCapturingFailure({
      args: ["diff", "--adapter", "lfv", "pr", "42"],
      binDirectory,
      cwd: repo,
      monkeHome: home
    });
    expect(result.error).not.toBeNull();
    expect(result.stderr).toContain("Provider sign-in required");
    expect(result.stdout).toBe("");
    expect(existsSync(log)).toBeFalsy();
  });

  test.each([
    {
      command: "gh",
      response: { url: "https://github.com/owner/repo/pull/42/files\n" },
      selector: "pr"
    },
    {
      command: "gh",
      response: { url: "https://github.com/owner/repo/pull/42/\u0000" },
      selector: "pr"
    },
    {
      command: "glab",
      response: {
        web_url: "https://gitlab.example.test/group/repo/-/merge_requests/42/diffs\u001B[2J"
      },
      selector: "mr"
    }
  ])(
    "rejects raw controls in resolved $selector URLs before invoking LFV",
    ({ command, response, selector }) => {
      const { binDirectory, home, log, repo } = fixture();
      writeExecutable(
        path.join(binDirectory, command),
        `#!/bin/sh\nprintf '%s\\n' ${shellQuote(JSON.stringify(response))}\n`
      );
      const result = runMonkeCapturingFailure({
        args: ["diff", "--adapter", "lfv", selector, "42"],
        binDirectory,
        cwd: repo,
        monkeHome: home
      });
      expect(result.error).not.toBeNull();
      expect(result.stdout).toBe("");
      expect(existsSync(log)).toBeFalsy();
    }
  );

  test("reports missing LFV without invoking a desktop fallback", async () => {
    const { binDirectory, home, repo } = fixture();
    rmSync(path.join(binDirectory, "lfv"));
    const desktopLog = installFakeCodiff(binDirectory);
    await expect(
      runMonkeAsync({
        args: ["diff", "--adapter", "lfv", "--working-tree"],
        binDirectory,
        cwd: repo,
        extraEnv: { PATH: `${binDirectory}:/usr/bin:/bin` },
        monkeHome: home
      })
    ).rejects.toThrow("LFV is unavailable");
    expect(existsSync(desktopLog)).toBeFalsy();
  });

  test("saves LFV without launching, retains other preferences, and supports a one-off Codiff override", async () => {
    const { binDirectory, home, log, repo } = fixture();
    mkdirSync(home, { recursive: true });
    const configPath = path.join(home, "config.yml");
    writeFileSync(
      configPath,
      "version: 1\nskillInstallPreference:\n  targets:\n    - kind: codex\n"
    );
    const configured = await runMonkeAsync({
      args: ["diff", "configure"],
      cwd: repo,
      monkeHome: home,
      onSelect(prompt) {
        expect(prompt.options.map((option) => option.value)).toStrictEqual(["codiff", "lfv"]);
      },
      selectValues: ["lfv"]
    });
    expect(configured.stdout).toBe("Diff adapter: lfv\n");
    expect(existsSync(log)).toBeFalsy();
    const saved = readFileSync(configPath, "utf-8");
    expect(saved).toContain("diffAdapter: lfv");
    expect(saved).toContain("kind: codex");
    const automatic = await runMonkeAsync({
      args: ["diff"],
      binDirectory,
      cwd: repo,
      monkeHome: home,
      onSelect() {
        throw new Error("default branch Diff prompted");
      }
    });
    expect(automatic.stdout).toBe(`${reviewUrl}\n`);
    expect(readFileSync(log, "utf-8")).toBe(
      [repo, "--json", "review", "create", repo, "--source", "working-tree", ""].join("\n")
    );
    const desktopLog = installFakeCodiff(binDirectory);
    await runMonkeAsync({
      args: ["diff", "--adapter", "codiff", "--working-tree"],
      binDirectory,
      cwd: repo,
      monkeHome: home
    });
    expect(readFileSync(desktopLog, "utf-8")).toBe(`${repo}\n`);
    expect(readFileSync(configPath, "utf-8")).toBe(saved);
  });

  test("preserves LFV failure code, message, hint, and diagnostics without printing a URL", () => {
    const { binDirectory, home, repo } = fixture({
      exitCode: 1,
      stderr: "authentication diagnostic\n",
      stdout: JSON.stringify({
        error: {
          code: "AUTH_REQUIRED",
          hint: "Run lfv auth login",
          message: "Sign in to the viewer"
        },
        ok: false,
        version: 1
      })
    });
    const result = runMonkeCapturingFailure({
      args: ["diff", "--adapter", "lfv", "--working-tree"],
      binDirectory,
      cwd: repo,
      monkeHome: home
    });
    expect(result.error).not.toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("authentication diagnostic\n");
    expect(result.stderr).toContain("AUTH_REQUIRED: Sign in to the viewer");
    expect(result.stderr).toContain("Run lfv auth login");
  });

  test.each([
    {
      args: ["#42"],
      command: "gh",
      delivered: ["pr", "view", "42", "--json", "url"],
      provider: "github",
      response: { url: "https://github.com/owner/repo/pull/42" },
      url: "https://github.com/owner/repo/pull/42"
    },
    {
      args: ["pr", "42"],
      command: "gh",
      delivered: ["pr", "view", "42", "--json", "url"],
      provider: "github",
      response: { url: "https://github.com/owner/repo/pull/42" },
      url: "https://github.com/owner/repo/pull/42"
    },
    {
      args: ["pr", "owner:feature"],
      command: "gh",
      delivered: ["pr", "view", "owner:feature", "--json", "url"],
      provider: "github",
      response: { url: "https://github.com/owner/repo/pull/42" },
      url: "https://github.com/owner/repo/pull/42"
    },
    {
      args: ["mr", "42"],
      command: "glab",
      delivered: ["mr", "view", "42", "--output", "json"],
      provider: "gitlab",
      response: { web_url: "https://gitlab.example.test/group/repo/-/merge_requests/42" },
      url: "https://gitlab.example.test/group/repo/-/merge_requests/42"
    }
  ])(
    "resolves $args through the provider's read-only CLI before LFV",
    async ({ args, command, delivered, provider, response, url }) => {
      const { binDirectory, home, log, repo, sandbox } = fixture();
      const providerLog = path.join(sandbox, "provider.log");
      writeExecutable(
        path.join(binDirectory, command),
        `#!/bin/sh
printf '%s\\n' "$PWD" "$@" > ${shellQuote(providerLog)}
printf '%s\\n' ${shellQuote(JSON.stringify(response))}
`
      );
      await runMonkeAsync({
        args: ["diff", "--adapter", "lfv", ...args],
        binDirectory,
        cwd: repo,
        monkeHome: home
      });
      expect(readFileSync(providerLog, "utf-8")).toBe([repo, ...delivered, ""].join("\n"));
      expect(readFileSync(log, "utf-8")).toBe(
        [
          repo,
          "--json",
          "review",
          "create",
          repo,
          "--source",
          "pull-request",
          "--url",
          url,
          "--provider",
          provider,
          ""
        ].join("\n")
      );
    }
  );

  test.each([
    { args: ["--working-tree"], source: ["--source", "working-tree"] },
    { args: ["--commit", "HEAD"], source: ["--source", "commit", "--ref", "HEAD"] },
    {
      args: ["HEAD~..HEAD"],
      source: ["--source", "range", "--base", "HEAD~", "--head", "HEAD", "--direct"]
    },
    {
      args: ["HEAD~...HEAD"],
      source: ["--source", "range", "--base", "HEAD~", "--head", "HEAD", "--merge-base"]
    },
    {
      args: ["https://github.com/owner/repo/pull/42"],
      source: ["--source", "pull-request", "--url", "https://github.com/owner/repo/pull/42"]
    },
    {
      args: ["https://gitlab.example.test/group/repo/-/merge_requests/42"],
      source: [
        "--source",
        "pull-request",
        "--url",
        "https://gitlab.example.test/group/repo/-/merge_requests/42"
      ]
    }
  ])(
    "preserves explicit source semantics for $args from a selected checkout",
    async ({ args, source }) => {
      const { binDirectory, home, log, repo, sandbox } = fixture();
      const result = await runMonkeAsync({
        args: ["diff", "--adapter", "lfv", "--path", repo, ...args],
        binDirectory,
        cwd: sandbox,
        monkeHome: home,
        onSelect() {
          throw new Error("explicit Diff prompted");
        }
      });
      expect(readFileSync(log, "utf-8")).toBe(
        [repo, "--json", "review", "create", repo, ...source, ""].join("\n")
      );
      expect(result.stdout).toBe(`${reviewUrl}\n`);
    }
  );

  test("delivers branch commits plus dirty changes to LFV and returns its canonical URL", async () => {
    const { base, binDirectory, home, log, repo } = fixture({ stderr: "viewer diagnostic\n" });
    const before = git(repo, ["status", "--porcelain"]);
    const result = await runMonkeAsync({
      args: ["diff", "--adapter", "lfv", "--branch", base],
      binDirectory,
      cwd: repo,
      monkeHome: home,
      onSelect() {
        throw new Error("explicit Diff prompted");
      }
    });

    expect(readFileSync(log, "utf-8")).toBe(
      [
        repo,
        "--json",
        "review",
        "create",
        repo,
        "--source",
        "branch-working-tree",
        "--ref",
        base,
        ""
      ].join("\n")
    );
    expect(result.stdout).toBe(`${reviewUrl}\n`);
    expect(result.stderr).toBe("viewer diagnostic\n");
    expect(git(repo, ["status", "--porcelain"])).toBe(before);
  });
});
