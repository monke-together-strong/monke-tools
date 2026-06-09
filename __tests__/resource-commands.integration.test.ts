import { expect, test } from "vitest";
import path from "node:path";

import { getExpectedWorktreePath } from "../src/git.ts";
import { loadSessionState, saveSessionState } from "../src/registry.ts";
import {
  createRepo,
  installFakeWt,
  installShShim,
  makeTempDir,
  read,
  readSingleYamlFile,
  runMonke,
  write,
} from "./helpers.ts";

test("create runs resource commands from the worktree and writes outputs to root env and state", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-commands",
    command: `pwd > command-cwd.log
cat > command-stdin.json
printf '%s' '{"E2E_FLOW1_SYMBOL":"SOL/USDT:USDT","E2E_FLOW2_SYMBOL":"LINK/USDT:USDT"}'`,
    outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"],
  });

  scenario.create("banana");

  const worktreeRoot = scenario.worktree("banana");
  expect(scenario.readWorktree("banana", "command-cwd.log")).toBe(`${worktreeRoot}\n`);
  expect(JSON.parse(scenario.readWorktree("banana", "command-stdin.json"))).toEqual({
    E2E_FLOW1_SYMBOL: [],
    E2E_FLOW2_SYMBOL: [],
  });
  expect(scenario.readWorktree("banana", ".env")).toBe(
    "API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\nE2E_FLOW2_SYMBOL=LINK/USDT:USDT\n",
  );
  expect(scenario.readWorktree("banana", "apps/api/.env.local")).toBe("PORT=10000\n");

  const sessionState = scenario.readSessionState<{
    repos: Array<{
      resourceCommandOutputs?: Array<{
        name: string;
        outputs: Array<{ env: string; value: string }>;
      }>;
    }>;
  }>();
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
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-retained-input",
    resourceValuesYaml: "DISCORD_CHANNEL: discord-${session}",
    command: `cat > command-stdin.json
if grep -q 'SOL/USDT:USDT' command-stdin.json; then
  printf '%s' '{"E2E_FLOW1_SYMBOL":"LINK/USDT:USDT","E2E_FLOW2_SYMBOL":"NEAR/USDT:USDT"}'
else
  printf '%s' '{"E2E_FLOW1_SYMBOL":"SOL/USDT:USDT","E2E_FLOW2_SYMBOL":"ATOM/USDT:USDT"}'
fi`,
    outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"],
  });
  saveSessionState(scenario.home, {
    version: 1,
    rootSourceRoot: scenario.repoRoot,
    session: "first",
    repos: [
      {
        sourceRoot: scenario.repoRoot,
        worktreePath: path.join(scenario.sandbox, "missing-first"),
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

  scenario.create("second");

  const secondInput = JSON.parse(scenario.readWorktree("second", "command-stdin.json")) as Record<
    string,
    string[]
  >;
  expect(Object.keys(secondInput)).toEqual(["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"]);
  expect(secondInput).toEqual({
    E2E_FLOW1_SYMBOL: ["SOL/USDT:USDT"],
    E2E_FLOW2_SYMBOL: ["ATOM/USDT:USDT"],
  });
  expect(JSON.stringify(secondInput)).not.toContain("discord-first");
});

test("create dedupes retained resource command input values", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-input-dedupe",
    command: `cat > command-stdin.json
printf '%s' '{"E2E_FLOW1_SYMBOL":"LINK/USDT:USDT","E2E_FLOW2_SYMBOL":"ATOM/USDT:USDT"}'`,
    outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"],
  });
  saveSessionState(scenario.home, {
    version: 1,
    rootSourceRoot: path.join(scenario.sandbox, "graph-a"),
    session: "retained-a",
    repos: [
      {
        sourceRoot: scenario.repoRoot,
        worktreePath: path.join(scenario.sandbox, "missing-a"),
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
  saveSessionState(scenario.home, {
    version: 1,
    rootSourceRoot: path.join(scenario.sandbox, "graph-b"),
    session: "retained-b",
    repos: [
      {
        sourceRoot: scenario.repoRoot,
        worktreePath: path.join(scenario.sandbox, "missing-b"),
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
  saveSessionState(scenario.home, {
    version: 1,
    rootSourceRoot: path.join(scenario.sandbox, "graph-c"),
    session: "current",
    repos: [
      {
        sourceRoot: scenario.repoRoot,
        worktreePath: path.join(scenario.sandbox, "current-worktree-from-another-graph"),
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

  scenario.create("current");

  const input = JSON.parse(scenario.readWorktree("current", "command-stdin.json")) as Record<
    string,
    string[]
  >;
  expect(input.E2E_FLOW1_SYMBOL?.sort()).toEqual(["SOL/USDT:USDT"]);
  expect(input.E2E_FLOW2_SYMBOL?.sort()).toEqual(["NEAR/USDT:USDT"]);
  expect(JSON.stringify(input)).not.toContain("DETERMINISTIC_SHOULD_NOT_APPEAR");
  expect(JSON.stringify(input)).not.toContain("RENAMED_SHOULD_NOT_APPEAR");
  expect(JSON.stringify(input)).not.toContain("CURRENT_SHOULD_NOT_APPEAR");
});

test("materialize excludes current-session command outputs when rerunning incomplete outputs", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-current-session-input",
    command: "printf '%s' '{\"E2E_FLOW1_SYMBOL\":\"SOL/USDT:USDT\"}'",
  });

  scenario.create("banana");
  scenario.writeRoot(
    "monke.yml",
    singleCommandMonkeYml({
      command: `cat > command-stdin-rerun.json
printf '%s' '{"E2E_FLOW1_SYMBOL":"LINK/USDT:USDT","E2E_FLOW2_SYMBOL":"ATOM/USDT:USDT"}'`,
      outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"],
    }),
  );

  scenario.materialize("banana");

  expect(JSON.parse(scenario.readWorktree("banana", "command-stdin-rerun.json"))).toEqual({
    E2E_FLOW1_SYMBOL: [],
    E2E_FLOW2_SYMBOL: [],
  });
});

test("create rejects same-output resource command collisions", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-output-collision",
    command: `cat > command-stdin.json
printf '%s' '{"E2E_FLOW1_SYMBOL":"SOL/USDT:USDT"}'`,
  });

  scenario.create("first");

  expect(() => scenario.create("second")).toThrow(
    /kind: same-output collision for E2E_FLOW1_SYMBOL[\s\S]*stdout:/,
  );
});

test("create leaves cross-output uniqueness to repo-owned resource commands", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-cross-output",
    command: `cat > command-stdin.json
if grep -q 'ALPHA/USDT:USDT' command-stdin.json; then
  printf '%s' '{"E2E_FLOW1_SYMBOL":"SOL/USDT:USDT","E2E_FLOW2_SYMBOL":"LINK/USDT:USDT"}'
else
  printf '%s' '{"E2E_FLOW1_SYMBOL":"ALPHA/USDT:USDT","E2E_FLOW2_SYMBOL":"SOL/USDT:USDT"}'
fi`,
    outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"],
  });
  saveSessionState(scenario.home, {
    version: 1,
    rootSourceRoot: scenario.repoRoot,
    session: "first",
    repos: [
      {
        sourceRoot: scenario.repoRoot,
        worktreePath: path.join(scenario.sandbox, "missing-first"),
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

  scenario.create("second");

  expect(scenario.readWorktree("second", ".env")).toBe(
    "API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\nE2E_FLOW2_SYMBOL=LINK/USDT:USDT\n",
  );
});

test("resource command renames create a new retained input namespace", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-rename",
    command: "printf '%s' '{\"E2E_FLOW1_SYMBOL\":\"SOL/USDT:USDT\"}'",
  });

  scenario.create("banana");
  scenario.writeRoot(
    "monke.yml",
    singleCommandMonkeYml({
      commandName: "renamed-symbols",
      command: `cat > command-stdin-renamed.json
printf '%s' '{"E2E_FLOW1_SYMBOL":"SOL/USDT:USDT"}'`,
    }),
  );

  scenario.materialize("banana");

  expect(JSON.parse(scenario.readWorktree("banana", "command-stdin-renamed.json"))).toEqual({
    E2E_FLOW1_SYMBOL: [],
  });
});

test("multiple resource commands run in YAML order", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-order",
    monkeYml: withDefaultApp(`resources:
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
        - SECOND_SYMBOL`),
  });

  scenario.create("banana");

  expect(scenario.readWorktree("banana", "command-order.log")).toBe("first\nsecond\n");
});

test("retained dead session states contribute until cleanup removes them", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-cleanup-boundary",
    command: `cat > command-stdin.json
if grep -q 'LINK/USDT:USDT' command-stdin.json; then
  value='ATOM/USDT:USDT'
elif grep -q 'SOL/USDT:USDT' command-stdin.json; then
  value='LINK/USDT:USDT'
else
  value='SOL/USDT:USDT'
fi
printf '{"E2E_FLOW1_SYMBOL":"%s"}' "$value"`,
  });
  saveSessionState(scenario.home, {
    version: 1,
    rootSourceRoot: scenario.repoRoot,
    session: "first",
    repos: [
      {
        sourceRoot: scenario.repoRoot,
        worktreePath: path.join(scenario.sandbox, "missing-first"),
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

  scenario.create("second");
  expect(scenario.readWorktree("second", "command-stdin.json")).toContain("SOL/USDT:USDT");

  const secondState = loadSessionState(scenario.home, scenario.repoRoot, "second");
  saveSessionState(scenario.home, {
    ...secondState,
    repos: secondState.repos.map((repo) => ({ ...repo, assignedPorts: [] })),
  });

  scenario.cleanup();
  scenario.create("third");

  const thirdInput = scenario.readWorktree("third", "command-stdin.json");
  expect(thirdInput).not.toContain("SOL/USDT:USDT");
  expect(thirdInput).toContain("LINK/USDT:USDT");
});

test("create and materialize reuse complete resource command outputs and prune undeclared outputs", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-reuse",
    command: `count=0
if [ -f command-runs ]; then count=$(cat command-runs); fi
count=$((count + 1))
printf '%s' "$count" > command-runs
printf '%s' '{"E2E_FLOW1_SYMBOL":"SOL/USDT:USDT","E2E_FLOW2_SYMBOL":"LINK/USDT:USDT"}'`,
    outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"],
  });

  scenario.create("banana");
  expect(scenario.readWorktree("banana", "command-runs")).toBe("1");

  scenario.create("banana");
  scenario.materialize("banana");

  expect(scenario.readWorktree("banana", "command-runs")).toBe("1");
  expect(scenario.readWorktree("banana", ".env")).toBe(
    "API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\nE2E_FLOW2_SYMBOL=LINK/USDT:USDT\n",
  );

  scenario.writeRoot("monke.yml", appOnlyMonkeYml());
  scenario.materialize("banana");

  expect(scenario.readWorktree("banana", ".env")).toBe("API_PORT=10000\n");
  const sessionState = scenario.readSessionState<{
    repos: Array<{ resourceCommandOutputs?: unknown }>;
  }>();
  expect(sessionState.repos[0]?.resourceCommandOutputs).toBeUndefined();
});

test("materialize reruns resource commands when remembered outputs are incomplete", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-incomplete",
    command: `count=0
if [ -f command-runs ]; then count=$(cat command-runs); fi
count=$((count + 1))
printf '%s' "$count" > command-runs
printf '%s' '{"E2E_FLOW1_SYMBOL":"SOL/USDT:USDT"}'`,
  });

  scenario.create("banana");
  expect(scenario.readWorktree("banana", "command-runs")).toBe("1");

  scenario.writeRoot(
    "monke.yml",
    singleCommandMonkeYml({
      command: `count=0
if [ -f command-runs ]; then count=$(cat command-runs); fi
count=$((count + 1))
printf '%s' "$count" > command-runs
printf '%s' '{"E2E_FLOW1_SYMBOL":"LINK/USDT:USDT","E2E_FLOW2_SYMBOL":"ATOM/USDT:USDT"}'`,
      outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"],
    }),
  );

  scenario.materialize("banana");

  expect(scenario.readWorktree("banana", "command-runs")).toBe("2");
  expect(scenario.readWorktree("banana", ".env")).toBe(
    "API_PORT=10000\nE2E_FLOW1_SYMBOL=LINK/USDT:USDT\nE2E_FLOW2_SYMBOL=ATOM/USDT:USDT\n",
  );
});

test("create persists resource command outputs before later materialization failures", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-partial",
    appEnv: "OTHER=keep\n",
    command: `count=0
if [ -f command-runs ]; then count=$(cat command-runs); fi
count=$((count + 1))
printf '%s' "$count" > command-runs
printf '%s' '{"E2E_FLOW1_SYMBOL":"SOL/USDT:USDT"}'`,
  });

  expect(() => scenario.create("banana")).toThrow(/Missing mapped env vars/);

  const partialState = scenario.readSessionState<{
    repos: Array<{
      resourceCommandOutputs?: Array<{
        name: string;
        outputs: Array<{ env: string; value: string }>;
      }>;
      materializationComplete?: boolean;
    }>;
  }>();
  expect(partialState.repos[0]?.resourceCommandOutputs).toEqual([
    {
      name: "e2e-symbols",
      outputs: [{ env: "E2E_FLOW1_SYMBOL", value: "SOL/USDT:USDT" }],
    },
  ]);
  expect(partialState.repos[0]?.materializationComplete).toBe(false);

  scenario.writeRoot("apps/api/.env.local", "PORT=3000\nOTHER=keep\n");
  scenario.writeWorktree("banana", "apps/api/.env.local", "PORT=3000\nOTHER=keep\n");

  scenario.create("banana");

  expect(scenario.readWorktree("banana", "command-runs")).toBe("1");
  expect(scenario.readWorktree("banana", ".env")).toBe(
    "API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\n",
  );
});

test("materialize can prune stale resource command env after a failed rerun retry", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-prune-after-failure",
    command:
      'printf \'%s\' \'{"E2E_FLOW1_SYMBOL":"SOL/USDT:USDT","E2E_FLOW2_SYMBOL":"LINK/USDT:USDT"}\'',
    outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"],
  });

  scenario.create("banana");
  scenario.writeWorktree("banana", "apps/api/.env.local", "OTHER=keep\n");
  scenario.writeRoot(
    "monke.yml",
    singleCommandMonkeYml({
      command:
        'printf \'%s\' \'{"E2E_FLOW1_SYMBOL":"SOL/USDT:USDT","E2E_FLOW3_SYMBOL":"ATOM/USDT:USDT"}\'',
      outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW3_SYMBOL"],
    }),
  );

  expect(() => scenario.materialize("banana")).toThrow(/Missing mapped env vars/);

  const partialState = scenario.readSessionState<{
    repos: Array<{
      resourceCommandOutputs?: Array<{
        outputs: Array<{ env: string; value: string }>;
      }>;
    }>;
  }>();
  expect(partialState.repos[0]?.resourceCommandOutputs?.[0]?.outputs).toEqual([
    { env: "E2E_FLOW1_SYMBOL", value: "SOL/USDT:USDT" },
    { env: "E2E_FLOW3_SYMBOL", value: "ATOM/USDT:USDT" },
    { env: "E2E_FLOW2_SYMBOL", value: "LINK/USDT:USDT" },
  ]);

  scenario.writeWorktree("banana", "apps/api/.env.local", "PORT=3000\n");
  scenario.materialize("banana");

  expect(scenario.readWorktree("banana", ".env")).toBe(
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
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-contract",
    command,
  });

  expect(() => scenario.create("banana")).toThrow(expected);
});

test("create reports nonzero resource command failures without stdout", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-nonzero",
    command: `printf '%s' "$SECRET_STDOUT"
printf '%s' 'allocator stderr' >&2
exit 7`,
  });

  let message = "";
  try {
    scenario.create("banana", { SECRET_STDOUT: "secret stdout" });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toMatch(
    /Resource command e2e-symbols failed[\s\S]*kind: nonzero exit 7[\s\S]*allocator stderr/,
  );
  expect(message).not.toContain("secret stdout");
});

test("create reports resource command timeouts", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-timeout",
    command: "sleep 5",
    timeoutSeconds: 1,
  });

  expect(() => scenario.create("banana")).toThrow(
    /Resource command e2e-symbols failed[\s\S]*kind: timeout[\s\S]*stderr:[\s\S]*<empty>/,
  );
});

interface ResourceCommandScenario {
  sandbox: string;
  home: string;
  repoRoot: string;
  create(
    session: string,
    extraEnv?: Record<string, string | undefined>,
  ): { stdout: string; stderr: string };
  materialize(session: string): { stdout: string; stderr: string };
  cleanup(): { stdout: string; stderr: string };
  readSessionState<T>(): T;
  readWorktree(session: string, relativePath: string): string;
  writeRoot(relativePath: string, contents: string): void;
  writeWorktree(session: string, relativePath: string, contents: string): void;
  worktree(session: string): string;
}

function createResourceCommandScenario(options: {
  name: string;
  appEnv?: string;
  command?: string;
  commandName?: string;
  files?: Record<string, string>;
  monkeYml?: string;
  outputs?: string[];
  resourceValuesYaml?: string;
  timeoutSeconds?: number;
}): ResourceCommandScenario {
  const sandbox = makeTempDir(options.name);
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  installShShim(binDirectory);
  const home = path.join(sandbox, "home");
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": options.appEnv ?? "PORT=3000\n",
    "monke.yml": options.monkeYml ?? singleCommandMonkeYml(options),
    ...options.files,
  });

  const worktree = (session: string): string => getExpectedWorktreePath(repoRoot, session);

  return {
    sandbox,
    home,
    repoRoot,
    create(session, extraEnv) {
      return runMonke({
        cwd: repoRoot,
        args: ["create", session],
        monkeHome: home,
        binDirectory,
        extraEnv,
      });
    },
    materialize(session) {
      return runMonke({
        cwd: worktree(session),
        args: ["materialize"],
        monkeHome: home,
        binDirectory,
      });
    },
    cleanup() {
      return runMonke({
        cwd: repoRoot,
        args: ["cleanup"],
        monkeHome: home,
        binDirectory,
      });
    },
    readSessionState<T>() {
      return readSingleYamlFile(path.join(home, "sessions")) as T;
    },
    readWorktree(session, relativePath) {
      return read(worktree(session), relativePath);
    },
    writeRoot(relativePath, contents) {
      write(repoRoot, relativePath, contents);
    },
    writeWorktree(session, relativePath, contents) {
      write(worktree(session), relativePath, contents);
    },
    worktree,
  };
}

function singleCommandMonkeYml(options: {
  command?: string;
  commandName?: string;
  outputs?: string[];
  resourceValuesYaml?: string;
  timeoutSeconds?: number;
}): string {
  if (!options.command) {
    throw new Error("Resource command scenario requires command or monkeYml");
  }

  const resourceValues = options.resourceValuesYaml
    ? `  values:\n${indentBlock(options.resourceValuesYaml, 4)}\n`
    : "";
  const outputs = options.outputs ?? ["E2E_FLOW1_SYMBOL"];
  return withDefaultApp(`resources:
${resourceValues}  commands:
    ${options.commandName ?? "e2e-symbols"}:
      command: |
${indentBlock(options.command, 8)}
      timeoutSeconds: ${options.timeoutSeconds ?? 60}
      outputs:
${outputs.map((output) => `        - ${output}`).join("\n")}`);
}

function appOnlyMonkeYml(): string {
  return defaultAppYaml();
}

function withDefaultApp(prefix: string): string {
  return `${prefix}
${defaultAppYaml()}`;
}

function defaultAppYaml(): string {
  return `apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`;
}

function indentBlock(value: string, spaces: number): string {
  const indentation = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${indentation}${line}`)
    .join("\n");
}
