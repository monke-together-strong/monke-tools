import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { getExpectedWorktreePath } from "../src/git.ts";
import { getSessionStateFilePath } from "../src/session-state-store.ts";
import { RepoReservationSchema, SessionStateSchema } from "../src/state-schema.ts";
import {
  createRepo,
  git,
  installShShim,
  makeTempDir,
  read,
  readSingleYamlFile,
  runMonke,
  runMonkeCapturingFailure,
  write
} from "./helpers.ts";

describe("recovery, bootstrap, and cleanup", () => {
  test("spawn preserves successful dependency state after root failure and resumes from the first unfinished repo", () => {
    const sandbox = makeTempDir("recovery");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");

    const depRoot = createRepo(path.join(sandbox, "dep"), {
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
`
    });

    expect(() => {
      runMonke({
        args: ["spawn", "resume"],
        binDirectory,
        cwd: root,
        monkeHome: home
      });
    }).toThrow(/Missing mapped env vars/u);

    const depWorktree = getExpectedWorktreePath(home, depRoot, "resume");
    const firstMtime = statSync(path.join(depWorktree, ".env")).mtimeMs;

    const partialState = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    expect(partialState.repos.map((repo) => repo.sourceRoot)).toStrictEqual([depRoot, root]);
    expect(partialState.repos[1]?.materializationStatus).toBe("failed");

    write(root, "apps/api/.env.local", "PORT=3000\nDATABASE_URL=postgres://localhost:5432/app\n");
    write(
      getExpectedWorktreePath(home, root, "resume"),
      "apps/api/.env.local",
      "PORT=3000\nDATABASE_URL=postgres://localhost:5432/app\n"
    );

    runMonke({
      args: ["spawn", "resume"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    const secondMtime = statSync(path.join(depWorktree, ".env")).mtimeMs;
    expect(secondMtime).toBe(firstMtime);
    expect(read(getExpectedWorktreePath(home, root, "resume"), "apps/api/.env.local")).toBe(
      "PORT=11000\nDATABASE_URL=postgres://localhost:10000/app\n"
    );
  });

  test("materialize recreates a missing dependency worktree", () => {
    const sandbox = makeTempDir("recreate-dependency");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");

    const depRoot = createRepo(path.join(sandbox, "dep"), {
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
`
    });

    runMonke({
      args: ["spawn", "heal"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    const depWorktree = getExpectedWorktreePath(home, depRoot, "heal");
    git(depRoot, ["worktree", "remove", depWorktree, "--force"]);
    expect(existsSync(depWorktree)).toBeFalsy();

    runMonke({
      args: ["materialize"],
      binDirectory,
      cwd: getExpectedWorktreePath(home, root, "heal"),
      monkeHome: home
    });

    expect(existsSync(depWorktree)).toBeTruthy();
    expect(read(depWorktree, ".env")).toBe("DEP_POSTGRES_PORT=10000\n");
  });

  test("Materialize from the Session worktree for the Root repo re-applies Dependency repos", () => {
    const sandbox = makeTempDir("rematerialize-dependency");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");

    const depRoot = createRepo(path.join(sandbox, "dep"), {
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
`
    });

    runMonke({
      args: ["spawn", "refresh"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    const depWorktree = getExpectedWorktreePath(home, depRoot, "refresh");
    write(depWorktree, "services/db/.env.local", "PORT=5432\n");
    write(depWorktree, ".env", "");

    runMonke({
      args: ["materialize"],
      binDirectory,
      cwd: getExpectedWorktreePath(home, root, "refresh"),
      monkeHome: home
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
`
    });

    expect(() => {
      runMonke({
        args: ["spawn", "boom"],
        binDirectory,
        cwd: root,
        monkeHome: home
      });
    }).toThrow(`Bootstrap command failed for ${root}: exit 7`);
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
`
    });

    runMonke({
      args: ["spawn", "clean-me"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    const worktree = getExpectedWorktreePath(home, root, "clean-me");
    git(root, ["worktree", "remove", worktree, "--force"]);

    runMonke({
      args: ["cleanup"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    expect(() => readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema)).toThrow(
      /Expected exactly one yaml file.*found 0/u
    );
    const reservationState = readSingleYamlFile(
      path.join(home, "repo-reservations"),
      RepoReservationSchema
    );
    expect(reservationState.sourceRoot).toBe(root);
  });

  test("cleanup removes dead no-config session state", () => {
    const sandbox = makeTempDir("cleanup-no-config");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");

    const root = createRepo(path.join(sandbox, "root"), {
      "README.md": "# root\n"
    });

    const spawn = runMonkeCapturingFailure({
      args: ["spawn", "banana"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });
    expect(spawn.stderr).toContain("Warning:");

    rmSync(getExpectedWorktreePath(home, root, "banana"), { force: true, recursive: true });

    runMonke({
      args: ["cleanup"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    expect(() => readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema)).toThrow(
      /Expected exactly one yaml file.*found 0/u
    );
  });

  test("missing worktree cleanup requires explicit source recovery", () => {
    const sandbox = makeTempDir("cleanup-command");
    const binDirectory = path.join(sandbox, "bin");
    const shLogPath = installShShim(binDirectory);
    const home = path.join(sandbox, "home");

    const root = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\n",
      "monke.yml": `bootstrapCommand: ':'
cleanupCommand: 'printf "%s\\n%s\\n%s\\n%s\\n%s\\n" "$PWD" "$DISCORD_CHANNEL" "$MONKE_SESSION" "$MONKE_SOURCE_ROOT" "$MONKE_WORKTREE_PATH" > cleanup.log'
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
`
    });

    runMonke({
      args: ["spawn", "clean-command"],
      binDirectory,
      cwd: root,
      extraEnv: { USER: "ada" },
      monkeHome: home
    });

    const liveCleanup = runMonke({
      args: ["cleanup"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });
    expect(liveCleanup.stdout).toContain("Skipped:");
    expect(existsSync(path.join(root, "cleanup.log"))).toBeFalsy();
    const shellLogBeforeDeadCleanup = readFileSync(shLogPath, "utf-8");

    const worktree = getExpectedWorktreePath(home, root, "clean-command");
    git(root, ["worktree", "remove", worktree, "--force"]);

    const missing = runMonkeCapturingFailure({
      args: ["cleanup"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });
    expect(missing.error).toBeInstanceOf(Error);
    expect(missing.stdout).toContain("Session worktree is missing");
    expect(existsSync(path.join(root, "cleanup.log"))).toBeFalsy();
    expect(existsSync(getSessionStateFilePath(home, root, "clean-command"))).toBeTruthy();
    runMonke({
      args: ["chop", "clean-command", "--cleanup-from-source"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    expect(read(root, "cleanup.log")).toBe(
      `${root}\nmt-ada-clean-command\nclean-command\n${root}\n${worktree}\n`
    );
    const shellArgs = readFileSync(shLogPath, "utf-8")
      .slice(shellLogBeforeDeadCleanup.length)
      .trim()
      .split("\n");
    expect(shellArgs.filter((arg) => arg === "-c")).toHaveLength(1);
    expect(shellArgs).not.toContain("-lc");
    expect(() => readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema)).toThrow(
      /Expected exactly one yaml file.*found 0/u
    );
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
`
    });

    runMonke({
      args: ["spawn", "clean-command"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    const worktree = getExpectedWorktreePath(home, root, "clean-command");
    git(root, ["worktree", "remove", worktree, "--force"]);

    runMonke({
      args: ["chop", "clean-command", "--cleanup-from-source"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    expect(read(root, "cleanup-resource-command.log")).toBe("SOL/USDT:USDT\nclean-command\n");
    expect(() => readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema)).toThrow(
      /Expected exactly one yaml file.*found 0/u
    );
  });

  test("cleanupCommand uses the command remembered in session state after config drift", () => {
    const sandbox = makeTempDir("cleanup-command-config-drift");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");

    const root = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\n",
      "monke.yml": `bootstrapCommand: ':'
cleanupCommand: 'printf "%s\\n%s\\n" "$MONKE_SESSION" "$MONKE_SOURCE_ROOT" > cleanup-drift.log'
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
      args: ["spawn", "drift-clean"],
      binDirectory,
      cwd: root,
      monkeHome: home
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
`
    );
    git(root, [
      "worktree",
      "remove",
      getExpectedWorktreePath(home, root, "drift-clean"),
      "--force"
    ]);

    runMonke({
      args: ["chop", "drift-clean", "--cleanup-from-source"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    expect(read(root, "cleanup-drift.log")).toBe(`drift-clean\n${root}\n`);
    expect(() => readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema)).toThrow(
      /Expected exactly one yaml file.*found 0/u
    );
  });

  test("missing cleanup worktrees retain each Session without executing commands", () => {
    const sandbox = makeTempDir("cleanup-command-failure-isolation");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");

    const root = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\n",
      "monke.yml": `bootstrapCommand: ':'
cleanupCommand: 'printf "%s\\n" "$MONKE_SESSION" >> cleanup-attempts.log; echo cleanup failed >&2; exit 1'
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
      args: ["spawn", "retry-one"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });
    runMonke({
      args: ["spawn", "retry-two"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    rmSync(getExpectedWorktreePath(home, root, "retry-one"), { force: true, recursive: true });
    rmSync(getExpectedWorktreePath(home, root, "retry-two"), { force: true, recursive: true });

    const failure = runMonkeCapturingFailure({
      args: ["cleanup"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });
    expect(failure.error).toBeInstanceOf(Error);
    expect(failure.stdout).toContain("retry-one");
    expect(failure.stdout).toContain("retry-two");
    expect(existsSync(path.join(root, "cleanup-attempts.log"))).toBeFalsy();
    expect(failure.stdout).toContain("Session worktree is missing");
    expect(existsSync(getSessionStateFilePath(home, root, "retry-one"))).toBeTruthy();
    expect(existsSync(getSessionStateFilePath(home, root, "retry-two"))).toBeTruthy();
  });

  test("cleanupCommand failure keeps session state for retry", () => {
    const sandbox = makeTempDir("cleanup-command-failure");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");

    const root = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\n",
      "monke.yml": `bootstrapCommand: ':'
cleanupCommand: 'printf "%s\\n" "$DISCORD_CHANNEL" > cleanup-failure.log; echo cleanup failed >&2; exit 9'
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
`
    });

    runMonke({
      args: ["spawn", "retry-me"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    git(root, ["worktree", "remove", getExpectedWorktreePath(home, root, "retry-me"), "--force"]);

    const failure = runMonkeCapturingFailure({
      args: ["chop", "retry-me", "--cleanup-from-source"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });
    expect(failure.error).toBeInstanceOf(Error);
    expect(failure.stderr).toMatch(/Cleanup command failed.*cleanup failed/su);

    expect(read(root, "cleanup-failure.log")).toBe("mt-retry-me\n");
    const retainedState = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    expect(retainedState.repos[0]?.resourceValues).toStrictEqual([
      { env: "DISCORD_CHANNEL", value: "mt-retry-me" }
    ]);
  });
});
