import { expect, test } from "vitest";
import path from "node:path";

import { getExpectedWorktreePath } from "../src/git.ts";
import {
  createRepo,
  installFakeWt,
  makeTempDir,
  read,
  readSingleYamlFile,
  runMonke,
  write,
} from "./helpers.ts";

test("create materializes direct dependencies before the root repo and propagates external ports", () => {
  const sandbox = makeTempDir("multi-repo");
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
    args: ["create", "swing"],
    monkeHome: home,
    binDirectory,
  });

  const depWorktree = getExpectedWorktreePath(depRoot, "swing");
  const rootWorktree = getExpectedWorktreePath(root, "swing");

  expect(read(depWorktree, ".env")).toBe("DEP_POSTGRES_PORT=10000\n");
  expect(read(rootWorktree, "apps/api/.env.local")).toBe(
    "PORT=10001\nDATABASE_URL=postgres://localhost:10000/app\n",
  );
  expect(read(rootWorktree, ".env")).toBe(
    `DEP_DIR=${path.relative(rootWorktree, depWorktree)}\nAPI_PORT=10001\nDEP_POSTGRES_PORT=10000\n`,
  );

  const sessionState = readSingleYamlFile(path.join(home, "sessions")) as {
    repos: Array<{ sourceRoot: string }>;
  };
  expect(sessionState.repos.map((repo) => repo.sourceRoot)).toEqual([depRoot, root]);
});

test("create fans out one dependency-owned port to multiple local targets", () => {
  const sandbox = makeTempDir("multi-repo-fanout");
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
    "apps/api/.env.local": "DATABASE_URL=postgres://localhost:5432/api\n",
    "apps/worker/.env.local": "DATABASE_URL=postgres://localhost:5432/worker\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings: []
  worker:
    path: apps/worker
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
      - port: DEP_POSTGRES_PORT
        app: worker
        env: DATABASE_URL
`,
  });

  runMonke({
    cwd: root,
    args: ["create", "swing"],
    monkeHome: home,
    binDirectory,
  });

  const rootWorktree = getExpectedWorktreePath(root, "swing");
  const depWorktree = getExpectedWorktreePath(depRoot, "swing");

  expect(read(rootWorktree, "apps/api/.env.local")).toBe(
    "DATABASE_URL=postgres://localhost:10000/api\n",
  );
  expect(read(rootWorktree, "apps/worker/.env.local")).toBe(
    "DATABASE_URL=postgres://localhost:10000/worker\n",
  );
  expect(read(rootWorktree, ".env")).toBe(
    `DEP_DIR=${path.relative(rootWorktree, depWorktree)}\nDEP_POSTGRES_PORT=10000\n`,
  );

  expect(depRoot).toBeTruthy();
});

test("materialize overwrites stale root path env values and preserves unrelated entries", () => {
  const sandbox = makeTempDir("multi-repo-pathenv-refresh");
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
    ".env": "KEEP_ME=1\nDEP_DIR=../somewhere-else\n",
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
    args: ["create", "refresh-env"],
    monkeHome: home,
    binDirectory,
  });

  const rootWorktree = getExpectedWorktreePath(root, "refresh-env");
  const depWorktree = getExpectedWorktreePath(depRoot, "refresh-env");
  write(rootWorktree, ".env", "KEEP_ME=1\nDEP_DIR=../stale\n");

  runMonke({
    cwd: rootWorktree,
    args: ["materialize"],
    monkeHome: home,
    binDirectory,
  });

  expect(read(rootWorktree, ".env")).toBe(
    `KEEP_ME=1\nDEP_DIR=${path.relative(rootWorktree, depWorktree)}\nDEP_POSTGRES_PORT=10000\n`,
  );
});

test("root path env file only includes direct externals", { timeout: 30_000 }, () => {
  const sandbox = makeTempDir("multi-repo-direct-pathenvs");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");

  createRepo(path.join(sandbox, "leaf"), {
    "services/leaf/.env.local": "PORT=9000\n",
    "monke.yml": `apps:
  leaf:
    path: services/leaf
    envFile: .env.local
    mappings:
      - port: LEAF_PORT
        env: PORT
`,
  });
  const dep = createRepo(path.join(sandbox, "dep"), {
    "services/dep/.env.local": "PORT=5432\nLEAF_URL=http://localhost:9000\n",
    "monke.yml": `apps:
  dep:
    path: services/dep
    envFile: .env.local
    mappings:
      - port: DEP_PORT
        env: PORT
external:
  leaf:
    path: ../leaf
    pathEnv: LEAF_DIR
    mappings:
      - port: LEAF_PORT
        app: dep
        env: LEAF_URL
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
      - port: DEP_PORT
        app: api
        env: DATABASE_URL
`,
  });

  runMonke({
    cwd: root,
    args: ["create", "direct-only"],
    monkeHome: home,
    binDirectory,
  });

  const rootWorktree = getExpectedWorktreePath(root, "direct-only");
  const depWorktree = getExpectedWorktreePath(dep, "direct-only");
  expect(read(rootWorktree, ".env")).toBe(
    `DEP_DIR=${path.relative(rootWorktree, depWorktree)}\nDEP_PORT=10001\n`,
  );
});

test("bootstrap commands receive direct external path env bindings", () => {
  const sandbox = makeTempDir("multi-repo-bootstrap-pathenv");
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
    "apps/api/.env.local": "DATABASE_URL=postgres://localhost:5432/app\n",
    "monke.yml": `bootstrapCommand: printf '%s' "$DEP_DIR" > .bootstrap-path
apps:
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
    args: ["create", "bootstrap-path"],
    monkeHome: home,
    binDirectory,
  });

  const rootWorktree = getExpectedWorktreePath(root, "bootstrap-path");
  const depWorktree = getExpectedWorktreePath(depRoot, "bootstrap-path");
  expect(read(rootWorktree, ".bootstrap-path")).toBe(path.relative(rootWorktree, depWorktree));
});

test("dependency bootstrap runs before root bootstrap and root can rely on synced dependency paths", () => {
  const sandbox = makeTempDir("multi-repo-bootstrap");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");

  const depRoot = createRepo(path.join(sandbox, "dep"), {
    "services/db/.env.local": "PORT=5432\n",
    "monke.yml": `bootstrapCommand: ': > .dep-ready'
apps:
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
    "monke.yml": `bootstrapCommand: 'set -a && . ./.env && set +a && test -f "$DEP_DIR/.dep-ready" && printf "%s" "$DEP_DIR" > root-saw-dep'
apps:
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
    args: ["create", "swing"],
    monkeHome: home,
    binDirectory,
  });

  const depWorktree = getExpectedWorktreePath(depRoot, "swing");
  const rootWorktree = getExpectedWorktreePath(root, "swing");

  expect(read(depWorktree, ".dep-ready")).toBe("");
  expect(read(rootWorktree, "root-saw-dep")).toBe(path.relative(rootWorktree, depWorktree));
});
