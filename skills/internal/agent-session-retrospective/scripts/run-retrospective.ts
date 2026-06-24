#!/usr/bin/env bun
/**
 * agent-session-retrospective — deterministic collect/commit brackets.
 *
 *   bun run-retrospective.ts collect [--since DATE] [--until DATE]
 *                                    [--idle-minutes N] [--run-ts TS]
 *   bun run-retrospective.ts commit  --run-ts TS [--synthesis FILE]
 *
 * The middle (per-repo subagent fan-out) is fuzzy and host-native; everything
 * here is deterministic and bun-testable. The script owns all disk I/O.
 */

import { runCollect } from "./lib/collect.ts";
import { runCommit } from "./lib/commit.ts";
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
        idleMinutes: flags["idle-minutes"] ? Number(flags["idle-minutes"]) : undefined,
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

  process.stderr.write("Usage: run-retrospective.ts <collect|commit> [flags]\n");
  process.exit(1);
}

main();
