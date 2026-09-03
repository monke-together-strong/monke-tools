import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { getExpectedWorktreePath } from "../src/git.ts";
import { hashKey } from "../src/runtime.ts";
import { loadSessionState } from "../src/session-state-store.ts";
import { createRepo, git, makeTempDir, runMonke, spawnMonkeWorker, write } from "./helpers.ts";

const STATE_POLL_ATTEMPTS = 200;
const STATE_POLL_DELAY_MS = 10;

describe("Cleanup authority", () => {
  test("all-reused Resource command outputs retain Cleanup authority A", () => {
    const fixture = createCleanupAuthorityFixture("cleanup-authority-reuse");
    runMonke({
      args: ["spawn", "retained"],
      cwd: fixture.repoRoot,
      monkeHome: fixture.home
    });
    replaceCleanupAuthorityConfig(fixture, "B");

    runMonke({
      args: ["spawn", "retained"],
      cwd: fixture.repoRoot,
      monkeHome: fixture.home
    });

    const state = loadSessionState(fixture.home, fixture.repoRoot, "retained");
    expect(readFileSync(path.join(fixture.worktreeRoot, "resource-runs"), "utf-8")).toBe("r");
    expect(state.repos[0]).toMatchObject({
      cleanupCommand: cleanupCommand("A", fixture.cleanupLog),
      cleanupEligible: true,
      resourceCommandOutputs: [
        {
          name: "identity",
          outputs: [{ env: "AUTH_OUTPUT", value: "old-output" }]
        }
      ],
      resourceValues: [{ env: "AUTH_VALUE", value: "old-value" }]
    });

    runMonke({
      args: ["chop", "retained", "--force"],
      cwd: fixture.repoRoot,
      monkeHome: fixture.home
    });
    expect(readFileSync(fixture.cleanupLog, "utf-8")).toBe("A|old-value|old-output\n");
  });

  test("removing external-effect commands retains Cleanup authority A and its env", () => {
    const fixture = createCleanupAuthorityFixture("cleanup-authority-removed-command");
    runMonke({
      args: ["spawn", "retained"],
      cwd: fixture.repoRoot,
      monkeHome: fixture.home
    });
    replaceCleanupAuthorityConfig(fixture, "B", { includeResources: false });

    runMonke({
      args: ["spawn", "retained"],
      cwd: fixture.repoRoot,
      monkeHome: fixture.home
    });
    runMonke({
      args: ["chop", "retained", "--force"],
      cwd: fixture.repoRoot,
      monkeHome: fixture.home
    });

    expect(readFileSync(fixture.cleanupLog, "utf-8")).toBe("A|old-value|old-output\n");
  });

  test("interruption while waiting for a Resource command lock retains Cleanup authority A", async () => {
    const fixture = createCleanupAuthorityFixture("cleanup-authority-lock-wait");
    runMonke({
      args: ["spawn", "retained"],
      cwd: fixture.repoRoot,
      monkeHome: fixture.home
    });
    replaceCleanupAuthorityConfig(fixture, "B", { commandName: "replacement" });
    const lockPath = path.join(
      fixture.home,
      "locks",
      `${hashKey(`resource-command\u0000${fixture.repoRoot}\u0000replacement`)}.lock`
    );
    write(
      fixture.home,
      path.relative(fixture.home, lockPath),
      JSON.stringify({ acquiredAt: Date.now(), pid: process.pid })
    );
    const child = spawnMonkeWorker({
      args: ["spawn", "retained"],
      cwd: fixture.repoRoot,
      monkeHome: fixture.home
    });

    try {
      await waitForState(() => {
        const [repo] = loadSessionState(fixture.home, fixture.repoRoot, "retained").repos;
        return Boolean(
          repo?.materializationStatus === "pending" && repo.cleanupCommand?.includes("A|")
        );
      });
      expect(child.exitCode).toBeNull();
    } finally {
      // Kill in cleanup so a waitForState timeout cannot leave the worker running against
      // the temp sandbox after the lock is removed.
      child.kill("SIGKILL");
      await child.exited;
      rmSync(lockPath, { force: true });
    }

    expect(loadSessionState(fixture.home, fixture.repoRoot, "retained").repos[0]).toMatchObject({
      cleanupCommand: cleanupCommand("A", fixture.cleanupLog),
      cleanupEligible: true
    });
    runMonke({
      args: ["chop", "retained", "--force"],
      cwd: fixture.repoRoot,
      monkeHome: fixture.home
    });
    expect(readFileSync(fixture.cleanupLog, "utf-8")).toBe("A|old-value|old-output\n");
  });
});

function createCleanupAuthorityFixture(name: string) {
  const sandbox = makeTempDir(name);
  const home = path.join(sandbox, "home");
  const cleanupLog = path.join(sandbox, "cleanup.log");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "monke.yml": authorityConfig("A", cleanupLog),
    "resource.ts": `import { appendFileSync } from "node:fs";

export default function () {
  appendFileSync("resource-runs", "r");
  return { AUTH_OUTPUT: "old-output" };
}
`
  });
  return {
    cleanupLog,
    home,
    repoRoot,
    sandbox,
    worktreeRoot: getExpectedWorktreePath(home, repoRoot, "retained")
  };
}

function replaceCleanupAuthorityConfig(
  fixture: ReturnType<typeof createCleanupAuthorityFixture>,
  label: string,
  options: { commandName?: string; includeResources?: boolean } = {}
) {
  write(fixture.repoRoot, "monke.yml", authorityConfig(label, fixture.cleanupLog, options));
  git(fixture.repoRoot, ["add", "monke.yml"]);
  git(fixture.repoRoot, ["commit", "-m", `configure Cleanup ${label}`]);
}

function authorityConfig(
  label: string,
  cleanupLog: string,
  options: { commandName?: string; includeResources?: boolean } = {}
) {
  const resources =
    options.includeResources === false
      ? ""
      : `resources:
  values:
    AUTH_VALUE: old-value
  commands:
    ${options.commandName ?? "identity"}:
      run: ./resource.ts
      timeoutSeconds: 30
      outputs:
        - AUTH_OUTPUT
`;
  return `cleanupCommand: '${cleanupCommand(label, cleanupLog)}'
${resources}apps: {}
`;
}

function cleanupCommand(label: string, cleanupLog: string) {
  return `printf "${label}|%s|%s\\n" "$AUTH_VALUE" "$AUTH_OUTPUT" > "${cleanupLog}"`;
}

async function waitForState(predicate: () => boolean) {
  for (let attempt = 0; attempt < STATE_POLL_ATTEMPTS; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, STATE_POLL_DELAY_MS);
    });
  }
  throw new Error("Timed out waiting for Session state");
}
