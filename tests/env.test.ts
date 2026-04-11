import { expect, test } from "bun:test";
import path from "node:path";

import { rewriteEnvFile } from "../src/env.ts";
import { makeTempDir, read, write } from "./helpers.ts";

test("rewriteEnvFile updates numeric values, urls, dsns, and duplicate active assignments", () => {
  const sandbox = makeTempDir("env-rewrite");
  write(
    sandbox,
    "app/.env.local",
    `# prelude
PORT=3000
DATABASE_URL="postgres://user:pass@localhost:5432/app" # inline
DATABASE_URL='postgres://user:pass@localhost:5432/app-two'
API_URL=http://localhost:8080/path?x=1
IGNORED=keep
# DATABASE_URL=postgres://localhost:9999/ignored
`,
  );

  rewriteEnvFile(
    path.join(sandbox, "app/.env.local"),
    new Map([
      ["PORT", 11_000],
      ["DATABASE_URL", 11_001],
      ["API_URL", 11_002],
    ]),
  );

  expect(read(sandbox, "app/.env.local")).toBe(`# prelude
PORT=11000
DATABASE_URL="postgres://user:pass@localhost:11001/app" # inline
DATABASE_URL='postgres://user:pass@localhost:11001/app-two'
API_URL=http://localhost:11002/path?x=1
IGNORED=keep
# DATABASE_URL=postgres://localhost:9999/ignored
`);
});

test("rewriteEnvFile fails when a mapped target is missing", () => {
  const sandbox = makeTempDir("env-missing");
  write(sandbox, "app/.env.local", "PORT=3000\n");

  expect(() => {
    rewriteEnvFile(path.join(sandbox, "app/.env.local"), new Map([["DATABASE_URL", 12_000]]));
  }).toThrow(/Missing mapped env vars/);
});

test("rewriteEnvFile rejects malformed or portless values", () => {
  const sandbox = makeTempDir("env-invalid");
  write(
    sandbox,
    "app/.env.local",
    "DATABASE_URL=postgres://localhost/app\nBROKEN=localhost:5432\n",
  );

  expect(() => {
    rewriteEnvFile(path.join(sandbox, "app/.env.local"), new Map([["DATABASE_URL", 12_000]]));
  }).toThrow(/Expected explicit port/);

  expect(() => {
    rewriteEnvFile(path.join(sandbox, "app/.env.local"), new Map([["BROKEN", 12_001]]));
  }).toThrow(/Unsupported env value/);
});
