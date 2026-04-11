import { expect, test } from "bun:test";
import path from "node:path";

import { getExpectedWorktreePath } from "../src/git.ts";
import {
  createRepo,
  installFakeWt,
  makeTempDir,
  read,
  readSingleYamlFile,
  runMonke,
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

  expect(read(depWorktree, ".monke/ports.env")).toBe("DEP_POSTGRES_PORT=10000");
  expect(read(rootWorktree, "apps/api/.env.local")).toBe(
    "PORT=10001\nDATABASE_URL=postgres://localhost:10000/app\n",
  );
  expect(read(rootWorktree, ".monke/ports.env")).toBe("API_PORT=10001\nDEP_POSTGRES_PORT=10000");

  const sessionState = readSingleYamlFile(path.join(home, "sessions")) as {
    repos: Array<{ sourceRoot: string }>;
  };
  expect(sessionState.repos.map((repo) => repo.sourceRoot)).toEqual([depRoot, root]);
});
