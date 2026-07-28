#!/usr/bin/env bun

import { Argument, Command } from "@commander-js/extra-typings";

import { configureCliParser, reportCliFailure } from "./cli-errors.ts";
import { runChop } from "./chop.ts";
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
  if (selectedCommand !== undefined && selectedCommand.commands.length > 0 && argv.length === 1) {
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
  // Subcommands copy these at .command() time, so every subcommand below must be declared after.
  const program = new Command()
    .name("mt")
    .helpOption(false)
    .helpCommand(false)
    .allowExcessArguments(false);

  configureCliParser(program);

  program
    .command("spawn")
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
          : { copyDirty: options.dirty, mode: "current-head" },
        { codex: options.codex },
      );
    });

  program
    .command("swing")
    .argument("[target]")
    .option("--codex")
    .action((target, options) => swingAction(runtime, target, options));

  program.command("materialize").action(() => {
    runMaterialize(runtime);
  });

  program
    .command("chop")
    .description("Remove one worktree while preserving its local branch")
    .argument("[target]")
    .action((target) => {
      runChop(runtime, target);
    });

  const cleanup = program
    .command("cleanup")
    .option("--merged")
    .option("--dry-run")
    .action((options) => {
      if (options.dryRun && !options.merged) {
        cleanup.error("error: option '--dry-run' cannot be used without option '--merged'");
      }

      runCleanup(
        runtime,
        options.merged === true
          ? { dryRun: options.dryRun === true, mode: "merged" }
          : { mode: "dead-only" },
      );
    });

  program.command("setup").action(() => {
    runSetup(runtime);
  });

  program
    .command("install-dependencies")
    .description("Install or verify runtime dependencies used by mt")
    .action(() => {
      runInstallDependencies(runtime);
    });

  const shell = program.command("shell");

  shell
    .command("install")
    .option("--binary <path>")
    .action((options) => {
      runShellInstall(runtime, options);
    });

  shell
    .command("init")
    .addArgument(new Argument("<shell>").choices(["bash", "zsh"]))
    .option("--binary <path>")
    .action((shellName, options) => {
      runShellInit(runtime, shellName, options);
    });

  const skills = program.command("skills");

  skills.command("configure").action(() => {
    runSkillsConfigure(runtime);
  });

  skills
    .command("local-install")
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
