#!/usr/bin/env bun

import { Argument, Command, Option } from "@commander-js/extra-typings";

import { runChop } from "./chop.ts";
import { configureCliParser, reportCliFailure } from "./cli-errors.ts";
import { runDiff, runDiffInteractive } from "./diff.ts";
import {
  expectedReleaseIdentityFromEnvironment,
  runActivateLocalInstall,
  runActivateReleaseInstall
} from "./installation.ts";
import { runCleanup, runSpawn, runInstallDependencies, runMaterialize, runSetup } from "./monke.ts";
import { createRuntime, getMonkeHome } from "./runtime.ts";
import { runShellInit, runShellInstall } from "./shell.ts";
import { runLocalInstallSkills, runSkillsConfigure } from "./skills.ts";
import type { ExplicitSkillTargetSelection } from "./skills.ts";
import { runSwing, runSwingInteractive } from "./swing.ts";
import type { Runtime } from "./types.ts";
import { runUpdate } from "./update.ts";

/** Run the Monke Tools CLI. */
export function runCli(argv: string[], runtime = createRuntime()) {
  const program = createProgram(runtime, runSwing, runDiff);
  program.parse(argv, { from: "user" });
}

/** Run the Monke Tools CLI with async interactive prompts enabled. */
export async function runCliAsync(argv: string[], runtime = createRuntime()) {
  const program = createProgram(runtime, runSwingInteractive, runDiffInteractive);
  await program.parseAsync(argv, { from: "user" });
}

function createProgram(
  runtime: Runtime,
  swingAction: (
    runtime: Runtime,
    target: string | undefined,
    options: { codex?: boolean }
  ) => void | Promise<void>,
  diffAction: (runtime: Runtime, options: { pick?: boolean }) => void | Promise<void>
) {
  // Subcommands copy these at .command() time, so every subcommand below must be declared after.
  const program = new Command()
    .name("mt")
    .version(runtime.toolBuildIdentity)
    .allowExcessArguments(false);

  configureCliParser(program);

  program
    .command("home")
    .description("Print the resolved Monke home path")
    .action(() => {
      runtime.writeStdout(`${getMonkeHome(runtime)}\n`);
    });

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
        { codex: options.codex }
      );
    });

  program
    .command("swing")
    .argument("[target]")
    .option("--codex")
    .action((target, options) => swingAction(runtime, target, options));

  program
    .command("diff")
    .option("-p, --pick")
    .action((options) => diffAction(runtime, options));

  program.command("materialize").action(() => {
    runMaterialize(runtime);
  });

  program
    .command("chop")
    .description("Remove one Session or Ordinary worktree target while preserving local branches")
    .helpOption("-h, --help", "Display help for Chop")
    .argument("[target]")
    .option(
      "--force",
      "Discard staged, modified, and untracked files; ignored files are always deleted"
    )
    .action((target, options) => {
      runChop(runtime, target, { force: options.force === true });
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
          : { mode: "dead-only" }
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

  program
    .command("update")
    .option("--check", "Check for a compatible stable Release without installing it")
    .action((options) => runUpdate(runtime, { check: options.check === true }));

  program
    .command("activate-release-install", { hidden: true })
    .argument("<bundle-root>")
    .option("--custom-target <path>", "Add a custom Agent Skill root")
    .option("--installation-lock-held")
    .option("--interactive")
    .addOption(
      new Option(
        "--targets <targets...>",
        "Replace the saved Skill install preference with built-in targets"
      ).choices(["codex", "claude", "cursor"])
    )
    .action((bundleRoot, options) =>
      runActivateReleaseInstall(runtime, {
        bundleRoot,
        expectedReleaseIdentity: expectedReleaseIdentityFromEnvironment(runtime.env),
        explicitTargets: explicitSkillTargets(options.targets, options.customTarget),
        installationLockHeld: options.installationLockHeld === true,
        interactive: options.interactive === true
      })
    );

  program
    .command("activate-local-install", { hidden: true })
    .argument("<staged-install>")
    .argument("<source-checkout>")
    .requiredOption("--install-id <identity>")
    .requiredOption("--source-commit <sha>")
    .requiredOption("--created-at <timestamp>")
    .requiredOption("--platform <platform>")
    .option("--custom-target <path>", "Add a custom Agent Skill root")
    .option("--dirty")
    .option("--installation-lock-held")
    .addOption(
      new Option(
        "--targets <targets...>",
        "Replace the saved Skill install preference with built-in targets"
      ).choices(["codex", "claude", "cursor"])
    )
    .action((stagedInstall, sourceCheckout, options) =>
      runActivateLocalInstall(runtime, {
        createdAt: options.createdAt,
        dirty: options.dirty === true,
        explicitTargets: explicitSkillTargets(options.targets, options.customTarget),
        installationLockHeld: options.installationLockHeld === true,
        installId: options.installId,
        platform: options.platform,
        sourceCheckout,
        sourceCommit: options.sourceCommit,
        stagedInstall
      })
    );

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

  skills.command("configure").action(() => runSkillsConfigure(runtime));

  skills
    .command("local-install", { hidden: true })
    .argument("<source-checkout>")
    .option("--custom-target <path>", "Add a custom Agent Skill root")
    .addOption(
      new Option(
        "--targets <targets...>",
        "Replace the saved Skill install preference with built-in targets"
      ).choices(["codex", "claude", "cursor"])
    )
    .action((sourceCheckout, options) =>
      runLocalInstallSkills(
        runtime,
        sourceCheckout,
        explicitSkillTargets(options.targets, options.customTarget)
      )
    );

  return program;
}

function explicitSkillTargets(
  builtInTargetKinds: ExplicitSkillTargetSelection["builtInTargetKinds"],
  customTargetPath: string | undefined
): ExplicitSkillTargetSelection | undefined {
  if (builtInTargetKinds === undefined && customTargetPath === undefined) {
    return undefined;
  }
  return { builtInTargetKinds, customTargetPath };
}

if (import.meta.main) {
  try {
    await runCliAsync(Bun.argv.slice(2));
  } catch (error) {
    reportCliFailure(error);
  }
}
