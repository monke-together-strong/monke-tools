import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { getExpectedWorktreePath } from "../src/git.ts";
import { getSessionStateFilePath, saveSessionState } from "../src/session-state-store.ts";
import { SessionStateSchema } from "../src/state-schema.ts";
import {
  completeSessionState,
  createRepo,
  git,
  installCodexUrlOpenShim,
  installGitShim,
  installShShim,
  makeTempDir,
  materializedRepoState,
  read,
  readSingleYamlFile,
  runMonke,
  runMonkeAsync,
  runMonkeCapturingFailure,
  write
} from "./helpers.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const INDEPENDENT_SIBLING_SETTLE_DELAY_SECONDS = 0.1;
const SIBLING_START_BARRIER_ATTEMPTS = 200;
const SIBLING_START_BARRIER_DELAY_SECONDS = 0.01;

function makeRepoTempDir(prefix: string) {
  const testTempRoot = path.join(projectRoot, "tmp", "tests");
  mkdirSync(testTempRoot, { recursive: true });
  return realpathSync.native(mkdtempSync(path.join(testTempRoot, `${prefix}-`)));
}

describe("multi-repo sessions", () => {
  test("spawn materializes direct dependencies before the root repo and propagates external ports", () => {
    const sandbox = makeTempDir("multi-repo");
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
      args: ["spawn", "swing"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    const depWorktree = getExpectedWorktreePath(home, depRoot, "swing");
    const rootWorktree = getExpectedWorktreePath(home, root, "swing");

    expect(read(depWorktree, ".env")).toBe("DEP_POSTGRES_PORT=10000\n");
    expect(read(rootWorktree, "apps/api/.env.local")).toBe(
      "PORT=11000\nDATABASE_URL=postgres://localhost:10000/app\n"
    );
    expect(read(rootWorktree, ".env")).toBe(
      `DEP_DIR=${path.relative(rootWorktree, depWorktree)}\nAPI_PORT=11000\nDEP_POSTGRES_PORT=10000\n`
    );

    const sessionState = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    expect(sessionState.repos.map((repo) => repo.sourceRoot)).toStrictEqual([depRoot, root]);
  });

  test("missing Root config cannot discard retained dependency Cleanup obligations", () => {
    const sandbox = makeTempDir("multi-repo-missing-root-config");
    const home = path.join(sandbox, "home");
    const depRoot = createRepo(path.join(sandbox, "dep"), {
      "app/.env": "PORT=4100\n",
      "monke.yml": `bootstrapCommand: "true"
cleanupCommand: "true"
apps:
  dep:
    path: app
    envFile: .env
    mappings:
      - port: DEP_PORT
        env: PORT
`
    });
    const root = createRepo(path.join(sandbox, "root"), {
      "app/.env": "DEP_PORT=4100\n",
      "monke.yml": `bootstrapCommand: "true"
cleanupCommand: "true"
apps:
  root:
    path: app
    envFile: .env
external:
  dep:
    path: ../dep
    pathEnv: DEP_DIR
    mappings:
      - port: DEP_PORT
        app: root
        env: DEP_PORT
`
    });

    runMonke({ args: ["spawn", "retained"], cwd: root, monkeHome: home });
    const before = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    expect(before.repos).toHaveLength(2);
    expect(before.repos.every((repo) => repo.cleanupEligible)).toBeTruthy();
    rmSync(path.join(root, "monke.yml"));

    const result = runMonkeCapturingFailure({
      args: ["spawn", "retained"],
      cwd: root,
      monkeHome: home
    });

    expect(result.error?.message).toContain("monke.yml is missing");
    expect(result.error?.message).toContain("retained Session state and Cleanup obligations");
    expect(readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema)).toStrictEqual(
      before
    );
    expect(before.repos.map((repo) => repo.sourceRoot)).toStrictEqual([depRoot, root]);
    expect(before.repos.map((repo) => repo.cleanupCommand)).toStrictEqual(["true", "true"]);
  });

  test("spawn warns when skipped dependency source dirt is not carried", () => {
    const sandbox = makeTempDir("multi-repo-skipped-dep-dirty");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");

    const depRoot = createRepo(path.join(sandbox, "dep"), {
      "dep.txt": "clean dep\n",
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
      args: ["spawn", "swing"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });
    write(depRoot, "dep.txt", "dirty dep\n");

    const result = runMonke({
      args: ["spawn", "swing"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    expect(read(getExpectedWorktreePath(home, depRoot, "swing"), "dep.txt")).toBe("clean dep\n");
    expect(result.stderr).toContain(
      `Warning: Session worktree for swing at ${depRoot} already exists; dirty Source checkout changes were not carried into it.`
    );
  });

  test("spawn --no-dirty fails dirty dependency source checkouts before creating any worktrees", () => {
    const sandbox = makeRepoTempDir("multi-repo-dirty-preflight");
    try {
      const binDirectory = path.join(sandbox, "bin");
      const home = path.join(sandbox, "home");

      const cleanDepRoot = createRepo(path.join(sandbox, "clean-dep"), {
        "monke.yml": `apps:
  cache:
    path: services/cache
    envFile: .env.local
    mappings:
      - port: CACHE_PORT
        env: PORT
`,
        "services/cache/.env.local": "PORT=6379\n"
      });

      const dirtyDepRoot = createRepo(path.join(sandbox, "dirty-dep"), {
        "monke.yml": `apps:
  db:
    path: services/db
    envFile: .env.local
    mappings:
      - port: DB_PORT
        env: PORT
`,
        "services/db/.env.local": "PORT=5432\n"
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
`
      });

      expect(() => {
        runMonke({
          args: ["spawn", "dirty-first", "--no-dirty"],
          binDirectory,
          cwd: root,
          monkeHome: home
        });
      }).toThrow(`Source checkout is dirty: ${dirtyDepRoot}`);

      expect(existsSync(getExpectedWorktreePath(home, cleanDepRoot, "dirty-first"))).toBeFalsy();
      expect(existsSync(getExpectedWorktreePath(home, dirtyDepRoot, "dirty-first"))).toBeFalsy();
      expect(existsSync(getExpectedWorktreePath(home, root, "dirty-first"))).toBeFalsy();
      expect(existsSync(getSessionStateFilePath(home, root, "dirty-first"))).toBeFalsy();
      expect(() =>
        git(cleanDepRoot, ["show-ref", "--verify", "--quiet", "refs/heads/dirty-first"])
      ).toThrow(/show-ref/u);
      expect(() =>
        git(dirtyDepRoot, ["show-ref", "--verify", "--quiet", "refs/heads/dirty-first"])
      ).toThrow(/show-ref/u);
      expect(() =>
        git(root, ["show-ref", "--verify", "--quiet", "refs/heads/dirty-first"])
      ).toThrow(/show-ref/u);
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  });

  test("spawn carries dirty state across multi-repo graph by default", () => {
    const sandbox = makeTempDir("multi-repo-dirty-carry");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");

    const depRoot = createRepo(path.join(sandbox, "dep"), {
      "dep.txt": "clean dep\n",
      "monke.yml": `apps:
  db:
    path: services/db
    envFile: .env.local
    mappings:
      - port: DEP_PORT
        env: PORT
`,
      "services/db/.env.local": "PORT=5432\n"
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
      "root.txt": "clean root\n"
    });
    write(depRoot, "dep.txt", "dirty dep\n");
    write(root, "root.txt", "dirty root\n");

    runMonke({
      args: ["spawn", "dirty-graph"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    expect(read(getExpectedWorktreePath(home, depRoot, "dirty-graph"), "dep.txt")).toBe(
      "dirty dep\n"
    );
    expect(read(getExpectedWorktreePath(home, root, "dirty-graph"), "root.txt")).toBe(
      "dirty root\n"
    );
  });

  test("dirty spawn fails before creating any graph worktrees when a dependency session branch diverged", () => {
    const sandbox = makeTempDir("multi-repo-dirty-diverged-dep");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");

    const depRoot = createRepo(path.join(sandbox, "dep"), {
      "dep.txt": "clean dep\n",
      "monke.yml": `apps:
  db:
    path: services/db
    envFile: .env.local
    mappings:
      - port: DEP_PORT
        env: PORT
`,
      "services/db/.env.local": "PORT=5432\n"
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
      "root.txt": "clean root\n"
    });

    git(depRoot, ["branch", "banana", "HEAD"]);
    git(depRoot, ["switch", "banana"]);
    write(depRoot, "dep.txt", "session branch dep\n");
    git(depRoot, ["add", "dep.txt"]);
    git(depRoot, ["commit", "-m", "diverge banana"]);
    git(depRoot, ["switch", "main"]);
    write(depRoot, "dep.txt", "dirty dep\n");

    expect(() =>
      runMonke({
        args: ["spawn", "banana"],
        binDirectory,
        cwd: root,
        monkeHome: home
      })
    ).toThrow(/Session branch "banana" already exists.*diverged branch is unsafe/su);

    expect(existsSync(getExpectedWorktreePath(home, depRoot, "banana"))).toBeFalsy();
    expect(existsSync(getExpectedWorktreePath(home, root, "banana"))).toBeFalsy();
    expect(existsSync(getSessionStateFilePath(home, root, "banana"))).toBeFalsy();
  });

  test("spawn -m discovers dependencies from default branch config", () => {
    const sandbox = makeTempDir("multi-repo-main-config");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");

    const depRoot = createRepo(path.join(sandbox, "dep"), {
      "default-only.txt": "default dep\n",
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
      "services/db/.env.local": "PORT=5432\n"
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
`
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
`
    );

    runMonke({
      args: ["spawn", "default-graph", "-m"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    const rootWorktree = getExpectedWorktreePath(home, root, "default-graph");
    const depWorktree = getExpectedWorktreePath(home, depRoot, "default-graph");
    expect(read(depWorktree, ".env")).toBe("DEP_POSTGRES_PORT=10000\n");
    expect(read(rootWorktree, ".env")).toBe(
      `DEP_DIR=${path.relative(rootWorktree, depWorktree)}\nDEP_POSTGRES_PORT=10000\n`
    );

    const sessionState = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    expect(sessionState.graphSource).toBe("session-branch");
    expect(sessionState.repos.map((repo) => repo.sourceRoot)).toStrictEqual([depRoot, root]);

    write(depRoot, "default-only.txt", "dirty dep source\n");
    git(depRoot, ["worktree", "remove", "--force", depWorktree]);
    runMonke({
      args: ["materialize"],
      binDirectory,
      cwd: rootWorktree,
      monkeHome: home
    });
    expect(read(rootWorktree, ".env")).toBe(
      `DEP_DIR=${path.relative(rootWorktree, depWorktree)}\nDEP_POSTGRES_PORT=10000\n`
    );
    expect(read(depWorktree, "default-only.txt")).toBe("default dep\n");

    git(root, ["worktree", "remove", "--force", rootWorktree]);
    git(depRoot, ["worktree", "remove", "--force", depWorktree]);
    const cleanupResult = runMonke({
      args: ["cleanup"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });
    expect(cleanupResult.stdout).toBe("");
    expect(cleanupResult.stderr).toBe("Removed 1 dead session\n");
  });

  test("spawn -m uses dependency resolved default branch env files", () => {
    const sandbox = makeTempDir("multi-repo-main-local-env");
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
      "services/db/.env.local": "PORT=5432\nDEFAULT_ONLY=1\n"
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
`
    });
    git(root, ["switch", "-c", "feature"]);

    runMonke({
      args: ["spawn", "local-env", "-m"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    const rootWorktree = getExpectedWorktreePath(home, root, "local-env");
    const depWorktree = getExpectedWorktreePath(home, depRoot, "local-env");
    expect(read(depWorktree, "services/db/.env.local")).toBe("PORT=10001\nDEFAULT_ONLY=1\n");
    expect(read(rootWorktree, "apps/api/.env.local")).toBe(
      "DATABASE_URL=postgres://localhost:10001/app\n"
    );
    expect(read(rootWorktree, ".env")).toBe(
      `DEP_DIR=${path.relative(rootWorktree, depWorktree)}\nDEP_POSTGRES_PORT=10001\n`
    );
  });

  test("spawn -m materializes mixed main and master repos in one graph", () => {
    const sandbox = makeTempDir("multi-repo-main-master");
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
      "services/db/.env.local": "PORT=5432\nMASTER_DEFAULT=1\n"
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
`
    });

    runMonke({
      args: ["spawn", "mixed-defaults", "-m"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    const rootWorktree = getExpectedWorktreePath(home, root, "mixed-defaults");
    const depWorktree = getExpectedWorktreePath(home, depRoot, "mixed-defaults");
    expect(read(depWorktree, "services/db/.env.local")).toBe("PORT=10000\nMASTER_DEFAULT=1\n");
    expect(read(rootWorktree, ".env")).toBe(
      `DEP_DIR=${path.relative(rootWorktree, depWorktree)}\nDEP_POSTGRES_PORT=10000\n`
    );
  });

  test("spawn fails clearly when two repos collide on repo-name session worktree paths", () => {
    const sandbox = makeTempDir("multi-repo-worktree-collision");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");

    createRepo(path.join(sandbox, "other", "root"), {
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
`
    });

    expect(() =>
      runMonke({
        args: ["spawn", "collision"],
        binDirectory,
        cwd: root,
        monkeHome: home
      })
    ).toThrow(/Session worktree path collision/u);
    expect(existsSync(path.join(home, "worktrees", "root", "collision"))).toBeFalsy();
  });

  test("resource command retained inputs are scoped to the declaring repo across root graphs", () => {
    const sandbox = makeTempDir("multi-repo-resource-command-declaring-scope");
    const binDirectory = path.join(sandbox, "bin");
    installShShim(binDirectory);
    const home = path.join(sandbox, "home");

    const depRoot = createRepo(path.join(sandbox, "dep"), {
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
      "services/db/.env.local": "PORT=5432\n"
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
`
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
`
    });

    saveSessionState(
      home,
      completeSessionState({
        repos: [
          materializedRepoState({
            cleanupEligible: true,
            resourceCommandOutputs: [
              {
                name: "e2e-symbols",
                outputs: [{ env: "E2E_FLOW1_SYMBOL", value: "SOL/USDT:USDT" }]
              }
            ],
            sourceRoot: depRoot,
            worktreePath: path.join(sandbox, "missing-alpha-dep")
          }),
          materializedRepoState({
            sourceRoot: rootA,
            worktreePath: path.join(sandbox, "missing-alpha-root")
          })
        ],
        rootSourceRoot: rootA,
        session: "alpha"
      })
    );
    runMonke({
      args: ["spawn", "beta"],
      binDirectory,
      cwd: rootB,
      monkeHome: home
    });

    const betaDepWorktree = getExpectedWorktreePath(home, depRoot, "beta");
    expect(read(betaDepWorktree, "command-stdin.json")).toContain("SOL/USDT:USDT");
    expect(read(betaDepWorktree, ".env")).toContain("E2E_FLOW1_SYMBOL=LINK/USDT:USDT\n");
  });

  test("resource command return violation records an incomplete root repo and rerun heals external path env", () => {
    const sandbox = makeTempDir("multi-repo-resource-command-partial-root");
    const binDirectory = path.join(sandbox, "bin");
    installShShim(binDirectory);
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
      ".env": "DEP_DIR=../dep\n",
      "apps/api/.env.local": "PORT=3000\nDATABASE_URL=postgres://localhost:5432/app\n",
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
      "scripts/resource-command.ts": `export default function () {
  console.log("install progress");
  return "not an output record";
}
`
    });

    expect(() =>
      runMonke({
        args: ["spawn", "partial"],
        binDirectory,
        cwd: root,
        monkeHome: home
      })
    ).toThrow(/kind: return contract violation/u);

    const rootWorktree = getExpectedWorktreePath(home, root, "partial");
    const depWorktree = getExpectedWorktreePath(home, depRoot, "partial");
    expect(read(rootWorktree, ".env")).toBe("DEP_DIR=../dep\n");

    const partialState = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    expect(partialState.repos.map((repo) => repo.sourceRoot)).toStrictEqual([depRoot, root]);
    expect(partialState.repos[1]).toMatchObject({
      materializationStatus: "failed",
      sourceRoot: root,
      worktreePath: rootWorktree
    });

    write(
      rootWorktree,
      "scripts/resource-command.ts",
      `export default function () {
  return { E2E_CHANNEL_ID: "123" };
}
`
    );

    runMonke({
      args: ["spawn", "partial"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    expect(read(rootWorktree, ".env")).toBe(
      `DEP_DIR=${path.relative(rootWorktree, depWorktree)}\nAPI_PORT=11000\nDEP_POSTGRES_PORT=10000\nE2E_CHANNEL_ID=123\n`
    );
  });

  test("spawn fans out one dependency-owned port to multiple local targets", () => {
    const sandbox = makeTempDir("multi-repo-fanout");
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
`
    });

    runMonke({
      args: ["spawn", "swing"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    const rootWorktree = getExpectedWorktreePath(home, root, "swing");
    const depWorktree = getExpectedWorktreePath(home, depRoot, "swing");

    expect(read(rootWorktree, "apps/api/.env.local")).toBe(
      "DATABASE_URL=postgres://localhost:10000/api\n"
    );
    expect(read(rootWorktree, "apps/worker/.env.local")).toBe(
      "DATABASE_URL=postgres://localhost:10000/worker\n"
    );
    expect(read(rootWorktree, ".env")).toBe(
      `DEP_DIR=${path.relative(rootWorktree, depWorktree)}\nDEP_POSTGRES_PORT=10000\n`
    );

    expect(depRoot).toBeTruthy();
  });

  test("materialize overwrites stale root path env values and preserves unrelated entries", () => {
    const sandbox = makeTempDir("multi-repo-pathenv-refresh");
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
`
    });

    runMonke({
      args: ["spawn", "refresh-env"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    const rootWorktree = getExpectedWorktreePath(home, root, "refresh-env");
    const depWorktree = getExpectedWorktreePath(home, depRoot, "refresh-env");
    write(rootWorktree, ".env", "KEEP_ME=1\nDEP_DIR=../stale\n");

    runMonke({
      args: ["materialize"],
      binDirectory,
      cwd: rootWorktree,
      monkeHome: home
    });

    expect(read(rootWorktree, ".env")).toBe(
      `KEEP_ME=1\nDEP_DIR=${path.relative(rootWorktree, depWorktree)}\nDEP_POSTGRES_PORT=10000\n`
    );
  });

  test("root path env file only includes direct externals", { timeout: 30_000 }, () => {
    const sandbox = makeTempDir("multi-repo-direct-pathenvs");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");

    createRepo(path.join(sandbox, "leaf"), {
      "monke.yml": `apps:
  leaf:
    path: services/leaf
    envFile: .env.local
    mappings:
      - port: LEAF_PORT
        env: PORT
`,
      "services/leaf/.env.local": "PORT=9000\n"
    });
    const dep = createRepo(path.join(sandbox, "dep"), {
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
      "services/dep/.env.local": "PORT=5432\nLEAF_URL=http://localhost:9000\n"
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
`
    });

    runMonke({
      args: ["spawn", "direct-only"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    const rootWorktree = getExpectedWorktreePath(home, root, "direct-only");
    const depWorktree = getExpectedWorktreePath(home, dep, "direct-only");
    expect(read(rootWorktree, ".env")).toBe(
      `DEP_DIR=${path.relative(rootWorktree, depWorktree)}\nDEP_PORT=11000\n`
    );
  });

  test("bootstrap commands receive direct external path env bindings", () => {
    const sandbox = makeTempDir("multi-repo-bootstrap-pathenv");
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
`
    });

    runMonke({
      args: ["spawn", "bootstrap-path"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    const rootWorktree = getExpectedWorktreePath(home, root, "bootstrap-path");
    const depWorktree = getExpectedWorktreePath(home, depRoot, "bootstrap-path");
    expect(read(rootWorktree, ".bootstrap-path")).toBe(path.relative(rootWorktree, depWorktree));
  });

  test("Dependency repo bootstrap runs before Root repo bootstrap and the Root repo can rely on synced Path env values", () => {
    const sandbox = makeTempDir("multi-repo-bootstrap");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");

    const depRoot = createRepo(path.join(sandbox, "dep"), {
      "monke.yml": `bootstrapCommand: ': > .dep-ready'
apps:
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
`
    });

    runMonke({
      args: ["spawn", "swing"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    const depWorktree = getExpectedWorktreePath(home, depRoot, "swing");
    const rootWorktree = getExpectedWorktreePath(home, root, "swing");

    expect(read(depWorktree, ".dep-ready")).toBe("");
    expect(read(rootWorktree, "root-saw-dep")).toBe(path.relative(rootWorktree, depWorktree));
  });

  test("current-head Dependency repo bootstrap failure leaves the Root repo Session worktree prepared", () => {
    const sandbox = makeTempDir("multi-repo-failed-dependency-preparation");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");

    const depRoot = createRepo(path.join(sandbox, "dep"), {
      "monke.yml": `bootstrapCommand: exit 9
apps:
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
      ".gitignore": ".env.local\nseed-data/\n",
      "apps/api/.env.local": "DATABASE_URL=postgres://localhost:5432/app\n",
      "monke.yml": `bootstrapCommand: ': > .root-materialized'
seedPaths:
  - seed-data
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
      "seed-data/browser-profile": "authenticated\n"
    });

    expect(() =>
      runMonke({
        args: ["spawn", "failed-dependency"],
        binDirectory,
        cwd: root,
        monkeHome: home
      })
    ).toThrow(/Bootstrap command failed/u);

    const rootWorktree = getExpectedWorktreePath(home, root, "failed-dependency");
    expect(read(rootWorktree, "apps/api/.env.local")).toBe(
      "DATABASE_URL=postgres://localhost:5432/app\n"
    );
    expect(read(rootWorktree, "seed-data/browser-profile")).toBe("authenticated\n");
    expect(existsSync(path.join(rootWorktree, ".root-materialized"))).toBeFalsy();
    expect(existsSync(getExpectedWorktreePath(home, depRoot, "failed-dependency"))).toBeTruthy();
  });

  test("a failed sibling does not stop independent materialization and retry reuses its checkpoint", () => {
    const sandbox = makeTempDir("multi-repo-quiescent-retry");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const codexOpenLog = installCodexUrlOpenShim(binDirectory);
    const settledMarker = path.join(sandbox, "settled");
    const successfulRuns = path.join(sandbox, "successful-runs");

    const failingRoot = createRepo(path.join(sandbox, "failing"), {
      "app/.env": "PORT=4100\n",
      "monke.yml": `bootstrapCommand: sh scripts/bootstrap.sh
apps:
  failing:
    path: app
    envFile: .env
    mappings:
      - port: FAILING_PORT
        env: PORT
`,
      "scripts/bootstrap.sh": "exit 9\n"
    });
    const successfulRoot = createRepo(path.join(sandbox, "successful"), {
      "app/.env": "PORT=4200\n",
      "monke.yml": `bootstrapCommand: sleep ${INDEPENDENT_SIBLING_SETTLE_DELAY_SECONDS}; printf x >> "${successfulRuns}"; touch "${settledMarker}"
seedPaths:
  - optional-missing
apps:
  successful:
    path: app
    envFile: .env
    mappings:
      - port: SUCCESSFUL_PORT
        env: PORT
`
    });
    const root = createRepo(path.join(sandbox, "root"), {
      "app/.env": "FAILING_PORT=4100\nSUCCESSFUL_PORT=4200\n",
      "monke.yml": `bootstrapCommand: touch root-materialized
apps:
  root:
    path: app
    envFile: .env
    mappings: []
external:
  failing:
    path: ../failing
    pathEnv: FAILING_DIR
    mappings:
      - port: FAILING_PORT
        app: root
        env: FAILING_PORT
  successful:
    path: ../successful
    pathEnv: SUCCESSFUL_DIR
    mappings:
      - port: SUCCESSFUL_PORT
        app: root
        env: SUCCESSFUL_PORT
`
    });

    const failed = runMonkeCapturingFailure({
      args: ["spawn", "quiescent", "--codex"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    expect(failed.error).not.toBeNull();
    expect(existsSync(settledMarker)).toBeTruthy();
    expect(failed.stderr).toContain(`${failingRoot}: failed (repo materialization; prepared)`);
    expect(failed.stderr).toContain(`${successfulRoot}: materialized`);
    expect(failed.stderr).toContain("warning: Warning: seedPath optional-missing is missing");
    expect(failed.stderr).toContain(`${root}: blocked by ${failingRoot}`);
    expect(failed.stderr).toContain(
      `Prepared Root worktree: ${getExpectedWorktreePath(home, root, "quiescent")}`
    );
    expect(failed.stderr).toContain("Retry: mt spawn quiescent");
    expect(failed.stdout).toBe("");
    expect(existsSync(codexOpenLog)).toBeFalsy();

    const failedState = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    expect(failedState.version).toBe(2);
    expect(failedState.generation).toStrictEqual({ number: 1, status: "incomplete" });
    expect(
      Object.fromEntries(
        failedState.repos.map((repo) => [repo.sourceRoot, repo.materializationStatus])
      )
    ).toStrictEqual({
      [failingRoot]: "failed",
      [root]: "blocked",
      [successfulRoot]: "materialized"
    });

    write(
      getExpectedWorktreePath(home, failingRoot, "quiescent"),
      "scripts/bootstrap.sh",
      ": > .repaired\n"
    );
    runMonke({
      args: ["spawn", "quiescent"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    expect(read(sandbox, "successful-runs")).toBe("x");
    expect(
      existsSync(path.join(getExpectedWorktreePath(home, root, "quiescent"), "root-materialized"))
    ).toBeTruthy();
    const completeState = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    expect(completeState.generation).toStrictEqual({ number: 1, status: "complete" });
  });

  test("Materialize does not reuse a materialized Dependency repo on the wrong branch", () => {
    const sandbox = makeTempDir("multi-repo-invalid-materialized-dependency");
    const home = path.join(sandbox, "home");
    const depRuns = path.join(sandbox, "dep-runs");
    const depRoot = createRepo(path.join(sandbox, "dep"), {
      "app/.env": "PORT=4100\n",
      "monke.yml": `bootstrapCommand: printf x >> "${depRuns}"
apps:
  dep:
    path: app
    envFile: .env
    mappings:
      - port: DEP_PORT
        env: PORT
`
    });
    const root = createRepo(path.join(sandbox, "root"), {
      "app/.env": "DEP_PORT=4100\n",
      "monke.yml": `bootstrapCommand: printf x >> root-runs
apps:
  root:
    path: app
    envFile: .env
    mappings: []
external:
  dep:
    path: ../dep
    pathEnv: DEP_DIR
    mappings:
      - port: DEP_PORT
        app: root
        env: DEP_PORT
`
    });

    runMonke({ args: ["spawn", "retained"], cwd: root, monkeHome: home });
    const rootWorktree = getExpectedWorktreePath(home, root, "retained");
    const depWorktree = getExpectedWorktreePath(home, depRoot, "retained");
    const complete = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    saveSessionState(home, {
      ...complete,
      generation: { ...complete.generation, status: "incomplete" }
    });
    git(depWorktree, ["switch", "-c", "session-local"]);

    const retried = runMonkeCapturingFailure({
      args: ["materialize"],
      cwd: rootWorktree,
      monkeHome: home
    });

    expect(retried.error?.message).toContain(
      `Expected worktree ${depWorktree} to be on branch retained, found session-local`
    );
    expect(read(rootWorktree, "root-runs")).toBe("x");
    const failed = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    expect(failed.repos.find((repo) => repo.sourceRoot === depRoot)).toMatchObject({
      failure: { phase: "worktree-preparation" },
      materializationStatus: "materialized",
      preparationStatus: "failed"
    });
    expect(failed.repos.find((repo) => repo.sourceRoot === root)).toMatchObject({
      materializationStatus: "materialized"
    });
    expect(failed.repos.find((repo) => repo.sourceRoot === root)?.blockedBy).toBeUndefined();

    git(depWorktree, ["switch", "retained"]);
    runMonke({ args: ["materialize"], cwd: rootWorktree, monkeHome: home });

    expect(read(sandbox, "dep-runs")).toBe("x");
    expect(read(rootWorktree, "root-runs")).toBe("x");
  });

  test("a ready repo materializes without waiting for unrelated Worktree preparation", () => {
    const sandbox = makeTempDir("multi-repo-preparation-overlap");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const materializedEarly = path.join(sandbox, "materialized-early");
    const slowPreparationDone = path.join(sandbox, "slow-preparation-done");

    const readyRoot = createRepo(path.join(sandbox, "ready"), {
      "app/.env": "PORT=4100\n",
      "monke.yml": `bootstrapCommand: test ! -f "${slowPreparationDone}" && touch "${materializedEarly}"
apps:
  ready:
    path: app
    envFile: .env
    mappings:
      - port: READY_PORT
        env: PORT
`
    });
    const slowRoot = createRepo(path.join(sandbox, "slow"), {
      "app/.env": "PORT=4200\n",
      "monke.yml": `bootstrapCommand: test -f "${slowPreparationDone}"
apps:
  slow:
    path: app
    envFile: .env
    mappings:
      - port: SLOW_PORT
        env: PORT
`
    });
    const root = createRepo(path.join(sandbox, "root"), {
      "app/.env": "READY_PORT=4100\nSLOW_PORT=4200\n",
      "monke.yml": `apps:
  root:
    path: app
    envFile: .env
    mappings: []
external:
  ready:
    path: ../ready
    pathEnv: READY_DIR
    mappings:
      - port: READY_PORT
        app: root
        env: READY_PORT
  slow:
    path: ../slow
    pathEnv: SLOW_DIR
    mappings:
      - port: SLOW_PORT
        app: root
        env: SLOW_PORT
`
    });
    const slowWorktree = getExpectedWorktreePath(home, slowRoot, "overlap");
    installGitShim(binDirectory, {
      afterCommand: {
        args: `worktree add ${slowWorktree} overlap`,
        cwd: slowRoot,
        // Hold slow preparation open until the ready repo's bootstrap has run, so the overlap
        // is proven by ordering rather than by wall-clock timing on a loaded machine.
        script: `attempts=0; while [ ! -f "${materializedEarly}" ]; do attempts=$((attempts + 1)); [ "$attempts" -lt ${SIBLING_START_BARRIER_ATTEMPTS} ] || exit 91; sleep ${SIBLING_START_BARRIER_DELAY_SECONDS}; done; touch "${slowPreparationDone}"`
      }
    });

    runMonke({
      args: ["spawn", "overlap"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    expect(existsSync(materializedEarly)).toBeTruthy();
    expect(existsSync(slowPreparationDone)).toBeTruthy();
    expect(existsSync(getExpectedWorktreePath(home, readyRoot, "overlap"))).toBeTruthy();
  });

  test("ready siblings materialize concurrently without losing either checkpoint", () => {
    const sandbox = makeTempDir("multi-repo-sibling-materialization-concurrency");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const firstStarted = path.join(sandbox, "first-started");
    const secondStarted = path.join(sandbox, "second-started");
    const waitForSibling = (ownMarker: string, siblingMarker: string) =>
      `touch "${ownMarker}"; attempts=0; while [ ! -f "${siblingMarker}" ]; do attempts=$((attempts + 1)); [ "$attempts" -lt ${SIBLING_START_BARRIER_ATTEMPTS} ] || exit 91; sleep ${SIBLING_START_BARRIER_DELAY_SECONDS}; done`;

    const firstRoot = createRepo(path.join(sandbox, "first"), {
      "app/.env": "PORT=4100\n",
      "monke.yml": `bootstrapCommand: ${waitForSibling(firstStarted, secondStarted)}
apps:
  first:
    path: app
    envFile: .env
    mappings:
      - port: FIRST_PORT
        env: PORT
`
    });
    const secondRoot = createRepo(path.join(sandbox, "second"), {
      "app/.env": "PORT=4200\n",
      "monke.yml": `bootstrapCommand: ${waitForSibling(secondStarted, firstStarted)}
apps:
  second:
    path: app
    envFile: .env
    mappings:
      - port: SECOND_PORT
        env: PORT
`
    });
    const root = createRepo(path.join(sandbox, "root"), {
      "app/.env": "FIRST_PORT=4100\nSECOND_PORT=4200\n",
      "monke.yml": `apps:
  root:
    path: app
    envFile: .env
    mappings: []
external:
  first:
    path: ../first
    pathEnv: FIRST_DIR
    mappings:
      - port: FIRST_PORT
        app: root
        env: FIRST_PORT
  second:
    path: ../second
    pathEnv: SECOND_DIR
    mappings:
      - port: SECOND_PORT
        app: root
        env: SECOND_PORT
`
    });

    runMonke({
      args: ["spawn", "concurrent"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    const state = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    expect(
      Object.fromEntries(
        state.repos.map((repo) => [
          repo.sourceRoot,
          { assignedPorts: repo.assignedPorts, status: repo.materializationStatus }
        ])
      )
    ).toStrictEqual({
      [firstRoot]: {
        assignedPorts: [{ key: "FIRST_PORT", value: 10_000 }],
        status: "materialized"
      },
      [root]: {
        assignedPorts: [],
        status: "materialized"
      },
      [secondRoot]: {
        assignedPorts: [{ key: "SECOND_PORT", value: 11_000 }],
        status: "materialized"
      }
    });
  });

  test("default-branch dependency bootstrap failure retains every prepared worktree", () => {
    const sandbox = makeTempDir("multi-repo-default-failed-dependency-preparation");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const depRoot = createRepo(path.join(sandbox, "dep"), {
      "monke.yml": `bootstrapCommand: sh scripts/bootstrap.sh
apps:
  db:
    path: services/db
    envFile: .env.local
    mappings:
      - port: DEP_PORT
        env: DEP
`,
      "scripts/bootstrap.sh": "exit 9\n",
      "services/db/.env.local": "DEP=1\n"
    });
    const root = createRepo(path.join(sandbox, "root"), {
      ".gitignore": "seed-data/\n",
      "apps/api/.env.local": "API=1\n",
      "monke.yml": `seedPaths:
      - seed-data
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
      - port: DEP_PORT
        app: api
        env: API
`,
      "seed-data/profile": "authenticated\n"
    });

    expect(() =>
      runMonke({
        args: ["spawn", "default-failure", "-m"],
        binDirectory,
        cwd: root,
        monkeHome: home
      })
    ).toThrow(/re-run mt spawn default-failure -m/u);

    const depWorktree = getExpectedWorktreePath(home, depRoot, "default-failure");
    const rootWorktree = getExpectedWorktreePath(home, root, "default-failure");
    expect(read(rootWorktree, "apps/api/.env.local")).toBe("API=1\n");
    expect(read(rootWorktree, "seed-data/profile")).toBe("authenticated\n");
    expect(existsSync(depWorktree)).toBeTruthy();
    const failedState = readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    expect(failedState.generation.status).toBe("incomplete");
    expect(failedState.repos.every((repo) => repo.pinnedRef !== undefined)).toBeTruthy();

    git(root, ["switch", "-c", "feature"]);
    write(root, "monke.yml", "apps: {}\n");
    git(root, ["add", "monke.yml"]);
    git(root, ["commit", "-m", "diverge feature config"]);
    write(depWorktree, "scripts/bootstrap.sh", ": > .bootstrap-complete\n");

    runMonke({
      args: ["spawn", "default-failure", "-m"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    expect(read(depWorktree, ".bootstrap-complete")).toBe("");
    expect(read(rootWorktree, ".env")).toContain("DEP_DIR=");
    expect(
      readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema).generation.status
    ).toBe("complete");
  });

  test("a Dependency repo Worktree preparation failure does not stop Root repo Worktree preparation", () => {
    const sandbox = makeTempDir("multi-repo-preparation-failure-settlement");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const depRoot = createRepo(path.join(sandbox, "dep"), {
      ".gitignore": "seed-data/\n",
      "monke.yml": `seedPaths:
  - seed-data
apps:
  db:
    path: services/db
    envFile: .env.local
    mappings:
      - port: DEP_PORT
        env: DEP
`,
      "seed-data/fixture": "dependency fixture\n",
      "services/db/.env.local": "DEP=1\n"
    });
    const root = createRepo(path.join(sandbox, "root"), {
      ".gitignore": "seed-data/\n",
      "apps/api/.env.local": "API=1\n",
      "monke.yml": `bootstrapCommand: printf x >> bootstrap-runs
seedPaths:
  - seed-data
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
      - port: DEP_PORT
        app: api
        env: API
`,
      "seed-data/original": "original\n"
    });

    runMonke({
      args: ["spawn", "preparation-failure"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    const rootWorktree = getExpectedWorktreePath(home, root, "preparation-failure");
    const protectedSourcePath = path.join(depRoot, "seed-data/protected");
    write(depRoot, "seed-data/protected/fixture", "protected fixture\n");
    chmodSync(protectedSourcePath, 0o000);
    write(root, "seed-data/new", "new Root material\n");

    try {
      expect(() =>
        runMonke({
          args: ["materialize"],
          binDirectory,
          cwd: rootWorktree,
          monkeHome: home
        })
      ).toThrow(/Worktree preparation failed/u);
    } finally {
      // Restore the mode even when the assertion fails, so temp-directory cleanup cannot
      // fail on an unreadable directory and mask the original failure.
      chmodSync(protectedSourcePath, 0o700);
    }
    expect(read(rootWorktree, "seed-data/new")).toBe("new Root material\n");
    expect(read(rootWorktree, "bootstrap-runs")).toBe("x");
  });

  test("public async Spawn starts worktree preparations concurrently", async () => {
    const sandbox = makeTempDir("multi-repo-bounded-preparation");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    installGitShim(binDirectory, { worktreeAddBarrier: 2 });
    createRepo(path.join(sandbox, "dep"), {
      "monke.yml": `apps:
  db:
    path: services/db
    envFile: .env.local
    mappings:
      - port: DEP_PORT
        env: DEP
`,
      "services/db/.env.local": "DEP=9000\n"
    });
    const root = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "API=http://localhost:9000\n",
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
        env: API
`
    });

    await runMonkeAsync({
      args: ["spawn", "bounded-preparation"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    expect(existsSync(getExpectedWorktreePath(home, root, "bounded-preparation"))).toBeTruthy();
  });

  test("spawn -m seeds untracked dependency env files from the dependency source checkout", () => {
    const sandbox = makeTempDir("multi-repo-main-untracked-seeds");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");

    const depRoot = createRepo(path.join(sandbox, "dep"), {
      ".gitignore": ".env\n.env.local\n",
      "monke.yml": `apps:
  db:
    path: services/db
    envFile: .env.local
    mappings:
      - port: DEP_POSTGRES_PORT
        env: PORT
`,
      "services/db/.env.local": "PORT=5432\n",
      "services/db/index.js": "// db\n"
    });

    const root = createRepo(path.join(sandbox, "root"), {
      ".gitignore": ".env\n.env.local\n",
      "apps/api/.env.local": "PORT=3000\nDATABASE_URL=postgres://localhost:5432/app\n",
      "apps/api/index.js": "// api\n",
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
      args: ["spawn", "fresh-dep-seeds", "-m"],
      binDirectory,
      cwd: root,
      monkeHome: home
    });

    const depWorktree = getExpectedWorktreePath(home, depRoot, "fresh-dep-seeds");
    const rootWorktree = getExpectedWorktreePath(home, root, "fresh-dep-seeds");
    expect(read(depWorktree, "services/db/.env.local")).toBe("PORT=10000\n");
    expect(read(rootWorktree, "apps/api/.env.local")).toBe(
      "PORT=11000\nDATABASE_URL=postgres://localhost:10000/app\n"
    );
    expect(read(depRoot, "services/db/.env.local")).toBe("PORT=5432\n");
  });
});
