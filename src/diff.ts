import path from "node:path";

import { launchCodiff, verifyCodiffAsync } from "./codiff.ts";
import {
  findInitialDefaultBranchBase,
  findNewerDefaultBranchBase,
  hasWorkingTreeChanges,
  planBranchComparison,
  planWorkingTreeComparison
} from "./comparison-plan.ts";
import { describeSessionBranchMismatch, resolveRepoContext } from "./git.ts";
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
  pick?: boolean;
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

/** Verify Codiff alongside repo discovery, then discover picker targets only when needed. */
export async function runDiffInteractive(runtime: Runtime, options: DiffOptions = {}) {
  const [executable, remembered] = await Promise.all([
    verifyCodiffAsync(runtime),
    Promise.try(() => resolveRememberedDiff(runtime))
  ]);
  warnSessionBranchElsewhere(runtime, remembered);
  if (launchAutomaticDiff(runtime, executable, remembered, options)) {
    return;
  }
  await selectAndLaunchDiff(runtime, executable, remembered);
}

function launchAutomaticDiff(
  runtime: Runtime,
  executable: string,
  remembered: RememberedDiff,
  options: DiffOptions
) {
  if (options.pick === true) {
    return false;
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
  launchCodiff(runtime, executable, plan);
  if (baseRef !== remembered.baseRef) {
    persistDiffBase(runtime, remembered, baseRef);
  }
  return true;
}

function resolveAutomaticBase(runtime: Runtime, remembered: RememberedDiff) {
  if (remembered.baseRef === undefined) {
    return remembered.owner === undefined
      ? undefined
      : findInitialDefaultBranchBase(runtime, remembered.context);
  }
  return (
    findNewerDefaultBranchBase(runtime, remembered.context, remembered.baseRef) ??
    remembered.baseRef
  );
}

async function selectAndLaunchDiff(
  runtime: Runtime,
  executable: string,
  remembered: RememberedDiff
) {
  let choices = buildDiffChoices(remembered);
  while (true) {
    if (choices.length === 1) {
      launchLocalChanges(runtime, executable, remembered.context);
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
      launchLocalChanges(runtime, executable, remembered.context);
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
      choices = buildDiffChoices(remembered);
      continue;
    }

    if (refreshedTarget) {
      warnDirtyBase(runtime, refreshedTarget);
    } else {
      // A remembered ref can survive its attached worktree being removed while the picker waits.
      remembered.getTargets(true);
      warnDirtyRememberedBase(runtime, remembered, plan.baseRef);
    }
    launchCodiff(runtime, executable, plan);
    if (refreshedTarget?.kind === "session" && refreshedTarget.branch !== null) {
      persistDiffBase(runtime, remembered, plan.baseRef);
    }
    return;
  }
}

function buildDiffChoices(remembered: RememberedDiff) {
  const targets = remembered
    .getTargets()
    .filter((target) => !samePath(target.path, remembered.context.worktreeRoot));
  const choices: DiffChoice[] = targets.map((target) => ({
    label: formatDiffTargetLabel(target),
    target,
    value: `worktree:${target.path}`
  }));
  if (remembered.baseRef) {
    choices.unshift({
      baseRef: remembered.baseRef,
      label: `${remembered.baseRef} (current Diff base)`,
      value: `remembered:${remembered.baseRef}`
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

function launchLocalChanges(runtime: Runtime, executable: string, context: RepoContext) {
  if (!hasWorkingTreeChanges(runtime, context.worktreeRoot)) {
    runtime.writeStdout(
      `No Diff base or local changes found for ${path.basename(context.sourceRoot)}.\n`
    );
    return;
  }
  launchCodiff(runtime, executable, planWorkingTreeComparison(context));
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
