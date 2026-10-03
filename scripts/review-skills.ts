#!/usr/bin/env bun
import { Command } from "@commander-js/extra-typings";

import { configureCliParser, reportCliFailure } from "../src/cli-errors.ts";
import { ThrownValueSchema } from "../src/errors.ts";
import { clearSkillReviews, reviewSkillRevisions } from "./skill-review.ts";

export async function runReviewSkills(argv = process.argv.slice(2)) {
  const program = new Command().name("bun run skills:review");
  program
    .command("clear")
    .description("Clear saved complete skill reviews")
    .action(async () => {
      await clearSkillReviews();
    });
  program
    .argument("<base>")
    .argument("[head]", "Candidate source revision", "HEAD")
    .option("--adapter <adapter>", "codiff or lfv")
    .action(async (base, head, options) => {
      await reviewSkillRevisions(base, head, options);
    });
  configureCliParser(program);
  await program.parseAsync(argv, { from: "user" });
}

if (import.meta.main) {
  try {
    await runReviewSkills();
  } catch (error) {
    reportCliFailure(ThrownValueSchema.parse(error));
  }
}
