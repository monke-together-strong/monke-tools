#!/usr/bin/env bun

import { Command, CommanderError } from "commander";

import { MonkeError } from "./errors.ts";
import { runCleanup, runCreate, runMaterialize, runSetup } from "./monke.ts";
import { createRuntime } from "./runtime.ts";
import type { Runtime } from "./types.ts";

const ROOT_USAGE = "Usage:\n  monke create <session>\n  monke materialize\n  monke cleanup\n  monke setup";

export function runCli(argv: string[], runtime = createRuntime()): void {
  if (argv.length === 0) {
    throw new MonkeError(ROOT_USAGE);
  }

  try {
    createProgram(runtime).parse(argv, { from: "user" });
  } catch (error) {
    throw mapCliError(error, argv);
  }
}

function createProgram(runtime: Runtime): Command {
  const program = new Command()
    .name("monke")
    .helpOption(false)
    .addHelpCommand(false)
    .showSuggestionAfterError(false)
    .allowExcessArguments(false)
    .configureOutput({
      writeErr: () => undefined,
      writeOut: () => undefined,
    });

  program.exitOverride();

  program
    .command("create")
    .helpOption(false)
    .allowExcessArguments(false)
    .argument("<session>")
    .action((session: string) => {
      runCreate(runtime, session);
    });

  program
    .command("materialize")
    .helpOption(false)
    .allowExcessArguments(false)
    .action(() => {
      runMaterialize(runtime);
    });

  program
    .command("cleanup")
    .helpOption(false)
    .allowExcessArguments(false)
    .action(() => {
      runCleanup(runtime);
    });

  program
    .command("setup")
    .helpOption(false)
    .allowExcessArguments(false)
    .action(() => {
      runSetup(runtime);
    });

  return program;
}

function mapCliError(error: unknown, argv: string[]): Error {
  if (!(error instanceof CommanderError)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  switch (argv[0]) {
    case "create":
      return new MonkeError("Usage: monke create <session>");
    case "materialize":
      return new MonkeError("Usage: monke materialize");
    case "cleanup":
      return new MonkeError("Usage: monke cleanup");
    case "setup":
      return new MonkeError("Usage: monke setup");
    default:
      return new MonkeError(ROOT_USAGE);
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
