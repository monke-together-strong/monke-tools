import { expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { getExpectedWorktreePath } from "../src/git.ts";
import {
  createRepo,
  git,
  installFakeBrew,
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
  const firstMtime = statSync(path.join(depWorktree, ".monke/ports.env")).mtimeMs;

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

  const secondMtime = statSync(path.join(depWorktree, ".monke/ports.env")).mtimeMs;
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
  expect(read(depWorktree, ".monke/ports.env")).toBe("DEP_POSTGRES_PORT=10000");
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

test("create installs worktrunk through Homebrew when wt is missing", () => {
  const sandbox = makeTempDir("bootstrap");
  const binDirectory = path.join(sandbox, "bin");
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
  });

  expect(read(path.dirname(brewLog), "brew.log")).toContain("install worktrunk");
  expect(existsSync(path.join(binDirectory, "wt"))).toBe(true);
});
