import { existsSync, symlinkSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { rewriteEnvFile, seedWorktreeFiles } from "../src/env.ts";
import type { RepoConfig } from "../src/types.ts";
import { makeTempDir, read, write } from "./helpers.ts";

describe("environment rewriting", () => {
  test("seedWorktreeFiles discovers env files while pruning managed and dependency trees", () => {
    const sandbox = makeTempDir("env-seed-discovery");
    const sourceRoot = path.join(sandbox, "source");
    const worktreeRoot = path.join(sandbox, "worktree");
    write(sourceRoot, ".env", "ROOT=1\n");
    write(sourceRoot, "apps/api/.env.local", "APP=1\n");
    write(sourceRoot, ".git/.env", "GIT=1\n");
    write(sourceRoot, ".monke/.env.generated", "MONKE=1\n");
    write(sourceRoot, "node_modules/example/.env", "DEPENDENCY=1\n");
    symlinkSync(path.join(sourceRoot, "apps"), path.join(sourceRoot, "linked-apps"));
    const config: RepoConfig = {
      appsInOrder: [],
      configPath: path.join(sourceRoot, "monke.yml"),
      externalInOrder: [],
      externalMappingsInOrder: [],
      localPortOrder: [],
      resourceCommandsInOrder: [],
      resourceValuesInOrder: [],
      seedPaths: [],
      sourceRoot
    };

    seedWorktreeFiles(config, worktreeRoot);

    expect(read(worktreeRoot, ".env")).toBe("ROOT=1\n");
    expect(read(worktreeRoot, "apps/api/.env.local")).toBe("APP=1\n");
    expect(existsSync(path.join(worktreeRoot, ".git/.env"))).toBeFalsy();
    expect(existsSync(path.join(worktreeRoot, ".monke/.env.generated"))).toBeFalsy();
    expect(existsSync(path.join(worktreeRoot, "node_modules/example/.env"))).toBeFalsy();
    expect(existsSync(path.join(worktreeRoot, "linked-apps/api/.env.local"))).toBeFalsy();
  });

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

function captureThrowMessage(action: () => void) {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("Expected action to throw");
}
