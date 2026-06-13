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
    module: `import { writeFileSync } from "node:fs";

export default function ({ previous }) {
  writeFileSync("command-cwd.log", process.cwd() + "\\n");
  writeFileSync("command-stdin.json", JSON.stringify(previous));
  console.log("allocator progress");
  console.error("allocator detail");
  return {
    E2E_FLOW1_SYMBOL: "SOL/USDT:USDT",
    E2E_FLOW2_SYMBOL: "LINK/USDT:USDT",
  };
}
`,
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
    module: `import { writeFileSync } from "node:fs";

export default function ({ previous }) {
  writeFileSync("command-stdin.json", JSON.stringify(previous));
  if (previous.E2E_FLOW1_SYMBOL.includes("SOL/USDT:USDT")) {
    return {
      E2E_FLOW1_SYMBOL: "LINK/USDT:USDT",
      E2E_FLOW2_SYMBOL: "NEAR/USDT:USDT",
    };
  }
  return {
    E2E_FLOW1_SYMBOL: "SOL/USDT:USDT",
    E2E_FLOW2_SYMBOL: "ATOM/USDT:USDT",
  };
}
`,
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
    module: `import { writeFileSync } from "node:fs";

export default function ({ previous }) {
  writeFileSync("command-stdin.json", JSON.stringify(previous));
  return {
    E2E_FLOW1_SYMBOL: "LINK/USDT:USDT",
    E2E_FLOW2_SYMBOL: "ATOM/USDT:USDT",
  };
}
`,
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
    module: `export default function () {
  return { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
}
`,
  });

  scenario.create("banana");
  scenario.writeRoot(
    "monke.yml",
    singleCommandMonkeYml({
      outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"],
    }),
  );
  scenario.writeWorktree(
    "banana",
    "scripts/resource-command.ts",
    `import { writeFileSync } from "node:fs";

export default function ({ previous }) {
  writeFileSync("command-stdin-rerun.json", JSON.stringify(previous));
  return {
    E2E_FLOW1_SYMBOL: "LINK/USDT:USDT",
    E2E_FLOW2_SYMBOL: "ATOM/USDT:USDT",
  };
}
`,
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
    module: `import { writeFileSync } from "node:fs";

export default function ({ previous }) {
  writeFileSync("command-stdin.json", JSON.stringify(previous));
  return { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
}
`,
  });

  scenario.create("first");

  expect(() => scenario.create("second")).toThrow(
    /kind: same-output collision for E2E_FLOW1_SYMBOL[\s\S]*stdout:/,
  );
});

test("create leaves cross-output uniqueness to repo-owned resource commands", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-cross-output",
    module: `import { writeFileSync } from "node:fs";

export default function ({ previous }) {
  writeFileSync("command-stdin.json", JSON.stringify(previous));
  if (previous.E2E_FLOW1_SYMBOL.includes("ALPHA/USDT:USDT")) {
    return {
      E2E_FLOW1_SYMBOL: "SOL/USDT:USDT",
      E2E_FLOW2_SYMBOL: "LINK/USDT:USDT",
    };
  }
  return {
    E2E_FLOW1_SYMBOL: "ALPHA/USDT:USDT",
    E2E_FLOW2_SYMBOL: "SOL/USDT:USDT",
  };
}
`,
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
    module: `export default function () {
  return { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
}
`,
  });

  scenario.create("banana");
  scenario.writeRoot(
    "monke.yml",
    singleCommandMonkeYml({
      commandName: "renamed-symbols",
    }),
  );
  scenario.writeWorktree(
    "banana",
    "scripts/resource-command.ts",
    `import { writeFileSync } from "node:fs";

export default function ({ previous }) {
  writeFileSync("command-stdin-renamed.json", JSON.stringify(previous));
  return { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
}
`,
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
      run: ./scripts/first-symbols.ts
      outputs:
        - FIRST_SYMBOL
    second-symbols:
      run: ./scripts/second-symbols.ts
      outputs:
        - SECOND_SYMBOL`),
    files: {
      "scripts/first-symbols.ts": `import { appendFileSync } from "node:fs";

export default function () {
  appendFileSync("command-order.log", "first\\n");
  return { FIRST_SYMBOL: "SOL/USDT:USDT" };
}
`,
      "scripts/second-symbols.ts": `import { appendFileSync } from "node:fs";

export default function () {
  appendFileSync("command-order.log", "second\\n");
  return { SECOND_SYMBOL: "LINK/USDT:USDT" };
}
`,
    },
  });

  scenario.create("banana");

  expect(scenario.readWorktree("banana", "command-order.log")).toBe("first\nsecond\n");
});

test("retained dead session states contribute until cleanup removes them", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-cleanup-boundary",
    module: `import { writeFileSync } from "node:fs";

export default function ({ previous }) {
  writeFileSync("command-stdin.json", JSON.stringify(previous));
  let value = "SOL/USDT:USDT";
  if (previous.E2E_FLOW1_SYMBOL.includes("LINK/USDT:USDT")) {
    value = "ATOM/USDT:USDT";
  } else if (previous.E2E_FLOW1_SYMBOL.includes("SOL/USDT:USDT")) {
    value = "LINK/USDT:USDT";
  }
  return { E2E_FLOW1_SYMBOL: value };
}
`,
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
    module: `import { existsSync, readFileSync, writeFileSync } from "node:fs";

export default function () {
  const count = existsSync("command-runs") ? Number(readFileSync("command-runs", "utf8")) : 0;
  writeFileSync("command-runs", String(count + 1));
  return {
    E2E_FLOW1_SYMBOL: "SOL/USDT:USDT",
    E2E_FLOW2_SYMBOL: "LINK/USDT:USDT",
  };
}
`,
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
    module: `import { existsSync, readFileSync, writeFileSync } from "node:fs";

export default function () {
  const count = existsSync("command-runs") ? Number(readFileSync("command-runs", "utf8")) : 0;
  writeFileSync("command-runs", String(count + 1));
  return { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
}
`,
  });

  scenario.create("banana");
  expect(scenario.readWorktree("banana", "command-runs")).toBe("1");

  scenario.writeRoot(
    "monke.yml",
    singleCommandMonkeYml({
      outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"],
    }),
  );
  scenario.writeWorktree(
    "banana",
    "scripts/resource-command.ts",
    `import { existsSync, readFileSync, writeFileSync } from "node:fs";

export default function () {
  const count = existsSync("command-runs") ? Number(readFileSync("command-runs", "utf8")) : 0;
  writeFileSync("command-runs", String(count + 1));
  return {
    E2E_FLOW1_SYMBOL: "LINK/USDT:USDT",
    E2E_FLOW2_SYMBOL: "ATOM/USDT:USDT",
  };
}
`,
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
    module: `import { existsSync, readFileSync, writeFileSync } from "node:fs";

export default function () {
  const count = existsSync("command-runs") ? Number(readFileSync("command-runs", "utf8")) : 0;
  writeFileSync("command-runs", String(count + 1));
  return { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
}
`,
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
    module: `export default function () {
  return {
    E2E_FLOW1_SYMBOL: "SOL/USDT:USDT",
    E2E_FLOW2_SYMBOL: "LINK/USDT:USDT",
  };
}
`,
    outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"],
  });

  scenario.create("banana");
  scenario.writeWorktree("banana", "apps/api/.env.local", "OTHER=keep\n");
  scenario.writeRoot(
    "monke.yml",
    singleCommandMonkeYml({
      outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW3_SYMBOL"],
    }),
  );
  scenario.writeWorktree(
    "banana",
    "scripts/resource-command.ts",
    `export default function () {
  return {
    E2E_FLOW1_SYMBOL: "SOL/USDT:USDT",
    E2E_FLOW3_SYMBOL: "ATOM/USDT:USDT",
  };
}
`,
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
    name: "non-object return",
    module: `export default function () {
  console.log("returning scalar");
  return "not-object";
}
`,
    expected: /kind: return contract violation[\s\S]*stdout:[\s\S]*returning scalar/,
  },
  {
    name: "missing output",
    module: `export default function () {
  return {};
}
`,
    expected: /kind: return contract violation/,
  },
  {
    name: "extra output",
    module: `export default function () {
  return { E2E_FLOW1_SYMBOL: "SOL", EXTRA: "x" };
}
`,
    expected: /kind: return contract violation/,
  },
  {
    name: "non-string output",
    module: `export default function () {
  return { E2E_FLOW1_SYMBOL: 42 };
}
`,
    expected: /kind: return contract violation/,
  },
  {
    name: "empty output",
    module: `export default function () {
  return { E2E_FLOW1_SYMBOL: "   " };
}
`,
    expected: /kind: return contract violation[\s\S]*stdout:/,
  },
])("create rejects resource command returns with $name", ({ module, expected }) => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-contract",
    module,
  });

  expect(() => scenario.create("banana")).toThrow(expected);
});

test.each([
  {
    name: "missing default export",
    module: `export const allocate = () => ({ E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" });
`,
    expected: /must export a default function/,
  },
  {
    name: "default export not a function",
    module: `export default { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
`,
    expected: /default export must be a function/,
  },
  {
    name: "thrown error",
    module: `export default function () {
  console.log("stdout before failure");
  console.error("stderr before failure");
  throw new Error("allocator boom");
}
`,
    expected: /kind: nonzero exit 1[\s\S]*stderr before failure[\s\S]*allocator boom/,
  },
  {
    name: "rejected error",
    module: `export default async function () {
  throw new Error("async allocator boom");
}
`,
    expected: /kind: nonzero exit 1[\s\S]*async allocator boom/,
  },
])("create reports resource command module failures with $name", ({ module, expected }) => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-module-failure",
    module,
  });

  expect(() => scenario.create("banana")).toThrow(expected);
});

test("create reports missing resource command modules", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-missing-module",
    monkeYml: singleCommandMonkeYml({ run: "./scripts/missing-module.ts" }),
  });

  expect(() => scenario.create("banana")).toThrow(
    /Resource command e2e-symbols failed[\s\S]*(Cannot find module|Module not found)/,
  );
});

test("create accepts async default exports and ignores stdout and stderr logging on success", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-async-success",
    module: `export default async function () {
  console.log("stdout should not affect success");
  console.error("stderr should not affect success");
  await Promise.resolve();
  return { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
}
`,
  });

  scenario.create("banana");

  expect(scenario.readWorktree("banana", ".env")).toBe(
    "API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\n",
  );
});

test("create accepts resource command run paths whose first segment starts with two dots", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-dot-prefix-path",
    run: "./..commands/resource-command.ts",
    module: `export default function () {
  return { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
}
`,
  });

  scenario.create("banana");

  expect(scenario.readWorktree("banana", ".env")).toBe(
    "API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\n",
  );
});

test("create imports resource modules without triggering direct execution guards", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-direct-guard",
    module: `import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export default function () {
  return { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
}

if (isDirectExecution(import.meta.url)) {
  throw new Error("direct execution path should not run during resource import");
}

function isDirectExecution(importMetaUrl) {
  return Boolean(process.argv[1] && fileURLToPath(importMetaUrl) === resolve(process.argv[1]));
}
`,
  });

  scenario.create("banana");

  expect(scenario.readWorktree("banana", ".env")).toBe(
    "API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\n",
  );
});

test("create reports thrown resource command failures with stderr and omits stdout", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-throw",
    module: `export default function () {
  console.log(process.env.SECRET_STDOUT);
  console.error("allocator stderr");
  throw new Error("allocator failed");
}
`,
  });

  let message = "";
  try {
    scenario.create("banana", { SECRET_STDOUT: "secret stdout" });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toMatch(
    /Resource command e2e-symbols failed[\s\S]*kind: nonzero exit 1[\s\S]*allocator stderr/,
  );
  expect(message).not.toContain("stdout:");
  expect(message).not.toContain("secret stdout");
});

test("create reports resource command timeouts", () => {
  const scenario = createResourceCommandScenario({
    name: "single-repo-resource-command-timeout",
    module: `export default async function () {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  return { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
}
`,
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
  commandName?: string;
  files?: Record<string, string>;
  monkeYml?: string;
  module?: string;
  outputs?: string[];
  resourceValuesYaml?: string;
  run?: string;
  timeoutSeconds?: number;
}): ResourceCommandScenario {
  const sandbox = makeTempDir(options.name);
  const binDirectory = path.join(sandbox, "bin");
  installFakeWt(binDirectory);
  installShShim(binDirectory);
  const home = path.join(sandbox, "home");
  const moduleFiles = options.module ? { [moduleFilePath(options.run)]: options.module } : {};
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": options.appEnv ?? "PORT=3000\n",
    "monke.yml": options.monkeYml ?? singleCommandMonkeYml(options),
    ...moduleFiles,
    ...options.files,
  });

  const worktree = (session: string): string => getExpectedWorktreePath(home, repoRoot, session);

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
  commandName?: string;
  outputs?: string[];
  resourceValuesYaml?: string;
  run?: string;
  timeoutSeconds?: number;
}): string {
  const resourceValues = options.resourceValuesYaml
    ? `  values:\n${indentBlock(options.resourceValuesYaml, 4)}\n`
    : "";
  const outputs = options.outputs ?? ["E2E_FLOW1_SYMBOL"];
  return withDefaultApp(`resources:
${resourceValues}  commands:
    ${options.commandName ?? "e2e-symbols"}:
      run: ${options.run ?? "./scripts/resource-command.ts"}
      timeoutSeconds: ${options.timeoutSeconds ?? 60}
      outputs:
${outputs.map((output) => `        - ${output}`).join("\n")}`);
}

function moduleFilePath(run = "./scripts/resource-command.ts"): string {
  return path.normalize(run);
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
