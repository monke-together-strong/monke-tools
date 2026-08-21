#!/usr/bin/env bun

import { runReleaseBundleCli } from "../src/release-bundle.ts";

try {
  runReleaseBundleCli(Bun.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
