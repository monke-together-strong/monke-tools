import { expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { inferSessionName, getExpectedWorktreePath } from "../src/git.ts";
import { getSessionStateFilePath, saveSessionState } from "../src/registry.ts";
import {
  createRepo,
  git,
  installShShim,
  makeTempDir,
  read,
  readSingleYamlFile,
  runMonke,
  write,
} from "./helpers.ts";

test("create bootstraps a single-repo session and rewrites only mapped env vars", () => {
  const sandbox = makeTempDir("single-repo");
  const binDirectory = path.join(sandbox, "bin");
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

  const result = runMonke({
    cwd: repoRoot,
    args: ["create", "banana"],
    monkeHome: home,
    binDirectory,
  });

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
  expect(result.stdout).toBe(`Created or updated session banana\n${worktreeRoot}\n`);
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
  expect(existsSync(path.join(sandbox, ".monke-worktrees"))).toBe(false);
});

test("create without monke.yml creates an unmaterialized worktree and warns", () => {
  const sandbox = makeTempDir("single-repo-no-config");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "hello\n",
  });

  const result = runMonke({
    cwd: repoRoot,
    args: ["create", "banana"],
    monkeHome: home,
    binDirectory,
  });

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
  expect(read(worktreeRoot, "README.md")).toBe("hello\n");
  expect(git(worktreeRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("banana");
  expect(result.stderr).toContain(
    `Warning: no monke.yml found for ${repoRoot}; created session worktree without materializing it.`,
  );
  expect(result.stdout).toBe(`Created or updated session banana\n${worktreeRoot}\n`);

  const sessionState = readSingleYamlFile(path.join(home, "sessions")) as {
    graphSource?: string;
    repos: Array<{
      sourceRoot: string;
      worktreePath: string;
      assignedPorts: unknown[];
      materializationComplete?: boolean;
    }>;
  };
  expect(sessionState.graphSource).toBe("session-branch");
  expect(sessionState.repos).toEqual([
    {
      sourceRoot: repoRoot,
      worktreePath: worktreeRoot,
      assignedPorts: [],
      materializationComplete: false,
    },
  ]);
});

test("create rejects stale repo-name session collisions from unrelated source roots", () => {
  const sandbox = makeTempDir("single-repo-global-path-collision");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoFiles = {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  };
  const firstRepo = createRepo(path.join(sandbox, "client-a", "api"), repoFiles);
  const secondRepo = createRepo(path.join(sandbox, "client-b", "api"), repoFiles);

  runMonke({
    cwd: firstRepo,
    args: ["create", "banana"],
    monkeHome: home,
    binDirectory,
  });
  git(firstRepo, [
    "worktree",
    "remove",
    "--force",
    getExpectedWorktreePath(home, firstRepo, "banana"),
  ]);

  expect(() =>
    runMonke({
      cwd: secondRepo,
      args: ["create", "banana"],
      monkeHome: home,
      binDirectory,
    }),
  ).toThrow(/Session worktree path collision.*already recorded/s);
});

test("create -m keeps default branch file content while avoiding source checkout baseline ports", () => {
  const sandbox = makeTempDir("single-repo-main-mode");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\nDEFAULT_ONLY=1\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });
  git(repoRoot, ["switch", "-c", "feature"]);
  write(repoRoot, "apps/api/.env.local", "PORT=10000\nBRANCH_DIRTY=1\n");

  runMonke({
    cwd: repoRoot,
    args: ["create", "fresh", "-m"],
    monkeHome: home,
    binDirectory,
  });

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "fresh");
  expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10001\nDEFAULT_ONLY=1\n");
  expect(read(worktreeRoot, ".env")).toBe("API_PORT=10001\n");
  expect(read(repoRoot, "apps/api/.env.local")).toBe("PORT=10000\nBRANCH_DIRTY=1\n");
});

test("create -m without monke.yml creates an unmaterialized default-branch worktree", () => {
  const sandbox = makeTempDir("single-repo-main-no-config");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "README.md": "main\n",
  });
  git(repoRoot, ["switch", "-c", "feature"]);
  write(repoRoot, "README.md", "feature\n");

  const result = runMonke({
    cwd: repoRoot,
    args: ["create", "fresh", "-m"],
    monkeHome: home,
    binDirectory,
  });

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "fresh");
  expect(read(worktreeRoot, "README.md")).toBe("main\n");
  expect(git(worktreeRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("fresh");
  expect(result.stderr).toContain(
    `Warning: no monke.yml found for ${repoRoot}; created session worktree without materializing it.`,
  );

  const sessionState = readSingleYamlFile(path.join(home, "sessions")) as {
    graphSource?: string;
    repos: Array<{ sourceRoot: string; worktreePath: string; materializationComplete?: boolean }>;
  };
  expect(sessionState.graphSource).toBe("session-branch");
  expect(sessionState.repos[0]).toMatchObject({
    sourceRoot: repoRoot,
    worktreePath: worktreeRoot,
    materializationComplete: false,
  });
});

test("create -m seeds configured paths from the source checkout", () => {
  const sandbox = makeTempDir("single-repo-main-seed-source");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `seedPaths:
  - local-only.txt
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });
  git(repoRoot, ["switch", "-c", "feature"]);
  write(repoRoot, "local-only.txt", "dirty source only\n");

  runMonke({
    cwd: repoRoot,
    args: ["create", "fresh", "-m"],
    monkeHome: home,
    binDirectory,
  });

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "fresh");
  expect(read(worktreeRoot, "local-only.txt")).toBe("dirty source only\n");
});

test("create -m seeds ignored managed env files and avoids their baseline ports", () => {
  const sandbox = makeTempDir("single-repo-main-local-env");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    ".gitignore": "apps/api/.env.local\n",
    "apps/api/package.json": "{}\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });
  git(repoRoot, ["switch", "-c", "feature"]);
  write(repoRoot, "apps/api/.env.local", "PORT=10000\nLOCAL_ONLY=1\n");

  runMonke({
    cwd: repoRoot,
    args: ["create", "fresh", "-m"],
    monkeHome: home,
    binDirectory,
  });

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "fresh");
  expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10001\nLOCAL_ONLY=1\n");
  expect(read(worktreeRoot, ".env")).toBe("API_PORT=10001\n");
});

test("create -m prefers fetched origin main over stale local main", () => {
  const sandbox = makeTempDir("single-repo-origin-main");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\nLOCAL_MAIN=1\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });
  const origin = path.join(sandbox, "origin.git");
  git(repoRoot, ["init", "--bare", origin]);
  git(repoRoot, ["remote", "add", "origin", origin]);
  git(repoRoot, ["push", "-u", "origin", "main"]);
  const localMain = git(repoRoot, ["rev-parse", "HEAD"]);
  write(repoRoot, "apps/api/.env.local", "PORT=4000\nORIGIN_MAIN=1\n");
  git(repoRoot, ["add", "apps/api/.env.local"]);
  git(repoRoot, ["commit", "-m", "origin main update"]);
  git(repoRoot, ["push", "origin", "main"]);
  git(repoRoot, ["reset", "--hard", localMain]);
  git(repoRoot, ["switch", "-c", "feature"]);

  runMonke({
    cwd: repoRoot,
    args: ["create", "remote-default", "-m"],
    monkeHome: home,
    binDirectory,
  });

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "remote-default");
  expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10000\nORIGIN_MAIN=1\n");
});

test("create -m prunes deleted origin main before choosing origin master", () => {
  const sandbox = makeTempDir("single-repo-pruned-origin-main");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\nLOCAL_MAIN=1\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });
  const origin = path.join(sandbox, "origin.git");
  git(repoRoot, ["init", "--bare", origin]);
  git(repoRoot, ["remote", "add", "origin", origin]);
  git(repoRoot, ["push", "-u", "origin", "main"]);
  const staleOriginMain = git(repoRoot, ["rev-parse", "refs/remotes/origin/main"]);

  git(repoRoot, ["switch", "-c", "master"]);
  write(repoRoot, "apps/api/.env.local", "PORT=4000\nORIGIN_MASTER=1\n");
  git(repoRoot, ["add", "apps/api/.env.local"]);
  git(repoRoot, ["commit", "-m", "origin master default"]);
  git(repoRoot, ["push", "origin", "master"]);
  git(origin, ["symbolic-ref", "HEAD", "refs/heads/master"]);
  git(repoRoot, ["push", "origin", "--delete", "main"]);
  git(repoRoot, ["update-ref", "refs/remotes/origin/main", staleOriginMain]);
  git(repoRoot, ["switch", "main"]);
  git(repoRoot, ["switch", "-c", "feature"]);

  runMonke({
    cwd: repoRoot,
    args: ["create", "remote-master", "-m"],
    monkeHome: home,
    binDirectory,
  });

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "remote-master");
  expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10000\nORIGIN_MASTER=1\n");
});

test("create -m falls back to local main when origin fetch fails", () => {
  const sandbox = makeTempDir("single-repo-fetch-fallback");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\nLOCAL_MAIN=1\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });
  const origin = path.join(sandbox, "origin.git");
  git(repoRoot, ["init", "--bare", origin]);
  git(repoRoot, ["remote", "add", "origin", origin]);
  git(repoRoot, ["push", "-u", "origin", "main"]);
  const localMain = git(repoRoot, ["rev-parse", "HEAD"]);
  write(repoRoot, "apps/api/.env.local", "PORT=4000\nSTALE_ORIGIN_MAIN=1\n");
  git(repoRoot, ["add", "apps/api/.env.local"]);
  git(repoRoot, ["commit", "-m", "stale origin main update"]);
  git(repoRoot, ["push", "origin", "main"]);
  git(repoRoot, ["reset", "--hard", localMain]);
  git(repoRoot, ["remote", "set-url", "origin", path.join(sandbox, "missing-origin.git")]);
  git(repoRoot, ["switch", "-c", "feature"]);

  runMonke({
    cwd: repoRoot,
    args: ["create", "local-default", "-m"],
    monkeHome: home,
    binDirectory,
  });

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "local-default");
  expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10000\nLOCAL_MAIN=1\n");
});

test("create -m rolls back failed fresh attempts so they can be retried", () => {
  const sandbox = makeTempDir("single-repo-main-rollback");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/package.json": "{}\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });

  expect(() =>
    runMonke({
      cwd: repoRoot,
      args: ["create", "retryable", "-m"],
      monkeHome: home,
      binDirectory,
    }),
  ).toThrow(/Expected managed env file to exist/);

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "retryable");
  expect(existsSync(worktreeRoot)).toBe(false);
  expect(existsSync(getSessionStateFilePath(home, repoRoot, "retryable"))).toBe(false);
  expect(() =>
    git(repoRoot, ["show-ref", "--verify", "--quiet", "refs/heads/retryable"]),
  ).toThrow();

  write(repoRoot, "apps/api/.env.local", "PORT=3000\n");
  git(repoRoot, ["add", "apps/api/.env.local"]);
  git(repoRoot, ["commit", "-m", "add api env"]);

  runMonke({
    cwd: repoRoot,
    args: ["create", "retryable", "-m"],
    monkeHome: home,
    binDirectory,
  });

  expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10000\n");
});

test("create -m fails when session state already exists", () => {
  const sandbox = makeTempDir("single-repo-main-existing-state");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
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
  saveSessionState(home, {
    version: 1,
    rootSourceRoot: repoRoot,
    session: "fresh",
    repos: [],
  });

  expect(() =>
    runMonke({
      cwd: repoRoot,
      args: ["create", "fresh", "-m"],
      monkeHome: home,
      binDirectory,
    }),
  ).toThrow(/Session state already exists for "fresh"/);
});

test("create -m fails when the session branch already exists", () => {
  const sandbox = makeTempDir("single-repo-main-existing-branch");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
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
  git(repoRoot, ["branch", "fresh"]);

  expect(() =>
    runMonke({
      cwd: repoRoot,
      args: ["create", "fresh", "-m"],
      monkeHome: home,
      binDirectory,
    }),
  ).toThrow(/Session branch "fresh" already exists/);
});

test("create --main and --master are aliases for default branch mode", () => {
  const sandbox = makeTempDir("single-repo-main-aliases");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
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

  for (const [session, flag, env] of [
    ["main-alias", "--main", "API_PORT=10000\n"],
    ["master-alias", "--master", "API_PORT=10001\n"],
  ] as const) {
    runMonke({
      cwd: repoRoot,
      args: ["create", session, flag],
      monkeHome: home,
      binDirectory,
    });

    expect(read(getExpectedWorktreePath(home, repoRoot, session), ".env")).toBe(env);
  }
});

test("create rewrites one local port key into multiple same-repo app env files", () => {
  const sandbox = makeTempDir("single-repo-shared-port");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "apps/web/.env.local": "API_URL=http://localhost:3000\n",
    "monke.yml": `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
  web:
    path: apps/web
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: API_URL
`,
  });

  runMonke({
    cwd: repoRoot,
    args: ["create", "banana"],
    monkeHome: home,
    binDirectory,
  });

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
  expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10000\n");
  expect(read(worktreeRoot, "apps/web/.env.local")).toBe("API_URL=http://localhost:10000\n");
  expect(read(worktreeRoot, ".env")).toBe("API_PORT=10000\n");
});

test("create and materialize resolve, reuse, write, and prune resource values", () => {
  const sandbox = makeTempDir("single-repo-resources");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\nOTHER=keep\n",
    "monke.yml": `resources:
  values:
    DISCORD_CHANNEL: mt-\${user}-\${session}
    STATIC_HANDLE: fixed-\${session}
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
    extraEnv: { USER: "ada" },
  });

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
  expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10000\nOTHER=keep\n");
  expect(read(worktreeRoot, ".env")).toBe(
    "API_PORT=10000\nDISCORD_CHANNEL=mt-ada-banana\nSTATIC_HANDLE=fixed-banana\n",
  );

  const initialState = readSingleYamlFile(path.join(home, "sessions")) as {
    repos: Array<{ resourceValues?: Array<{ env: string; value: string }> }>;
  };
  expect(initialState.repos[0]?.resourceValues).toEqual([
    { env: "DISCORD_CHANNEL", value: "mt-ada-banana" },
    { env: "STATIC_HANDLE", value: "fixed-banana" },
  ]);

  write(
    repoRoot,
    "monke.yml",
    `resources:
  values:
    DISCORD_CHANNEL: changed-\${session}
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  );

  runMonke({
    cwd: worktreeRoot,
    args: ["materialize"],
    monkeHome: home,
    binDirectory,
    extraEnv: { USER: "ada" },
  });

  expect(read(worktreeRoot, ".env")).toBe("API_PORT=10000\nDISCORD_CHANNEL=mt-ada-banana\n");

  const nextState = readSingleYamlFile(path.join(home, "sessions")) as {
    repos: Array<{ resourceValues?: Array<{ env: string; value: string }> }>;
  };
  expect(nextState.repos[0]?.resourceValues).toEqual([
    { env: "DISCORD_CHANNEL", value: "mt-ada-banana" },
  ]);
});

test("create rejects resource value collisions with retained sessions", () => {
  const sandbox = makeTempDir("single-repo-resource-collision");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources:
  values:
    DISCORD_CHANNEL: shared
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
    args: ["create", "first"],
    monkeHome: home,
    binDirectory,
  });

  expect(() =>
    runMonke({
      cwd: repoRoot,
      args: ["create", "second"],
      monkeHome: home,
      binDirectory,
    }),
  ).toThrow(/Resource value collision for DISCORD_CHANNEL=shared/);
});

test("materialize rejects source checkout context and reuses sticky ports inside a valid session worktree", () => {
  const sandbox = makeTempDir("single-materialize");
  const binDirectory = path.join(sandbox, "bin");
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

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
  expect(inferSessionName(home, repoRoot, worktreeRoot, "banana")).toBe("banana");
  expect(() => inferSessionName(home, repoRoot, worktreeRoot, "wrong")).toThrow(
    /match current branch/,
  );

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
  const shLogPath = installShShim(binDirectory);
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

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
  expect(read(worktreeRoot, "bootstrap-runs")).toBe(`${worktreeRoot}\n`);

  runMonke({
    cwd: worktreeRoot,
    args: ["materialize"],
    monkeHome: home,
    binDirectory,
  });

  expect(read(worktreeRoot, "bootstrap-runs")).toBe(`${worktreeRoot}\n${worktreeRoot}\n`);
  const shellArgs = readFileSync(shLogPath, "utf8").trim().split("\n");
  expect(shellArgs.filter((arg) => arg === "-c")).toHaveLength(2);
  expect(shellArgs).not.toContain("-lc");
});

test("create seeds configured directories and files into a new session worktree", () => {
  const sandbox = makeTempDir("single-seedpaths");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "apps/frostbite-crawler/data/sessions/hoangbn/Preferences": '{ "theme": "dark" }\n',
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

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
  expect(read(worktreeRoot, "apps/frostbite-crawler/data/sessions/hoangbn/Preferences")).toBe(
    '{ "theme": "dark" }\n',
  );
  expect(read(worktreeRoot, "apps/frostbite-crawler/data/sessions/hoangbn/Cookies")).toBe(
    "cookie-jar\n",
  );
  expect(read(worktreeRoot, "scripts/bootstrap.sh")).toBe("#!/bin/sh\necho seeded\n");
});

test("create merges seeded directories into tracked worktree directories without clobbering existing files", () => {
  const sandbox = makeTempDir("single-seedpaths-merge");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    ".gitignore": "apps/frostbite-crawler/data/sessions/hoangbn/Cookies\n",
    "apps/api/.env.local": "PORT=3000\n",
    "apps/frostbite-crawler/data/sessions/.gitkeep": "",
    "apps/frostbite-crawler/data/sessions/hoangbn/Preferences": '{ "theme": "dark" }\n',
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
  write(repoRoot, "apps/frostbite-crawler/data/sessions/hoangbn/Cookies", "cookie-jar\n");

  runMonke({
    cwd: repoRoot,
    args: ["create", "banana"],
    monkeHome: home,
    binDirectory,
  });

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
  expect(read(worktreeRoot, "apps/frostbite-crawler/data/sessions/.gitkeep")).toBe("");
  expect(read(worktreeRoot, "apps/frostbite-crawler/data/sessions/hoangbn/Preferences")).toBe(
    '{ "theme": "dark" }\n',
  );
  expect(read(worktreeRoot, "apps/frostbite-crawler/data/sessions/hoangbn/Cookies")).toBe(
    "cookie-jar\n",
  );
});

test("repeated create and materialize do not clobber seeded paths already changed in the worktree", () => {
  const sandbox = makeTempDir("single-seedpaths-no-clobber");
  const binDirectory = path.join(sandbox, "bin");
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "apps/frostbite-crawler/data/sessions/hoangbn/Preferences": '{ "theme": "dark" }\n',
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

  const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "banana");
  write(
    worktreeRoot,
    "apps/frostbite-crawler/data/sessions/hoangbn/Preferences",
    '{ "theme": "light" }\n',
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
    '{ "theme": "light" }\n',
  );
});

test("missing configured seedPaths warn and do not fail session creation", () => {
  const sandbox = makeTempDir("single-seedpaths-missing");
  const binDirectory = path.join(sandbox, "bin");
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

  expect(result.stderr).toContain(
    "Warning: seedPath apps/frostbite-crawler/data/sessions is missing",
  );
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
      cwd: getExpectedWorktreePath(home, root, "banana"),
      args: ["setup"],
      monkeHome: home,
      binDirectory,
    }),
  ).toThrow(/must run from the source checkout/);
});
