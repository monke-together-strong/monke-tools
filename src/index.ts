#!/usr/bin/env bun

import { MonkeError } from "./errors.ts";
import { runCleanup, runCreate, runMaterialize } from "./monke.ts";
import { createRuntime } from "./runtime.ts";

export function runCli(argv: string[], runtime = createRuntime()): void {
  const [command, ...rest] = argv;

  switch (command) {
    case "create": {
      if (rest.length !== 1) {
        throw new MonkeError("Usage: monke create <session>");
      }
      runCreate(runtime, rest[0]!);
      return;
    }
    case "materialize": {
      if (rest.length !== 0) {
        throw new MonkeError("Usage: monke materialize");
      }
      runMaterialize(runtime);
      return;
    }
    case "cleanup": {
      if (rest.length !== 0) {
        throw new MonkeError("Usage: monke cleanup");
      }
      runCleanup(runtime);
      return;
    }
    default:
      throw new MonkeError(
        "Usage:\n  monke create <session>\n  monke materialize\n  monke cleanup",
      );
  }
}

if (import.meta.main) {
  try {
    runCli(Bun.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
