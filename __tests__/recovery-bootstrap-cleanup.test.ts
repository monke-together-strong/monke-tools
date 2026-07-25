import { expect, test } from "vitest";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { getExpectedWorktreePath } from "../src/git.ts";
import { getSessionStateFilePath } from "../src/registry.ts";
import {
  createRepo,
  git,
  installFakeGhForMergedPrs,
  installGitShim,
  installShShim,
  makeTempDir,
  read,
  readSingleYamlFile,
  runMonke,
  write,
} from "./helpers.ts";

function mergedPr(options: {
  number: number;
  head: string;
  base: string;
  headRefOid: string;
}): Record<string, unknown> {
  return {
    number: options.number,
    headRefName: options.head,
    baseRefName: options.base,
    headRefOid: options.headRefOid,
    mergedAt: "2026-06-16T00:00:00Z",
    url: `https://github.com/owner/repo/pull/${options.number}`,
    isCrossRepository: false,
    headRepository: { name: "repo" },
    headRepositoryOwner: { login: "owner" },
  };
}

test("spawn preserves successful dependency state after root failure and resumes from the first unfinished repo", () => {
  const sandbox = makeTempDir("recovery");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");

  const depRoot = createRepo(path.join(sandbox, "dep"), {
    "services/db/.env.local": "PORT=5432\n",
    "monke.yml": `apps:
  db:
    path: services/db
    envFile: .env.local
    mappings:
      - port: DEP_POSTGRES_PORT
        env: PORT
`,
  });

  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
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

  expect(() => {
    runMonke({
      cwd: root,
      args: ["spawn", "resume"],
      monkeHome: home,
      binDirectory,
    });
  }).toThrow(/Missing mapped env vars/);

  const depWorktree = getExpectedWorktreePath(home, depRoot, "resume");
  const firstMtime = statSync(path.join(depWorktree, ".env")).mtimeMs;

  const partialState = readSingleYamlFile(path.join(home, "sessions")) as {
    repos: Array<{ sourceRoot: string; materializationComplete?: boolean }>;
  };
  expect(partialState.repos.map((repo) => repo.sourceRoot)).toEqual([depRoot, root]);
  expect(partialState.repos[1]?.materializationComplete).toBe(false);

  write(root, "apps/api/.env.local", "PORT=3000\nDATABASE_URL=postgres://localhost:5432/app\n");
  write(
    getExpectedWorktreePath(home, root, "resume"),
    "apps/api/.env.local",
    "PORT=3000\nDATABASE_URL=postgres://localhost:5432/app\n",
  );

  runMonke({
    cwd: root,
    args: ["spawn", "resume"],
    monkeHome: home,
    binDirectory,
  });

  const secondMtime = statSync(path.join(depWorktree, ".env")).mtimeMs;
  expect(secondMtime).toBe(firstMtime);
  expect(read(getExpectedWorktreePath(home, root, "resume"), "apps/api/.env.local")).toBe(
    "PORT=11000\nDATABASE_URL=postgres://localhost:10000/app\n",
  );
});

test("materialize recreates a missing dependency worktree", () => {
  const sandbox = makeTempDir("recreate-dependency");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");

  const depRoot = createRepo(path.join(sandbox, "dep"), {
    "services/db/.env.local": "PORT=5432\n",
    "monke.yml": `apps:
  db:
    path: services/db
    envFile: .env.local
    mappings:
      - port: DEP_POSTGRES_PORT
        env: PORT
`,
  });

  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\nDATABASE_URL=postgres://localhost:5432/app\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
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
    cwd: root,
    args: ["spawn", "heal"],
    monkeHome: home,
    binDirectory,
  });

  const depWorktree = getExpectedWorktreePath(home, depRoot, "heal");
  git(depRoot, ["worktree", "remove", depWorktree, "--force"]);
  expect(existsSync(depWorktree)).toBe(false);

  runMonke({
    cwd: getExpectedWorktreePath(home, root, "heal"),
    args: ["materialize"],
    monkeHome: home,
    binDirectory,
  });

  expect(existsSync(depWorktree)).toBe(true);
  expect(read(depWorktree, ".env")).toBe("DEP_POSTGRES_PORT=10000\n");
});

test("materialize from the root worktree re-applies dependency repos", () => {
  const sandbox = makeTempDir("rematerialize-dependency");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");

  const depRoot = createRepo(path.join(sandbox, "dep"), {
    "services/db/.env.local": "PORT=5432\n",
    "monke.yml": `apps:
  db:
    path: services/db
    envFile: .env.local
    mappings:
      - port: DEP_POSTGRES_PORT
        env: PORT
`,
  });

  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\nDATABASE_URL=postgres://localhost:5432/app\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
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
    cwd: root,
    args: ["spawn", "refresh"],
    monkeHome: home,
    binDirectory,
  });

  const depWorktree = getExpectedWorktreePath(home, depRoot, "refresh");
  write(depWorktree, "services/db/.env.local", "PORT=5432\n");
  write(depWorktree, ".env", "");

  runMonke({
    cwd: getExpectedWorktreePath(home, root, "refresh"),
    args: ["materialize"],
    monkeHome: home,
    binDirectory,
  });

  expect(read(depWorktree, "services/db/.env.local")).toBe("PORT=10000\n");
  expect(read(depWorktree, ".env")).toBe("DEP_POSTGRES_PORT=10000\n");
});

test("bootstrap failure is fatal for spawn and surfaces the repo and command", () => {
  const sandbox = makeTempDir("bootstrap-failure");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");

  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `bootstrapCommand: exit 7
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });

  expect(() => {
    runMonke({
      cwd: root,
      args: ["spawn", "boom"],
      monkeHome: home,
      binDirectory,
    });
  }).toThrow(new RegExp(`Bootstrap command failed for ${root}: exit 7`));
});

test("cleanup removes dead session state but leaves repo reservations intact", () => {
  const sandbox = makeTempDir("cleanup");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");

  const root = createRepo(path.join(sandbox, "root"), {
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
    cwd: root,
    args: ["spawn", "clean-me"],
    monkeHome: home,
    binDirectory,
  });

  const worktree = getExpectedWorktreePath(home, root, "clean-me");
  git(root, ["worktree", "remove", worktree, "--force"]);

  runMonke({
    cwd: root,
    args: ["cleanup"],
    monkeHome: home,
    binDirectory,
  });

  expect(() => readSingleYamlFile(path.join(home, "sessions"))).toThrow();
  const reservationState = readSingleYamlFile(path.join(home, "repo-reservations")) as {
    sourceRoot: string;
  };
  expect(reservationState.sourceRoot).toBe(root);
});

test("cleanup removes dead no-config session state", () => {
  const sandbox = makeTempDir("cleanup-no-config");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");

  const root = createRepo(path.join(sandbox, "root"), {
    "README.md": "# root\n",
  });

  const spawn = runMonke({
    cwd: root,
    args: ["spawn", "banana"],
    monkeHome: home,
    binDirectory,
  });
  expect(spawn.stderr).toContain("Warning:");

  rmSync(getExpectedWorktreePath(home, root, "banana"), { recursive: true, force: true });

  runMonke({
    cwd: root,
    args: ["cleanup"],
    monkeHome: home,
    binDirectory,
  });

  expect(() => readSingleYamlFile(path.join(home, "sessions"))).toThrow();
});

test("cleanup --merged --dry-run reports eligible and skipped sessions without removing state", () => {
  const sandbox = makeTempDir("cleanup-merged-dry-run");
  const binDirectory = path.join(sandbox, "bin");
  const gitLog = installGitShim(binDirectory);
  const home = path.join(sandbox, "home");

  const root = createRepo(path.join(sandbox, "root"), {
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

  runMonke({
    cwd: root,
    args: ["spawn", "clean-merged"],
    monkeHome: home,
    binDirectory,
  });
  const cleanWorktree = getExpectedWorktreePath(home, root, "clean-merged");
  git(cleanWorktree, ["add", "-A"]);
  git(cleanWorktree, ["commit", "-m", "session clean merged"]);
  const cleanHead = git(cleanWorktree, ["rev-parse", "HEAD"]);

  runMonke({
    cwd: root,
    args: ["spawn", "dirty-untracked"],
    monkeHome: home,
    binDirectory,
  });
  const dirtyWorktree = getExpectedWorktreePath(home, root, "dirty-untracked");
  git(dirtyWorktree, ["add", "-A"]);
  git(dirtyWorktree, ["commit", "-m", "session dirty merged"]);
  const dirtyHead = git(dirtyWorktree, ["rev-parse", "HEAD"]);
  write(dirtyWorktree, "scratch.txt", "keep me\n");

  installFakeGhForMergedPrs(binDirectory, {
    repo: "owner/repo",
    prsByHead: {
      "clean-merged": [
        mergedPr({ number: 10, head: "clean-merged", base: "main", headRefOid: cleanHead }),
      ],
      "dirty-untracked": [
        mergedPr({
          number: 11,
          head: "dirty-untracked",
          base: "main",
          headRefOid: dirtyHead,
        }),
      ],
    },
  });
  const gitLogBeforeCleanup = readFileSync(gitLog, "utf8");

  const result = runMonke({
    cwd: root,
    args: ["cleanup", "--merged", "--dry-run"],
    monkeHome: home,
    binDirectory,
  });

  expect(result.stderr).toContain(
    `Would remove merged worktree clean-merged ${root}: ${cleanWorktree}`,
  );
  expect(result.stderr).toContain(
    `Skipped merged worktree dirty-untracked ${root}: worktree has 1 dirty/untracked status line(s)`,
  );
  expect(result.stderr).toContain(
    "Merged cleanup dry-run: would remove 1 worktree, skipped 1 worktree",
  );
  expect(existsSync(cleanWorktree)).toBe(true);
  expect(existsSync(dirtyWorktree)).toBe(true);
  expect(
    readdirSync(path.join(home, "sessions")).filter((entry) => entry.endsWith(".yml")),
  ).toHaveLength(2);
  expect(readFileSync(gitLog, "utf8").slice(gitLogBeforeCleanup.length)).not.toContain(
    "fetch --prune origin",
  );
});

test("cleanup --merged removes eligible worktrees and preserves branch refs", () => {
  const sandbox = makeTempDir("cleanup-merged-remove");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");

  const root = createRepo(path.join(sandbox, "root"), {
    ".gitignore": "ignored-cache\nignored-dir/\n",
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `cleanupCommand: 'printf "%s\\n%s\\n" "$MONKE_SESSION" "$MONKE_WORKTREE_PATH" > cleanup-merged.log'
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
    cwd: root,
    args: ["spawn", "clean-merged"],
    monkeHome: home,
    binDirectory,
  });
  const worktree = getExpectedWorktreePath(home, root, "clean-merged");
  git(worktree, ["add", "-A"]);
  git(worktree, ["commit", "-m", "session clean merged"]);
  const head = git(worktree, ["rev-parse", "HEAD"]);
  write(worktree, "ignored-cache", "delete with worktree\n");
  write(worktree, "ignored-dir/cache.txt", "delete with worktree\n");

  installFakeGhForMergedPrs(binDirectory, {
    repo: "owner/repo",
    prsByHead: {
      "clean-merged": [
        mergedPr({ number: 12, head: "clean-merged", base: "main", headRefOid: head }),
      ],
    },
  });

  const result = runMonke({
    cwd: root,
    args: ["cleanup", "--merged"],
    monkeHome: home,
    binDirectory,
  });

  expect(result.stderr).toContain(`Removed merged worktree clean-merged ${root}: ${worktree}`);
  expect(result.stderr).toContain("Merged cleanup: removed 1 worktree, skipped 0 worktrees");
  expect(result.stderr).toContain("Removed 1 dead session");
  expect(existsSync(worktree)).toBe(false);
  expect(read(root, "cleanup-merged.log")).toBe(`clean-merged\n${worktree}\n`);
  expect(() =>
    git(root, ["show-ref", "--verify", "--quiet", "refs/heads/clean-merged"]),
  ).not.toThrow();
  expect(() => readSingleYamlFile(path.join(home, "sessions"))).toThrow();
});

test("cleanup --merged resolves repo metadata once per source repo", () => {
  const sandbox = makeTempDir("cleanup-merged-lookup-cache");
  const binDirectory = path.join(sandbox, "bin");
  const gitLog = installGitShim(binDirectory);
  const home = path.join(sandbox, "home");

  const root = createRepo(path.join(sandbox, "root"), {
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

  runMonke({
    cwd: root,
    args: ["spawn", "clean-one"],
    monkeHome: home,
    binDirectory,
  });
  const firstWorktree = getExpectedWorktreePath(home, root, "clean-one");
  git(firstWorktree, ["add", "-A"]);
  git(firstWorktree, ["commit", "-m", "session clean one"]);
  const firstHead = git(firstWorktree, ["rev-parse", "HEAD"]);

  runMonke({
    cwd: root,
    args: ["spawn", "clean-two"],
    monkeHome: home,
    binDirectory,
  });
  const secondWorktree = getExpectedWorktreePath(home, root, "clean-two");
  git(secondWorktree, ["add", "-A"]);
  git(secondWorktree, ["commit", "-m", "session clean two"]);
  const secondHead = git(secondWorktree, ["rev-parse", "HEAD"]);

  const ghLog = installFakeGhForMergedPrs(binDirectory, {
    repo: "owner/repo",
    prsByHead: {
      "clean-one": [
        mergedPr({ number: 20, head: "clean-one", base: "main", headRefOid: firstHead }),
      ],
      "clean-two": [
        mergedPr({ number: 21, head: "clean-two", base: "main", headRefOid: secondHead }),
      ],
    },
  });

  runMonke({
    cwd: root,
    args: ["cleanup", "--merged", "--dry-run"],
    monkeHome: home,
    binDirectory,
  });

  const dryRunGhCalls = readFileSync(ghLog, "utf8").trim().split("\n");
  expect(dryRunGhCalls.filter((call) => call.startsWith("repo view "))).toHaveLength(1);
  expect(dryRunGhCalls.filter((call) => call.startsWith("pr list "))).toHaveLength(2);

  const gitLogBeforeCleanup = readFileSync(gitLog, "utf8");
  runMonke({
    cwd: root,
    args: ["cleanup", "--merged"],
    monkeHome: home,
    binDirectory,
  });

  const cleanupGitCalls = readFileSync(gitLog, "utf8").slice(gitLogBeforeCleanup.length);
  expect(
    cleanupGitCalls.split("\n").filter((call) => call === "fetch --prune origin"),
  ).toHaveLength(1);
});

test("cleanup --merged skips safely when GitHub metadata is unavailable", () => {
  const sandbox = makeTempDir("cleanup-merged-no-gh");
  const binDirectory = path.join(sandbox, "bin");
  installGitShim(binDirectory);
  const home = path.join(sandbox, "home");

  const root = createRepo(path.join(sandbox, "root"), {
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

  runMonke({
    cwd: root,
    args: ["spawn", "clean-merged"],
    monkeHome: home,
    binDirectory,
    extraEnv: { PATH: binDirectory },
  });
  const worktree = getExpectedWorktreePath(home, root, "clean-merged");
  git(worktree, ["add", "-A"]);
  git(worktree, ["commit", "-m", "session clean merged"]);

  const result = runMonke({
    cwd: root,
    args: ["cleanup", "--merged"],
    monkeHome: home,
    binDirectory,
    extraEnv: { PATH: binDirectory },
  });

  expect(result.stderr).toContain(
    `Skipped merged worktree clean-merged ${root}: GitHub repository lookup failed`,
  );
  expect(result.stderr).toContain("Merged cleanup: removed 0 worktrees, skipped 1 worktree");
  expect(result.stderr).toContain("Removed 0 dead sessions");
  expect(existsSync(worktree)).toBe(true);
  expect(readSingleYamlFile(path.join(home, "sessions"))).toBeDefined();
});

test("cleanup --merged fails closed for malformed GitHub PR metadata", () => {
  const sandbox = makeTempDir("cleanup-merged-malformed-gh");
  const binDirectory = path.join(sandbox, "bin");
  installGitShim(binDirectory);
  const home = path.join(sandbox, "home");
  const root = createRepo(path.join(sandbox, "root"), {
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

  runMonke({
    cwd: root,
    args: ["spawn", "clean-merged"],
    monkeHome: home,
    binDirectory,
  });
  const worktree = getExpectedWorktreePath(home, root, "clean-merged");
  git(worktree, ["add", "-A"]);
  git(worktree, ["commit", "-m", "session clean merged"]);
  installFakeGhForMergedPrs(binDirectory, {
    repo: "owner/repo",
    prsByHead: {
      "clean-merged": [
        {
          number: "not-a-number",
          headRefName: "clean-merged",
          baseRefName: "main",
          headRefOid: git(worktree, ["rev-parse", "HEAD"]),
          isCrossRepository: false,
        },
      ],
    },
  });

  const result = runMonke({
    cwd: root,
    args: ["cleanup", "--merged"],
    monkeHome: home,
    binDirectory,
  });

  expect(result.stderr).toContain("no exact merged PR match");
  expect(result.stderr).toContain("Merged cleanup: removed 0 worktrees, skipped 1 worktree");
  expect(existsSync(worktree)).toBe(true);
  expect(readSingleYamlFile(path.join(home, "sessions"))).toBeDefined();
});

test("cleanup --merged keeps session state when cleanupCommand fails after worktree removal", () => {
  const sandbox = makeTempDir("cleanup-merged-command-failure");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");

  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `cleanupCommand: 'printf "%s\\n" "$MONKE_SESSION" > cleanup-merged-failure.log; echo cleanup failed >&2; exit 9'
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
    cwd: root,
    args: ["spawn", "clean-merged"],
    monkeHome: home,
    binDirectory,
  });
  const worktree = getExpectedWorktreePath(home, root, "clean-merged");
  git(worktree, ["add", "-A"]);
  git(worktree, ["commit", "-m", "session clean merged"]);
  const head = git(worktree, ["rev-parse", "HEAD"]);

  installFakeGhForMergedPrs(binDirectory, {
    repo: "owner/repo",
    prsByHead: {
      "clean-merged": [
        mergedPr({ number: 13, head: "clean-merged", base: "main", headRefOid: head }),
      ],
    },
  });

  expect(() =>
    runMonke({
      cwd: root,
      args: ["cleanup", "--merged"],
      monkeHome: home,
      binDirectory,
    }),
  ).toThrow(/Cleanup command failed.*cleanup failed/s);

  expect(existsSync(worktree)).toBe(false);
  expect(read(root, "cleanup-merged-failure.log")).toBe("clean-merged\n");
  expect(readSingleYamlFile(path.join(home, "sessions"))).toBeDefined();
});

test("cleanupCommand runs only for dead worktrees and removes state after success", () => {
  const sandbox = makeTempDir("cleanup-command");
  const binDirectory = path.join(sandbox, "bin");
  const shLogPath = installShShim(binDirectory);
  const home = path.join(sandbox, "home");

  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `cleanupCommand: 'printf "%s\\n%s\\n%s\\n%s\\n%s\\n" "$PWD" "$DISCORD_CHANNEL" "$MONKE_SESSION" "$MONKE_SOURCE_ROOT" "$MONKE_WORKTREE_PATH" > cleanup.log'
resources:
  values:
    DISCORD_CHANNEL: mt-\${user}-\${session}
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
    cwd: root,
    args: ["spawn", "clean-command"],
    monkeHome: home,
    binDirectory,
    extraEnv: { USER: "ada" },
  });

  const liveCleanup = runMonke({
    cwd: root,
    args: ["cleanup"],
    monkeHome: home,
    binDirectory,
  });
  expect(liveCleanup.stderr).toContain("Removed 0 dead sessions");
  expect(existsSync(path.join(root, "cleanup.log"))).toBe(false);

  const worktree = getExpectedWorktreePath(home, root, "clean-command");
  git(root, ["worktree", "remove", worktree, "--force"]);

  runMonke({
    cwd: root,
    args: ["cleanup"],
    monkeHome: home,
    binDirectory,
  });

  expect(read(root, "cleanup.log")).toBe(
    `${root}\nmt-ada-clean-command\nclean-command\n${root}\n${worktree}\n`,
  );
  const shellArgs = readFileSync(shLogPath, "utf8").trim().split("\n");
  expect(shellArgs.filter((arg) => arg === "-c")).toHaveLength(1);
  expect(shellArgs).not.toContain("-lc");
  expect(() => readSingleYamlFile(path.join(home, "sessions"))).toThrow();
});

test("cleanupCommand receives resource command output env", () => {
  const sandbox = makeTempDir("cleanup-command-resource-output");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");

  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `cleanupCommand: 'printf "%s\\n%s\\n" "$E2E_FLOW1_SYMBOL" "$MONKE_SESSION" > cleanup-resource-command.log'
resources:
  commands:
    e2e-symbols:
      run: ./scripts/e2e-symbols.ts
      outputs:
        - E2E_FLOW1_SYMBOL
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
    "scripts/e2e-symbols.ts": `export default function () {
  return { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
}
`,
  });

  runMonke({
    cwd: root,
    args: ["spawn", "clean-command"],
    monkeHome: home,
    binDirectory,
  });

  const worktree = getExpectedWorktreePath(home, root, "clean-command");
  git(root, ["worktree", "remove", worktree, "--force"]);

  runMonke({
    cwd: root,
    args: ["cleanup"],
    monkeHome: home,
    binDirectory,
  });

  expect(read(root, "cleanup-resource-command.log")).toBe("SOL/USDT:USDT\nclean-command\n");
  expect(() => readSingleYamlFile(path.join(home, "sessions"))).toThrow();
});

test("cleanupCommand uses the command remembered in session state after config drift", () => {
  const sandbox = makeTempDir("cleanup-command-config-drift");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");

  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `cleanupCommand: 'printf "%s\\n%s\\n" "$MONKE_SESSION" "$MONKE_SOURCE_ROOT" > cleanup-drift.log'
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
    cwd: root,
    args: ["spawn", "drift-clean"],
    monkeHome: home,
    binDirectory,
  });

  write(
    root,
    "monke.yml",
    `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  );
  git(root, ["worktree", "remove", getExpectedWorktreePath(home, root, "drift-clean"), "--force"]);

  runMonke({
    cwd: root,
    args: ["cleanup"],
    monkeHome: home,
    binDirectory,
  });

  expect(read(root, "cleanup-drift.log")).toBe(`drift-clean\n${root}\n`);
  expect(() => readSingleYamlFile(path.join(home, "sessions"))).toThrow();
});

test("one failing cleanupCommand does not block other dead sessions", () => {
  const sandbox = makeTempDir("cleanup-command-failure-isolation");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");

  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `cleanupCommand: 'printf "%s\\n" "$MONKE_SESSION" >> cleanup-attempts.log; echo cleanup failed >&2; exit 1'
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
    cwd: root,
    args: ["spawn", "retry-one"],
    monkeHome: home,
    binDirectory,
  });
  runMonke({
    cwd: root,
    args: ["spawn", "retry-two"],
    monkeHome: home,
    binDirectory,
  });

  rmSync(getExpectedWorktreePath(home, root, "retry-one"), { recursive: true, force: true });
  rmSync(getExpectedWorktreePath(home, root, "retry-two"), { recursive: true, force: true });

  let thrown: unknown;
  try {
    runMonke({
      cwd: root,
      args: ["cleanup"],
      monkeHome: home,
      binDirectory,
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain("retry-one");
  expect((thrown as Error).message).toContain("retry-two");
  expect(read(root, "cleanup-attempts.log").trim().split("\n").sort()).toEqual([
    "retry-one",
    "retry-two",
  ]);
  expect(existsSync(getSessionStateFilePath(home, root, "retry-one"))).toBe(true);
  expect(existsSync(getSessionStateFilePath(home, root, "retry-two"))).toBe(true);
});

test("cleanupCommand failure keeps session state for retry", () => {
  const sandbox = makeTempDir("cleanup-command-failure");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");

  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `cleanupCommand: 'printf "%s\\n" "$DISCORD_CHANNEL" > cleanup-failure.log; echo cleanup failed >&2; exit 9'
resources:
  values:
    DISCORD_CHANNEL: mt-\${session}
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
    cwd: root,
    args: ["spawn", "retry-me"],
    monkeHome: home,
    binDirectory,
  });

  git(root, ["worktree", "remove", getExpectedWorktreePath(home, root, "retry-me"), "--force"]);

  expect(() =>
    runMonke({
      cwd: root,
      args: ["cleanup"],
      monkeHome: home,
      binDirectory,
    }),
  ).toThrow(/Cleanup command failed.*cleanup failed/s);

  expect(read(root, "cleanup-failure.log")).toBe("mt-retry-me\n");
  const retainedState = readSingleYamlFile(path.join(home, "sessions")) as {
    repos: Array<{ resourceValues?: Array<{ env: string; value: string }> }>;
  };
  expect(retainedState.repos[0]?.resourceValues).toEqual([
    { env: "DISCORD_CHANNEL", value: "mt-retry-me" },
  ]);
});
