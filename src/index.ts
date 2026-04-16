#!/usr/bin/env bun

import { Command, CommanderError, Option } from "commander";

import { MonkeError } from "./errors.ts";
import { runCleanup, runCreate, runMaterialize, runSetup } from "./monke.ts";
import {
  CODEX_REASONING_EFFORTS,
  runSinglePassWorkflow,
  type CodexReasoningEffort,
} from "./run.ts";
import { createRuntime } from "./runtime.ts";
import type { Runtime } from "./types.ts";

const ROOT_USAGE =
  "Usage:\n  mt create <session>\n  mt materialize\n  mt cleanup\n  mt setup\n  mt run --plan <text> [--effort <level>]";
const RUN_USAGE = "Usage: mt run --plan <text> [--effort <level>]";

interface RunCommandOptions {
  plan: string;
  effort?: CodexReasoningEffort;
}

/** Run the Monke Tools CLI. Valid `mt run` invocations return a workflow promise. */
export function runCli(argv: string[], runtime = createRuntime()): void | Promise<void> {
  if (argv.length === 0) {
    throw new MonkeError(ROOT_USAGE);
  }

  const pendingRun: { options: RunCommandOptions | null } = { options: null };

  try {
    createProgram(runtime, (options) => {
      pendingRun.options = options;
    }).parse(argv, { from: "user" });
  } catch (error) {
    throw mapCliError(error, argv);
  }

  if (pendingRun.options) {
    return runSinglePassWorkflow(runtime, pendingRun.options.plan, {
      effort: pendingRun.options.effort,
    });
  }
}

function createProgram(runtime: Runtime, onRun: (options: RunCommandOptions) => void): Command {
  const program = new Command()
    .name("mt")
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

  program
    .command("run")
    .helpOption(false)
    .allowExcessArguments(false)
    .requiredOption("--plan <text>")
    .addOption(new Option("--effort <level>").choices([...CODEX_REASONING_EFFORTS]))
    .action((options: RunCommandOptions) => {
      onRun(options);
    });

  return program;
}

function mapCliError(error: unknown, argv: string[]): Error {
  if (!(error instanceof CommanderError)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  switch (argv[0]) {
    case "create":
      return new MonkeError("Usage: mt create <session>");
    case "materialize":
      return new MonkeError("Usage: mt materialize");
    case "cleanup":
      return new MonkeError("Usage: mt cleanup");
    case "setup":
      return new MonkeError("Usage: mt setup");
    case "run":
      return new MonkeError(RUN_USAGE);
    default:
      return new MonkeError(ROOT_USAGE);
  }
}

if (import.meta.main) {
  try {
    await runCli(Bun.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
