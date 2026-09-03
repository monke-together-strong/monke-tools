import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { getExpectedWorktreePath } from "../src/git.ts";
import { getSessionStateFilePath, saveSessionState } from "../src/session-state-store.ts";
import { SessionStateSchema } from "../src/state-schema.ts";
import {
  createRepo,
  git,
  installGitShim,
  installShShim,
  makeTempDir,
  read,
  readSingleYamlFile,
  runMonke,
  runMonkeAsync,
  write
} from "./helpers.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

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

    saveSessionState(home, {
      repos: [
        {
          assignedPorts: [],
          resourceCommandOutputs: [
            {
              name: "e2e-symbols",
              outputs: [{ env: "E2E_FLOW1_SYMBOL", value: "SOL/USDT:USDT" }]
            }
          ],
          sourceRoot: depRoot,
          worktreePath: path.join(sandbox, "missing-alpha-dep")
        }
      ],
      rootSourceRoot: rootA,
      session: "alpha",
      version: 1
    });
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
      materializationComplete: false,
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

  test("dependency bootstrap failure still leaves the Root worktree prepared", () => {
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

  test("default-branch dependency bootstrap failure retains every prepared worktree", () => {
    const sandbox = makeTempDir("multi-repo-default-failed-dependency-preparation");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const depRoot = createRepo(path.join(sandbox, "dep"), {
      "monke.yml": `bootstrapCommand: exit 9
apps:
  db:
    path: services/db
    envFile: .env.local
    mappings:
      - port: DEP_PORT
        env: DEP
`,
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
    ).toThrow(/Bootstrap command failed/u);

    const rootWorktree = getExpectedWorktreePath(home, root, "default-failure");
    expect(read(rootWorktree, "apps/api/.env.local")).toBe("API=1\n");
    expect(read(rootWorktree, "seed-data/profile")).toBe("authenticated\n");
    expect(existsSync(getExpectedWorktreePath(home, depRoot, "default-failure"))).toBeTruthy();
  });

  test("a Dependency preparation failure does not stop Root preparation", () => {
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

    const depWorktree = getExpectedWorktreePath(home, depRoot, "preparation-failure");
    const rootWorktree = getExpectedWorktreePath(home, root, "preparation-failure");
    rmSync(path.join(depWorktree, "seed-data"), { recursive: true });
    write(depWorktree, "seed-data", "copy conflict\n");
    write(root, "seed-data/new", "new Root material\n");

    expect(() =>
      runMonke({
        args: ["materialize"],
        binDirectory,
        cwd: rootWorktree,
        monkeHome: home
      })
    ).toThrow(/Worktree preparation failed/u);

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
