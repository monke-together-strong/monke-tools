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
  launchctl: () => string[][];
  monkeHome: string;
  skill: string;
  source: string;
  systemctl: () => string[][];
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

  const sandbox: Sandbox = {
    bin: path.join(root, "bin"),
    home: path.join(root, "home"),
    launchctl: () => [],
    monkeHome,
    skill,
    source,
    systemctl: () => [],
    worktree: realpathSync.native(worktree)
  };

  // Fake schedulers keep tracking from loading a real launchd or systemd job.
  sandbox.launchctl = installRecordingCommand(sandbox, "launchctl");
  sandbox.systemctl = installRecordingCommand(sandbox, "systemctl");
  installRecordingCommand(sandbox, "mt");

  return sandbox;
}

async function mt(
  sandbox: Sandbox,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  onStdout?: (text: string) => void
): Promise<string> {
  let stdout = "";

  const runtime = createTestRuntime({
    cwd: sandbox.source,
    env: {
      HOME: sandbox.home,
      MONKE_HOME: sandbox.monkeHome,
      PATH: `${sandbox.bin}${path.delimiter}${process.env.PATH ?? ""}`,
      // The runtime inherits the process environment, so pin systemd's user directory too.
      XDG_CONFIG_HOME: path.join(sandbox.home, ".config")
    },
    onStdout(text) {
      stdout += text;
      onStdout?.(text);
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

async function track(sandbox: Sandbox, number: number, platform?: NodeJS.Platform) {
  await mt(
    sandbox,
    ["prs", "track", prUrl(number), "--thread", `thread-${number}`, "--checkout", sandbox.worktree],
    platform
  );
}

describe("mt prs", () => {
  it("creates in the PR checkout and registers tracking and scheduling before success", async () => {
    const sandbox = createSandbox();

    const ghCalls = installRecordingCommand(
      sandbox,
      "gh",
      `test "$PWD" = '${sandbox.worktree}' || exit 1\nprintf '${prUrl(661)}\\n'`
    );

    const args = ["--base", "main", "--title", "One rule", "--body-file", "body.md"];

    await expect(
      mt(sandbox, [
        "prs",
        "create",
        "--thread",
        "thread-661",
        "--checkout",
        sandbox.worktree,
        "--",
        ...args
      ])
    ).resolves.toBe(`Tracking ${prUrl(661)}\n`);
    expect(ghCalls()).toStrictEqual([["pr", "create", ...args]]);
    await expect(mt(sandbox, ["prs", "list"])).resolves.toBe(
      `${prUrl(661)}\tthread thread-661\tcheckout ${sandbox.worktree}\n`
    );
    expect([...sandbox.launchctl(), ...sandbox.systemctl()].length).toBeGreaterThan(0);
  });

  it("rejects publishing when GitHub created the PR but poll scheduling fails", async () => {
    const sandbox = createSandbox();
    const ghCalls = installRecordingCommand(sandbox, "gh", `printf '${prUrl(661)}\\n'`);
    installRecordingCommand(sandbox, "launchctl", '[ "$1" = "bootstrap" ] && exit 1\nexit 0');
    let stdout = "";

    await expect(
      mt(
        sandbox,
        [
          "prs",
          "create",
          "--thread",
          "thread-661",
          "--checkout",
          sandbox.worktree,
          "--",
          "--title",
          "One rule",
          "--body",
          "Description"
        ],
        "darwin",
        (text) => {
          stdout += text;
        }
      )
    ).rejects.toThrow(`Created ${prUrl(661)}, but post-merge tracking is incomplete`);
    expect(stdout).toBe("");
    expect(ghCalls()).toHaveLength(1);
    // Retain the registration so `track` can retry scheduling without creating another PR.
    await expect(mt(sandbox, ["prs", "list"])).resolves.toContain(prUrl(661));
    installRecordingCommand(sandbox, "launchctl");
    await track(sandbox, 661, "darwin");
    expect(ghCalls()).toHaveLength(1);
  });

  it("leaves no registration when GitHub creation fails", async () => {
    const sandbox = createSandbox();
    installRecordingCommand(sandbox, "gh", 'echo "creation failed" >&2\nexit 1');

    await expect(
      mt(sandbox, [
        "prs",
        "create",
        "--thread",
        "thread-661",
        "--checkout",
        sandbox.worktree,
        "--",
        "--title",
        "One rule",
        "--body",
        "Description"
      ])
    ).rejects.toThrow("creation failed");
    await expect(mt(sandbox, ["prs", "list"])).resolves.toBe("");
    expect([...sandbox.launchctl(), ...sandbox.systemctl()]).toStrictEqual([]);
  });

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

  it("keeps a merged PR tracked when its hand-off fails", async () => {
    const sandbox = createSandbox();
    installFakeGh(sandbox, { 6: "MERGED" });
    installRecordingCommand(sandbox, "t3", "exit 1");
    await track(sandbox, 6);

    await expect(mt(sandbox, ["prs", "poll"])).rejects.toThrow(`Could not hand off ${prUrl(6)}`);
    await expect(mt(sandbox, ["prs", "list"])).resolves.toContain(prUrl(6));
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

  it("schedules the poll with launchd while any PR is tracked", async () => {
    const sandbox = createSandbox();

    const plist = path.join(
      sandbox.home,
      "Library/LaunchAgents/com.monke-together-strong.mt-prs-poll.plist"
    );

    await track(sandbox, 1, "darwin");
    await track(sandbox, 2, "darwin");

    expect(readFileSync(plist, "utf-8")).toContain(
      `<string>${path.join(sandbox.bin, "mt")}</string>\n    <string>prs</string>\n    <string>poll</string>`
    );
    expect(sandbox.launchctl().map((call) => call[0])).toStrictEqual(["bootout", "bootstrap"]);

    await mt(sandbox, ["prs", "untrack", prUrl(1)], "darwin");
    installFakeGh(sandbox, { 2: "MERGED" });
    installRecordingCommand(sandbox, "t3");
    await mt(sandbox, ["prs", "poll"], "darwin");

    expect(existsSync(plist)).toBeFalsy();
    expect(sandbox.launchctl().map((call) => call[0])).toStrictEqual([
      "bootout",
      "bootstrap",
      "bootout"
    ]);
  });

  it("retries scheduling on the next track when loading the job fails", async () => {
    const sandbox = createSandbox();

    const plist = path.join(
      sandbox.home,
      "Library/LaunchAgents/com.monke-together-strong.mt-prs-poll.plist"
    );

    installRecordingCommand(sandbox, "launchctl", '[ "$1" = "bootstrap" ] && exit 1\nexit 0');

    await expect(track(sandbox, 1, "darwin")).rejects.toThrow(
      "Command failed: launchctl bootstrap"
    );
    expect(existsSync(plist)).toBeFalsy();
  });

  it("schedules the poll with a systemd user timer on Linux", async () => {
    const sandbox = createSandbox();
    const units = path.join(sandbox.home, ".config/systemd/user");
    await track(sandbox, 1, "linux");

    expect(readFileSync(path.join(units, "mt-prs-poll.service"), "utf-8")).toContain(
      `ExecStart="${path.join(sandbox.bin, "mt")}" prs poll`
    );
    expect(readFileSync(path.join(units, "mt-prs-poll.timer"), "utf-8")).toContain(
      "OnCalendar=*:0/5"
    );

    await mt(sandbox, ["prs", "untrack", prUrl(1)], "linux");

    expect(existsSync(path.join(units, "mt-prs-poll.timer"))).toBeFalsy();
    expect(sandbox.systemctl()).toStrictEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", "mt-prs-poll.timer"],
      ["--user", "disable", "--now", "mt-prs-poll.timer"],
      ["--user", "daemon-reload"]
    ]);
  });
});
