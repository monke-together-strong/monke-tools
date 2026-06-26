#!/usr/bin/env bun
/**
 * agent-session-retrospective — deterministic collect/commit brackets.
 *
 *   bun run-retrospective.ts collect [--since DATE] [--until DATE]
 *                                    [--idle-minutes N] [--run-ts TS]
 *   bun run-retrospective.ts pr-collect --run-ts TS [--repo-cache DIR]
 *   bun run-retrospective.ts pr-aggregate --run-ts TS
 *   bun run-retrospective.ts commit  --run-ts TS [--synthesis FILE]
 *
 * The middle (per-repo and per-PR subagent fan-out) is fuzzy and host-native;
 * everything here is deterministic and bun-testable. The script owns disk I/O.
 */

import path from "node:path";

import { runCollect } from "./lib/collect.ts";
import { runCommit } from "./lib/commit.ts";
import { runPrAggregate, runPrCollect } from "./lib/pr-analysis.ts";
import { retroHome, withRetroLock } from "./lib/store.ts";

interface Flags {
  [key: string]: string | undefined;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = "true";
      }
    }
  }
  return flags;
}

function defaultRunTs(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseDateMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid date: ${value}`);
  }
  return parsed;
}

function parseIdleMinutes(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`Invalid --idle-minutes: ${value}`);
  }
  return minutes;
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const root = retroHome(flags.home);

  if (command === "collect") {
    const runTs = flags["run-ts"] ?? defaultRunTs();
    const result = withRetroLock(root, () =>
      runCollect({
        retroRoot: root,
        runTs,
        sinceMs: parseDateMs(flags.since),
        untilMs: parseDateMs(flags.until),
        idleMinutes: parseIdleMinutes(flags["idle-minutes"]),
      }),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "commit") {
    const runTs = flags["run-ts"];
    if (!runTs) {
      throw new Error("commit requires --run-ts");
    }
    const result = withRetroLock(root, () =>
      runCommit({
        retroRoot: root,
        runTs,
        synthesisPath: flags.synthesis,
        nowIso: new Date().toISOString(),
      }),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "pr-collect") {
    const runTs = flags["run-ts"];
    if (!runTs) {
      throw new Error("pr-collect requires --run-ts");
    }
    const result = withRetroLock(root, () =>
      runPrCollect({
        retroRoot: root,
        runTs,
        repoCacheRoot: flags["repo-cache"] ?? path.join(process.cwd(), "tmp", "agent-retrospective-pr-analysis"),
      }),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "pr-aggregate") {
    const runTs = flags["run-ts"];
    if (!runTs) {
      throw new Error("pr-aggregate requires --run-ts");
    }
    const result = withRetroLock(root, () =>
      runPrAggregate({
        retroRoot: root,
        runTs,
      }),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stderr.write("Usage: run-retrospective.ts <collect|pr-collect|pr-aggregate|commit> [flags]\n");
  process.exit(1);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
