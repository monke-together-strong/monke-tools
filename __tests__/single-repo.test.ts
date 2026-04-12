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
  write,
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
  expect(read(worktreeRoot, ".env")).toBe("API_PORT=10000\nDB_PORT=10001\n");

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

  const before = read(worktreeRoot, ".env");
  expect(before).toBe("API_PORT=10000\nDB_PORT=10001\n");

  runMonke({
    cwd: worktreeRoot,
    args: ["materialize"],
    monkeHome: home,
    binDirectory,
  });

  expect(read(worktreeRoot, ".env")).toBe(before);
});

test("create and materialize run bootstrapCommand after env sync from the repo worktree root", () => {
  const sandbox = makeTempDir("single-bootstrap");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\nDATABASE_URL=postgres://localhost:5432/app\n",
    "monke.yml": `bootstrapCommand: grep -q 'PORT=10000' apps/api/.env.local && grep -q 'DB_PORT=10001' .env && pwd >> bootstrap-runs
apps:
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
  expect(read(worktreeRoot, "bootstrap-runs")).toBe(`${worktreeRoot}\n`);

  runMonke({
    cwd: worktreeRoot,
    args: ["materialize"],
    monkeHome: home,
    binDirectory,
  });

  expect(read(worktreeRoot, "bootstrap-runs")).toBe(`${worktreeRoot}\n${worktreeRoot}\n`);
});

test("create seeds configured directories and files into a new session worktree", () => {
  const sandbox = makeTempDir("single-seedpaths");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "apps/frostbite-crawler/data/sessions/hoangbn/Preferences": "{ \"theme\": \"dark\" }\n",
    "apps/frostbite-crawler/data/sessions/hoangbn/Cookies": "cookie-jar\n",
    "scripts/bootstrap.sh": "#!/bin/sh\necho seeded\n",
    "monke.yml": `seedPaths:
  - apps/frostbite-crawler/data/sessions
  - scripts/bootstrap.sh
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
    cwd: repoRoot,
    args: ["create", "banana"],
    monkeHome: home,
    binDirectory,
  });

  const worktreeRoot = getExpectedWorktreePath(repoRoot, "banana");
  expect(read(worktreeRoot, "apps/frostbite-crawler/data/sessions/hoangbn/Preferences")).toBe(
    "{ \"theme\": \"dark\" }\n",
  );
  expect(read(worktreeRoot, "apps/frostbite-crawler/data/sessions/hoangbn/Cookies")).toBe(
    "cookie-jar\n",
  );
  expect(read(worktreeRoot, "scripts/bootstrap.sh")).toBe("#!/bin/sh\necho seeded\n");
});

test("repeated create and materialize do not clobber seeded paths already changed in the worktree", () => {
  const sandbox = makeTempDir("single-seedpaths-no-clobber");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "apps/frostbite-crawler/data/sessions/hoangbn/Preferences": "{ \"theme\": \"dark\" }\n",
    "monke.yml": `seedPaths:
  - apps/frostbite-crawler/data/sessions
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
    cwd: repoRoot,
    args: ["create", "banana"],
    monkeHome: home,
    binDirectory,
  });

  const worktreeRoot = getExpectedWorktreePath(repoRoot, "banana");
  write(
    worktreeRoot,
    "apps/frostbite-crawler/data/sessions/hoangbn/Preferences",
    "{ \"theme\": \"light\" }\n",
  );

  runMonke({
    cwd: worktreeRoot,
    args: ["materialize"],
    monkeHome: home,
    binDirectory,
  });

  runMonke({
    cwd: repoRoot,
    args: ["create", "banana"],
    monkeHome: home,
    binDirectory,
  });

  expect(read(worktreeRoot, "apps/frostbite-crawler/data/sessions/hoangbn/Preferences")).toBe(
    "{ \"theme\": \"light\" }\n",
  );
});

test("missing configured seedPaths warn and do not fail session creation", () => {
  const sandbox = makeTempDir("single-seedpaths-missing");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `seedPaths:
  - apps/frostbite-crawler/data/sessions
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });

  const result = runMonke({
    cwd: repoRoot,
    args: ["create", "banana"],
    monkeHome: home,
    binDirectory,
  });

  expect(result.stderr).toContain("Warning: seedPath apps/frostbite-crawler/data/sessions is missing");
  expect(result.stdout).toContain("Created or updated session banana");
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
