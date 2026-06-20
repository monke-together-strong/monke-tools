#!/usr/bin/env bun

import { Command, CommanderError } from "commander";

import { MonkeError } from "./errors.ts";
import {
  runCleanup,
  runCreate,
  runInstallDependencies,
  runMaterialize,
  runSetup,
} from "./monke.ts";
import { createRuntime } from "./runtime.ts";
import { runLocalInstallSkills, runSkillsConfigure } from "./skills.ts";
import type { Runtime } from "./types.ts";

const ROOT_USAGE =
  "Usage:\n  mt create <session> [-m|--main|--master]\n  mt materialize\n  mt cleanup [--merged] [--dry-run]\n  mt setup\n  mt skills configure";
const CREATE_USAGE = "Usage: mt create <session> [-m|--main|--master]";
const CLEANUP_USAGE = "Usage: mt cleanup [--merged] [--dry-run]";
const SKILLS_USAGE = "Usage: mt skills configure";
const SKILLS_LOCAL_INSTALL_USAGE = "Usage: mt skills local-install <source-checkout>";

interface RawCleanupCommandOptions {
  merged?: boolean;
  dryRun?: boolean;
}

/** Run the Monke Tools CLI. */
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
    .option("-m, --main")
    .option("--master")
    .action((session: string, options: { main?: boolean; master?: boolean }) => {
      runCreate(runtime, session, {
        mode: options.main || options.master ? "default-branch" : "current-head",
      });
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
    .option("--merged")
    .option("--dry-run")
    .action((options: RawCleanupCommandOptions) => {
      if (options.dryRun && !options.merged) {
        throw new MonkeError(CLEANUP_USAGE);
      }

      runCleanup(
        runtime,
        options.merged === true
          ? { mode: "merged", dryRun: options.dryRun === true }
          : { mode: "dead-only" },
      );
    });

  program
    .command("setup")
    .helpOption(false)
    .allowExcessArguments(false)
    .action(() => {
      runSetup(runtime);
    });

  program
    .command("install-dependencies")
    .description("Install or verify runtime dependencies used by mt")
    .helpOption(false)
    .allowExcessArguments(false)
    .action(() => {
      runInstallDependencies(runtime);
    });

  const skills = program
    .command("skills")
    .helpOption(false)
    .allowExcessArguments(false)
    .addHelpCommand(false);

  skills
    .command("configure")
    .helpOption(false)
    .allowExcessArguments(false)
    .action(() => {
      runSkillsConfigure(runtime);
    });

  skills
    .command("local-install")
    .helpOption(false)
    .allowExcessArguments(false)
    .argument("<source-checkout>")
    .action((sourceCheckout: string) => {
      runLocalInstallSkills(runtime, sourceCheckout);
    });

  return program;
}

function mapCliError(error: unknown, argv: string[]): Error {
  if (!(error instanceof CommanderError)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  switch (argv[0]) {
    case "create":
      return new MonkeError(CREATE_USAGE);
    case "materialize":
      return new MonkeError("Usage: mt materialize");
    case "cleanup":
      return new MonkeError(CLEANUP_USAGE);
    case "setup":
      return new MonkeError("Usage: mt setup");
    case "install-dependencies":
      return new MonkeError("Usage: mt install-dependencies");
    case "skills":
      if (argv[1] === "local-install") {
        return new MonkeError(SKILLS_LOCAL_INSTALL_USAGE);
      }
      return new MonkeError(SKILLS_USAGE);
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
