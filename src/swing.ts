import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";

import { MonkeError } from "./errors.ts";
import { getExpectedWorktreePath, resolveRepoContext, validateWorktreeForSession } from "./git.ts";
import { createLogger } from "./logger.ts";
import { spawnSessionFromSourceRootLocked } from "./monke.ts";
import { listSessionStates } from "./registry.ts";
import {
  ensureDirectory,
  findExecutable,
  getMonkeHome,
  hashKey,
  withGlobalLock,
} from "./runtime.ts";
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

interface ResolveStoredTargetOptions {
  createIfMissing?: boolean;
  prepareCreate?: () => void;
}

interface SwingPickerOption {
  rawTarget: string;
  target: SwingHistoryTarget;
  label: string;
  path: string;
  markers: string[];
}

interface PullRequestSwingTarget {
  number: number;
  repo?: {
    owner: string;
    name: string;
  };
}

interface ResolvedPullRequestSession {
  number: number;
  session: string;
}

export interface SwingOptions {
  codex?: boolean;
}

/** Navigate to an existing Source checkout or Session worktree. */
export function runSwing(runtime: Runtime, rawTarget?: string, options: SwingOptions = {}): void {
  if (rawTarget === undefined) {
    throw new MonkeError("Interactive Swing picker requires the async CLI runner");
  }

  const home = getMonkeHome(runtime);
  const context = resolveRepoContext(runtime, runtime.cwd, home, {
    allowExternalSessionWorktree: true,
  });
  const currentTarget = getCurrentSwingTarget(context);
  navigateToSwingTarget(runtime, home, context.sourceRoot, currentTarget, rawTarget, options);
}

/** Navigate with the Clack-backed interactive Swing picker used by the real CLI. */
export async function runSwingInteractive(
  runtime: Runtime,
  rawTarget?: string,
  options: SwingOptions = {},
): Promise<void> {
  const home = getMonkeHome(runtime);
  const context = resolveRepoContext(runtime, runtime.cwd, home, {
    allowExternalSessionWorktree: true,
  });
  const currentTarget = getCurrentSwingTarget(context);
  const selectedTarget =
    rawTarget ?? (await selectSwingTarget(runtime, home, context.sourceRoot, currentTarget));
  navigateToSwingTarget(runtime, home, context.sourceRoot, currentTarget, selectedTarget, options);
}

function navigateToSwingTarget(
  runtime: Runtime,
  home: string,
  rootSourceRoot: string,
  currentTarget: SwingHistoryTarget,
  selectedTarget: string,
  options: SwingOptions,
): void {
  let targetPath = "";

  withGlobalLock(home, () => {
    const resolved = resolveSwingTarget(runtime, home, rootSourceRoot, selectedTarget);
    if (!isSameSwingTarget(resolved.target, currentTarget)) {
      saveSwingHistory(home, rootSourceRoot, {
        version: 1,
        current: resolved.target,
        previous: currentTarget,
      });
    }
    targetPath = resolved.path;
  });

  requestShellDirectory(runtime, targetPath);
  if (options.codex) {
    openCodexThread(runtime, targetPath);
  }
}

function openCodexThread(runtime: Runtime, targetPath: string): void {
  const logger = createLogger(runtime);
  const url = formatCodexNewThreadUrl(targetPath);
  const opener = getUrlOpener(url);
  if (!canRunUrlOpener(runtime, opener.command)) {
    logger.warning(`Could not open Codex thread: ${opener.command} was not found`);
    return;
  }

  const result = runtime.exec(opener.command, opener.args, { allowFailure: true });
  if (result.exitCode !== 0 || result.timedOut) {
    logger.warning(`Could not open Codex thread: ${formatOpenFailure(result)}`);
    return;
  }

  logger.success(`Opened Codex thread for ${targetPath}`);
}

function formatCodexNewThreadUrl(targetPath: string): string {
  return `codex://threads/new?path=${encodeURIComponent(targetPath)}`;
}

function getUrlOpener(url: string): { command: string; args: string[] } {
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }

  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", escapeWindowsCmdUrl(url)] };
  }

  return { command: "xdg-open", args: [url] };
}

function escapeWindowsCmdUrl(url: string): string {
  // cmd expands %NAME% before start sees the URL; preserve percent-encoded paths.
  return url.replaceAll("%", "^%");
}

function canRunUrlOpener(runtime: Runtime, command: string): boolean {
  return process.platform === "win32" && command === "cmd"
    ? true
    : findExecutable(command, runtime.env) !== null;
}

function formatOpenFailure(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}): string {
  if (result.timedOut) {
    return "timed out";
  }

  return result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
}

async function selectSwingTarget(
  runtime: Runtime,
  home: string,
  rootSourceRoot: string,
  currentTarget: SwingHistoryTarget,
): Promise<string> {
  const options = listSwingPickerOptions(home, rootSourceRoot, currentTarget);
  const initialValue = options.find((option) => option.markers.includes("current"))?.rawTarget;
  return runtime.select({
    message: "Swing target",
    initialValue,
    maxItems: Math.min(options.length, 10),
    options: options.map((option) => ({
      value: option.rawTarget,
      label: formatSwingPickerLabel(option),
      hint: option.path,
    })),
  });
}

function listSwingPickerOptions(
  home: string,
  rootSourceRoot: string,
  currentTarget: SwingHistoryTarget,
): SwingPickerOption[] {
  const previousTarget = loadSwingHistory(home, rootSourceRoot).previous;
  const options: SwingPickerOption[] = [];

  if (existsSync(rootSourceRoot)) {
    options.push({
      rawTarget: "^",
      target: { kind: "source" },
      label: "Source checkout",
      path: rootSourceRoot,
      markers: formatTargetMarkers({ kind: "source" }, currentTarget, previousTarget),
    });
  }

  const sessionStates = listSessionStates(home)
    .filter((state) => state.rootSourceRoot === rootSourceRoot)
    .toSorted((left, right) => left.session.localeCompare(right.session));
  const seenSessions = new Set<string>();

  for (const state of sessionStates) {
    if (seenSessions.has(state.session)) {
      continue;
    }
    seenSessions.add(state.session);

    const worktreePath = getExpectedWorktreePath(home, rootSourceRoot, state.session);
    if (!existsSync(worktreePath)) {
      continue;
    }

    const target: SwingHistoryTarget = { kind: "session", session: state.session };
    options.push({
      rawTarget: state.session,
      target,
      label: `Session ${state.session}`,
      path: worktreePath,
      markers: formatTargetMarkers(target, currentTarget, previousTarget),
    });
  }

  if (options.length === 0) {
    throw new MonkeError(`No Swing targets found for ${rootSourceRoot}`);
  }

  return options;
}

function formatSwingPickerLabel(option: SwingPickerOption): string {
  const markers = option.markers.length > 0 ? ` [${option.markers.join(", ")}]` : "";
  return `${option.rawTarget} ${option.label}${markers}`;
}

function formatTargetMarkers(
  target: SwingHistoryTarget,
  currentTarget: SwingHistoryTarget,
  previousTarget: SwingHistoryTarget | undefined,
): string[] {
  const markers: string[] = [];
  if (isSameSwingTarget(target, currentTarget)) {
    markers.push("current");
  }
  if (previousTarget && isSameSwingTarget(target, previousTarget)) {
    markers.push("previous");
  }
  return markers;
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

  if (rawTarget === "@") {
    throw new MonkeError("@ Swing targets are not supported");
  }

  const pullRequestTarget = parsePullRequestTarget(rawTarget);
  if (pullRequestTarget !== null) {
    const pullRequestSession = resolvePullRequestSession(
      runtime,
      rootSourceRoot,
      pullRequestTarget,
    );
    return resolveStoredTarget(
      runtime,
      home,
      rootSourceRoot,
      {
        kind: "session",
        session: pullRequestSession.session,
      },
      {
        createIfMissing: true,
        prepareCreate() {
          ensurePullRequestSessionBranch(
            runtime,
            rootSourceRoot,
            pullRequestSession.number,
            pullRequestSession.session,
          );
        },
      },
    );
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
  options: ResolveStoredTargetOptions = {},
): ResolvedSwingTarget {
  if (target.kind === "source") {
    if (!existsSync(rootSourceRoot)) {
      throw new MonkeError(`Source checkout does not exist at ${rootSourceRoot}`);
    }
    return { target, path: rootSourceRoot };
  }

  const worktreePath = getExpectedWorktreePath(home, rootSourceRoot, target.session);
  if (!existsSync(worktreePath)) {
    if (options.createIfMissing) {
      options.prepareCreate?.();
      spawnSessionFromSourceRootLocked(runtime, home, rootSourceRoot, target.session, {
        mode: "session-branch",
      });
      createLogger(runtime).success(`Spawned or updated session ${target.session}`);
    } else {
      throw new MonkeError(
        `Session "${target.session}" does not exist for ${rootSourceRoot}; mt swing never creates worktrees`,
      );
    }
  }
  validateWorktreeForSession(runtime, home, rootSourceRoot, worktreePath, target.session);
  return { target, path: worktreePath };
}

function resolvePullRequestSession(
  runtime: Runtime,
  rootSourceRoot: string,
  pullRequestTarget: PullRequestSwingTarget,
): ResolvedPullRequestSession {
  const currentRepo = resolveCurrentGithubRepo(runtime, rootSourceRoot);
  if (pullRequestTarget.repo && !isSameGithubRepo(pullRequestTarget.repo, currentRepo)) {
    throw new MonkeError(
      `Cross-repo PR URLs are not supported: target ${pullRequestTarget.repo.owner}/${pullRequestTarget.repo.name} does not match current repo ${currentRepo.owner}/${currentRepo.name}`,
    );
  }

  const pullRequestNumber = pullRequestTarget.number;
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

  if (!isSameGithubRepo({ owner: headOwnerLogin, name: headRepoName }, currentRepo)) {
    throw new MonkeError(
      `Fork PR targets are not supported: PR #${pullRequestNumber} comes from ${headOwnerLogin}/${headRepoName}`,
    );
  }

  return { number: pullRequestNumber, session: headRefName };
}

function ensurePullRequestSessionBranch(
  runtime: Runtime,
  rootSourceRoot: string,
  pullRequestNumber: number,
  session: string,
): void {
  runtime.exec(
    "git",
    ["fetch", "origin", `+pull/${pullRequestNumber}/head:refs/heads/${session}`],
    {
      cwd: rootSourceRoot,
    },
  );
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

function parsePullRequestTarget(rawTarget: string): PullRequestSwingTarget | null {
  const prMatch = rawTarget.match(/^pr:(\d+)$/);
  if (prMatch) {
    return { number: Number.parseInt(prMatch[1]!, 10) };
  }

  try {
    const url = new URL(rawTarget);
    if (url.hostname !== "github.com") {
      return null;
    }
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
    return match
      ? {
          number: Number.parseInt(match[3]!, 10),
          repo: {
            owner: match[1]!,
            name: match[2]!,
          },
        }
      : null;
  } catch {
    return null;
  }
}

function isSameGithubRepo(
  left: { owner: string; name: string },
  right: { owner: string; name: string },
): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase()
  );
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

function isSameSwingTarget(left: SwingHistoryTarget, right: SwingHistoryTarget): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "source") {
    return true;
  }
  return right.kind === "session" && left.session === right.session;
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
