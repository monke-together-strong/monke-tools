import { expect, test } from "vitest";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { getExpectedWorktreePath } from "../src/git.ts";
import {
  createRepo,
  git,
  installFailingBrew,
  installFakeBrew,
  installGitShim,
  installNoopBrew,
  installFakeWt,
  makeTempDir,
  read,
  readSingleYamlFile,
  runMonke,
  write,
} from "./helpers.ts";

test("create preserves successful dependency state after root failure and resumes from the first unfinished repo", () => {
  const sandbox = makeTempDir("recovery");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
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
      args: ["create", "resume"],
      monkeHome: home,
      binDirectory,
    });
  }).toThrow(/Missing mapped env vars/);

  const depWorktree = getExpectedWorktreePath(depRoot, "resume");
  const firstMtime = statSync(path.join(depWorktree, ".env")).mtimeMs;

  const partialState = readSingleYamlFile(path.join(home, "sessions")) as {
    repos: Array<{ sourceRoot: string }>;
  };
  expect(partialState.repos.map((repo) => repo.sourceRoot)).toEqual([depRoot]);

  write(root, "apps/api/.env.local", "PORT=3000\nDATABASE_URL=postgres://localhost:5432/app\n");
  write(
    getExpectedWorktreePath(root, "resume"),
    "apps/api/.env.local",
    "PORT=3000\nDATABASE_URL=postgres://localhost:5432/app\n",
  );

  runMonke({
    cwd: root,
    args: ["create", "resume"],
    monkeHome: home,
    binDirectory,
  });

  const secondMtime = statSync(path.join(depWorktree, ".env")).mtimeMs;
  expect(secondMtime).toBe(firstMtime);
  expect(read(getExpectedWorktreePath(root, "resume"), "apps/api/.env.local")).toBe(
    "PORT=10001\nDATABASE_URL=postgres://localhost:10000/app\n",
  );
});

test("materialize recreates a missing dependency worktree", () => {
  const sandbox = makeTempDir("recreate-dependency");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
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
    args: ["create", "heal"],
    monkeHome: home,
    binDirectory,
  });

  const depWorktree = getExpectedWorktreePath(depRoot, "heal");
  git(depRoot, ["worktree", "remove", depWorktree, "--force"]);
  expect(existsSync(depWorktree)).toBe(false);

  runMonke({
    cwd: getExpectedWorktreePath(root, "heal"),
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
  installFakeWt(binDirectory);
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
    args: ["create", "refresh"],
    monkeHome: home,
    binDirectory,
  });

  const depWorktree = getExpectedWorktreePath(depRoot, "refresh");
  write(depWorktree, "services/db/.env.local", "PORT=5432\n");
  write(depWorktree, ".env", "");

  runMonke({
    cwd: getExpectedWorktreePath(root, "refresh"),
    args: ["materialize"],
    monkeHome: home,
    binDirectory,
  });

  expect(read(depWorktree, "services/db/.env.local")).toBe("PORT=10000\n");
  expect(read(depWorktree, ".env")).toBe("DEP_POSTGRES_PORT=10000\n");
});

test("bootstrap failure is fatal for create and surfaces the repo and command", () => {
  const sandbox = makeTempDir("bootstrap-failure");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
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
      args: ["create", "boom"],
      monkeHome: home,
      binDirectory,
    });
  }).toThrow(new RegExp(`Bootstrap command failed for ${root}: exit 7`));
});

test("cleanup removes dead session state but leaves repo reservations intact", () => {
  const sandbox = makeTempDir("cleanup");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
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
    args: ["create", "clean-me"],
    monkeHome: home,
    binDirectory,
  });

  const worktree = getExpectedWorktreePath(root, "clean-me");
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

test("cleanupCommand runs only for dead worktrees and removes state after success", () => {
  const sandbox = makeTempDir("cleanup-command");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
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
    args: ["create", "clean-command"],
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
  expect(liveCleanup.stdout).toContain("Removed 0 dead sessions");
  expect(existsSync(path.join(root, "cleanup.log"))).toBe(false);

  const worktree = getExpectedWorktreePath(root, "clean-command");
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
  expect(() => readSingleYamlFile(path.join(home, "sessions"))).toThrow();
});

test("cleanupCommand failure keeps session state for retry", () => {
  const sandbox = makeTempDir("cleanup-command-failure");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
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
    args: ["create", "retry-me"],
    monkeHome: home,
    binDirectory,
  });

  git(root, ["worktree", "remove", getExpectedWorktreePath(root, "retry-me"), "--force"]);

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

test("create installs worktrunk through Homebrew and configures shell integration when wt is missing", () => {
  const sandbox = makeTempDir("bootstrap");
  const binDirectory = path.join(sandbox, "bin");
  installGitShim(binDirectory);
  const brewLog = installFakeBrew(binDirectory);
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
    args: ["create", "brew-me"],
    monkeHome: home,
    binDirectory,
    extraEnv: { PATH: binDirectory },
  });

  expect(read(path.dirname(brewLog), "brew.log")).toContain("install worktrunk");
  expect(existsSync(path.join(binDirectory, "wt"))).toBe(true);
  expect(read(path.dirname(brewLog), "wt.log")).toContain("config shell install");
});

test("create fails when wt is missing and Homebrew is unavailable", () => {
  const sandbox = makeTempDir("bootstrap-no-brew");
  const binDirectory = path.join(sandbox, "empty-bin");
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

  expect(() => {
    runMonke({
      cwd: root,
      args: ["create", "no-brew"],
      monkeHome: home,
      binDirectory,
      extraEnv: { PATH: binDirectory },
    });
  }).toThrow(/Homebrew is not available/);
});

test("create surfaces Homebrew install failures when wt bootstrap does not succeed", () => {
  const sandbox = makeTempDir("bootstrap-brew-fails");
  const binDirectory = path.join(sandbox, "bin");
  installGitShim(binDirectory);
  const brewLog = installFailingBrew(binDirectory);
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

  expect(() => {
    runMonke({
      cwd: root,
      args: ["create", "brew-fails"],
      monkeHome: home,
      binDirectory,
      extraEnv: { PATH: binDirectory },
    });
  }).toThrow(/Command failed: .*brew install worktrunk/);
  expect(read(path.dirname(brewLog), "brew.log")).toContain("install worktrunk");
});

test("create fails if Homebrew finishes but wt is still missing", () => {
  const sandbox = makeTempDir("bootstrap-no-wt");
  const binDirectory = path.join(sandbox, "bin");
  installGitShim(binDirectory);
  const brewLog = installNoopBrew(binDirectory);
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

  expect(() => {
    runMonke({
      cwd: root,
      args: ["create", "brew-no-wt"],
      monkeHome: home,
      binDirectory,
      extraEnv: { PATH: binDirectory },
    });
  }).toThrow(/could not find wt on PATH/);
  expect(read(path.dirname(brewLog), "brew.log")).toContain("install worktrunk");
});
