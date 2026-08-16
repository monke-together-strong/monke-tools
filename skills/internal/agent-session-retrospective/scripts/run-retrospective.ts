#!/usr/bin/env bun
/**
 * agent-session-retrospective — deterministic collect/commit brackets.
 *
 *   bun run-retrospective.ts collect [--since DATE] [--until DATE]
 *                                    [--idle-minutes N] [--run-ts TS]
 *   bun run-retrospective.ts pr-collect --run-ts TS [--repo-cache DIR]
 *   bun run-retrospective.ts pr-aggregate --run-ts TS
 *   bun run-retrospective.ts commit  --run-ts TS --synthesis FILE
 *
 * The middle (per-repo and per-PR subagent fan-out) is fuzzy and host-native;
 * everything here is deterministic and bun-testable. The script owns disk I/O.
 */

import path from "node:path";

import { runCollect } from "./lib/collect.ts";
import { runCommit } from "./lib/commit.ts";
import { runPrAggregate, runPrCollect } from "./lib/pr-analysis.ts";
import { retroHome, withRetroLock } from "./lib/store.ts";

class RetrospectiveCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetrospectiveCliError";
  }
}

function parseFlags(argv: string[]) {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token?.startsWith("--") === true) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && next !== "" && !next.startsWith("--")) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, "true");
      }
    }
  }
  return flags;
}

function defaultRunTs() {
  return new Date().toISOString().replaceAll(/[:.]/gu, "-");
}

function parseDateMs(value: string | undefined) {
  if (value === undefined || value === "") {
    return;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new RetrospectiveCliError(`Invalid date: ${value}`);
  }
  return parsed;
}

function parseIdleMinutes(value: string | undefined) {
  if (value === undefined) {
    return;
  }
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new RetrospectiveCliError(`Invalid --idle-minutes: ${value}`);
  }
  return minutes;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const root = retroHome(flags.get("home"));

  if (command === "collect") {
    const runTs = flags.get("run-ts") ?? defaultRunTs();
    const result = withRetroLock(root, () =>
      runCollect({
        idleMinutes: parseIdleMinutes(flags.get("idle-minutes")),
        retroRoot: root,
        runTs,
        sinceMs: parseDateMs(flags.get("since")),
        untilMs: parseDateMs(flags.get("until")),
      }),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "commit") {
    const runTs = flags.get("run-ts");
    if (runTs === undefined || runTs === "") {
      throw new RetrospectiveCliError("commit requires --run-ts");
    }
    const result = withRetroLock(root, () =>
      runCommit({
        nowIso: new Date().toISOString(),
        retroRoot: root,
        runTs,
        synthesisPath: flags.get("synthesis"),
      }),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "pr-collect") {
    const runTs = flags.get("run-ts");
    if (runTs === undefined || runTs === "") {
      throw new RetrospectiveCliError("pr-collect requires --run-ts");
    }
    const result = withRetroLock(root, () =>
      runPrCollect({
        repoCacheRoot:
          flags.get("repo-cache") ?? path.join(root, "tmp", "agent-retrospective-pr-analysis"),
        retroRoot: root,
        runTs,
      }),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "pr-aggregate") {
    const runTs = flags.get("run-ts");
    if (runTs === undefined || runTs === "") {
      throw new RetrospectiveCliError("pr-aggregate requires --run-ts");
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
  const message =
    error instanceof RetrospectiveCliError
      ? error.message
      : error instanceof Error
        ? (error.stack ?? `${error.name}: ${error.message}`)
        : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
