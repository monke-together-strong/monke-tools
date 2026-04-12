import { expect, test } from "vitest";
import path from "node:path";

import { inferSessionName, getExpectedWorktreePath } from "../src/git.ts";
import {
  createRepo,
  installFakeWt,
  makeTempDir,
  read,
  readSingleYamlFile,
  runMonke,
} from "./helpers.ts";

test("create bootstraps a single-repo session and rewrites only mapped env vars", () => {
  const sandbox = makeTempDir("single-repo");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    ".env.shared": "ROOT_ONLY=true\n",
    "apps/api/.env.local": "PORT=3000\nDATABASE_URL=postgres://localhost:5432/app\nOTHER=keep\n",
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
    cwd: repoRoot,
    args: ["create", "banana"],
    monkeHome: home,
    binDirectory,
  });

  const worktreeRoot = getExpectedWorktreePath(repoRoot, "banana");
  expect(read(worktreeRoot, ".env.shared")).toBe("ROOT_ONLY=true\n");
  expect(read(worktreeRoot, "apps/api/.env.local")).toBe(
    "PORT=10000\nDATABASE_URL=postgres://localhost:10001/app\nOTHER=keep\n",
  );
  expect(read(repoRoot, "apps/api/.env.local")).toBe(
    "PORT=3000\nDATABASE_URL=postgres://localhost:5432/app\nOTHER=keep\n",
  );
  expect(read(worktreeRoot, ".monke/ports.env")).toBe("API_PORT=10000\nDB_PORT=10001");

  const sessionState = readSingleYamlFile(path.join(home, "sessions")) as {
    repos: Array<{ sourceRoot: string; worktreePath: string }>;
  };
  expect(sessionState.repos).toHaveLength(1);
  expect(sessionState.repos[0]?.sourceRoot).toBe(repoRoot);
  expect(sessionState.repos[0]?.worktreePath).toBe(worktreeRoot);
});

test("materialize rejects source checkout context and reuses sticky ports inside a valid session worktree", () => {
  const sandbox = makeTempDir("single-materialize");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
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
    cwd: repoRoot,
    args: ["create", "banana"],
    monkeHome: home,
    binDirectory,
  });

  expect(() => {
    runMonke({
      cwd: repoRoot,
      args: ["materialize"],
      monkeHome: home,
      binDirectory,
    });
  }).toThrow(/must run inside a session worktree/);

  const worktreeRoot = getExpectedWorktreePath(repoRoot, "banana");
  expect(inferSessionName(worktreeRoot, "banana")).toBe("banana");
  expect(() => inferSessionName(worktreeRoot, "wrong")).toThrow(/match current branch/);

  const before = read(worktreeRoot, ".monke/ports.env");
  expect(before).toBe("API_PORT=10000\nDB_PORT=10001");

  runMonke({
    cwd: worktreeRoot,
    args: ["materialize"],
    monkeHome: home,
    binDirectory,
  });

  expect(read(worktreeRoot, ".monke/ports.env")).toBe(before);
});

test("setup creates the root .env with direct external path env defaults", () => {
  const sandbox = makeTempDir("setup-root-env");
  const home = path.join(sandbox, "home");
  createRepo(path.join(sandbox, "dep"), {
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
    "apps/api/.env.local": "DATABASE_URL=postgres://localhost:5432/app\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings: []
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
    args: ["setup"],
    monkeHome: home,
  });

  expect(read(root, ".env")).toBe("DEP_DIR=../dep\n");
});

test("setup overwrites stale external path env values and preserves unrelated root env entries", () => {
  const sandbox = makeTempDir("setup-root-env-refresh");
  const home = path.join(sandbox, "home");
  createRepo(path.join(sandbox, "dep"), {
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
    ".env": "KEEP_ME=1\nDEP_DIR=../old-location\n",
    "apps/api/.env.local": "DATABASE_URL=postgres://localhost:5432/app\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings: []
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
    args: ["setup"],
    monkeHome: home,
  });

  expect(read(root, ".env")).toBe("KEEP_ME=1\nDEP_DIR=../dep\n");
});

test("setup must run from the source checkout", () => {
  const sandbox = makeTempDir("setup-source-checkout-only");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  createRepo(path.join(sandbox, "dep"), {
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
    "apps/api/.env.local": "DATABASE_URL=postgres://localhost:5432/app\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings: []
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
    args: ["create", "banana"],
    monkeHome: home,
    binDirectory,
  });

  expect(() =>
    runMonke({
      cwd: getExpectedWorktreePath(root, "banana"),
      args: ["setup"],
      monkeHome: home,
      binDirectory,
    }),
  ).toThrow(/must run from the source checkout/);
});
