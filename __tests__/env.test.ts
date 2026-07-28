import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { rewriteEnvFile } from "../src/env.ts";
import { makeTempDir, read, write } from "./helpers.ts";

describe("environment rewriting", () => {
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
`
    );

    rewriteEnvFile(
      path.join(sandbox, "app/.env.local"),
      new Map([
        ["PORT", 11_000],
        ["DATABASE_URL", 11_001],
        ["API_URL", 11_002]
      ])
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
    }).toThrow(/Missing mapped env vars/u);
  });

  test("rewriteEnvFile rejects malformed or portless values", () => {
    const sandbox = makeTempDir("env-invalid");
    write(
      sandbox,
      "app/.env.local",
      "DATABASE_URL=postgres://localhost/app\nBROKEN=localhost:5432\n"
    );

    expect(() => {
      rewriteEnvFile(path.join(sandbox, "app/.env.local"), new Map([["DATABASE_URL", 12_000]]));
    }).toThrow(/Expected explicit port/u);

    expect(() => {
      rewriteEnvFile(path.join(sandbox, "app/.env.local"), new Map([["BROKEN", 12_001]]));
    }).toThrow(/Unsupported env value/u);
  });

  test("rewriteEnvFile redacts invalid managed env values in errors", () => {
    const sandbox = makeTempDir("env-redacted-invalid");
    const envPath = path.join(sandbox, "app/.env.local");
    const unsupportedValue = "fake_token_without_scheme_123";
    const malformedDsn = "postgres://fake_user:fake_password@[::1:5432/app";
    write(
      sandbox,
      "app/.env.local",
      `API_TOKEN=${unsupportedValue}
DATABASE_URL=${malformedDsn}
`
    );

    const unsupportedMessage = captureThrowMessage(() => {
      rewriteEnvFile(envPath, new Map([["API_TOKEN", 12_000]]));
    });
    expect(unsupportedMessage).toContain(`Unsupported env value at ${envPath}:API_TOKEN`);
    expect(unsupportedMessage).toContain(`<redacted length=${unsupportedValue.length}>`);
    expect(unsupportedMessage).not.toContain(unsupportedValue);

    const malformedMessage = captureThrowMessage(() => {
      rewriteEnvFile(envPath, new Map([["DATABASE_URL", 12_001]]));
    });
    expect(malformedMessage).toContain(`Malformed URL or DSN at ${envPath}:DATABASE_URL`);
    expect(malformedMessage).toContain(`<redacted length=${malformedDsn.length}>`);
    expect(malformedMessage).not.toContain(malformedDsn);
  });
});

function captureThrowMessage(action: () => void): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("Expected action to throw");
}
