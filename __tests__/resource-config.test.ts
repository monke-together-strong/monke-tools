import { expect, test } from "vitest";
import path from "node:path";

import { loadResolvedGraph } from "../src/config.ts";
import { createRuntime } from "../src/runtime.ts";
import { createRepo, makeTempDir } from "./helpers.ts";

test("loadResolvedGraph accepts nested resource values and cleanupCommand", () => {
  const sandbox = makeTempDir("config-resources");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `cleanupCommand: pnpm cleanup:session
resources:
  values:
    DISCORD_CHANNEL: mt-\${user}-\${session}
    STATIC_HANDLE: stable
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

  expect(graph.reposByRoot.get(root)?.cleanupCommand).toBe("pnpm cleanup:session");
  expect(graph.reposByRoot.get(root)?.resourceValuesInOrder).toEqual([
    { env: "DISCORD_CHANNEL", literal: "mt-${user}-${session}" },
    { env: "STATIC_HANDLE", literal: "stable" },
  ]);
});

test("loadResolvedGraph accepts nested resource commands", () => {
  const sandbox = makeTempDir("config-resource-commands");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources:
  commands:
    e2e-symbols:
      run: ./scripts/e2e-symbols.ts
      timeoutSeconds: 45
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

  const graph = loadResolvedGraph(createRuntime({ cwd: root }), root);

  expect(graph.reposByRoot.get(root)?.resourceCommandsInOrder).toEqual([
    {
      name: "e2e-symbols",
      run: "scripts/e2e-symbols.ts",
      timeoutSeconds: 45,
      outputs: ["E2E_FLOW1_SYMBOL", "E2E_FLOW2_SYMBOL"],
    },
  ]);
});

test("loadResolvedGraph defaults resource command timeoutSeconds to 60", () => {
  const sandbox = makeTempDir("config-resource-command-default-timeout");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources:
  commands:
    e2e-symbols:
      run: ./scripts/e2e-symbols.ts
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

  const graph = loadResolvedGraph(createRuntime({ cwd: root }), root);

  expect(graph.reposByRoot.get(root)?.resourceCommandsInOrder[0]?.timeoutSeconds).toBe(60);
});

test.each([
  {
    name: "invalid command name",
    resources: `commands:
    Bad_Name:
      run: ./scripts/e2e-symbols.ts
      outputs:
        - E2E_FLOW1_SYMBOL`,
    expected: /resources\.commands\.Bad_Name/,
  },
  {
    name: "old command field",
    resources: `commands:
    e2e-symbols:
      command: pnpm e2e:allocate-symbols
      outputs:
        - E2E_FLOW1_SYMBOL`,
    expected: /resources\.commands\.e2e-symbols.*command/s,
  },
  {
    name: "missing run",
    resources: `commands:
    e2e-symbols:
      outputs:
        - E2E_FLOW1_SYMBOL`,
    expected: /resources.commands.e2e-symbols.run.*non-empty string/,
  },
  {
    name: "empty run",
    resources: `commands:
    e2e-symbols:
      run: "   "
      outputs:
        - E2E_FLOW1_SYMBOL`,
    expected: /resources.commands.e2e-symbols.run.*non-empty string/,
  },
  {
    name: "absolute run path",
    resources: `commands:
    e2e-symbols:
      run: /tmp/e2e-symbols.ts
      outputs:
        - E2E_FLOW1_SYMBOL`,
    expected: /run.*must be a relative JS\/TS module path/,
  },
  {
    name: "escaping run path",
    resources: `commands:
    e2e-symbols:
      run: ../e2e-symbols.ts
      outputs:
        - E2E_FLOW1_SYMBOL`,
    expected: /run must resolve inside the session worktree/,
  },
  {
    name: "bare package run specifier",
    resources: `commands:
    e2e-symbols:
      run: e2e-symbols
      outputs:
        - E2E_FLOW1_SYMBOL`,
    expected: /run.*must be a relative JS\/TS module path/,
  },
  {
    name: "invalid timeout",
    resources: `commands:
    e2e-symbols:
      run: ./scripts/e2e-symbols.ts
      timeoutSeconds: 0
      outputs:
        - E2E_FLOW1_SYMBOL`,
    expected: /timeoutSeconds.*positive integer/,
  },
  {
    name: "empty outputs",
    resources: `commands:
    e2e-symbols:
      run: ./scripts/e2e-symbols.ts
      outputs: []`,
    expected: /outputs.*must be a non-empty array/,
  },
  {
    name: "invalid output name",
    resources: `commands:
    e2e-symbols:
      run: ./scripts/e2e-symbols.ts
      outputs:
        - e2e_flow1_symbol`,
    expected: /outputs\[0\].*uppercase env name/,
  },
  {
    name: "duplicate output name",
    resources: `commands:
    e2e-symbols:
      run: ./scripts/e2e-symbols.ts
      outputs:
        - E2E_FLOW1_SYMBOL
        - E2E_FLOW1_SYMBOL`,
    expected: /Duplicate resource command output E2E_FLOW1_SYMBOL/,
  },
  {
    name: "duplicate env across values and commands",
    resources: `values:
    E2E_FLOW1_SYMBOL: fixed
  commands:
    e2e-symbols:
      run: ./scripts/e2e-symbols.ts
      outputs:
        - E2E_FLOW1_SYMBOL`,
    expected: /Duplicate resource env name E2E_FLOW1_SYMBOL/,
  },
  {
    name: "duplicate env across commands",
    resources: `commands:
    e2e-symbols:
      run: ./scripts/e2e-symbols.ts
      outputs:
        - E2E_FLOW1_SYMBOL
    other-symbols:
      run: ./scripts/e2e-more-symbols.ts
      outputs:
        - E2E_FLOW1_SYMBOL`,
    expected: /Duplicate resource env name E2E_FLOW1_SYMBOL/,
  },
  {
    name: "empty commands section",
    resources: `commands: {}`,
    expected: /resources\.commands.*must declare at least one command/,
  },
])("loadResolvedGraph rejects resource commands with $name", ({ resources, expected }) => {
  const sandbox = makeTempDir("config-invalid-resource-command");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources:
  ${resources}
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });

  expect(() => loadResolvedGraph(createRuntime({ cwd: root }), root)).toThrow(expected);
});

test("loadResolvedGraph rejects old flat resources mappings", () => {
  const sandbox = makeTempDir("config-flat-resources");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources:
  DISCORD_CHANNEL: mt-\${session}
apps:
  api:
    path: apps/api
    envFile: .env.local
    mappings:
      - port: API_PORT
        env: PORT
`,
  });

  expect(() => loadResolvedGraph(createRuntime({ cwd: root }), root)).toThrow(/DISCORD_CHANNEL/);
});

test("loadResolvedGraph rejects empty resources sections", () => {
  const sandbox = makeTempDir("config-empty-resources");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources: {}
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
    /resources.*must contain values or commands/,
  );
});

test("loadResolvedGraph rejects empty resource values sections", () => {
  const sandbox = makeTempDir("config-empty-resource-values");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources:
  values: {}
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
    /resources\.values.*must declare at least one value/,
  );
});

test("loadResolvedGraph rejects invalid resource value declarations", () => {
  const sandbox = makeTempDir("config-invalid-resources");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources:
  values:
    discord_channel: mt-\${session}
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
    /resources\.values\.discord_channel/,
  );
});

test("loadResolvedGraph rejects empty resource literals", () => {
  const sandbox = makeTempDir("config-empty-resource-literal");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources:
  values:
    DISCORD_CHANNEL: "   "
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
    /DISCORD_CHANNEL.*non-empty string/,
  );
});

test("loadResolvedGraph rejects unsupported resource placeholders", () => {
  const sandbox = makeTempDir("config-resource-placeholder");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources:
  values:
    DISCORD_CHANNEL: mt-\${branch}
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
    /unsupported placeholder.*session.*user/,
  );
});

test("loadResolvedGraph rejects duplicate resource env names", () => {
  const sandbox = makeTempDir("config-duplicate-resource");
  const root = createRepo(path.join(sandbox, "root"), {
    "apps/api/.env.local": "PORT=3000\n",
    "monke.yml": `resources:
  values:
    DISCORD_CHANNEL: one
    DISCORD_CHANNEL: two
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
    /Map keys must be unique|duplicate key/i,
  );
});
