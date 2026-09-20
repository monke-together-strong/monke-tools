import { syncRootEnvFileWithRemovals } from "./env.ts";
import { MonkeError } from "./errors.ts";
import { resolveRepoContext, validateWorktreeForSession } from "./git.ts";
import { loadResolvedGraphForSession } from "./monke.ts";
import { samePath } from "./path-identity.ts";
import { resolveResourceCommands, resolveResourceValues } from "./resources.ts";
import { getMonkeHome, withGlobalLockAsync } from "./runtime.ts";
import { cleanupSessionResources } from "./session-finalization.ts";
import { SessionStateStore } from "./session-state-store.ts";
import type { Runtime } from "./types.ts";

/** Manage recorded resources without removing the current repository's Session worktree. */
export async function runResources(runtime: Runtime, operation: "acquire" | "release") {
  const home = getMonkeHome(runtime);
  await withGlobalLockAsync(home, async () => {
    const context = resolveRepoContext(runtime, runtime.cwd, home);
    const store = new SessionStateStore(home);
    const owners = store
      .list()
      .filter((state) =>
        state.repos.some((repo) => samePath(repo.worktreePath, context.worktreeRoot))
      );
    const [state] = owners;
    if (context.isSourceCheckout || owners.length !== 1 || !state) {
      throw new MonkeError("mt resources must run inside an unambiguously owned Session worktree");
    }
    const repo = state.repos.find((member) => samePath(member.worktreePath, context.worktreeRoot));
    if (!repo) {
      throw new MonkeError("Missing Session repository");
    }
    validateWorktreeForSession(runtime, home, repo.sourceRoot, repo.worktreePath, state.session);
    if (operation === "release") {
      cleanupSessionResources(runtime, { ...state, repos: [repo] });
      const removedEnvNames = (repo.resourceCommandOutputs ?? []).flatMap((command) =>
        command.outputs.map((output) => output.env)
      );
      syncRootEnvFileWithRemovals(repo.worktreePath, [], removedEnvNames);
      repo.resourceCommandOutputs = [];
      repo.cleanupEligible = false;
      store.checkpoint(state);
      return;
    }
    const config = loadResolvedGraphForSession(
      runtime,
      state.rootSourceRoot,
      state
    ).reposByRoot.get(repo.sourceRoot);
    if (!config) {
      throw new MonkeError("Current repository is absent from the Session configuration");
    }
    const values = resolveResourceValues({
      env: runtime.env,
      existingRepoState: repo,
      repoConfig: config,
      rootSourceRoot: state.rootSourceRoot,
      session: state.session,
      store
    });
    let acquired = false;
    const persist = (commands: NonNullable<typeof repo.resourceCommandOutputs>) => {
      acquired = true;
      repo.cleanupEligible = true;
      repo.cleanupCommand = config.cleanupCommand;
      repo.resourceValues = values.values;
      repo.resourceCommandOutputs = commands;
      store.checkpoint(state);
    };
    const result = await resolveResourceCommands({
      acquireExplicit: true,
      existingRepoState: repo,
      onCommandExecutionStarting: persist,
      onResolvedCommandOutputs: persist,
      repoConfig: config,
      resourceValues: values.values,
      rootSourceRoot: state.rootSourceRoot,
      runtime,
      session: state.session,
      store,
      worktreePath: repo.worktreePath
    });
    // A no-effect refresh cannot retire inputs still owned by recorded cleanup.
    if (!acquired && repo.cleanupEligible) {
      syncRootEnvFileWithRemovals(repo.worktreePath, [
        ...(repo.resourceValues ?? []),
        ...(repo.resourceCommandOutputs ?? []).flatMap((command) => command.outputs)
      ]);
      return;
    }
    syncRootEnvFileWithRemovals(
      repo.worktreePath,
      [...values.values, ...result.commands.flatMap((command) => command.outputs)],
      [...values.removedEnvNames, ...result.removedEnvNames]
    );
    repo.resourceValues = values.values;
    repo.resourceCommandOutputs = result.commands;
    store.checkpoint(state);
  });
}
