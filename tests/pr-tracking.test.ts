import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { runCliAsync } from "../src/index.ts";
import { createRepo, git, makeTempDir, writeExecutable } from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

const prUrl = (number: number) => `https://github.com/o/r/pull/${number}`;

interface Sandbox {
  bin: string;
  home: string;
  monkeHome: string;
  skill: string;
  source: string;
  worktree: string;
}

function createSandbox(): Sandbox {
  const root = makeTempDir("pr-tracking");
  const source = createRepo(path.join(root, "source"), { "README.md": "Source.\n" });
  const worktree = path.join(root, "worktree");
  git(source, ["worktree", "add", "-b", "feature/x", worktree]);
  const monkeHome = path.join(root, "monke");
  const skill = path.join(monkeHome, "skill-registry/skills/internal/post-merge/SKILL.md");
  writeExecutable(skill, "Post-merge.\n");

  return {
    bin: path.join(root, "bin"),
    home: path.join(root, "home"),
    monkeHome,
    skill,
    source,
    worktree: realpathSync.native(worktree)
  };
}

async function mt(
  sandbox: Sandbox,
  args: string[],
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  let stdout = "";

  const runtime = createTestRuntime({
    cwd: sandbox.source,
    env: {
      HOME: sandbox.home,
      MONKE_HOME: sandbox.monkeHome,
      PATH: `${sandbox.bin}${path.delimiter}${process.env.PATH ?? ""}`
    },
    onStdout(text) {
      stdout += text;
    },
    platform
  });

  await runCliAsync(args, runtime);

  return stdout;
}

/** Writes a fake command that records each invocation's arguments, one per line. */
function installRecordingCommand(sandbox: Sandbox, name: string, body = "exit 0") {
  const log = path.join(sandbox.bin, `${name}.log`);
  writeExecutable(
    path.join(sandbox.bin, name),
    `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg" >> '${log}'; done\nprintf '%s\\n' '--' >> '${log}'\n${body}\n`
  );

  return () =>
    existsSync(log)
      ? readFileSync(log, "utf-8")
          .split("--\n")
          .filter(Boolean)
          .map((call) => call.trimEnd().split("\n"))
      : [];
}

function installFakeGh(sandbox: Sandbox, states: Record<number, string>) {
  const cases = Object.entries(states)
    .map(([number, state]) => `  ${prUrl(Number(number))}) printf '{"state":"${state}"}\\n' ;;`)
    .join("\n");

  installRecordingCommand(
    sandbox,
    "gh",
    `case "$3" in\n${cases}\n  *) echo "cannot read $3" >&2; exit 1 ;;\nesac`
  );
}

async function track(sandbox: Sandbox, number: number, checkout = sandbox.worktree) {
  await mt(sandbox, [
    "prs",
    "track",
    prUrl(number),
    "--thread",
    `thread-${number}`,
    "--checkout",
    checkout
  ]);
}

describe("mt prs", () => {
  it("tracks a PR with its thread and checkout until it is untracked", async () => {
    const sandbox = createSandbox();
    await track(sandbox, 7);

    await expect(mt(sandbox, ["prs", "list"])).resolves.toBe(
      `${prUrl(7)}\tthread thread-7\tcheckout ${sandbox.worktree}\n`
    );
    await expect(mt(sandbox, ["prs", "untrack", prUrl(7)])).resolves.toBe(
      `Untracked ${prUrl(7)} (thread thread-7, checkout ${sandbox.worktree})\n`
    );
    await expect(mt(sandbox, ["prs", "list"])).resolves.toBe("");
  });

  it("sends externally merged PRs to their thread and drops closed ones", async () => {
    const sandbox = createSandbox();
    installFakeGh(sandbox, { 1: "OPEN", 2: "CLOSED", 3: "MERGED" });
    const t3Calls = installRecordingCommand(sandbox, "t3");
    await Promise.all([1, 2, 3].map((number) => track(sandbox, number)));

    await expect(mt(sandbox, ["prs", "poll"])).resolves.toBe(
      `Sent post-merge for ${prUrl(3)} to thread thread-3\n`
    );
    expect(t3Calls()).toStrictEqual([
      [
        "thread",
        "send",
        "thread-3",
        `${prUrl(3)} was merged outside this thread. Follow ${sandbox.skill} for it. Its checkout was ${sandbox.worktree}.`
      ]
    ]);
    await expect(mt(sandbox, ["prs", "list"])).resolves.toContain(prUrl(1));
    await expect(mt(sandbox, ["prs", "list"])).resolves.not.toContain(prUrl(2));
  });

  it("starts a thread in the source checkout when the PR's thread rejects the message", async () => {
    const sandbox = createSandbox();
    installFakeGh(sandbox, { 3: "MERGED" });
    const t3Calls = installRecordingCommand(sandbox, "t3", '[ "$2" = "send" ] && exit 1\nexit 0');
    await track(sandbox, 3);

    await expect(mt(sandbox, ["prs", "poll"])).resolves.toBe(
      `Started a thread for post-merge of ${prUrl(3)}\n`
    );
    expect(t3Calls()[1]?.slice(0, 5)).toStrictEqual([
      "thread",
      "start",
      "--title",
      "Verify #3",
      sandbox.source
    ]);
    await expect(mt(sandbox, ["prs", "list"])).resolves.toBe("");
  });

  it("leaves a PR re-tracked during a poll for the next poll", async () => {
    const sandbox = createSandbox();
    const state = path.join(sandbox.monkeHome, "tracked-prs.json");
    const t3Calls = installRecordingCommand(sandbox, "t3");
    await track(sandbox, 5);

    // While poll waits on a stale CLOSED read, the PR is reopened and re-tracked with another thread.
    installRecordingCommand(
      sandbox,
      "gh",
      `sed 's/thread-5/thread-6/' '${state}' > '${state}.new' && mv '${state}.new' '${state}'\nprintf '{"state":"CLOSED"}\\n'`
    );

    await expect(mt(sandbox, ["prs", "poll"])).resolves.toBe("");
    await expect(mt(sandbox, ["prs", "list"])).resolves.toContain("thread thread-6");

    installFakeGh(sandbox, { 5: "MERGED" });

    await expect(mt(sandbox, ["prs", "poll"])).resolves.toBe(
      `Sent post-merge for ${prUrl(5)} to thread thread-6\n`
    );
    expect(t3Calls().map((call) => call.slice(0, 3))).toStrictEqual([
      ["thread", "send", "thread-6"]
    ]);
  });

  it("keeps a PR tracked when GitHub cannot be read", async () => {
    const sandbox = createSandbox();
    installFakeGh(sandbox, {});
    const t3Calls = installRecordingCommand(sandbox, "t3");
    await track(sandbox, 4);

    await expect(mt(sandbox, ["prs", "poll"])).rejects.toThrow(`Could not read ${prUrl(4)}`);
    expect(t3Calls()).toStrictEqual([]);
    await expect(mt(sandbox, ["prs", "list"])).resolves.toContain(prUrl(4));
  });

  it("installs a launchd agent that polls every five minutes", async () => {
    const sandbox = createSandbox();
    const launchctlCalls = installRecordingCommand(sandbox, "launchctl");
    installRecordingCommand(sandbox, "mt");

    await mt(sandbox, ["prs", "install"], "darwin");

    const plist = readFileSync(
      path.join(
        sandbox.home,
        "Library",
        "LaunchAgents",
        "com.monke-together-strong.mt-prs-poll.plist"
      ),
      "utf-8"
    );

    expect(plist).toContain(
      `<string>${path.join(sandbox.bin, "mt")}</string>\n    <string>prs</string>\n    <string>poll</string>`
    );
    expect(plist).toContain("<key>StartInterval</key>\n  <integer>300</integer>");
    expect(launchctlCalls().map((call) => call[0])).toStrictEqual(["bootout", "bootstrap"]);
  });
});
