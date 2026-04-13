import { expect, test } from "vitest";
import path from "node:path";

import { loadResolvedGraph } from "../src/config.ts";
import { createRuntime } from "../src/runtime.ts";
import { createRepo, makeTempDir, write } from "./helpers.ts";

test("loadResolvedGraph accepts valid local and external config", () => {
  const sandbox = makeTempDir("config-valid");
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
    "apps/consumer/.env.local": "DATABASE_URL=postgres://localhost:5432/app\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
  consumer:
    path: apps/consumer
    envFile: .env.local
    mappings: []
external:
  dep:
    path: ../dep
    pathEnv: DEP_DIR
    mappings:
      - port: DEP_POSTGRES_PORT
        app: consumer
        env: DATABASE_URL
`,
  });

  const graph = loadResolvedGraph(createRuntime({ cwd: root }), root);

  expect(graph.reposInMaterializationOrder.map((repo) => repo.sourceRoot)).toEqual([depRoot, root]);
  expect(graph.reposByRoot.get(root)?.localPortOrder).toEqual(["API_PORT"]);
  expect(graph.reposByRoot.get(root)?.externalMappingsInOrder).toHaveLength(1);
  expect(graph.reposByRoot.get(root)?.externalInOrder[0]?.pathEnv).toBe("DEP_DIR");
  expect(graph.reposByRoot.get(root)?.bootstrapCommand).toBeUndefined();
});

test("loadResolvedGraph accepts bootstrapCommand when present", () => {
  const sandbox = makeTempDir("config-bootstrap");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `bootstrapCommand: pnpm install && pnpm generate
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });

  const graph = loadResolvedGraph(createRuntime({ cwd: root }), root);

  expect(graph.reposByRoot.get(root)?.bootstrapCommand).toBe("pnpm install && pnpm generate");
});

test("loadResolvedGraph accepts repo-level seedPaths", () => {
  const sandbox = makeTempDir("config-seedpaths");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "apps/frostbite-crawler/data/sessions/hoangbn/Preferences": "{}\n",
    "scripts/bootstrap.sh": "#!/bin/sh\n",
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

  const graph = loadResolvedGraph(createRuntime({ cwd: root }), root);

  expect(graph.reposByRoot.get(root)?.seedPaths).toEqual([
    "apps/frostbite-crawler/data/sessions",
    "scripts/bootstrap.sh",
  ]);
});

test("loadResolvedGraph rejects non-string bootstrapCommand", () => {
  const sandbox = makeTempDir("config-bootstrap-non-string");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `bootstrapCommand:
  nested: nope
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });

  expect(() => loadResolvedGraph(createRuntime({ cwd: root }), root)).toThrow(
    /bootstrapCommand.*non-empty string/,
  );
});

test("loadResolvedGraph rejects empty bootstrapCommand", () => {
  const sandbox = makeTempDir("config-bootstrap-empty");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `bootstrapCommand: "   "
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });

  expect(() => loadResolvedGraph(createRuntime({ cwd: root }), root)).toThrow(
    /bootstrapCommand.*non-empty string/,
  );
});

test("loadResolvedGraph rejects non-array seedPaths", () => {
  const sandbox = makeTempDir("config-seedpaths-not-array");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `seedPaths: apps/frostbite-crawler/data/sessions
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });

  expect(() => loadResolvedGraph(createRuntime({ cwd: root }), root)).toThrow(
    /seedPaths must be an array/,
  );
});

test("loadResolvedGraph rejects seedPaths that escape the repo root", () => {
  const sandbox = makeTempDir("config-seedpaths-escape");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `seedPaths:
  - ../shared/sessions
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });

  expect(() => loadResolvedGraph(createRuntime({ cwd: root }), root)).toThrow(
    /seedPaths\[0\].*must resolve inside/,
  );
});

test("loadResolvedGraph rejects duplicate normalized seedPaths", () => {
  const sandbox = makeTempDir("config-seedpaths-duplicate");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "apps/frostbite-crawler/data/sessions/hoangbn/Preferences": "{}\n",
    "monke.yml": `seedPaths:
  - apps/frostbite-crawler/data/sessions
  - apps/frostbite-crawler/data/../data/sessions
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });

  expect(() => loadResolvedGraph(createRuntime({ cwd: root }), root)).toThrow(/Duplicate seedPath/);
});

test("loadResolvedGraph rejects seedPaths that point at the repo root", () => {
  const sandbox = makeTempDir("config-seedpaths-root");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `seedPaths:
  - .
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });

  expect(() => loadResolvedGraph(createRuntime({ cwd: root }), root)).toThrow(
    /seedPath "." is not allowed/,
  );
});

test("loadResolvedGraph rejects seedPaths that normalize to the repo root", () => {
  const sandbox = makeTempDir("config-seedpaths-normalized-root");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "apps/.keep": "\n",
    "monke.yml": `seedPaths:
  - apps/..
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });

  expect(() => loadResolvedGraph(createRuntime({ cwd: root }), root)).toThrow(
    /seedPath "." is not allowed/,
  );
});

test("loadResolvedGraph rejects missing external pathEnv", () => {
  const sandbox = makeTempDir("config-missing-pathenv");
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
    mappings:
      - port: DEP_POSTGRES_PORT
        app: api
        env: DATABASE_URL
`,
  });

  expect(() => loadResolvedGraph(createRuntime({ cwd: root }), root)).toThrow(/pathEnv/);
});

test("loadResolvedGraph rejects invalid external pathEnv", () => {
  const sandbox = makeTempDir("config-invalid-pathenv");
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
    pathEnv: dep_dir
    mappings:
      - port: DEP_POSTGRES_PORT
        app: api
        env: DATABASE_URL
`,
  });

  expect(() => loadResolvedGraph(createRuntime({ cwd: root }), root)).toThrow(
    /must be an uppercase env name/,
  );
});

test("loadResolvedGraph rejects duplicate external pathEnv names", () => {
  const sandbox = makeTempDir("config-duplicate-pathenv");
  createRepo(path.join(sandbox, "dep-a"), {
    "services/a/.env.local": "PORT=5432\n",
    "monke.yml": `apps:
  a:
    path: services/a
    envFile: .env.local
    mappings:
      - port: DEP_A_PORT
        env: PORT
`,
  });
  createRepo(path.join(sandbox, "dep-b"), {
    "services/b/.env.local": "PORT=6432\n",
    "monke.yml": `apps:
  b:
    path: services/b
    envFile: .env.local
    mappings:
      - port: DEP_B_PORT
        env: PORT
`,
  });
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local":
      "DATABASE_URL=postgres://localhost:5432/app\nCACHE_URL=redis://localhost:6432/0\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings: []
external:
  dep-a:
    path: ../dep-a
    pathEnv: SHARED_DEP_DIR
    mappings:
      - port: DEP_A_PORT
        app: api
        env: DATABASE_URL
  dep-b:
    path: ../dep-b
    pathEnv: SHARED_DEP_DIR
    mappings:
      - port: DEP_B_PORT
        app: api
        env: CACHE_URL
`,
  });

  expect(() => loadResolvedGraph(createRuntime({ cwd: root }), root)).toThrow(
    /Duplicate external pathEnv SHARED_DEP_DIR/,
  );
});

test("loadResolvedGraph rejects duplicate yaml keys", () => {
  const sandbox = makeTempDir("config-duplicate-keys");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings: []
  api:
    path: apps/api
    envFile: .env.local
    mappings: []
`,
  });

  expect(() => loadResolvedGraph(createRuntime({ cwd: root }), root)).toThrow(/Invalid/);
});

test("loadResolvedGraph rejects duplicate rewrite targets", () => {
  const sandbox = makeTempDir("config-duplicate-targets");
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
        env: DATABASE_URL
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

  expect(() => loadResolvedGraph(createRuntime({ cwd: root }), root)).toThrow(
    /Duplicate rewrite target/,
  );
  expect(depRoot).toBeTruthy();
});

test("loadResolvedGraph rejects direct dependency references to non-local ports", () => {
  const sandbox = makeTempDir("config-direct-only");
  const leafRoot = createRepo(path.join(sandbox, "leaf"), {
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
  const depRoot = createRepo(path.join(sandbox, "dep"), {
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
      - port: LEAF_PORT
        app: api
        env: DATABASE_URL
`,
  });

  expect(() => loadResolvedGraph(createRuntime({ cwd: root }), root)).toThrow(/not owned locally/);
  expect(leafRoot).toBeTruthy();
  expect(depRoot).toBeTruthy();
});

test("loadResolvedGraph rejects unused zero-port apps", () => {
  const sandbox = makeTempDir("config-unused-zero-port");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "apps/consumer/.env.local": "DATABASE_URL=postgres://localhost:5432/app\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
  consumer:
    path: apps/consumer
    envFile: .env.local
    mappings: []
`,
  });
  write(root, "apps/consumer/.keep", "");

  expect(() => loadResolvedGraph(createRuntime({ cwd: root }), root)).toThrow(
    /owns no local ports/,
  );
});

test("loadResolvedGraph rejects duplicate local port keys across the resolved session graph", () => {
  const sandbox = makeTempDir("config-duplicate-port-keys");
  createRepo(path.join(sandbox, "dep"), {
    "services/db/.env.local": "PORT=5432\n",
    "monke.yml": `apps:
  db:
    path: services/db
    envFile: .env.local
    mappings:
      - port: SHARED_PORT
        env: PORT
`,
  });
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "apps/consumer/.env.local": "DATABASE_URL=postgres://localhost:5432/app\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: SHARED_PORT
        env: PORT
  consumer:
    path: apps/consumer
    envFile: .env.local
    mappings: []
external:
  dep:
    path: ../dep
    pathEnv: DEP_DIR
    mappings:
      - port: SHARED_PORT
        app: consumer
        env: DATABASE_URL
`,
  });

  expect(() => loadResolvedGraph(createRuntime({ cwd: root }), root)).toThrow(/owned by both/);
});

test("loadResolvedGraph rejects duplicate local port keys within one repo", () => {
  const sandbox = makeTempDir("config-duplicate-local-port");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "apps/worker/.env.local": "PORT=3001\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: SHARED_PORT
        env: PORT
  worker:
    path: apps/worker
    envFile: .env.local
    mappings:
      - port: SHARED_PORT
        env: PORT
`,
  });

  expect(() => loadResolvedGraph(createRuntime({ cwd: root }), root)).toThrow(
    /Duplicate local port key SHARED_PORT.*api and worker/,
  );
});

test("loadResolvedGraph rejects dependency cycles instead of returning cached partial config", () => {
  const sandbox = makeTempDir("config-cycle");
  const root = path.join(sandbox, "root");
  const dep = path.join(sandbox, "dep");

  createRepo(root, {
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
      - port: DEP_PORT
        app: api
        env: DATABASE_URL
`,
  });

  createRepo(dep, {
    "apps/db/.env.local": "PORT=5432\nDATABASE_URL=postgres://localhost:3000/dep\n",
    "monke.yml": `apps:
  db:
    path: apps/db
    envFile: .env.local
    mappings:
      - port: DEP_PORT
        env: PORT
external:
  root:
    path: ../root
    pathEnv: ROOT_DIR
    mappings:
      - port: API_PORT
        app: db
        env: DATABASE_URL
`,
  });

  expect(() => loadResolvedGraph(createRuntime({ cwd: root }), root)).toThrow(
    /Dependency cycles are not supported/,
  );
});

test("loadResolvedGraph rejects envFile paths that escape the app directory", () => {
  const sandbox = makeTempDir("config-envfile-escape");
  const root = createRepo(path.join(sandbox, "root"), {
    ".env.root": "DATABASE_URL=postgres://localhost:5432/root\n",
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: ../../.env.root
    mappings:
      - port: DB_PORT
        env: DATABASE_URL
`,
  });

  expect(() => loadResolvedGraph(createRuntime({ cwd: root }), root)).toThrow(
    /envFile.*must resolve inside/,
  );
});

test("loadResolvedGraph defaults envFile to .env when omitted", () => {
  const sandbox = makeTempDir("config-default-envfile");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env": "PORT=3000\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    mappings:
      - port: API_PORT
        env: PORT
`,
  });

  const graph = loadResolvedGraph(createRuntime({ cwd: root }), root);
  expect(graph.reposByRoot.get(root)?.appsByLabel.get("api")?.relativeEnvFile).toBe(".env");
});
