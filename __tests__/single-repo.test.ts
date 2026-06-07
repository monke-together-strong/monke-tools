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

test("create and materialize resolve, reuse, write, and prune resource values", () => {
  const sandbox = makeTempDir("single-repo-resources");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
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

  const worktreeRoot = getExpectedWorktreePath(repoRoot, "banana");
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

test("create runs resource commands from the worktree and writes outputs to root env and state", () => {
  const sandbox = makeTempDir("single-repo-resource-commands");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources:
  commands:
    e2e-symbols:
      command: |
        pwd > command-cwd.log
        cat > command-stdin.json
        printf '%s' '{"E2E_FLOW1_SYMBOL":"SOL/USDT:USDT","E2E_FLOW2_SYMBOL":"LINK/USDT:USDT"}'
      outputs:
        - E2E_FLOW1_SYMBOL
        - E2E_FLOW2_SYMBOL
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
  expect(read(worktreeRoot, "command-cwd.log")).toBe(`${worktreeRoot}\n`);
  expect(JSON.parse(read(worktreeRoot, "command-stdin.json"))).toEqual({
    E2E_FLOW1_SYMBOL: [],
    E2E_FLOW2_SYMBOL: [],
  });
  expect(read(worktreeRoot, ".env")).toBe(
    "API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\nE2E_FLOW2_SYMBOL=LINK/USDT:USDT\n",
  );
  expect(read(worktreeRoot, "apps/api/.env.local")).toBe("PORT=10000\n");

  const sessionState = readSingleYamlFile(path.join(home, "sessions")) as {
    repos: Array<{
      resourceCommandOutputs?: Array<{
        name: string;
        outputs: Array<{ env: string; value: string }>;
      }>;
    }>;
  };
  expect(sessionState.repos[0]?.resourceCommandOutputs).toEqual([
    {
      name: "e2e-symbols",
      outputs: [
        { env: "E2E_FLOW1_SYMBOL", value: "SOL/USDT:USDT" },
        { env: "E2E_FLOW2_SYMBOL", value: "LINK/USDT:USDT" },
      ],
    },
  ]);
});

test("create and materialize reuse complete resource command outputs and prune undeclared outputs", () => {
  const sandbox = makeTempDir("single-repo-resource-command-reuse");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources:
  commands:
    e2e-symbols:
      command: |
        count=0
        if [ -f command-runs ]; then count=$(cat command-runs); fi
        count=$((count + 1))
        printf '%s' "$count" > command-runs
        printf '%s' '{"E2E_FLOW1_SYMBOL":"SOL/USDT:USDT","E2E_FLOW2_SYMBOL":"LINK/USDT:USDT"}'
      outputs:
        - E2E_FLOW1_SYMBOL
        - E2E_FLOW2_SYMBOL
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
  expect(read(worktreeRoot, "command-runs")).toBe("1");

  runMonke({
    cwd: repoRoot,
    args: ["create", "banana"],
    monkeHome: home,
    binDirectory,
  });
  runMonke({
    cwd: worktreeRoot,
    args: ["materialize"],
    monkeHome: home,
    binDirectory,
  });

  expect(read(worktreeRoot, "command-runs")).toBe("1");
  expect(read(worktreeRoot, ".env")).toBe(
    "API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\nE2E_FLOW2_SYMBOL=LINK/USDT:USDT\n",
  );

  write(
    repoRoot,
    "monke.yml",
    `apps:
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
  });

  expect(read(worktreeRoot, ".env")).toBe("API_PORT=10000\n");
  const sessionState = readSingleYamlFile(path.join(home, "sessions")) as {
    repos: Array<{ resourceCommandOutputs?: unknown }>;
  };
  expect(sessionState.repos[0]?.resourceCommandOutputs).toBeUndefined();
});

test("materialize reruns resource commands when remembered outputs are incomplete", () => {
  const sandbox = makeTempDir("single-repo-resource-command-incomplete");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources:
  commands:
    e2e-symbols:
      command: |
        count=0
        if [ -f command-runs ]; then count=$(cat command-runs); fi
        count=$((count + 1))
        printf '%s' "$count" > command-runs
        printf '%s' '{"E2E_FLOW1_SYMBOL":"SOL/USDT:USDT"}'
      outputs:
        - E2E_FLOW1_SYMBOL
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
  expect(read(worktreeRoot, "command-runs")).toBe("1");

  write(
    repoRoot,
    "monke.yml",
    `resources:
  commands:
    e2e-symbols:
      command: |
        count=0
        if [ -f command-runs ]; then count=$(cat command-runs); fi
        count=$((count + 1))
        printf '%s' "$count" > command-runs
        printf '%s' '{"E2E_FLOW1_SYMBOL":"LINK/USDT:USDT","E2E_FLOW2_SYMBOL":"ATOM/USDT:USDT"}'
      outputs:
        - E2E_FLOW1_SYMBOL
        - E2E_FLOW2_SYMBOL
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
  });

  expect(read(worktreeRoot, "command-runs")).toBe("2");
  expect(read(worktreeRoot, ".env")).toBe(
    "API_PORT=10000\nE2E_FLOW1_SYMBOL=LINK/USDT:USDT\nE2E_FLOW2_SYMBOL=ATOM/USDT:USDT\n",
  );
});

test("create persists resource command outputs before later materialization failures", () => {
  const sandbox = makeTempDir("single-repo-resource-command-partial");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "OTHER=keep\n",
    "monke.yml": `resources:
  commands:
    e2e-symbols:
      command: |
        count=0
        if [ -f command-runs ]; then count=$(cat command-runs); fi
        count=$((count + 1))
        printf '%s' "$count" > command-runs
        printf '%s' '{"E2E_FLOW1_SYMBOL":"SOL/USDT:USDT"}'
      outputs:
        - E2E_FLOW1_SYMBOL
apps:
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
      args: ["create", "banana"],
      monkeHome: home,
      binDirectory,
    }),
  ).toThrow(/Missing mapped env vars/);

  const worktreeRoot = getExpectedWorktreePath(repoRoot, "banana");
  const partialState = readSingleYamlFile(path.join(home, "sessions")) as {
    repos: Array<{
      resourceCommandOutputs?: Array<{
        name: string;
        outputs: Array<{ env: string; value: string }>;
      }>;
      materializationComplete?: boolean;
    }>;
  };
  expect(partialState.repos[0]?.resourceCommandOutputs).toEqual([
    {
      name: "e2e-symbols",
      outputs: [{ env: "E2E_FLOW1_SYMBOL", value: "SOL/USDT:USDT" }],
    },
  ]);
  expect(partialState.repos[0]?.materializationComplete).toBe(false);

  write(repoRoot, "apps/api/.env.local", "PORT=3000\nOTHER=keep\n");
  write(worktreeRoot, "apps/api/.env.local", "PORT=3000\nOTHER=keep\n");

  runMonke({
    cwd: repoRoot,
    args: ["create", "banana"],
    monkeHome: home,
    binDirectory,
  });

  expect(read(worktreeRoot, "command-runs")).toBe("1");
  expect(read(worktreeRoot, ".env")).toBe("API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\n");
});

test("materialize can prune stale resource command env after a failed rerun retry", () => {
  const sandbox = makeTempDir("single-repo-resource-command-prune-after-failure");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources:
  commands:
    e2e-symbols:
      command: printf '%s' '{"E2E_FLOW1_SYMBOL":"SOL/USDT:USDT","E2E_FLOW2_SYMBOL":"LINK/USDT:USDT"}'
      outputs:
        - E2E_FLOW1_SYMBOL
        - E2E_FLOW2_SYMBOL
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
  write(worktreeRoot, "apps/api/.env.local", "OTHER=keep\n");
  write(
    repoRoot,
    "monke.yml",
    `resources:
  commands:
    e2e-symbols:
      command: printf '%s' '{"E2E_FLOW1_SYMBOL":"SOL/USDT:USDT","E2E_FLOW3_SYMBOL":"ATOM/USDT:USDT"}'
      outputs:
        - E2E_FLOW1_SYMBOL
        - E2E_FLOW3_SYMBOL
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  );

  expect(() =>
    runMonke({
      cwd: worktreeRoot,
      args: ["materialize"],
      monkeHome: home,
      binDirectory,
    }),
  ).toThrow(/Missing mapped env vars/);

  const partialState = readSingleYamlFile(path.join(home, "sessions")) as {
    repos: Array<{
      resourceCommandOutputs?: Array<{
        outputs: Array<{ env: string; value: string }>;
      }>;
    }>;
  };
  expect(partialState.repos[0]?.resourceCommandOutputs?.[0]?.outputs).toEqual([
    { env: "E2E_FLOW1_SYMBOL", value: "SOL/USDT:USDT" },
    { env: "E2E_FLOW3_SYMBOL", value: "ATOM/USDT:USDT" },
    { env: "E2E_FLOW2_SYMBOL", value: "LINK/USDT:USDT" },
  ]);

  write(worktreeRoot, "apps/api/.env.local", "PORT=3000\n");

  runMonke({
    cwd: worktreeRoot,
    args: ["materialize"],
    monkeHome: home,
    binDirectory,
  });

  expect(read(worktreeRoot, ".env")).toBe(
    "API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\nE2E_FLOW3_SYMBOL=ATOM/USDT:USDT\n",
  );
});

test.each([
  {
    name: "invalid JSON",
    command: "printf '%s' 'not-json'",
    expected: /kind: invalid stdout JSON[\s\S]*stdout:[\s\S]*not-json/,
  },
  {
    name: "missing output",
    command: "printf '%s' '{}'",
    expected: /kind: stdout contract violation[\s\S]*stdout:[\s\S]*\{\}/,
  },
  {
    name: "extra output",
    command: 'printf \'%s\' \'{"E2E_FLOW1_SYMBOL":"SOL","EXTRA":"x"}\'',
    expected: /kind: stdout contract violation[\s\S]*stdout:[\s\S]*EXTRA/,
  },
  {
    name: "non-string output",
    command: "printf '%s' '{\"E2E_FLOW1_SYMBOL\":42}'",
    expected: /kind: stdout contract violation[\s\S]*stdout:[\s\S]*42/,
  },
  {
    name: "empty output",
    command: "printf '%s' '{\"E2E_FLOW1_SYMBOL\":\"   \"}'",
    expected: /kind: stdout contract violation[\s\S]*stdout:/,
  },
])("create rejects resource command stdout with $name", ({ command, expected }) => {
  const sandbox = makeTempDir("single-repo-resource-command-contract");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createResourceCommandRepo(path.join(sandbox, "root"), command, 60);

  expect(() =>
    runMonke({
      cwd: repoRoot,
      args: ["create", "banana"],
      monkeHome: home,
      binDirectory,
    }),
  ).toThrow(expected);
});

test("create reports nonzero resource command failures without stdout", () => {
  const sandbox = makeTempDir("single-repo-resource-command-nonzero");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createResourceCommandRepo(
    path.join(sandbox, "root"),
    `printf '%s' "$SECRET_STDOUT"
printf '%s' 'allocator stderr' >&2
exit 7`,
    60,
  );

  let message = "";
  try {
    runMonke({
      cwd: repoRoot,
      args: ["create", "banana"],
      monkeHome: home,
      binDirectory,
      extraEnv: { SECRET_STDOUT: "secret stdout" },
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toMatch(
    /Resource command e2e-symbols failed[\s\S]*kind: nonzero exit 7[\s\S]*allocator stderr/,
  );
  expect(message).not.toContain("secret stdout");
});

test("create reports resource command timeouts", () => {
  const sandbox = makeTempDir("single-repo-resource-command-timeout");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createResourceCommandRepo(path.join(sandbox, "root"), "sleep 5", 1);

  expect(() =>
    runMonke({
      cwd: repoRoot,
      args: ["create", "banana"],
      monkeHome: home,
      binDirectory,
    }),
  ).toThrow(/Resource command e2e-symbols failed[\s\S]*kind: timeout[\s\S]*stderr:[\s\S]*<empty>/);
});

test("create rejects resource value collisions with retained sessions", () => {
  const sandbox = makeTempDir("single-repo-resource-collision");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
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
  expect(inferSessionName(repoRoot, worktreeRoot, "banana")).toBe("banana");
  expect(() => inferSessionName(repoRoot, worktreeRoot, "wrong")).toThrow(/match current branch/);

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

  const worktreeRoot = getExpectedWorktreePath(repoRoot, "banana");
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
  installFakeWt(binDirectory);
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

  const worktreeRoot = getExpectedWorktreePath(repoRoot, "banana");
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
  installFakeWt(binDirectory);
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

  const worktreeRoot = getExpectedWorktreePath(repoRoot, "banana");
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

function createResourceCommandRepo(root: string, command: string, timeoutSeconds: number): string {
  return createRepo(root, {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources:
  commands:
    e2e-symbols:
      command: |
${indentBlock(command, 8)}
      timeoutSeconds: ${timeoutSeconds}
      outputs:
        - E2E_FLOW1_SYMBOL
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });
}

function indentBlock(value: string, spaces: number): string {
  const indentation = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${indentation}${line}`)
    .join("\n");
}
