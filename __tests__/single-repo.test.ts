import { expect, test } from "vitest";
import path from "node:path";

import { inferSessionName, getExpectedWorktreePath } from "../src/git.ts";
import { loadSessionState, saveSessionState } from "../src/registry.ts";
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

test("create builds resource command stdin from retained command outputs only", () => {
  const sandbox = makeTempDir("single-repo-resource-command-retained-input");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources:
  values:
    DISCORD_CHANNEL: discord-\${session}
  commands:
    e2e-symbols:
      command: |
        cat > command-stdin.json
        if grep -q 'SOL/USDT:USDT' command-stdin.json; then
          printf '%s' '{"E2E_FLOW1_SYMBOL":"LINK/USDT:USDT","E2E_FLOW2_SYMBOL":"NEAR/USDT:USDT"}'
        else
          printf '%s' '{"E2E_FLOW1_SYMBOL":"SOL/USDT:USDT","E2E_FLOW2_SYMBOL":"ATOM/USDT:USDT"}'
        fi
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
  saveSessionState(home, {
    version: 1,
    rootSourceRoot: repoRoot,
    session: "first",
    repos: [
      {
        sourceRoot: repoRoot,
        worktreePath: path.join(sandbox, "missing-first"),
        assignedPorts: [],
        resourceValues: [{ env: "DISCORD_CHANNEL", value: "discord-first" }],
        resourceCommandOutputs: [
          {
            name: "e2e-symbols",
            outputs: [
              { env: "E2E_FLOW1_SYMBOL", value: "SOL/USDT:USDT" },
              { env: "E2E_FLOW2_SYMBOL", value: "ATOM/USDT:USDT" },
            ],
          },
        ],
      },
    ],
  });
  runMonke({
    cwd: repoRoot,
    args: ["create", "second"],
    monkeHome: home,
    binDirectory,
  });

  const secondInput = JSON.parse(
    read(getExpectedWorktreePath(repoRoot, "second"), "command-stdin.json"),
  ) as Record<string, string[]>;
  expect(Object.keys(secondInput)).toEqual(["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"]);
  expect(secondInput).toEqual({
    E2E_FLOW1_SYMBOL: ["SOL/USDT:USDT"],
    E2E_FLOW2_SYMBOL: ["ATOM/USDT:USDT"],
  });
  expect(JSON.stringify(secondInput)).not.toContain("discord-first");
});

test("create dedupes retained resource command input values", () => {
  const sandbox = makeTempDir("single-repo-resource-command-input-dedupe");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources:
  commands:
    e2e-symbols:
      command: |
        cat > command-stdin.json
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
  });
  saveSessionState(home, {
    version: 1,
    rootSourceRoot: path.join(sandbox, "graph-a"),
    session: "retained-a",
    repos: [
      {
        sourceRoot: repoRoot,
        worktreePath: path.join(sandbox, "missing-a"),
        assignedPorts: [],
        resourceValues: [{ env: "E2E_FLOW2_SYMBOL", value: "DETERMINISTIC_SHOULD_NOT_APPEAR" }],
        resourceCommandOutputs: [
          {
            name: "e2e-symbols",
            outputs: [{ env: "E2E_FLOW1_SYMBOL", value: "SOL/USDT:USDT" }],
          },
          {
            name: "renamed-symbols",
            outputs: [{ env: "E2E_FLOW2_SYMBOL", value: "RENAMED_SHOULD_NOT_APPEAR" }],
          },
        ],
      },
    ],
  });
  saveSessionState(home, {
    version: 1,
    rootSourceRoot: path.join(sandbox, "graph-b"),
    session: "retained-b",
    repos: [
      {
        sourceRoot: repoRoot,
        worktreePath: path.join(sandbox, "missing-b"),
        assignedPorts: [],
        resourceCommandOutputs: [
          {
            name: "e2e-symbols",
            outputs: [
              { env: "E2E_FLOW1_SYMBOL", value: "SOL/USDT:USDT" },
              { env: "E2E_FLOW2_SYMBOL", value: "NEAR/USDT:USDT" },
            ],
          },
        ],
      },
    ],
  });
  saveSessionState(home, {
    version: 1,
    rootSourceRoot: path.join(sandbox, "graph-c"),
    session: "current",
    repos: [
      {
        sourceRoot: repoRoot,
        worktreePath: path.join(sandbox, "current-worktree-from-another-graph"),
        assignedPorts: [],
        resourceCommandOutputs: [
          {
            name: "e2e-symbols",
            outputs: [{ env: "E2E_FLOW2_SYMBOL", value: "CURRENT_SHOULD_NOT_APPEAR" }],
          },
        ],
      },
    ],
  });

  runMonke({
    cwd: repoRoot,
    args: ["create", "current"],
    monkeHome: home,
    binDirectory,
  });

  const input = JSON.parse(
    read(getExpectedWorktreePath(repoRoot, "current"), "command-stdin.json"),
  ) as Record<string, string[]>;
  expect(input.E2E_FLOW1_SYMBOL?.sort()).toEqual(["SOL/USDT:USDT"]);
  expect(input.E2E_FLOW2_SYMBOL?.sort()).toEqual(["NEAR/USDT:USDT"]);
  expect(JSON.stringify(input)).not.toContain("DETERMINISTIC_SHOULD_NOT_APPEAR");
  expect(JSON.stringify(input)).not.toContain("RENAMED_SHOULD_NOT_APPEAR");
  expect(JSON.stringify(input)).not.toContain("CURRENT_SHOULD_NOT_APPEAR");
});

test("materialize excludes current-session command outputs when rerunning incomplete outputs", () => {
  const sandbox = makeTempDir("single-repo-resource-command-current-session-input");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources:
  commands:
    e2e-symbols:
      command: printf '%s' '{"E2E_FLOW1_SYMBOL":"SOL/USDT:USDT"}'
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
  write(
    repoRoot,
    "monke.yml",
    `resources:
  commands:
    e2e-symbols:
      command: |
        cat > command-stdin-rerun.json
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

  expect(JSON.parse(read(worktreeRoot, "command-stdin-rerun.json"))).toEqual({
    E2E_FLOW1_SYMBOL: [],
    E2E_FLOW2_SYMBOL: [],
  });
});

test("create rejects same-output resource command collisions", () => {
  const sandbox = makeTempDir("single-repo-resource-command-output-collision");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createResourceCommandRepo(
    path.join(sandbox, "root"),
    `cat > command-stdin.json
printf '%s' '{"E2E_FLOW1_SYMBOL":"SOL/USDT:USDT"}'`,
    60,
  );

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
  ).toThrow(/kind: same-output collision for E2E_FLOW1_SYMBOL[\s\S]*stdout:/);
});

test("create leaves cross-output uniqueness to repo-owned resource commands", () => {
  const sandbox = makeTempDir("single-repo-resource-command-cross-output");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources:
  commands:
    e2e-symbols:
      command: |
        cat > command-stdin.json
        if grep -q 'ALPHA/USDT:USDT' command-stdin.json; then
          printf '%s' '{"E2E_FLOW1_SYMBOL":"SOL/USDT:USDT","E2E_FLOW2_SYMBOL":"LINK/USDT:USDT"}'
        else
          printf '%s' '{"E2E_FLOW1_SYMBOL":"ALPHA/USDT:USDT","E2E_FLOW2_SYMBOL":"SOL/USDT:USDT"}'
        fi
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
  saveSessionState(home, {
    version: 1,
    rootSourceRoot: repoRoot,
    session: "first",
    repos: [
      {
        sourceRoot: repoRoot,
        worktreePath: path.join(sandbox, "missing-first"),
        assignedPorts: [],
        resourceCommandOutputs: [
          {
            name: "e2e-symbols",
            outputs: [
              { env: "E2E_FLOW1_SYMBOL", value: "ALPHA/USDT:USDT" },
              { env: "E2E_FLOW2_SYMBOL", value: "SOL/USDT:USDT" },
            ],
          },
        ],
      },
    ],
  });
  runMonke({
    cwd: repoRoot,
    args: ["create", "second"],
    monkeHome: home,
    binDirectory,
  });

  expect(read(getExpectedWorktreePath(repoRoot, "second"), ".env")).toBe(
    "API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\nE2E_FLOW2_SYMBOL=LINK/USDT:USDT\n",
  );
});

test("resource command renames create a new retained input namespace", () => {
  const sandbox = makeTempDir("single-repo-resource-command-rename");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createResourceCommandRepo(
    path.join(sandbox, "root"),
    "printf '%s' '{\"E2E_FLOW1_SYMBOL\":\"SOL/USDT:USDT\"}'",
    60,
  );

  runMonke({
    cwd: repoRoot,
    args: ["create", "banana"],
    monkeHome: home,
    binDirectory,
  });

  const worktreeRoot = getExpectedWorktreePath(repoRoot, "banana");
  write(
    repoRoot,
    "monke.yml",
    `resources:
  commands:
    renamed-symbols:
      command: |
        cat > command-stdin-renamed.json
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
  );

  runMonke({
    cwd: worktreeRoot,
    args: ["materialize"],
    monkeHome: home,
    binDirectory,
  });

  expect(JSON.parse(read(worktreeRoot, "command-stdin-renamed.json"))).toEqual({
    E2E_FLOW1_SYMBOL: [],
  });
});

test("multiple resource commands run in YAML order", () => {
  const sandbox = makeTempDir("single-repo-resource-command-order");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources:
  commands:
    first-symbols:
      command: |
        printf '%s\\n' first >> command-order.log
        printf '%s' '{"FIRST_SYMBOL":"SOL/USDT:USDT"}'
      outputs:
        - FIRST_SYMBOL
    second-symbols:
      command: |
        printf '%s\\n' second >> command-order.log
        printf '%s' '{"SECOND_SYMBOL":"LINK/USDT:USDT"}'
      outputs:
        - SECOND_SYMBOL
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

  expect(read(getExpectedWorktreePath(repoRoot, "banana"), "command-order.log")).toBe(
    "first\nsecond\n",
  );
});

test("retained dead session states contribute until cleanup removes them", () => {
  const sandbox = makeTempDir("single-repo-resource-command-cleanup-boundary");
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources:
  commands:
    e2e-symbols:
      command: |
        cat > command-stdin.json
        if grep -q 'LINK/USDT:USDT' command-stdin.json; then
          value='ATOM/USDT:USDT'
        elif grep -q 'SOL/USDT:USDT' command-stdin.json; then
          value='LINK/USDT:USDT'
        else
          value='SOL/USDT:USDT'
        fi
        printf '{"E2E_FLOW1_SYMBOL":"%s"}' "$value"
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
  saveSessionState(home, {
    version: 1,
    rootSourceRoot: repoRoot,
    session: "first",
    repos: [
      {
        sourceRoot: repoRoot,
        worktreePath: path.join(sandbox, "missing-first"),
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
    cwd: repoRoot,
    args: ["create", "second"],
    monkeHome: home,
    binDirectory,
  });
  expect(read(getExpectedWorktreePath(repoRoot, "second"), "command-stdin.json")).toContain(
    "SOL/USDT:USDT",
  );

  const secondState = loadSessionState(home, repoRoot, "second");
  saveSessionState(home, {
    ...secondState,
    repos: secondState.repos.map((repo) => ({ ...repo, assignedPorts: [] })),
  });

  runMonke({
    cwd: repoRoot,
    args: ["cleanup"],
    monkeHome: home,
    binDirectory,
  });
  runMonke({
    cwd: repoRoot,
    args: ["create", "third"],
    monkeHome: home,
    binDirectory,
  });

  const thirdInput = read(getExpectedWorktreePath(repoRoot, "third"), "command-stdin.json");
  expect(thirdInput).not.toContain("SOL/USDT:USDT");
  expect(thirdInput).toContain("LINK/USDT:USDT");
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
