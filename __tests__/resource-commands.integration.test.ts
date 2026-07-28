import { chmodSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";
import * as z from "zod";

import { getExpectedWorktreePath } from "../src/git.ts";
import { loadSessionState, saveSessionState } from "../src/registry.ts";
import { SessionStateSchema } from "../src/state-schema.ts";
import type { SessionState } from "../src/types.ts";
import {
  createRepo,
  installShShim,
  makeTempDir,
  read,
  readSingleYamlFile,
  runMonke,
  write,
} from "./helpers.ts";

interface ResourceCommandScenario {
  sandbox: string;
  home: string;
  repoRoot: string;
  spawn: (
    session: string,
    extraEnv?: Record<string, string | undefined>
  ) => { stdout: string; stderr: string };
  materialize: (session: string) => { stdout: string; stderr: string };
  cleanup: () => { stdout: string; stderr: string };
  readSessionState: () => SessionState;
  readWorktree: (session: string, relativePath: string) => string;
  writeRoot: (relativePath: string, contents: string) => void;
  writeWorktree: (session: string, relativePath: string, contents: string) => void;
  worktree: (session: string) => string;
}

const ResourceCommandInputSchema = z.record(z.string(), z.array(z.string()));

describe("resource commands", () => {
  test("spawn runs resource commands from the worktree and writes outputs to root env and state", () => {
    const scenario = createResourceCommandScenario({
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
      name: "single-repo-resource-commands",
      outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"],
    });

    scenario.spawn("banana");

    const worktreeRoot = scenario.worktree("banana");
    expect(scenario.readWorktree("banana", "command-cwd.log")).toBe(`${worktreeRoot}\n`);
    expect(JSON.parse(scenario.readWorktree("banana", "command-stdin.json"))).toStrictEqual({
      E2E_FLOW1_SYMBOL: [],
      E2E_FLOW2_SYMBOL: [],
    });
    expect(scenario.readWorktree("banana", ".env")).toBe(
      "API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\nE2E_FLOW2_SYMBOL=LINK/USDT:USDT\n"
    );
    expect(scenario.readWorktree("banana", "apps/api/.env.local")).toBe("PORT=10000\n");

    const sessionState = scenario.readSessionState();
    expect(sessionState.repos[0]?.resourceCommandOutputs).toStrictEqual([
      {
        name: "e2e-symbols",
        outputs: [
          { env: "E2E_FLOW1_SYMBOL", value: "SOL/USDT:USDT" },
          { env: "E2E_FLOW2_SYMBOL", value: "LINK/USDT:USDT" },
        ],
      },
    ]);
  });

  test("fresh spawn lets pnpm resource modules use bootstrap-provided workspace packages", () => {
    const sandbox = makeTempDir("single-repo-resource-command-bootstrap-pnpm");
    const binDirectory = path.join(sandbox, "bin");
    installShShim(binDirectory);
    installFakePnpmBootstrapper(binDirectory);
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "apps/api/.env.local": "PORT=3000\n",
      "monke.yml": withDefaultApp(`bootstrapCommand: pnpm install
resources:
  commands:
    e2e-symbols:
      run: ./scripts/resource-command.ts
      timeoutSeconds: 60
      outputs:
        - E2E_FLOW1_SYMBOL`),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "scripts/resource-command.ts": `import { resourceValue } from "@demo/resource-lib";

export default function () {
  return { E2E_FLOW1_SYMBOL: resourceValue };
}
`,
    });

    runMonke({
      args: ["spawn", "fresh"],
      binDirectory,
      cwd: repoRoot,
      monkeHome: home,
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "fresh");
    expect(read(worktreeRoot, ".env")).toBe("API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\n");
  });

  test("materialize removes stale resource command env before bootstrap", () => {
    const scenario = createResourceCommandScenario({
      module: `export default function () {
  return { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
}
`,
      monkeYml: withDefaultApp(`bootstrapCommand: |
  set -a && . ./.env && set +a
  if [ "\${E2E_FLOW1_SYMBOL+x}" = x ]; then
    printf "%s" "$E2E_FLOW1_SYMBOL" > bootstrap-saw-command-env
  else
    : > bootstrap-saw-command-env
  fi
resources:
  commands:
    e2e-symbols:
      run: ./scripts/resource-command.ts
      timeoutSeconds: 60
      outputs:
        - E2E_FLOW1_SYMBOL`),
      name: "single-repo-resource-command-bootstrap-stale-env",
    });

    scenario.spawn("banana");
    expect(scenario.readWorktree("banana", "bootstrap-saw-command-env")).toBe("");

    scenario.materialize("banana");

    expect(scenario.readWorktree("banana", "bootstrap-saw-command-env")).toBe("");
    expect(scenario.readWorktree("banana", ".env")).toBe(
      "API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\n"
    );
  });

  test("spawn builds resource command stdin from retained command outputs only", () => {
    const scenario = createResourceCommandScenario({
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
      name: "single-repo-resource-command-retained-input",
      outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"],
      // Exercise the resource-literal interpolation syntax as YAML data.
      // oxlint-disable-next-line no-template-curly-in-string
      resourceValuesYaml: "DISCORD_CHANNEL: discord-${session}",
    });
    saveSessionState(scenario.home, {
      repos: [
        {
          assignedPorts: [],
          resourceCommandOutputs: [
            {
              name: "e2e-symbols",
              outputs: [
                { env: "E2E_FLOW1_SYMBOL", value: "SOL/USDT:USDT" },
                { env: "E2E_FLOW2_SYMBOL", value: "ATOM/USDT:USDT" },
              ],
            },
          ],
          resourceValues: [{ env: "DISCORD_CHANNEL", value: "discord-first" }],
          sourceRoot: scenario.repoRoot,
          worktreePath: path.join(scenario.sandbox, "missing-first"),
        },
      ],
      rootSourceRoot: scenario.repoRoot,
      session: "first",
      version: 1,
    });

    scenario.spawn("second");

    const secondInput = ResourceCommandInputSchema.parse(
      JSON.parse(scenario.readWorktree("second", "command-stdin.json"))
    );
    expect(Object.keys(secondInput)).toStrictEqual(["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"]);
    expect(secondInput).toStrictEqual({
      E2E_FLOW1_SYMBOL: ["SOL/USDT:USDT"],
      E2E_FLOW2_SYMBOL: ["ATOM/USDT:USDT"],
    });
    expect(JSON.stringify(secondInput)).not.toContain("discord-first");
  });

  test("spawn dedupes retained resource command input values", () => {
    const scenario = createResourceCommandScenario({
      module: `import { writeFileSync } from "node:fs";

export default function ({ previous }) {
  writeFileSync("command-stdin.json", JSON.stringify(previous));
  return {
    E2E_FLOW1_SYMBOL: "LINK/USDT:USDT",
    E2E_FLOW2_SYMBOL: "ATOM/USDT:USDT",
  };
}
`,
      name: "single-repo-resource-command-input-dedupe",
      outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"],
    });
    saveSessionState(scenario.home, {
      repos: [
        {
          assignedPorts: [],
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
          resourceValues: [{ env: "E2E_FLOW2_SYMBOL", value: "DETERMINISTIC_SHOULD_NOT_APPEAR" }],
          sourceRoot: scenario.repoRoot,
          worktreePath: path.join(scenario.sandbox, "missing-a"),
        },
      ],
      rootSourceRoot: path.join(scenario.sandbox, "graph-a"),
      session: "retained-a",
      version: 1,
    });
    saveSessionState(scenario.home, {
      repos: [
        {
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
          sourceRoot: scenario.repoRoot,
          worktreePath: path.join(scenario.sandbox, "missing-b"),
        },
      ],
      rootSourceRoot: path.join(scenario.sandbox, "graph-b"),
      session: "retained-b",
      version: 1,
    });
    saveSessionState(scenario.home, {
      repos: [
        {
          assignedPorts: [],
          resourceCommandOutputs: [
            {
              name: "e2e-symbols",
              outputs: [{ env: "E2E_FLOW2_SYMBOL", value: "CURRENT_SHOULD_NOT_APPEAR" }],
            },
          ],
          sourceRoot: scenario.repoRoot,
          worktreePath: path.join(scenario.sandbox, "current-worktree-from-another-graph"),
        },
      ],
      rootSourceRoot: path.join(scenario.sandbox, "graph-c"),
      session: "current",
      version: 1,
    });

    scenario.spawn("current");

    const input = ResourceCommandInputSchema.parse(
      JSON.parse(scenario.readWorktree("current", "command-stdin.json"))
    );
    expect(input.E2E_FLOW1_SYMBOL?.toSorted()).toStrictEqual(["SOL/USDT:USDT"]);
    expect(input.E2E_FLOW2_SYMBOL?.toSorted()).toStrictEqual(["NEAR/USDT:USDT"]);
    expect(JSON.stringify(input)).not.toContain("DETERMINISTIC_SHOULD_NOT_APPEAR");
    expect(JSON.stringify(input)).not.toContain("RENAMED_SHOULD_NOT_APPEAR");
    expect(JSON.stringify(input)).not.toContain("CURRENT_SHOULD_NOT_APPEAR");
  });

  test("materialize excludes current-session command outputs when rerunning incomplete outputs", () => {
    const scenario = createResourceCommandScenario({
      module: `export default function () {
  return { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
}
`,
      name: "single-repo-resource-command-current-session-input",
    });

    scenario.spawn("banana");
    scenario.writeRoot(
      "monke.yml",
      singleCommandMonkeYml({
        outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"],
      })
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
`
    );

    scenario.materialize("banana");

    expect(JSON.parse(scenario.readWorktree("banana", "command-stdin-rerun.json"))).toStrictEqual({
      E2E_FLOW1_SYMBOL: [],
      E2E_FLOW2_SYMBOL: [],
    });
  });

  test("spawn rejects same-output resource command collisions", () => {
    const scenario = createResourceCommandScenario({
      module: `import { writeFileSync } from "node:fs";

export default function ({ previous }) {
  writeFileSync("command-stdin.json", JSON.stringify(previous));
  return { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
}
`,
      name: "single-repo-resource-command-output-collision",
    });

    scenario.spawn("first");

    expect(() => scenario.spawn("second")).toThrow(
      /kind: same-output collision for E2E_FLOW1_SYMBOL[\s\S]*stdout:/u
    );
  });

  test("spawn leaves cross-output uniqueness to repo-owned resource commands", () => {
    const scenario = createResourceCommandScenario({
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
      name: "single-repo-resource-command-cross-output",
      outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"],
    });
    saveSessionState(scenario.home, {
      repos: [
        {
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
          sourceRoot: scenario.repoRoot,
          worktreePath: path.join(scenario.sandbox, "missing-first"),
        },
      ],
      rootSourceRoot: scenario.repoRoot,
      session: "first",
      version: 1,
    });

    scenario.spawn("second");

    expect(scenario.readWorktree("second", ".env")).toBe(
      "API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\nE2E_FLOW2_SYMBOL=LINK/USDT:USDT\n"
    );
  });

  test("resource command renames establish a new retained input namespace", () => {
    const scenario = createResourceCommandScenario({
      module: `export default function () {
  return { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
}
`,
      name: "single-repo-resource-command-rename",
    });

    scenario.spawn("banana");
    scenario.writeRoot(
      "monke.yml",
      singleCommandMonkeYml({
        commandName: "renamed-symbols",
      })
    );
    scenario.writeWorktree(
      "banana",
      "scripts/resource-command.ts",
      `import { writeFileSync } from "node:fs";

export default function ({ previous }) {
  writeFileSync("command-stdin-renamed.json", JSON.stringify(previous));
  return { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
}
`
    );

    scenario.materialize("banana");

    expect(JSON.parse(scenario.readWorktree("banana", "command-stdin-renamed.json"))).toStrictEqual(
      {
        E2E_FLOW1_SYMBOL: [],
      }
    );
  });

  test("multiple resource commands run in YAML order", () => {
    const scenario = createResourceCommandScenario({
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
      name: "single-repo-resource-command-order",
    });

    scenario.spawn("banana");

    expect(scenario.readWorktree("banana", "command-order.log")).toBe("first\nsecond\n");
  });

  test("retained dead session states contribute until cleanup removes them", () => {
    const scenario = createResourceCommandScenario({
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
      name: "single-repo-resource-command-cleanup-boundary",
    });
    saveSessionState(scenario.home, {
      repos: [
        {
          assignedPorts: [],
          resourceCommandOutputs: [
            {
              name: "e2e-symbols",
              outputs: [{ env: "E2E_FLOW1_SYMBOL", value: "SOL/USDT:USDT" }],
            },
          ],
          sourceRoot: scenario.repoRoot,
          worktreePath: path.join(scenario.sandbox, "missing-first"),
        },
      ],
      rootSourceRoot: scenario.repoRoot,
      session: "first",
      version: 1,
    });

    scenario.spawn("second");
    expect(scenario.readWorktree("second", "command-stdin.json")).toContain("SOL/USDT:USDT");

    const secondState = loadSessionState(scenario.home, scenario.repoRoot, "second");
    saveSessionState(scenario.home, {
      ...secondState,
      repos: secondState.repos.map((repo) => ({ ...repo, assignedPorts: [] })),
    });

    scenario.cleanup();
    scenario.spawn("third");

    const thirdInput = scenario.readWorktree("third", "command-stdin.json");
    expect(thirdInput).not.toContain("SOL/USDT:USDT");
    expect(thirdInput).toContain("LINK/USDT:USDT");
  });

  test("spawn and materialize reuse complete resource command outputs and prune undeclared outputs", () => {
    const scenario = createResourceCommandScenario({
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
      name: "single-repo-resource-command-reuse",
      outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"],
    });

    scenario.spawn("banana");
    expect(scenario.readWorktree("banana", "command-runs")).toBe("1");

    scenario.spawn("banana");
    scenario.materialize("banana");

    expect(scenario.readWorktree("banana", "command-runs")).toBe("1");
    expect(scenario.readWorktree("banana", ".env")).toBe(
      "API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\nE2E_FLOW2_SYMBOL=LINK/USDT:USDT\n"
    );

    scenario.writeRoot("monke.yml", appOnlyMonkeYml());
    scenario.materialize("banana");

    expect(scenario.readWorktree("banana", ".env")).toBe("API_PORT=10000\n");
    const sessionState = scenario.readSessionState();
    expect(sessionState.repos[0]?.resourceCommandOutputs).toBeUndefined();
  });

  test("materialize reruns resource commands when remembered outputs are incomplete", () => {
    const scenario = createResourceCommandScenario({
      module: `import { existsSync, readFileSync, writeFileSync } from "node:fs";

export default function () {
  const count = existsSync("command-runs") ? Number(readFileSync("command-runs", "utf8")) : 0;
  writeFileSync("command-runs", String(count + 1));
  return { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
}
`,
      name: "single-repo-resource-command-incomplete",
    });

    scenario.spawn("banana");
    expect(scenario.readWorktree("banana", "command-runs")).toBe("1");

    scenario.writeRoot(
      "monke.yml",
      singleCommandMonkeYml({
        outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"],
      })
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
`
    );

    scenario.materialize("banana");

    expect(scenario.readWorktree("banana", "command-runs")).toBe("2");
    expect(scenario.readWorktree("banana", ".env")).toBe(
      "API_PORT=10000\nE2E_FLOW1_SYMBOL=LINK/USDT:USDT\nE2E_FLOW2_SYMBOL=ATOM/USDT:USDT\n"
    );
  });

  test("spawn persists resource command outputs before later materialization failures", () => {
    const scenario = createResourceCommandScenario({
      appEnv: "OTHER=keep\n",
      module: `import { existsSync, readFileSync, writeFileSync } from "node:fs";

export default function () {
  const count = existsSync("command-runs") ? Number(readFileSync("command-runs", "utf8")) : 0;
  writeFileSync("command-runs", String(count + 1));
  return { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
}
`,
      name: "single-repo-resource-command-partial",
    });

    expect(() => scenario.spawn("banana")).toThrow(/Missing mapped env vars/u);

    const partialState = scenario.readSessionState();
    expect(partialState.repos[0]?.resourceCommandOutputs).toStrictEqual([
      {
        name: "e2e-symbols",
        outputs: [{ env: "E2E_FLOW1_SYMBOL", value: "SOL/USDT:USDT" }],
      },
    ]);
    expect(partialState.repos[0]?.materializationComplete).toBeFalsy();

    scenario.writeRoot("apps/api/.env.local", "PORT=3000\nOTHER=keep\n");
    scenario.writeWorktree("banana", "apps/api/.env.local", "PORT=3000\nOTHER=keep\n");

    scenario.spawn("banana");

    expect(scenario.readWorktree("banana", "command-runs")).toBe("1");
    expect(scenario.readWorktree("banana", ".env")).toBe(
      "API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\n"
    );
  });

  test("materialize can prune stale resource command env after a failed rerun retry", () => {
    const scenario = createResourceCommandScenario({
      module: `export default function () {
  return {
    E2E_FLOW1_SYMBOL: "SOL/USDT:USDT",
    E2E_FLOW2_SYMBOL: "LINK/USDT:USDT",
  };
}
`,
      name: "single-repo-resource-command-prune-after-failure",
      outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"],
    });

    scenario.spawn("banana");
    scenario.writeWorktree("banana", "apps/api/.env.local", "OTHER=keep\n");
    scenario.writeRoot(
      "monke.yml",
      singleCommandMonkeYml({
        outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW3_SYMBOL"],
      })
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
`
    );

    expect(() => scenario.materialize("banana")).toThrow(/Missing mapped env vars/u);

    const partialState = scenario.readSessionState();
    expect(partialState.repos[0]?.resourceCommandOutputs?.[0]?.outputs).toStrictEqual([
      { env: "E2E_FLOW1_SYMBOL", value: "SOL/USDT:USDT" },
      { env: "E2E_FLOW3_SYMBOL", value: "ATOM/USDT:USDT" },
      { env: "E2E_FLOW2_SYMBOL", value: "LINK/USDT:USDT" },
    ]);

    scenario.writeWorktree("banana", "apps/api/.env.local", "PORT=3000\n");
    scenario.materialize("banana");

    expect(scenario.readWorktree("banana", ".env")).toBe(
      "API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\nE2E_FLOW3_SYMBOL=ATOM/USDT:USDT\n"
    );
  });

  test.each([
    {
      expected: /kind: return contract violation[\s\S]*stdout:[\s\S]*returning scalar/u,
      module: `export default function () {
  console.log("returning scalar");
  return "not-object";
}
`,
      name: "non-object return",
    },
    {
      expected: /kind: return contract violation/u,
      module: `export default function () {
  return {};
}
`,
      name: "missing output",
    },
    {
      expected: /kind: return contract violation/u,
      module: `export default function () {
  return { E2E_FLOW1_SYMBOL: "SOL", EXTRA: "x" };
}
`,
      name: "extra output",
    },
    {
      expected: /kind: return contract violation/u,
      module: `export default function () {
  return { E2E_FLOW1_SYMBOL: 42 };
}
`,
      name: "non-string output",
    },
    {
      expected: /kind: return contract violation[\s\S]*stdout:/u,
      module: `export default function () {
  return { E2E_FLOW1_SYMBOL: "   " };
}
`,
      name: "empty output",
    },
  ])("spawn rejects resource command returns with $name", ({ module, expected }) => {
    const scenario = createResourceCommandScenario({
      module,
      name: "single-repo-resource-command-contract",
    });

    expect(() => scenario.spawn("banana")).toThrow(expected);
  });

  test.each([
    {
      expected: /must export a default function/u,
      module: `export const allocate = () => ({ E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" });
`,
      name: "missing default export",
    },
    {
      expected: /default export must be a function/u,
      module: `export default { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
`,
      name: "default export not a function",
    },
    {
      expected: /kind: nonzero exit 1[\s\S]*stderr before failure[\s\S]*allocator boom/u,
      module: `export default function () {
  console.log("stdout before failure");
  console.error("stderr before failure");
  throw new Error("allocator boom");
}
`,
      name: "thrown error",
    },
    {
      expected: /kind: nonzero exit 1[\s\S]*async allocator boom/u,
      module: `export default async function () {
  throw new Error("async allocator boom");
}
`,
      name: "rejected error",
    },
  ])("spawn reports resource command module failures with $name", ({ module, expected }) => {
    const scenario = createResourceCommandScenario({
      module,
      name: "single-repo-resource-command-module-failure",
    });

    expect(() => scenario.spawn("banana")).toThrow(expected);
  });

  test("spawn reports missing resource command modules", () => {
    const scenario = createResourceCommandScenario({
      monkeYml: singleCommandMonkeYml({ run: "./scripts/missing-module.ts" }),
      name: "single-repo-resource-command-missing-module",
    });

    expect(() => scenario.spawn("banana")).toThrow(
      /Resource command e2e-symbols failed[\s\S]*(?:Cannot find module|Module not found)/u
    );
  });

  test("spawn accepts async default exports and ignores stdout and stderr logging on success", () => {
    const scenario = createResourceCommandScenario({
      module: `export default async function () {
  console.log("stdout should not affect success");
  console.error("stderr should not affect success");
  await Promise.resolve();
  return { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
}
`,
      name: "single-repo-resource-command-async-success",
    });

    scenario.spawn("banana");

    expect(scenario.readWorktree("banana", ".env")).toBe(
      "API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\n"
    );
  });

  test("spawn accepts resource command run paths whose first segment starts with two dots", () => {
    const scenario = createResourceCommandScenario({
      module: `export default function () {
  return { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
}
`,
      name: "single-repo-resource-command-dot-prefix-path",
      run: "./..commands/resource-command.ts",
    });

    scenario.spawn("banana");

    expect(scenario.readWorktree("banana", ".env")).toBe(
      "API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\n"
    );
  });

  test("spawn imports resource modules without triggering direct execution guards", () => {
    const scenario = createResourceCommandScenario({
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
      name: "single-repo-resource-command-direct-guard",
    });

    scenario.spawn("banana");

    expect(scenario.readWorktree("banana", ".env")).toBe(
      "API_PORT=10000\nE2E_FLOW1_SYMBOL=SOL/USDT:USDT\n"
    );
  });

  test("spawn reports thrown resource command failures with stderr and omits stdout", () => {
    const scenario = createResourceCommandScenario({
      module: `export default function () {
  console.log(process.env.SECRET_STDOUT);
  console.error("allocator stderr");
  throw new Error("allocator failed");
}
`,
      name: "single-repo-resource-command-throw",
    });

    let message = "";
    try {
      scenario.spawn("banana", { SECRET_STDOUT: "secret stdout" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(
      /Resource command e2e-symbols failed[\s\S]*kind: nonzero exit 1[\s\S]*allocator stderr/u
    );
    expect(message).not.toContain("stdout:");
    expect(message).not.toContain("secret stdout");
  });

  test("spawn reports resource command timeouts", () => {
    const scenario = createResourceCommandScenario({
      module: `export default async function () {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  return { E2E_FLOW1_SYMBOL: "SOL/USDT:USDT" };
}
`,
      name: "single-repo-resource-command-timeout",
      timeoutSeconds: 1,
    });

    expect(() => scenario.spawn("banana")).toThrow(
      /Resource command e2e-symbols failed[\s\S]*kind: timeout[\s\S]*stderr:[\s\S]*<empty>/u
    );
  });
});

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
  installShShim(binDirectory);
  const home = path.join(sandbox, "home");
  const moduleFiles =
    options.module !== undefined && options.module !== ""
      ? { [moduleFilePath(options.run)]: options.module }
      : {};
  const repoRoot = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": options.appEnv ?? "PORT=3000\n",
    "monke.yml": options.monkeYml ?? singleCommandMonkeYml(options),
    ...moduleFiles,
    ...options.files,
  });

  const worktree = (session: string): string => getExpectedWorktreePath(home, repoRoot, session);

  return {
    cleanup() {
      return runMonke({
        args: ["cleanup"],
        binDirectory,
        cwd: repoRoot,
        monkeHome: home,
      });
    },
    home,
    materialize(session) {
      return runMonke({
        args: ["materialize"],
        binDirectory,
        cwd: worktree(session),
        monkeHome: home,
      });
    },
    readSessionState() {
      return readSingleYamlFile(path.join(home, "sessions"), SessionStateSchema);
    },
    readWorktree(session, relativePath) {
      return read(worktree(session), relativePath);
    },
    repoRoot,
    sandbox,
    spawn(session, extraEnv) {
      return runMonke({
        args: ["spawn", session],
        binDirectory,
        cwd: repoRoot,
        extraEnv,
        monkeHome: home,
      });
    },
    worktree,
    writeRoot(relativePath, contents) {
      write(repoRoot, relativePath, contents);
    },
    writeWorktree(session, relativePath, contents) {
      write(worktree(session), relativePath, contents);
    },
  };
}

function singleCommandMonkeYml(options: {
  commandName?: string;
  outputs?: string[];
  resourceValuesYaml?: string;
  run?: string;
  timeoutSeconds?: number;
}): string {
  const resourceValues =
    options.resourceValuesYaml !== undefined && options.resourceValuesYaml !== ""
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

function installFakePnpmBootstrapper(binDirectory: string): void {
  const executablePath = path.join(binDirectory, "pnpm");
  write(
    binDirectory,
    "pnpm",
    `#!/bin/sh
set -eu
if [ "\${1:-}" = "install" ]; then
  mkdir -p node_modules/@demo/resource-lib
  cat > node_modules/@demo/resource-lib/package.json <<'EOF'
{"name":"@demo/resource-lib","type":"module","main":"index.js"}
EOF
  cat > node_modules/@demo/resource-lib/index.js <<'EOF'
export const resourceValue = "SOL/USDT:USDT";
EOF
  exit 0
fi

if [ "\${1:-}" = "exec" ] && [ "\${2:-}" = "bun" ]; then
  shift 2
  exec bun "$@"
fi

echo "unsupported pnpm invocation: $*" >&2
exit 1
`
  );
  chmodSync(executablePath, 0o755);
}
