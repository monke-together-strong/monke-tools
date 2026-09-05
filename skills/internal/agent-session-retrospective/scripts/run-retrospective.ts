#!/usr/bin/env bun
import path from "node:path";

import { Command, CommanderError, InvalidArgumentError } from "@commander-js/extra-typings";

import { runCollect } from "./lib/collect.ts";
import { runCommit } from "./lib/commit.ts";
import { runPrAggregate, runPrCollect } from "./lib/pr-analysis.ts";
import { retroHome, withRetroLock } from "./lib/store.ts";

type OperationResult = ReturnType<
  typeof runCollect | typeof runPrCollect | typeof runPrAggregate | typeof runCommit
>;

function parseDateMs(value: string) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new InvalidArgumentError(`Invalid date: ${value}`);
  }
  return parsed;
}

function parseIdleMinutes(value: string) {
  const minutes = Number(value);
  if (value.trim() === "" || !Number.isFinite(minutes) || minutes < 0) {
    throw new InvalidArgumentError("must be a nonnegative number of minutes");
  }
  return minutes;
}

function main() {
  const program = new Command()
    .name("run-retrospective")
    .description("Collect and commit agent transcript and PR analysis")
    .option("--home <directory>", "Monke home directory")
    .allowExcessArguments(false)
    .exitOverride()
    .showHelpAfterError();

  function runOperation(operation: (root: string) => OperationResult) {
    const root = retroHome(program.opts().home);
    const result = withRetroLock(root, () => operation(root));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }

  program
    .command("collect")
    .description("Collect eligible transcripts into repo bundles")
    .option("--since <date>", "Beginning of the retrospective window", parseDateMs)
    .option("--until <date>", "End of the retrospective window", parseDateMs)
    .option("--idle-minutes <minutes>", "Minimum transcript idle time", parseIdleMinutes)
    .option("--run-ts <timestamp>", "Run identifier")
    .action((options) => {
      runOperation((root) =>
        runCollect({
          idleMinutes: options.idleMinutes,
          retroRoot: root,
          runTs: options.runTs ?? new Date().toISOString().replaceAll(/[:.]/gu, "-"),
          sinceMs: options.since,
          untilMs: options.until
        })
      );
    });

  program
    .command("pr-collect")
    .description("Collect PR evidence for a transcript run")
    .requiredOption("--run-ts <timestamp>", "Run identifier")
    .option("--repo-cache <directory>", "Directory for source clones")
    .action((options) => {
      runOperation((root) =>
        runPrCollect({
          repoCacheRoot:
            options.repoCache ?? path.join(root, "tmp", "agent-retrospective-pr-analysis"),
          retroRoot: root,
          runTs: options.runTs
        })
      );
    });

  program
    .command("pr-aggregate")
    .description("Aggregate completed PR analyses")
    .requiredOption("--run-ts <timestamp>", "Run identifier")
    .action((options) => {
      runOperation((root) => runPrAggregate({ retroRoot: root, runTs: options.runTs }));
    });

  program
    .command("commit")
    .description("Validate completed analysis and freeze its report")
    .requiredOption("--run-ts <timestamp>", "Run identifier")
    .requiredOption("--synthesis <file>", "Completed synthesis Markdown")
    .action((options) => {
      runOperation((root) =>
        runCommit({
          nowIso: new Date().toISOString(),
          retroRoot: root,
          runTs: options.runTs,
          synthesisPath: options.synthesis
        })
      );
    });

  program.parse();
}

try {
  main();
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode;
  } else {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
