#!/usr/bin/env bun

import { Command, CommanderError } from "commander";

import { MonkeError } from "./errors.ts";
import { runCleanup, runSpawn, runInstallDependencies, runMaterialize, runSetup } from "./monke.ts";
import { createRuntime } from "./runtime.ts";
import { runShellInit, runShellInstall } from "./shell.ts";
import { runLocalInstallSkills, runSkillsConfigure } from "./skills.ts";
import { runSwing, runSwingInteractive } from "./swing.ts";
import type { SwingOptions } from "./swing.ts";
import type { Runtime } from "./types.ts";

const ROOT_USAGE =
  "Usage:\n  mt spawn <session> [--no-dirty] [-m|--main|--master]\n  mt swing [target] [--codex]\n  mt materialize\n  mt cleanup [--merged] [--dry-run]\n  mt setup\n  mt shell install\n  mt shell init <bash|zsh>\n  mt skills configure";
const SPAWN_USAGE = "Usage: mt spawn <session> [--no-dirty] [-m|--main|--master]";
const CLEANUP_USAGE = "Usage: mt cleanup [--merged] [--dry-run]";
const SKILLS_USAGE = "Usage: mt skills configure";
const SKILLS_LOCAL_INSTALL_USAGE = "Usage: mt skills local-install <source-checkout>";
const SHELL_USAGE = "Usage:\n  mt shell install\n  mt shell init <bash|zsh>";
const SWING_USAGE = "Usage: mt swing [target] [--codex]";

interface RawCleanupCommandOptions {
  merged?: boolean;
  dryRun?: boolean;
}

interface RawSpawnCommandOptions {
  main?: boolean;
  master?: boolean;
  dirty?: boolean;
}

/** Run the Monke Tools CLI. */
export function runCli(argv: string[], runtime = createRuntime()): void {
  if (argv.length === 0) {
    throw new MonkeError(ROOT_USAGE);
  }

  try {
    createProgram(runtime, runSwing).parse(argv, { from: "user" });
  } catch (error) {
    throw mapCliError(error, argv);
  }
}

/** Run the Monke Tools CLI with async interactive prompts enabled. */
export async function runCliAsync(argv: string[], runtime = createRuntime()): Promise<void> {
  if (argv.length === 0) {
    throw new MonkeError(ROOT_USAGE);
  }

  try {
    await createProgram(runtime, runSwingInteractive).parseAsync(argv, { from: "user" });
  } catch (error) {
    throw mapCliError(error, argv);
  }
}

function createProgram(
  runtime: Runtime,
  swingAction: (
    runtime: Runtime,
    target: string | undefined,
    options: SwingOptions,
  ) => void | Promise<void>,
): Command {
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
    .command("spawn")
    .helpOption(false)
    .allowExcessArguments(false)
    .argument("<session>")
    .option("--no-dirty")
    .option("-m, --main")
    .option("--master")
    .action((session: string, options: RawSpawnCommandOptions) => {
      runSpawn(
        runtime,
        session,
        options.main || options.master
          ? { mode: "default-branch" }
          : { mode: "current-head", copyDirty: options.dirty !== false },
      );
    });

  program
    .command("swing")
    .helpOption(false)
    .allowExcessArguments(false)
    .argument("[target]")
    .option("--codex")
    .action((target: string | undefined, options: SwingOptions) => {
      return swingAction(runtime, target, options);
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

  const shell = program
    .command("shell")
    .helpOption(false)
    .allowExcessArguments(false)
    .addHelpCommand(false);

  shell
    .command("install")
    .helpOption(false)
    .allowExcessArguments(false)
    .option("--binary <path>")
    .action((options: { binary?: string }) => {
      runShellInstall(runtime, options);
    });

  shell
    .command("init")
    .helpOption(false)
    .allowExcessArguments(false)
    .argument("<shell>")
    .option("--binary <path>")
    .action((shellName: string, options: { binary?: string }) => {
      runShellInit(runtime, shellName, options);
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
    case "spawn":
      return new MonkeError(SPAWN_USAGE);
    case "swing":
      return new MonkeError(SWING_USAGE);
    case "materialize":
      return new MonkeError("Usage: mt materialize");
    case "cleanup":
      return new MonkeError(CLEANUP_USAGE);
    case "setup":
      return new MonkeError("Usage: mt setup");
    case "install-dependencies":
      return new MonkeError("Usage: mt install-dependencies");
    case "shell":
      return new MonkeError(SHELL_USAGE);
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
    await runCliAsync(Bun.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
