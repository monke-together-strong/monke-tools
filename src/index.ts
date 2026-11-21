#!/usr/bin/env bun
import { Argument, Command, Option } from "@commander-js/extra-typings";
import "zod/compile";

import { runChop } from "./chop.ts";
import { runCleanup } from "./cleanup.ts";
import { configureCliParser, reportCliFailure } from "./cli-errors.ts";
import { createWaitForGateCommand } from "./deployment-gate.ts";
import { runDiffConfigure, runDiffInteractive } from "./diff.ts";
import { MonkeError, ThrownValueSchema } from "./errors.ts";
import { BUILT_IN_SKILL_INSTALL_TARGET_KINDS, MODEL_ROLES } from "./global-config.ts";
import { runLocalInstallSkills, runSkillsConfigure } from "./guidance-installation.ts";
import { addInstallGuidance } from "./install-guidance.ts";
import {
  expectedReleaseIdentityFromEnvironment,
  runActivateLocalInstall,
  runActivateReleaseInstall
} from "./installation.ts";
import { runModelsGet } from "./model-roles.ts";
import {
  ADOPTION_CONSEQUENCES,
  runSpawn,
  runInstallDependencies,
  runMaterialize,
  runSetup
} from "./monke.ts";
import type { SpawnOptions } from "./monke.ts";
import { runPrsCreate, runPrsList, runPrsPoll, runPrsTrack, runPrsUntrack } from "./pr-tracking.ts";
import { runResources, runResourcesExec } from "./resource-lifecycle.ts";
import { createRuntime, getMonkeHome } from "./runtime.ts";
import { runShellInit, runShellInstall } from "./shell.ts";
import { runSkillsRegistry } from "./skill-registry.ts";
import type { ExplicitSkillTargetSelection } from "./skills.ts";
import { runSwing } from "./swing.ts";
import type { Runtime } from "./types.ts";
import { runUpdate } from "./update.ts";

export async function runCliAsync(argv: string[], runtime = createRuntime()) {
  const program = createProgram(runtime);
  let installationCommand = false;
  program.hook("preAction", (_program, command) => {
    installationCommand =
      [
        "update",
        "install-dependencies",
        "activate-release-install",
        "activate-local-install"
      ].includes(command.name()) ||
      (command.parent?.name() === "shell" && ["install", "init"].includes(command.name())) ||
      (command.parent?.name() === "skills" &&
        ["configure", "local-install"].includes(command.name()));
  });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (cause) {
    if (installationCommand && cause instanceof MonkeError) {
      addInstallGuidance(runtime, cause);
    }

    throw cause;
  }
}

function createProgram(runtime: Runtime) {
  // Commander copies parser settings into subcommands at declaration time. Configure the parent first.
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
    .description("Create or complete a Session and its participating worktrees")
    .argument("<session>")
    .option("--no-dirty", "Require clean checkouts instead of carrying their edits")
    .option("-m, --main", "Start from default branches without carrying edits")
    .option("--master", "Alias for --main")
    .addOption(
      new Option(
        "--from <ref>",
        "Start the Root repo from a branch, tag, or commit, and dependencies from default branches, without carrying edits"
      ).conflicts(["main", "master"])
    )
    .option("--codex", "Open the Session in Codex once it is ready")
    .action((session, options) => {
      let spawnOptions: SpawnOptions = { copyDirty: options.dirty, mode: "current-head" };

      if (options.from !== undefined) {
        spawnOptions = { from: options.from, mode: "default-branch" };
      } else if (options.main || options.master) {
        spawnOptions = { mode: "default-branch" };
      }

      return runSpawn(runtime, session, spawnOptions, { codex: options.codex });
    });

  program
    .command("swing")
    .description("Navigate to a Checkout of the current repo, or create a PR's Session worktree")
    .argument(
      "[target]",
      "Session name, branch, ^ (Source checkout), - (Previous Swing target), pr:<number>, or PR URL"
    )
    .option("--codex", "Open the target Checkout in Codex")
    .action((target, options) => runSwing(runtime, target, options));

  const diff = program
    .command("diff")
    .enablePositionalOptions()
    .description(
      "Review changes in the selected checkout. An explicit comparison bypasses the remembered Diff base"
    )
    .argument(
      "[targets...]",
      "ref, base..head, base...head, #PR, pr <number|branch>, mr <number>, or review URL"
    )
    .option("-p, --pick", "Choose a Diff base or review only local changes")
    .option("--adapter <adapter>", "One-off adapter selection (codiff or ms)")
    .option("--path <checkout>", "Select an existing Checkout, including a nested directory")
    .option("--working-tree", "Review only staged, unstaged, and untracked changes")
    .option("--commit <ref>", "Review one commit")
    .option("--branch <ref>", "Review the branch contribution plus local changes")
    .action((targets, options) => runDiffInteractive(runtime, { ...options, targets }));

  diff
    .command("configure")
    .description("Save this machine's Diff adapter without launching a review")
    .option("--adapter <adapter>", "Noninteractive selection (codiff or ms)")
    .action((options) => runDiffConfigure(runtime, options));

  program
    .command("models")
    .description("Show the models agents use for each Model role")
    .command("get")
    .description("Print a Model role's models in fallback order")
    .addArgument(new Argument("<role>", "Model role").choices(MODEL_ROLES))
    .action((role) => {
      runModelsGet(runtime, role);
    });

  program
    .command("materialize")
    .description("Materialize the current Session worktree and its Dependency repos")
    .option(
      "--adopt",
      `Adopt this Ordinary worktree as the Root repo's Session worktree for its current branch. ${ADOPTION_CONSEQUENCES}`
    )
    .action((options) => runMaterialize(runtime, { adopt: options.adopt === true }));

  program.enablePositionalOptions();

  const resources = program
    .command("resources")
    .description("Manage resources owned by the current checkout")
    .enablePositionalOptions();

  resources
    .command("acquire")
    .description("Acquire missing Checkout resource allocations or reuse saved ones")
    .action(() => runResources(runtime, "acquire"));
  resources
    .command("release")
    .description("Release acquired Checkout resource allocations while keeping the checkout")
    .action(() => runResources(runtime, "release"));
  resources
    .command("exec")
    .description("Run a command with acquired resources, keeping them protected until it exits")
    .argument("<command>")
    .argument("[args...]")
    .allowUnknownOption()
    .passThroughOptions()
    .action(async (command, args) => {
      process.exitCode = await runResourcesExec(runtime, command, args);
    });

  const prs = program
    .command("prs")
    .description("Track PRs for post-merge and wait for deployment gates");

  prs.addCommand(createWaitForGateCommand(runtime));

  prs
    .command("create")
    .description("Create a PR and register its post-merge tracking before reporting success")
    .argument("<gh-args...>", "gh pr create arguments, after --")
    .requiredOption("--thread <id>", "T3 thread that owns the PR")
    .requiredOption("--checkout <path>", "Checkout the PR was built in")
    .action((args, options) => runPrsCreate(runtime, args, options));

  prs
    .command("track")
    .description("Track an open PR with the T3 thread and checkout that own it")
    .argument("<url>")
    .requiredOption("--thread <id>", "T3 thread that owns the PR")
    .requiredOption("--checkout <path>", "Checkout the PR was built in")
    .action((url, options) => runPrsTrack(runtime, url, options));

  prs
    .command("untrack")
    .description("Stop tracking a PR")
    .argument("<url>")
    .action((url) => runPrsUntrack(runtime, url));

  prs
    .command("list")
    .description("List tracked PRs")
    .action(() => {
      runPrsList(runtime);
    });

  prs
    .command("poll")
    .description("Hand externally merged PRs to their threads for post-merge")
    .action(() => runPrsPoll(runtime));

  program
    .command("chop")
    .description("Remove one Session or Ordinary worktree target while preserving local branches")
    .helpOption("-h, --help", "Display help for Chop")
    .argument("[target]")
    .option(
      "--force",
      "Discard staged, modified, and untracked files; ignored files are always deleted"
    )
    .option(
      "--cleanup-from-source",
      "Explicit recovery: run recorded Cleanup commands and resource release from the Source checkout for Missing Session worktrees"
    )
    .action((target, options) => {
      runChop(runtime, target, {
        cleanupFromSource: options.cleanupFromSource === true,
        force: options.force === true
      });
    });

  program
    .command("cleanup")
    .argument("[targets...]", "Limit Cleanup to the Sessions or worktrees at these paths")
    .description(
      "Remove eligible Sessions across known Source checkouts and preserve local branches"
    )
    .option(
      "--source <repo>",
      "Discover an additional Source checkout. Repeat to discover more",
      (source: string, sources: string[]) => [...sources, source],
      []
    )
    .option("--dry-run", "Report what Cleanup would remove without making changes")
    .option("--json", "Write a versioned JSON report to stdout")
    .option("--eligible", "Hide skipped Sessions in human output")
    .option(
      "--include-unowned",
      "Inspect Ordinary worktrees and stale registrations; live removal requires --recover-with"
    )
    .option(
      "--archive-untracked",
      "Archive untracked-only changes before eligible worktree removal"
    )
    .option(
      "--recover-with <command>",
      "Run a recovery command from the Source checkout. Requires explicit worktree targets"
    )
    .action((targets, options) =>
      runCleanup(runtime, {
        archiveUntracked: options.archiveUntracked === true,
        dryRun: options.dryRun === true,
        eligibleOnly: options.eligible === true,
        includeUnowned: options.includeUnowned === true,
        json: options.json === true,
        recoveryCommand: options.recoverWith,
        sources: options.source,
        targets
      })
    );

  program
    .command("setup")
    .description(
      "Reconcile project skill links, dependency paths, and deterministic resource values"
    )
    .action(() => runSetup(runtime));

  program
    .command("install-dependencies")
    .description("Install or verify runtime dependencies used by mt")
    .action(() => {
      runInstallDependencies(runtime);
    });

  program
    .command("update")
    .description("Check for or activate the latest compatible stable Release")
    .option("--check", "Check for a compatible stable Release without installing it")
    .action((options) => runUpdate(runtime, { check: options.check === true }));

  program
    .command("activate-release-install", { hidden: true })
    .argument("<bundle-root>")
    .option("--custom-target <path>", "Add a custom Agent skill root")
    .option("--installation-lock-held")
    .option("--interactive")
    .addOption(
      new Option(
        "--targets <targets...>",
        "Replace the saved Skill install preference with built-in targets"
      ).choices(BUILT_IN_SKILL_INSTALL_TARGET_KINDS)
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
    .option("--custom-target <path>", "Add a custom Agent skill root")
    .option("--dirty")
    .option("--installation-lock-held")
    .addOption(
      new Option(
        "--targets <targets...>",
        "Replace the saved Skill install preference with built-in targets"
      ).choices(BUILT_IN_SKILL_INSTALL_TARGET_KINDS)
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

  const shell = program
    .command("shell")
    .description("Install or emit shell integration for Spawn and Swing navigation");

  shell
    .command("install")
    .description("Configure your current shell to load the Shell adapter")
    .option("--binary <path>", "Explicit path to the mt binary")
    .action((options) => {
      runShellInstall(runtime, options);
    });

  shell
    .command("init")
    .description("Print the Shell adapter script for a supported shell")
    .addArgument(new Argument("<shell>").choices(["bash", "zsh"]))
    .option("--binary <path>", "Explicit path to the mt binary")
    .action((shellName, options) => {
      runShellInit(runtime, shellName, options);
    });

  const skills = program
    .command("skills")
    .description("Manage global, project, and repo skills and agent targets");

  skills
    .command("configure")
    .description("Select Skill install targets and reconcile agent guidance")
    .action(() => runSkillsConfigure(runtime));

  skills
    .command("create")
    .description("Create a Skill in Monke home and link it to configured agents")
    .argument("<name>", "Lowercase Skill slug")
    .option("--description <description>", "When agents should use this Skill")
    .action((name, options) =>
      runSkillsRegistry(runtime, { action: "create", description: options.description, name })
    );

  skills
    .command("adopt")
    .description("Move existing skills into Monke home and link them to configured agents")
    .argument("<source>", "Existing Skill directory or collection")
    .option("--name <name>", "Managed source name (defaults to the source folder name)")
    .option("--skill <slugs...>", "Only adopt the selected skills")
    .action((source, options) =>
      runSkillsRegistry(runtime, {
        action: "adopt",
        name: options.name,
        skills: options.skill,
        source
      })
    );

  skills
    .command("add")
    .alias("import")
    .description("Register imported skills from Git, a local link, or an installer command")
    .argument("[source]", "Git source or local Skill collection")
    .option("--repo", "Declare imports published with this repo in monke.yml")
    .option("--project", "Project skills into this clone using its machine-local registry")
    .option("--command <command>", "Installer command to save and replay on update")
    .option("--cwd <path>", "Installer working directory (defaults to a managed source directory)")
    .option("--link", "Register existing files without running the installer now")
    .option("--name <name>", "Source name (required for command-only imports)")
    .option("--skill <slugs...>", "Select skills to import (re-adding extends the selection)")
    .option("--replace", "Replace the source's selection with --skill")
    .option("--ref", "Import --skill selections as references in repo scope")
    .option("--accept-openclaw-risks", "Accept upstream OpenClaw security risks")
    .action((source, options) =>
      runSkillsRegistry(
        runtime,
        {
          acceptOpenClawRisks: options.acceptOpenclawRisks,
          action: "add",
          command: options.command,
          cwd: options.cwd,
          link: options.link,
          name: options.name,
          reference: options.ref,
          replace: options.replace,
          skills: options.skill,
          source
        },
        options.project,
        options.repo
      )
    );

  skills
    .command("list")
    .description("List registered imported Skill sources")
    .option("--repo", "List imports declared in this repo's monke.yml")
    .option("--project", "List the clone-local registry that projects skills into this clone")
    .action((options) =>
      runSkillsRegistry(runtime, { action: "list" }, options.project, options.repo)
    );

  skills
    .command("update")
    .description("Update imported skills and review changes in a single comparison")
    .option("--repo", "Pin and advance imports declared in this repo's monke.yml")
    .option("--project", "Update the clone-local registry and its skill projections")
    .addOption(
      new Option(
        "--adapter <adapter>",
        "Diff adapter for the update review (codiff or ms)"
      ).choices(["codiff", "ms"])
    )
    .option("--interactive", "Prompt before accepting upstream Skill slug replacements")
    .action((options) =>
      runSkillsRegistry(
        runtime,
        {
          action: "update",
          adapter: options.adapter,
          interactive: options.interactive
        },
        options.project,
        options.repo
      )
    );

  skills
    .command("remove")
    .description("Remove an import registration while preserving its Skill import source")
    .argument("<source>")
    .option("--repo", "Remove a source from this repo's monke.yml")
    .option("--project", "Remove a source from the clone-local registry and its projections")
    .action((source, options) =>
      runSkillsRegistry(runtime, { action: "remove", source }, options.project, options.repo)
    );

  skills
    .command("policy")
    .description("Override an imported Skill's description or model invocation")
    .option("--repo", "Set overrides in this repo's monke.yml")
    .option("--project", "Set overrides in the clone-local registry for skill projections")
    .argument("<source>")
    .argument("[skill]", "Skill slug; omit to set the source default, including future skills")
    .addOption(
      new Option(
        "--model-invocation <policy>",
        "Override whether models may select the skill automatically (allow or deny)"
      ).choices(["allow", "deny"])
    )
    .option("--description <description>", "Replace one Skill's description; requires a Skill slug")
    .action((source, skill, options) =>
      runSkillsRegistry(
        runtime,
        {
          action: "policy",
          description: options.description,
          disable:
            options.modelInvocation === undefined ? undefined : options.modelInvocation === "deny",
          skill,
          source
        },
        options.project,
        options.repo
      )
    );

  skills
    .command("restore")
    .description("Restore this repo's imports at their pinned commits")
    .option("--repo", "Restore the imports declared in monke.yml")
    .action((options) => runSkillsRegistry(runtime, { action: "restore" }, false, options.repo));

  skills
    .command("local-install", { hidden: true })
    .argument("<source-checkout>")
    .option("--custom-target <path>", "Add a custom Agent skill root")
    .addOption(
      new Option(
        "--targets <targets...>",
        "Replace the saved Skill install preference with built-in targets"
      ).choices(BUILT_IN_SKILL_INSTALL_TARGET_KINDS)
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

async function main() {
  try {
    await runCliAsync(Bun.argv.slice(2));
  } catch (cause) {
    reportCliFailure(ThrownValueSchema.parse(cause));
  }
}

if (import.meta.main) {
  void main();
}
