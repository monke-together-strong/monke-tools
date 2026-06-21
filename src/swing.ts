import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";

import { MonkeError } from "./errors.ts";
import { getExpectedWorktreePath, resolveRepoContext, validateWorktreeForSession } from "./git.ts";
import { ensureDirectory, getMonkeHome, hashKey, withGlobalLock } from "./runtime.ts";
import { requestShellDirectory } from "./shell.ts";
import type { RepoContext, Runtime } from "./types.ts";

type SwingHistoryTarget =
  | {
      kind: "source";
    }
  | {
      kind: "session";
      session: string;
    };

interface SwingHistory {
  version: 1;
  current?: SwingHistoryTarget;
  previous?: SwingHistoryTarget;
}

interface ResolvedSwingTarget {
  target: SwingHistoryTarget;
  path: string;
}

/** Navigate to an existing Source checkout or Session worktree. */
export function runSwing(runtime: Runtime, rawTarget: string): void {
  const home = getMonkeHome(runtime);
  const context = resolveRepoContext(runtime, runtime.cwd, home);
  const currentTarget = getCurrentSwingTarget(context);
  let targetPath = "";

  withGlobalLock(home, () => {
    const resolved = resolveSwingTarget(runtime, home, context.sourceRoot, rawTarget);
    saveSwingHistory(home, context.sourceRoot, {
      version: 1,
      current: resolved.target,
      previous: currentTarget,
    });
    targetPath = resolved.path;
  });

  requestShellDirectory(runtime, targetPath);
}

function resolveSwingTarget(
  runtime: Runtime,
  home: string,
  rootSourceRoot: string,
  rawTarget: string,
): ResolvedSwingTarget {
  if (rawTarget === "^") {
    return resolveStoredTarget(runtime, home, rootSourceRoot, { kind: "source" });
  }

  if (rawTarget === "-") {
    const previous = loadSwingHistory(home, rootSourceRoot).previous;
    if (!previous) {
      throw new MonkeError(`No Previous Swing target recorded for ${rootSourceRoot}`);
    }
    return resolveStoredTarget(runtime, home, rootSourceRoot, previous);
  }

  if (rawTarget.startsWith("mr:")) {
    throw new MonkeError("Merge request Swing targets are out of scope");
  }

  if (rawTarget.includes("@")) {
    throw new MonkeError("@ Swing targets are not supported");
  }

  const pullRequestNumber = parsePullRequestTarget(rawTarget);
  if (pullRequestNumber !== null) {
    return resolveStoredTarget(runtime, home, rootSourceRoot, {
      kind: "session",
      session: resolvePullRequestSession(runtime, rootSourceRoot, pullRequestNumber),
    });
  }

  return resolveStoredTarget(runtime, home, rootSourceRoot, {
    kind: "session",
    session: rawTarget,
  });
}

function resolveStoredTarget(
  runtime: Runtime,
  home: string,
  rootSourceRoot: string,
  target: SwingHistoryTarget,
): ResolvedSwingTarget {
  if (target.kind === "source") {
    if (!existsSync(rootSourceRoot)) {
      throw new MonkeError(`Source checkout does not exist at ${rootSourceRoot}`);
    }
    return { target, path: rootSourceRoot };
  }

  const worktreePath = getExpectedWorktreePath(home, rootSourceRoot, target.session);
  if (!existsSync(worktreePath)) {
    throw new MonkeError(
      `Session "${target.session}" does not exist for ${rootSourceRoot}; mt swing never creates worktrees`,
    );
  }
  validateWorktreeForSession(runtime, home, rootSourceRoot, worktreePath, target.session);
  return { target, path: worktreePath };
}

function resolvePullRequestSession(
  runtime: Runtime,
  rootSourceRoot: string,
  pullRequestNumber: number,
): string {
  const currentRepo = resolveCurrentGithubRepo(runtime, rootSourceRoot);
  const output = runtime.exec(
    "gh",
    [
      "pr",
      "view",
      String(pullRequestNumber),
      "--json",
      "headRefName,headRepository,headRepositoryOwner",
    ],
    { cwd: rootSourceRoot },
  ).stdout;
  const pullRequest = parseJsonObject(output, `GitHub PR #${pullRequestNumber}`);
  const headRefName = requireStringField(
    pullRequest,
    "headRefName",
    `GitHub PR #${pullRequestNumber}`,
  );
  const headRepository = requireRecordField(
    pullRequest,
    "headRepository",
    `GitHub PR #${pullRequestNumber}`,
  );
  const headRepositoryOwner = requireRecordField(
    pullRequest,
    "headRepositoryOwner",
    `GitHub PR #${pullRequestNumber}`,
  );
  const headRepoName = requireStringField(
    headRepository,
    "name",
    `GitHub PR #${pullRequestNumber} headRepository`,
  );
  const headOwnerLogin = requireStringField(
    headRepositoryOwner,
    "login",
    `GitHub PR #${pullRequestNumber} headRepositoryOwner`,
  );

  if (headOwnerLogin !== currentRepo.owner || headRepoName !== currentRepo.name) {
    throw new MonkeError(
      `Fork PR targets are not supported: PR #${pullRequestNumber} comes from ${headOwnerLogin}/${headRepoName}`,
    );
  }

  return headRefName;
}

function resolveCurrentGithubRepo(
  runtime: Runtime,
  rootSourceRoot: string,
): { owner: string; name: string } {
  const output = runtime.exec("gh", ["repo", "view", "--json", "nameWithOwner"], {
    cwd: rootSourceRoot,
  }).stdout;
  const trimmed = output.trim();
  const nameWithOwner = trimmed.startsWith("{")
    ? requireStringField(parseJsonObject(trimmed, "GitHub repo"), "nameWithOwner", "GitHub repo")
    : trimmed;
  const [owner, name] = nameWithOwner.split("/");

  if (!owner || !name) {
    throw new MonkeError(`Could not resolve current GitHub repo from gh output: ${trimmed}`);
  }

  return { owner, name };
}

function parsePullRequestTarget(rawTarget: string): number | null {
  const prMatch = rawTarget.match(/^pr:(\d+)$/);
  if (prMatch) {
    return Number.parseInt(prMatch[1]!, 10);
  }

  try {
    const url = new URL(rawTarget);
    if (url.hostname !== "github.com") {
      return null;
    }
    const match = url.pathname.match(/^\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/);
    return match ? Number.parseInt(match[1]!, 10) : null;
  } catch {
    return null;
  }
}

function getCurrentSwingTarget(context: RepoContext): SwingHistoryTarget {
  if (context.isSourceCheckout) {
    return { kind: "source" };
  }

  if (!context.sessionName) {
    throw new MonkeError("Unable to infer the current Session for Previous Swing target history");
  }

  return {
    kind: "session",
    session: context.sessionName,
  };
}

function loadSwingHistory(home: string, rootSourceRoot: string): SwingHistory {
  const filePath = getSwingHistoryFilePath(home, rootSourceRoot);
  if (!existsSync(filePath)) {
    return { version: 1 };
  }

  return parse(readFileSync(filePath, "utf8")) as SwingHistory;
}

function saveSwingHistory(home: string, rootSourceRoot: string, history: SwingHistory): void {
  const filePath = getSwingHistoryFilePath(home, rootSourceRoot);
  ensureDirectory(path.dirname(filePath));
  writeFileSync(filePath, stringify(history), "utf8");
}

function getSwingHistoryFilePath(home: string, rootSourceRoot: string): string {
  return path.join(home, "swing-history", `${hashKey(rootSourceRoot)}.yml`);
}

function parseJsonObject(output: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(output) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MonkeError(`Expected ${label} to be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function requireRecordField(
  value: Record<string, unknown>,
  field: string,
  label: string,
): Record<string, unknown> {
  const fieldValue = value[field];
  if (!fieldValue || typeof fieldValue !== "object" || Array.isArray(fieldValue)) {
    throw new MonkeError(`Expected ${label}.${field} to be a JSON object`);
  }
  return fieldValue as Record<string, unknown>;
}

function requireStringField(value: Record<string, unknown>, field: string, label: string): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string" || fieldValue.length === 0) {
    throw new MonkeError(`Expected ${label}.${field} to be a non-empty string`);
  }
  return fieldValue;
}
