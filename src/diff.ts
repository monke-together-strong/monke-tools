import path from "node:path";

import { launchCodiff, verifyCodiffAsync, verifyCodiffRangeSupport } from "./codiff.ts";
import {
  findInitialDefaultBranchBase,
  findNewerDefaultBranchBase,
  hasWorkingTreeChanges,
  isDefaultBranchCheckout,
  isReviewUrl,
  listDefaultBranchRefs,
  planBranchComparison,
  planWorkingTreeComparison
} from "./comparison-plan.ts";
import type { ComparisonPlan } from "./comparison-plan.ts";
import { MonkeError } from "./errors.ts";
import { describeSessionBranchMismatch, resolveRepoContext } from "./git.ts";
import { loadGlobalMonkeConfig, saveGlobalMonkeConfig } from "./global-config.ts";
import { launchLfv, resolveLfv } from "./lfv.ts";
import { samePath } from "./path-identity.ts";
import { getMonkeHome, withGlobalLock } from "./runtime.ts";
import { listSessionStates, loadSessionState, saveSessionState } from "./session-state-store.ts";
import type { RepoContext, Runtime } from "./types.ts";
import {
  listLocalWorktreeTargets,
  resolveLocalWorktreeTarget,
  resolveLocalWorktreeTargetBase
} from "./worktree-targets.ts";
import type { LocalWorktreeTarget } from "./worktree-targets.ts";

export interface DiffOptions {
  adapter?: string;
  branch?: string;
  commit?: string;
  path?: string;
  pick?: boolean;
  targets?: string[];
  workingTree?: boolean;
}

function requireDiffAdapter(adapter: string) {
  if (adapter !== "codiff" && adapter !== "lfv") {
    throw new MonkeError(
      `Unsupported Diff adapter: ${adapter}. This build supports codiff and lfv.`
    );
  }
  return adapter;
}

type DiffPresenter = (plan: ComparisonPlan) => Promise<void>;

async function prepareDiffPresenter(
  runtime: Runtime,
  adapter: "codiff" | "lfv"
): Promise<DiffPresenter> {
  if (adapter === "lfv") {
    const executable = resolveLfv(runtime);
    return (plan) => launchLfv(runtime, executable, plan);
  }
  const executable = await verifyCodiffAsync(runtime);
  return async (plan) => {
    if (plan.kind === "range") {
      await verifyCodiffRangeSupport(runtime, executable);
    }
    launchCodiff(runtime, executable, plan);
  };
}

export async function runDiffConfigure(runtime: Runtime, options: { adapter?: string }) {
  const adapter = requireDiffAdapter(
    options.adapter ??
      (await runtime.select({
        message: "Diff adapter",
        options: [
          { label: "Codiff desktop", value: "codiff" },
          { label: "LFV review link", value: "lfv" }
        ]
      }))
  );
  const home = getMonkeHome(runtime);
  withGlobalLock(home, () => {
    saveGlobalMonkeConfig(home, { ...loadGlobalMonkeConfig(home), diffAdapter: adapter });
  });
  runtime.writeStdout(`Diff adapter: ${adapter}\n`);
}

interface DiffChoice {
  baseRef?: string;
  label: string;
  target?: LocalWorktreeTarget;
  value: string;
}

interface RememberedDiff {
  baseRef?: string;
  context: RepoContext;
  getTargets: (refresh?: boolean) => LocalWorktreeTarget[];
  owner?: { rootSourceRoot: string; session: string };
}

/** Prepare delivery alongside repo discovery, then discover picker targets only when needed. */
export async function runDiffInteractive(runtime: Runtime, options: DiffOptions = {}) {
  const adapter = requireDiffAdapter(
    options.adapter ?? loadGlobalMonkeConfig(getMonkeHome(runtime)).diffAdapter ?? "codiff"
  );
  const selectors =
    Number(options.workingTree === true) +
    Number(options.commit !== undefined) +
    Number(options.branch !== undefined) +
    Number((options.targets?.length ?? 0) > 0);
  if (selectors > 1 || (selectors > 0 && options.pick)) {
    throw new MonkeError(
      "Choose exactly one Diff source; --pick cannot be combined with an explicit source."
    );
  }
  const selectedRuntime =
    options.path === undefined
      ? runtime
      : { ...runtime, cwd: path.resolve(runtime.cwd, options.path) };
  if (selectors > 0) {
    const context = resolveRepoContext(selectedRuntime, selectedRuntime.cwd, null, {
      inferSessionName: false
    });
    const plan = resolveExplicitComparison(selectedRuntime, context, options);
    const present = await prepareDiffPresenter(selectedRuntime, adapter);
    await present(plan);
    return;
  }
  const [present, remembered] = await Promise.all([
    prepareDiffPresenter(selectedRuntime, adapter),
    Promise.try(() => resolveRememberedDiff(selectedRuntime))
  ]);
  warnSessionBranchElsewhere(selectedRuntime, remembered);
  if (await launchAutomaticDiff(selectedRuntime, present, remembered, options)) {
    return;
  }
  await selectAndLaunchDiff(selectedRuntime, present, remembered, options);
}

function isValidRevision(runtime: Runtime, context: RepoContext, ref: string) {
  return (
    Boolean(ref) &&
    !ref.startsWith("-") &&
    runtime.exec(
      "git",
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
      { allowFailure: true, cwd: context.worktreeRoot }
    ).exitCode === 0
  );
}

function validateRevision(runtime: Runtime, context: RepoContext, ref: string) {
  if (!isValidRevision(runtime, context, ref)) {
    throw new MonkeError(`Invalid Diff revision: ${ref}`);
  }
}

function resolveExplicitComparison(
  runtime: Runtime,
  context: RepoContext,
  options: DiffOptions
): ComparisonPlan {
  const worktreePath = context.worktreeRoot;
  if (options.workingTree) {
    return { kind: "working-tree", worktreePath };
  }
  if (options.commit !== undefined) {
    validateRevision(runtime, context, options.commit);
    return { kind: "commit", ref: options.commit, worktreePath };
  }
  if (options.branch !== undefined) {
    validateRevision(runtime, context, options.branch);
    const plan = planBranchComparison(runtime, context, options.branch);
    if (!plan) {
      throw new MonkeError(`Diff branch ${options.branch} has no merge base with HEAD.`);
    }
    return plan;
  }
  const targets = options.targets ?? [];
  const [target = "", providerValue] = targets;
  if ((target === "pr" || target === "mr") && targets.length === 2) {
    validateProviderTarget(runtime, context, target, providerValue);
    return { kind: "pull-request", target: targets, worktreePath };
  }
  if (targets.length !== 1) {
    throw new MonkeError("Expected one Diff ref, range, review URL, or pr/mr selector.");
  }
  if (/^#[1-9]\d*$/u.test(target) || isReviewUrl(target)) {
    return { kind: "pull-request", target: [target], worktreePath };
  }
  if (target.includes("..")) {
    if (isValidRevision(runtime, context, target)) {
      return { kind: "commit", ref: target, worktreePath };
    }
    return resolveRangeComparison(runtime, context, target);
  }
  validateRevision(runtime, context, target);
  if (/^(?:HEAD|@)(?:$|[~^@])|[\^~]|@\{/u.test(target)) {
    return { kind: "commit", ref: target, worktreePath };
  }
  const branch =
    runtime.exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${target}`], {
      allowFailure: true,
      cwd: worktreePath
    }).exitCode === 0 ||
    runtime.exec("git", ["show-ref", "--verify", "--quiet", `refs/remotes/${target}`], {
      allowFailure: true,
      cwd: worktreePath
    }).exitCode === 0;
  return resolveExplicitComparison(
    runtime,
    context,
    branch ? { branch: target } : { commit: target }
  );
}

function validateProviderTarget(
  runtime: Runtime,
  context: RepoContext,
  provider: string,
  value: string | undefined
) {
  const positiveNumber = /^#?[1-9]\d*$/u;
  if (
    !value ||
    value.startsWith("-") ||
    (!positiveNumber.test(value) &&
      (provider !== "pr" ||
        /^#?\d+$/u.test(value) ||
        runtime.exec("git", ["check-ref-format", "--branch", value.replace(":", "/")], {
          allowFailure: true,
          cwd: context.worktreeRoot
        }).exitCode !== 0))
  ) {
    throw new MonkeError(`Invalid Diff ${provider} target: ${value}`);
  }
}

function resolveRangeComparison(
  runtime: Runtime,
  context: RepoContext,
  target: string
): ComparisonPlan {
  const match = /^(?<base>[^.].*?)(?<separator>\.\.\.?)(?<head>[^.].*)$/su.exec(target);
  const base = match?.groups?.base;
  const head = match?.groups?.head;
  if (!base || !head) {
    throw new MonkeError(`Invalid Diff range: ${target}`);
  }
  validateRevision(runtime, context, base);
  validateRevision(runtime, context, head);
  const symmetric = match.groups?.separator === "...";
  if (
    symmetric &&
    runtime.exec("git", ["merge-base", base, head], {
      allowFailure: true,
      cwd: context.worktreeRoot
    }).exitCode !== 0
  ) {
    throw new MonkeError(`Diff range ${target} has no merge base.`);
  }
  return { base, head, kind: "range", symmetric, worktreePath: context.worktreeRoot };
}

async function launchAutomaticDiff(
  runtime: Runtime,
  present: DiffPresenter,
  remembered: RememberedDiff,
  options: DiffOptions
) {
  if (options.pick === true) {
    return false;
  }
  if (isDefaultBranchCheckout(runtime, remembered.context)) {
    await launchLocalChanges(runtime, present, remembered.context);
    return true;
  }
  const baseRef = resolveAutomaticBase(runtime, remembered);
  if (baseRef === undefined) {
    return false;
  }
  const plan = planBranchComparison(runtime, remembered.context, baseRef);
  if (plan === undefined) {
    return false;
  }
  warnDirtyRememberedBase(runtime, remembered, baseRef);
  await present(plan);
  if (baseRef !== remembered.baseRef) {
    persistDiffBase(runtime, remembered, baseRef);
  }
  return true;
}

function resolveAutomaticBase(runtime: Runtime, remembered: RememberedDiff) {
  if (remembered.baseRef === undefined) {
    return findInitialDefaultBranchBase(runtime, remembered.context);
  }
  return (
    findNewerDefaultBranchBase(runtime, remembered.context, remembered.baseRef) ??
    remembered.baseRef
  );
}

async function selectAndLaunchDiff(
  runtime: Runtime,
  present: DiffPresenter,
  remembered: RememberedDiff,
  options: DiffOptions
) {
  const plan = await selectDiffPlan(runtime, remembered, options);
  if (plan === undefined) {
    await launchLocalChanges(runtime, present, remembered.context);
    return;
  }
  await present(plan);
  if (plan.baseRef.startsWith("refs/heads/") || plan.baseRef.startsWith("refs/remotes/")) {
    persistDiffBase(runtime, remembered, plan.baseRef);
  }
}

async function selectDiffPlan(runtime: Runtime, remembered: RememberedDiff, options: DiffOptions) {
  let choices = buildDiffChoices(runtime, remembered);
  while (true) {
    if (choices.length === 1 && options.pick !== true) {
      return;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- Recoverable target races reopen the picker.
    const selected = await runtime.select({
      maxItems: Math.min(choices.length, 10),
      message: "Diff base",
      options: choices.map(({ label, value }) => ({ label, value }))
    });
    const choice = choices.find((candidate) => candidate.value === selected);
    if (choice?.value === "local" || choice === undefined) {
      return;
    }

    const refreshedTarget =
      choice.target === undefined
        ? undefined
        : resolveLocalWorktreeTarget(
            runtime,
            getMonkeHome(runtime),
            remembered.context.sourceRoot,
            remembered.context.gitCommonDir,
            choice.target
          );
    const baseRef =
      choice.baseRef ??
      (refreshedTarget === undefined
        ? undefined
        : resolveLocalWorktreeTargetBase(runtime, refreshedTarget));
    const plan =
      baseRef === undefined
        ? undefined
        : planBranchComparison(runtime, remembered.context, baseRef);
    if (plan === undefined) {
      runtime.writeStderr(
        `Selected Diff base ${choice.label} is no longer valid; choose another Diff base.\n`
      );
      remembered.getTargets(true);
      choices = buildDiffChoices(runtime, remembered);
      continue;
    }

    if (refreshedTarget) {
      warnDirtyBase(runtime, refreshedTarget);
    } else {
      // A remembered ref can survive its attached worktree being removed while the picker waits.
      remembered.getTargets(true);
      warnDirtyRememberedBase(runtime, remembered, plan.baseRef);
    }
    return plan;
  }
}

function buildDiffChoices(runtime: Runtime, remembered: RememberedDiff) {
  const choices: DiffChoice[] = [];
  const refs = new Set<string>();
  if (remembered.baseRef) {
    refs.add(remembered.baseRef);
    choices.push({
      baseRef: remembered.baseRef,
      label: `${remembered.baseRef} (current Diff base)`,
      value: `remembered:${remembered.baseRef}`
    });
  }
  for (const baseRef of listDefaultBranchRefs(runtime, remembered.context)) {
    if (!refs.has(baseRef)) {
      refs.add(baseRef);
      choices.push({ baseRef, label: `${baseRef} (default branch base)`, value: `ref:${baseRef}` });
    }
  }
  for (const target of remembered.getTargets()) {
    if (samePath(target.path, remembered.context.worktreeRoot)) {
      continue;
    }
    if (target.branch !== null) {
      const ref = `refs/heads/${target.branch}`;
      if (refs.has(ref)) {
        continue;
      }
      refs.add(ref);
    }
    choices.push({
      label: formatDiffTargetLabel(target),
      target,
      value: `worktree:${target.path}`
    });
  }
  choices.push({ label: "Local changes only", value: "local" });
  return choices;
}

function formatDiffTargetLabel(target: LocalWorktreeTarget) {
  const label = target.kind === "source" ? `Source checkout: ${target.label}` : target.label;
  return `${label} (committed branch base)`;
}

function persistDiffBase(runtime: Runtime, remembered: RememberedDiff, baseRef: string) {
  const { owner } = remembered;
  if (owner === undefined) {
    return;
  }
  const home = getMonkeHome(runtime);
  withGlobalLock(home, () => {
    const state = loadSessionState(home, owner.rootSourceRoot, owner.session);
    saveSessionState(home, {
      ...state,
      repos: state.repos.map((repo) =>
        samePath(repo.sourceRoot, remembered.context.sourceRoot) &&
        samePath(repo.worktreePath, remembered.context.worktreeRoot)
          ? { ...repo, diffBaseRef: baseRef }
          : repo
      )
    });
  });
}

function warnDirtyBase(runtime: Runtime, target: LocalWorktreeTarget) {
  if (hasWorkingTreeChanges(runtime, target.path)) {
    runtime.writeStderr(
      `Warning: ${target.label} has local changes; Diff uses its committed branch state only.\n`
    );
  }
}

function warnSessionBranchElsewhere(runtime: Runtime, remembered: RememberedDiff) {
  const { owner } = remembered;
  if (owner === undefined) {
    return;
  }
  const branch = remembered.context.currentBranch;
  const mismatch = describeSessionBranchMismatch(owner.session, branch === "HEAD" ? null : branch);
  if (mismatch === null) {
    return;
  }
  const attached = remembered
    .getTargets()
    .find(
      (target) =>
        target.branch === owner.session && !samePath(target.path, remembered.context.worktreeRoot)
    );
  if (attached === undefined) {
    return;
  }
  runtime.writeStderr(
    `Warning: Session ${owner.session} worktree ${remembered.context.worktreeRoot} ${mismatch}; branch ${owner.session} is checked out at ${attached.path}. Diff reviews the current checkout only.\n`
  );
}

function warnDirtyRememberedBase(runtime: Runtime, remembered: RememberedDiff, baseRef: string) {
  const branchPrefix = "refs/heads/";
  if (!baseRef.startsWith(branchPrefix)) {
    return;
  }
  const branch = baseRef.slice(branchPrefix.length);
  const target = remembered.getTargets().find((candidate) => candidate.branch === branch);
  if (target) {
    warnDirtyBase(runtime, target);
  }
}

async function launchLocalChanges(runtime: Runtime, present: DiffPresenter, context: RepoContext) {
  if (!hasWorkingTreeChanges(runtime, context.worktreeRoot)) {
    runtime.writeStdout("No changes.\n");
    return;
  }
  await present(planWorkingTreeComparison(context));
}

function resolveRememberedDiff(runtime: Runtime) {
  const home = getMonkeHome(runtime);
  const context = resolveRepoContext(runtime, runtime.cwd, null, { inferSessionName: false });
  const normalizedWorktree = path.normalize(context.worktreeRoot);
  const sessionState = listSessionStates(home).find((state) =>
    state.repos.some(
      (repo) =>
        samePath(repo.sourceRoot, context.sourceRoot) &&
        path.normalize(repo.worktreePath) === normalizedWorktree
    )
  );
  const repoState = sessionState?.repos.find(
    (repo) =>
      samePath(repo.sourceRoot, context.sourceRoot) &&
      path.normalize(repo.worktreePath) === normalizedWorktree
  );
  let targets: LocalWorktreeTarget[] | undefined;
  return {
    baseRef: repoState?.diffBaseRef,
    context,
    getTargets(refresh = false) {
      if (refresh || targets === undefined) {
        targets = listLocalWorktreeTargets(runtime, home, context.sourceRoot);
      }
      return targets;
    },
    owner:
      sessionState === undefined
        ? undefined
        : { rootSourceRoot: sessionState.rootSourceRoot, session: sessionState.session }
  };
}
