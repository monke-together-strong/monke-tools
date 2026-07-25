import { existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import * as z from "zod";

import { openCodexThread } from "./codex.ts";
import { MonkeError } from "./errors.ts";
import {
  branchExists,
  getExpectedWorktreePath,
  resolveRepoContext,
  validateWorktreeForSession,
} from "./git.ts";
import { createLogger } from "./logger.ts";
import { spawnSessionFromSourceRootLocked } from "./monke.ts";
import { getSessionStateFilePath, listSessionStates } from "./registry.ts";
import { ensureDirectory, getMonkeHome, hashKey, withGlobalLock } from "./runtime.ts";
import { requestShellDirectory } from "./shell.ts";
import type { RepoContext, Runtime } from "./types.ts";
import { parseBoundaryValue, parseOwnedYamlFile } from "./validation.ts";

const SwingHistoryTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("source") }),
  z.strictObject({ kind: z.literal("session"), session: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("external-session"),
    session: z.string().min(1),
    path: z.string().min(1),
  }),
]);

const SwingHistorySchema = z.strictObject({
  version: z.literal(1),
  current: SwingHistoryTargetSchema.optional(),
  previous: SwingHistoryTargetSchema.optional(),
});
const GithubRepositorySchema = z.object({
  nameWithOwner: z.string().min(1),
});
const GithubPullRequestSchema = z.object({
  headRefName: z.string().min(1),
  headRepository: z.object({ name: z.string().min(1) }),
  headRepositoryOwner: z.object({ login: z.string().min(1) }),
});

type SwingHistoryTarget = z.output<typeof SwingHistoryTargetSchema>;
type SwingHistory = z.output<typeof SwingHistorySchema>;

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
  const currentTarget = getCurrentSwingTarget(home, context);
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
  const currentTarget = getCurrentSwingTarget(home, context);
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
  let moved = false;
  let targetPath = "";

  withGlobalLock(home, () => {
    const resolved = resolveSwingTarget(runtime, home, rootSourceRoot, selectedTarget);
    moved = !isSameSwingTarget(resolved.target, currentTarget);
    if (moved) {
      saveSwingHistory(home, rootSourceRoot, {
        version: 1,
        current: resolved.target,
        previous: currentTarget,
      });
    }
    targetPath = resolved.path;
  });

  if (moved) {
    createLogger(runtime).info(`Moved Swing target to ${targetPath}`);
  }
  requestShellDirectory(runtime, targetPath);
  if (options.codex) {
    openCodexThread(runtime, targetPath);
  }
}

async function selectSwingTarget(
  runtime: Runtime,
  home: string,
  rootSourceRoot: string,
  currentTarget: SwingHistoryTarget,
): Promise<string> {
  const options = listSwingPickerOptions(runtime, home, rootSourceRoot, currentTarget);
  const initialValue = options.find((option) => option.markers.includes("current"))?.rawTarget;
  return runtime.select({
    message: "Swing target",
    initialValue,
    maxItems: Math.min(options.length, 10),
    options: options.map((option) => ({
      value: option.rawTarget,
      label: formatSwingPickerLabel(option),
    })),
  });
}

function listSwingPickerOptions(
  runtime: Runtime,
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
      markers: formatTargetMarkers({ kind: "source" }, currentTarget, previousTarget),
    });
  }

  const branchCommitTimes = listBranchCommitTimes(runtime, rootSourceRoot);
  const sessionStates = listSessionStates(home)
    .filter((state) => state.rootSourceRoot === rootSourceRoot)
    .map((state) => ({
      state,
      updatedAt: Math.max(
        branchCommitTimes.get(state.session) ?? 0,
        statSync(getSessionStateFilePath(home, rootSourceRoot, state.session)).mtimeMs,
      ),
    }))
    .toSorted(
      (left, right) =>
        right.updatedAt - left.updatedAt || left.state.session.localeCompare(right.state.session),
    );
  const seenSessions = new Set<string>();

  for (const { state } of sessionStates) {
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
      markers: formatTargetMarkers(target, currentTarget, previousTarget),
    });
  }

  if (options.length === 0) {
    throw new MonkeError(`No Swing targets found for ${rootSourceRoot}`);
  }

  return options;
}

function listBranchCommitTimes(runtime: Runtime, rootSourceRoot: string): Map<string, number> {
  const result = runtime.exec(
    "git",
    ["for-each-ref", "--format=%(refname:lstrip=2)\t%(committerdate:unix)", "refs/heads"],
    { cwd: rootSourceRoot, allowFailure: true },
  );
  if (result.exitCode !== 0) {
    return new Map();
  }

  return new Map(
    result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [branch, seconds] = line.split("\t");
        return [branch!, Number(seconds) * 1000];
      }),
  );
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
    ensurePullRequestSessionBranch(
      runtime,
      rootSourceRoot,
      pullRequestSession.number,
      pullRequestSession.session,
      { createIfMissing: false },
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
            { createIfMissing: true },
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

  if (target.kind === "external-session") {
    validateExternalSessionTarget(runtime, rootSourceRoot, target);
    return { target, path: target.path };
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
        `Session "${target.session}" does not exist for ${rootSourceRoot}; mt swing only creates Session worktrees for pull request targets -- run mt spawn ${target.session} instead.`,
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
  const pullRequest = parseGithubJson(
    output,
    `GitHub PR #${pullRequestNumber}`,
    GithubPullRequestSchema,
  );
  const headRefName = pullRequest.headRefName;
  const headRepoName = pullRequest.headRepository.name;
  const headOwnerLogin = pullRequest.headRepositoryOwner.login;

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
  options: { createIfMissing: boolean },
): void {
  const temporaryRef = `refs/monke/pr-heads/${pullRequestNumber}`;
  try {
    runtime.exec("git", ["fetch", "origin", `+pull/${pullRequestNumber}/head:${temporaryRef}`], {
      cwd: rootSourceRoot,
    });
    const pullRequestHead = runtime
      .exec("git", ["rev-parse", temporaryRef], {
        cwd: rootSourceRoot,
      })
      .stdout.trim();

    if (branchExists(runtime, rootSourceRoot, session)) {
      const localHead = runtime
        .exec("git", ["rev-parse", `refs/heads/${session}`], {
          cwd: rootSourceRoot,
        })
        .stdout.trim();
      if (localHead !== pullRequestHead) {
        throw new MonkeError(
          `Local branch "${session}" differs from PR #${pullRequestNumber} head; update or rename it before swinging to this PR target.`,
        );
      }
      return;
    }

    if (options.createIfMissing) {
      runtime.exec("git", ["branch", session, temporaryRef], { cwd: rootSourceRoot });
    }
  } finally {
    runtime.exec("git", ["update-ref", "-d", temporaryRef], {
      cwd: rootSourceRoot,
      allowFailure: true,
    });
  }
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
    ? parseGithubJson(trimmed, "GitHub repo", GithubRepositorySchema).nameWithOwner
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

function getCurrentSwingTarget(home: string, context: RepoContext): SwingHistoryTarget {
  if (context.isSourceCheckout) {
    return { kind: "source" };
  }

  if (!context.sessionName) {
    throw new MonkeError("Unable to infer the current Session for Previous Swing target history");
  }

  const expectedPath = getExpectedWorktreePath(home, context.sourceRoot, context.sessionName);
  return path.normalize(context.worktreeRoot) === path.normalize(expectedPath)
    ? {
        kind: "session",
        session: context.sessionName,
      }
    : {
        kind: "external-session",
        session: context.sessionName,
        path: context.worktreeRoot,
      };
}

function isSameSwingTarget(left: SwingHistoryTarget, right: SwingHistoryTarget): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "source") {
    return true;
  }
  if (left.kind === "session") {
    return right.kind === "session" && left.session === right.session;
  }
  return (
    right.kind === "external-session" &&
    left.session === right.session &&
    path.normalize(left.path) === path.normalize(right.path)
  );
}

function validateExternalSessionTarget(
  runtime: Runtime,
  rootSourceRoot: string,
  target: Extract<SwingHistoryTarget, { kind: "external-session" }>,
): void {
  if (!existsSync(target.path)) {
    throw new MonkeError(`External Session worktree does not exist at ${target.path}`);
  }

  const context = resolveRepoContext(runtime, target.path, null, { inferSessionName: false });
  if (context.isSourceCheckout) {
    throw new MonkeError(`Expected ${target.path} to be a linked session worktree`);
  }
  if (path.normalize(context.sourceRoot) !== path.normalize(rootSourceRoot)) {
    throw new MonkeError(
      `Expected worktree ${target.path} to belong to ${rootSourceRoot}, found ${context.sourceRoot}`,
    );
  }
  if (context.currentBranch !== target.session) {
    throw new MonkeError(
      `Expected worktree ${target.path} to be on branch ${target.session}, found ${context.currentBranch}`,
    );
  }
}

function loadSwingHistory(home: string, rootSourceRoot: string): SwingHistory {
  const filePath = getSwingHistoryFilePath(home, rootSourceRoot);
  if (!existsSync(filePath)) {
    return { version: 1 };
  }

  return parseOwnedYamlFile(filePath, SwingHistorySchema);
}

function saveSwingHistory(home: string, rootSourceRoot: string, history: SwingHistory): void {
  const filePath = getSwingHistoryFilePath(home, rootSourceRoot);
  const parsed = parseBoundaryValue(SwingHistorySchema, history, filePath);
  ensureDirectory(path.dirname(filePath));
  writeFileSync(filePath, stringify(parsed), "utf8");
}

function getSwingHistoryFilePath(home: string, rootSourceRoot: string): string {
  return path.join(home, "swing-history", `${hashKey(rootSourceRoot)}.yml`);
}

function parseGithubJson<T extends z.ZodType>(
  output: string,
  label: string,
  schema: T,
): z.output<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new MonkeError(`Invalid ${label}: expected JSON output`);
  }
  return parseBoundaryValue(schema, parsed, label);
}
