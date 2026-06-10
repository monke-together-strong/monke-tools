#!/usr/bin/env bun

import { Command, CommanderError, Option } from "commander";

import { MonkeError } from "./errors.ts";
import {
  runCleanup,
  runCreate,
  runInstallDependencies,
  runMaterialize,
  runSetup,
} from "./monke.ts";
import {
  CODEX_REASONING_EFFORTS,
  runPrdIssueWorkflow,
  runSinglePassWorkflow,
  type CodexReasoningEffort,
} from "./run.ts";
import { createRuntime } from "./runtime.ts";
import { runLocalInstallSkills, runSkillsConfigure } from "./skills.ts";
import type { Runtime } from "./types.ts";

const ROOT_USAGE =
  "Usage:\n  mt create <session>\n  mt materialize\n  mt cleanup\n  mt setup\n  mt skills configure\n  mt work (<text> | --plan <text> | --prd <text>) [--effort <level>]";
const RUN_USAGE = "Usage: mt work (<text> | --plan <text> | --prd <text>) [--effort <level>]";
const SKILLS_USAGE = "Usage: mt skills configure";

type RunCommandOptions =
  | {
      kind: "plan";
      plan: string;
      effort?: CodexReasoningEffort;
    }
  | {
      kind: "prd";
      prd: string;
      effort?: CodexReasoningEffort;
    };

interface RawRunCommandOptions {
  plan?: string;
  prd?: string;
  effort?: CodexReasoningEffort;
}

/** Run the Monke Tools CLI. Valid `mt work` invocations return a workflow promise. */
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
    if (pendingRun.options.kind === "plan") {
      return runSinglePassWorkflow(runtime, pendingRun.options.plan, {
        effort: pendingRun.options.effort,
      });
    }

    return runPrdIssueWorkflow(runtime, pendingRun.options.prd, {
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

  program
    .command("work")
    .helpOption(false)
    .allowExcessArguments(false)
    .argument("[plan...]")
    .option("--plan <text>")
    .option("--prd <text>")
    .addOption(new Option("--effort <level>").choices([...CODEX_REASONING_EFFORTS]))
    .action((planParts: string[], options: RawRunCommandOptions) => {
      onRun(parseRunCommandOptions(planParts, options));
    });

  return program;
}

function parseRunCommandOptions(
  planParts: readonly string[],
  options: RawRunCommandOptions,
): RunCommandOptions {
  const positionalPlan = planParts.length > 0 ? planParts.join(" ") : undefined;

  if (positionalPlan !== undefined && options.plan === undefined && options.prd === undefined) {
    return {
      kind: "plan",
      plan: positionalPlan,
      effort: options.effort,
    };
  }

  if (options.plan !== undefined && options.prd === undefined && positionalPlan === undefined) {
    return {
      kind: "plan",
      plan: options.plan,
      effort: options.effort,
    };
  }

  if (options.prd !== undefined && options.plan === undefined && positionalPlan === undefined) {
    return {
      kind: "prd",
      prd: options.prd,
      effort: options.effort,
    };
  }

  throw new MonkeError(RUN_USAGE);
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
    case "install-dependencies":
      return new MonkeError("Usage: mt install-dependencies");
    case "skills":
      return new MonkeError(SKILLS_USAGE);
    case "work":
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
