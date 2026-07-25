#!/usr/bin/env bun

import { Argument, Command } from "@commander-js/extra-typings";

import { configureCliParser, reportCliFailure } from "./cli-errors.ts";
import { runCleanup, runSpawn, runInstallDependencies, runMaterialize, runSetup } from "./monke.ts";
import { createRuntime } from "./runtime.ts";
import { runShellInit, runShellInstall } from "./shell.ts";
import { runLocalInstallSkills, runSkillsConfigure } from "./skills.ts";
import { runSwing, runSwingInteractive } from "./swing.ts";
import type { Runtime } from "./types.ts";

/** Run the Monke Tools CLI. */
export function runCli(argv: string[], runtime = createRuntime()): void {
  const program = createProgram(runtime, runSwing);
  requireSelectedCommand(program, argv);
  program.parse(argv, { from: "user" });
}

/** Run the Monke Tools CLI with async interactive prompts enabled. */
export async function runCliAsync(argv: string[], runtime = createRuntime()): Promise<void> {
  const program = createProgram(runtime, runSwingInteractive);
  requireSelectedCommand(program, argv);
  await program.parseAsync(argv, { from: "user" });
}

function requireSelectedCommand(program: Command, argv: string[]): void {
  if (argv.length === 0) {
    program.error("error: missing command");
  }

  const selectedCommand = program.commands.find((command) => command.name() === argv[0]);
  if (selectedCommand?.commands.length && argv.length === 1) {
    selectedCommand.error("error: missing command");
  }
}

function createProgram(
  runtime: Runtime,
  swingAction: (
    runtime: Runtime,
    target: string | undefined,
    options: { codex?: boolean },
  ) => void | Promise<void>,
): Command {
  const program = new Command()
    .name("mt")
    .helpOption(false)
    .addHelpCommand(false)
    .allowExcessArguments(false);

  configureCliParser(program);

  program
    .command("spawn")
    .helpOption(false)
    .allowExcessArguments(false)
    .argument("<session>")
    .option("--no-dirty")
    .option("-m, --main")
    .option("--master")
    .option("--codex")
    .action((session, options) => {
      runSpawn(
        runtime,
        session,
        options.main || options.master
          ? { mode: "default-branch" }
          : { mode: "current-head", copyDirty: options.dirty !== false },
        { codex: options.codex },
      );
    });

  program
    .command("swing")
    .helpOption(false)
    .allowExcessArguments(false)
    .argument("[target]")
    .option("--codex")
    .action((target, options) => {
      return swingAction(runtime, target, options);
    });

  program
    .command("materialize")
    .helpOption(false)
    .allowExcessArguments(false)
    .action(() => {
      runMaterialize(runtime);
    });

  const cleanup = program
    .command("cleanup")
    .helpOption(false)
    .allowExcessArguments(false)
    .option("--merged")
    .option("--dry-run")
    .action((options) => {
      if (options.dryRun && !options.merged) {
        cleanup.error("error: option '--dry-run' cannot be used without option '--merged'");
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
    .action((options) => {
      runShellInstall(runtime, options);
    });

  shell
    .command("init")
    .helpOption(false)
    .allowExcessArguments(false)
    .addArgument(new Argument("<shell>").choices(["bash", "zsh"]))
    .option("--binary <path>")
    .action((shellName, options) => {
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
    .action((sourceCheckout) => {
      runLocalInstallSkills(runtime, sourceCheckout);
    });

  return program;
}

if (import.meta.main) {
  try {
    await runCliAsync(Bun.argv.slice(2));
  } catch (error) {
    reportCliFailure(error);
  }
}
