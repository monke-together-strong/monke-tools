#!/usr/bin/env bun
import { reportCliFailure } from "../src/cli-errors.ts";
import { ThrownValueSchema } from "../src/errors.ts";
import { restoreSkillImports } from "./skill-lock.ts";

if (import.meta.main) {
  try {
    await restoreSkillImports(process.cwd());
  } catch (error) {
    reportCliFailure(ThrownValueSchema.parse(error));
  }
}
