import { expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getExpectedWorktreePath } from "../src/git.ts";
import { getSessionStateFilePath, saveSessionState } from "../src/registry.ts";
import {
  createRepo,
  git,
  installFakeWt,
  installShShim,
  makeTempDir,
  read,
  readSingleYamlFile,
  runMonke,
  write,
} from "./helpers.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function makeRepoTempDir(prefix: string): string {
  const testTempRoot = path.join(projectRoot, "tmp", "tests");
  mkdirSync(testTempRoot, { recursive: true });
  return realpathSync.native(mkdtempSync(path.join(testTempRoot, `${prefix}-`)));
}

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

  const depWorktree = getExpectedWorktreePath(home, depRoot, "swing");
  const rootWorktree = getExpectedWorktreePath(home, root, "swing");

  expect(read(depWorktree, ".env")).toBe("DEP_POSTGRES_PORT=10000\n");
  expect(read(rootWorktree, "apps/api/.env.local")).toBe(
    "PORT=10100\nDATABASE_URL=postgres://localhost:10000/app\n",
  );
  expect(read(rootWorktree, ".env")).toBe(
    `DEP_DIR=${path.relative(rootWorktree, depWorktree)}\nAPI_PORT=10100\nDEP_POSTGRES_PORT=10000\n`,
  );

  const sessionState = readSingleYamlFile(path.join(home, "sessions")) as {
    repos: Array<{ sourceRoot: string }>;
  };
  expect(sessionState.repos.map((repo) => repo.sourceRoot)).toEqual([depRoot, root]);
});

test("create fails dirty dependency source checkouts before creating any worktrees", () => {
  const sandbox = makeRepoTempDir("multi-repo-dirty-preflight");
  try {
    const binDirectory = path.join(sandbox, "bin");
    installFakeWt(binDirectory);
    const home = path.join(sandbox, "home");

    const cleanDepRoot = createRepo(path.join(sandbox, "clean-dep"), {
      "services/cache/.env.local": "PORT=6379\n",
      "monke.yml": `apps:
  cache:
    path: services/cache
    envFile: .env.local
    mappings:
      - port: CACHE_PORT
        env: PORT
`,
    });

    const dirtyDepRoot = createRepo(path.join(sandbox, "dirty-dep"), {
      "services/db/.env.local": "PORT=5432\n",
      "monke.yml": `apps:
  db:
    path: services/db
    envFile: .env.local
    mappings:
      - port: DB_PORT
        env: PORT
`,
    });
    write(dirtyDepRoot, "untracked.txt", "dirty\n");

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
  clean-dep:
    path: ../clean-dep
    pathEnv: CACHE_DIR
    mappings:
      - port: CACHE_PORT
        app: api
        env: CACHE_URL
  dirty-dep:
    path: ../dirty-dep
    pathEnv: DB_DIR
    mappings:
      - port: DB_PORT
        app: api
        env: DATABASE_URL
`,
    });

    expect(() => {
      runMonke({
        cwd: root,
        args: ["create", "dirty-first"],
        monkeHome: home,
        binDirectory,
      });
    }).toThrow(`Source checkout is dirty: ${dirtyDepRoot}`);

    expect(existsSync(getExpectedWorktreePath(home, cleanDepRoot, "dirty-first"))).toBe(false);
    expect(existsSync(getExpectedWorktreePath(home, dirtyDepRoot, "dirty-first"))).toBe(false);
    expect(existsSync(getExpectedWorktreePath(home, root, "dirty-first"))).toBe(false);
    expect(existsSync(getSessionStateFilePath(home, root, "dirty-first"))).toBe(false);
    expect(() =>
      git(cleanDepRoot, ["show-ref", "--verify", "--quiet", "refs/heads/dirty-first"]),
    ).toThrow();
    expect(() =>
      git(dirtyDepRoot, ["show-ref", "--verify", "--quiet", "refs/heads/dirty-first"]),
    ).toThrow();
    expect(() =>
      git(root, ["show-ref", "--verify", "--quiet", "refs/heads/dirty-first"]),
    ).toThrow();
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("create -m discovers dependencies from default branch config", () => {
  const sandbox = makeTempDir("multi-repo-main-config");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");

  const depRoot = createRepo(path.join(sandbox, "dep"), {
    "default-only.txt": "default dep\n",
    "services/db/.env.local": "PORT=5432\n",
    "monke.yml": `seedPaths:
  - default-only.txt
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
  git(root, ["switch", "-c", "feature"]);
  write(
    root,
    "monke.yml",
    `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: DATABASE_URL
`,
  );

  runMonke({
    cwd: root,
    args: ["create", "default-graph", "-m"],
    monkeHome: home,
    binDirectory,
  });

  const rootWorktree = getExpectedWorktreePath(home, root, "default-graph");
  const depWorktree = getExpectedWorktreePath(home, depRoot, "default-graph");
  expect(read(depWorktree, ".env")).toBe("DEP_POSTGRES_PORT=10000\n");
  expect(read(rootWorktree, ".env")).toBe(
    `DEP_DIR=${path.relative(rootWorktree, depWorktree)}\nDEP_POSTGRES_PORT=10000\n`,
  );

  const sessionState = readSingleYamlFile(path.join(home, "sessions")) as {
    graphSource?: string;
    repos: Array<{ sourceRoot: string }>;
  };
  expect(sessionState.graphSource).toBe("session-branch");
  expect(sessionState.repos.map((repo) => repo.sourceRoot)).toEqual([depRoot, root]);

  write(depRoot, "default-only.txt", "dirty dep source\n");
  git(depRoot, ["worktree", "remove", "--force", depWorktree]);
  runMonke({
    cwd: rootWorktree,
    args: ["materialize"],
    monkeHome: home,
    binDirectory,
  });
  expect(read(rootWorktree, ".env")).toBe(
    `DEP_DIR=${path.relative(rootWorktree, depWorktree)}\nDEP_POSTGRES_PORT=10000\n`,
  );
  expect(read(depWorktree, "default-only.txt")).toBe("default dep\n");

  git(root, ["worktree", "remove", "--force", rootWorktree]);
  git(depRoot, ["worktree", "remove", "--force", depWorktree]);
  const cleanupResult = runMonke({
    cwd: root,
    args: ["cleanup"],
    monkeHome: home,
    binDirectory,
  });
  expect(cleanupResult.stdout).toBe("Removed 1 dead session\n");
});

test("create -m seeds dependency managed env files from source checkouts", () => {
  const sandbox = makeTempDir("multi-repo-main-local-env");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");

  const depRoot = createRepo(path.join(sandbox, "dep"), {
    ".gitignore": "services/db/.env.local\n",
    "services/db/package.json": "{}\n",
    "monke.yml": `apps:
  db:
    path: services/db
    envFile: .env.local
    mappings:
      - port: DEP_POSTGRES_PORT
        env: PORT
`,
  });
  write(depRoot, "services/db/.env.local", "PORT=10000\nLOCAL_ONLY=1\n");

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
  git(root, ["switch", "-c", "feature"]);

  runMonke({
    cwd: root,
    args: ["create", "local-env", "-m"],
    monkeHome: home,
    binDirectory,
  });

  const rootWorktree = getExpectedWorktreePath(home, root, "local-env");
  const depWorktree = getExpectedWorktreePath(home, depRoot, "local-env");
  expect(read(depWorktree, "services/db/.env.local")).toBe("PORT=10001\nLOCAL_ONLY=1\n");
  expect(read(rootWorktree, "apps/api/.env.local")).toBe(
    "DATABASE_URL=postgres://localhost:10001/app\n",
  );
  expect(read(rootWorktree, ".env")).toBe(
    `DEP_DIR=${path.relative(rootWorktree, depWorktree)}\nDEP_POSTGRES_PORT=10001\n`,
  );
});

test("create -m materializes mixed main and master repos in one graph", () => {
  const sandbox = makeTempDir("multi-repo-main-master");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");

  const depRoot = createRepo(path.join(sandbox, "dep"), {
    "services/db/.env.local": "PORT=5432\nMASTER_DEFAULT=1\n",
    "monke.yml": `apps:
  db:
    path: services/db
    envFile: .env.local
    mappings:
      - port: DEP_POSTGRES_PORT
        env: PORT
`,
  });
  git(depRoot, ["branch", "-m", "master"]);

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
    args: ["create", "mixed-defaults", "-m"],
    monkeHome: home,
    binDirectory,
  });

  const rootWorktree = getExpectedWorktreePath(home, root, "mixed-defaults");
  const depWorktree = getExpectedWorktreePath(home, depRoot, "mixed-defaults");
  expect(read(depWorktree, "services/db/.env.local")).toBe("PORT=10000\nMASTER_DEFAULT=1\n");
  expect(read(rootWorktree, ".env")).toBe(
    `DEP_DIR=${path.relative(rootWorktree, depWorktree)}\nDEP_POSTGRES_PORT=10000\n`,
  );
});

test("create fails clearly when two repos collide on repo-name session worktree paths", () => {
  const sandbox = makeTempDir("multi-repo-worktree-collision");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");

  createRepo(path.join(sandbox, "other", "root"), {
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
    path: ../other/root
    pathEnv: DEP_DIR
    mappings:
      - port: DEP_POSTGRES_PORT
        app: api
        env: DATABASE_URL
`,
  });

  expect(() =>
    runMonke({
      cwd: root,
      args: ["create", "collision"],
      monkeHome: home,
      binDirectory,
    }),
  ).toThrow(/Session worktree path collision/);
  expect(existsSync(path.join(home, "worktrees", "root", "collision"))).toBe(false);
});

test("resource command retained inputs are scoped to the declaring repo across root graphs", () => {
  const sandbox = makeTempDir("multi-repo-resource-command-declaring-scope");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  installShShim(binDirectory);
  const home = path.join(sandbox, "home");

  const depRoot = createRepo(path.join(sandbox, "dep"), {
    "services/db/.env.local": "PORT=5432\n",
    "monke.yml": `resources:
  commands:
    e2e-symbols:
      run: ./scripts/e2e-symbols.ts
      outputs:
        - E2E_FLOW1_SYMBOL
apps:
  db:
    path: services/db
    envFile: .env.local
    mappings:
      - port: DEP_POSTGRES_PORT
        env: PORT
`,
    "scripts/e2e-symbols.ts": `import { writeFileSync } from "node:fs";

export default function ({ previous }) {
  writeFileSync("command-stdin.json", JSON.stringify(previous));
  const value = previous.E2E_FLOW1_SYMBOL.includes("SOL/USDT:USDT")
    ? "LINK/USDT:USDT"
    : "SOL/USDT:USDT";
  return { E2E_FLOW1_SYMBOL: value };
}
`,
  });

  const rootA = createRepo(path.join(sandbox, "root-a"), {
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
  const rootB = createRepo(path.join(sandbox, "root-b"), {
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

  saveSessionState(home, {
    version: 1,
    rootSourceRoot: rootA,
    session: "alpha",
    repos: [
      {
        sourceRoot: depRoot,
        worktreePath: path.join(sandbox, "missing-alpha-dep"),
        assignedPorts: [],
        resourceCommandOutputs: [
          {
            name: "e2e-symbols",
            outputs: [{ env: "E2E_FLOW1_SYMBOL", value: "SOL/USDT:USDT" }],
          },
        ],
      },
    ],
  });
  runMonke({
    cwd: rootB,
    args: ["create", "beta"],
    monkeHome: home,
    binDirectory,
  });

  const betaDepWorktree = getExpectedWorktreePath(home, depRoot, "beta");
  expect(read(betaDepWorktree, "command-stdin.json")).toContain("SOL/USDT:USDT");
  expect(read(betaDepWorktree, ".env")).toContain("E2E_FLOW1_SYMBOL=LINK/USDT:USDT\n");
});

test("resource command return violation records an incomplete root repo and rerun heals external path env", () => {
  const sandbox = makeTempDir("multi-repo-resource-command-partial-root");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  installShShim(binDirectory);
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
    ".env": "DEP_DIR=../dep\n",
    "apps/api/.env.local": "PORT=3000\nDATABASE_URL=postgres://localhost:5432/app\n",
    "scripts/resource-command.ts": `export default function () {
  console.log("install progress");
  return "not an output record";
}
`,
    "monke.yml": `resources:
  commands:
    e2e-channel:
      run: ./scripts/resource-command.ts
      outputs:
        - E2E_CHANNEL_ID
apps:
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

  expect(() =>
    runMonke({
      cwd: root,
      args: ["create", "partial"],
      monkeHome: home,
      binDirectory,
    }),
  ).toThrow(/kind: return contract violation/);

  const rootWorktree = getExpectedWorktreePath(home, root, "partial");
  const depWorktree = getExpectedWorktreePath(home, depRoot, "partial");
  expect(read(rootWorktree, ".env")).toBe("DEP_DIR=../dep\n");

  const partialState = readSingleYamlFile(path.join(home, "sessions")) as {
    repos: Array<{
      sourceRoot: string;
      worktreePath: string;
      materializationComplete?: boolean;
    }>;
  };
  expect(partialState.repos.map((repo) => repo.sourceRoot)).toEqual([depRoot, root]);
  expect(partialState.repos[1]).toMatchObject({
    sourceRoot: root,
    worktreePath: rootWorktree,
    materializationComplete: false,
  });

  write(
    rootWorktree,
    "scripts/resource-command.ts",
    `export default function () {
  return { E2E_CHANNEL_ID: "123" };
}
`,
  );

  runMonke({
    cwd: root,
    args: ["create", "partial"],
    monkeHome: home,
    binDirectory,
  });

  expect(read(rootWorktree, ".env")).toBe(
    `DEP_DIR=${path.relative(rootWorktree, depWorktree)}\nAPI_PORT=10100\nDEP_POSTGRES_PORT=10000\nE2E_CHANNEL_ID=123\n`,
  );
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

  const rootWorktree = getExpectedWorktreePath(home, root, "swing");
  const depWorktree = getExpectedWorktreePath(home, depRoot, "swing");

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

  const rootWorktree = getExpectedWorktreePath(home, root, "refresh-env");
  const depWorktree = getExpectedWorktreePath(home, depRoot, "refresh-env");
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

  const rootWorktree = getExpectedWorktreePath(home, root, "direct-only");
  const depWorktree = getExpectedWorktreePath(home, dep, "direct-only");
  expect(read(rootWorktree, ".env")).toBe(
    `DEP_DIR=${path.relative(rootWorktree, depWorktree)}\nDEP_PORT=10100\n`,
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

  const rootWorktree = getExpectedWorktreePath(home, root, "bootstrap-path");
  const depWorktree = getExpectedWorktreePath(home, depRoot, "bootstrap-path");
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

  const depWorktree = getExpectedWorktreePath(home, depRoot, "swing");
  const rootWorktree = getExpectedWorktreePath(home, root, "swing");

  expect(read(depWorktree, ".dep-ready")).toBe("");
  expect(read(rootWorktree, "root-saw-dep")).toBe(path.relative(rootWorktree, depWorktree));
});
