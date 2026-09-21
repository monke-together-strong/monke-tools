import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { CheckoutResourceStore, resourceOwner } from "./checkout-resource-store.ts";
import type { CheckoutResources } from "./checkout-resource-store.ts";
import { loadResolvedGraph } from "./config.ts";
import { syncRootEnvFileWithRemovals } from "./env.ts";
import { MonkeError } from "./errors.ts";
import { resolveRepoContext, validateWorktreeForSession } from "./git.ts";
import { createLogger } from "./logger.ts";
import { samePath } from "./path-identity.ts";
import {
  resolveResourceCommands,
  resolveResourceValues,
  releaseResourceCommand
} from "./resources.ts";
import {
  acquireCheckoutResourceLock,
  getMonkeHome,
  withGlobalLock,
  withGlobalLockAsync
} from "./runtime.ts";
import { SessionStateStore } from "./session-state-store.ts";
import type { Runtime } from "./types.ts";

function resolveCheckout(runtime: Runtime) {
  const home = getMonkeHome(runtime);
  const context = resolveRepoContext(runtime, runtime.cwd, home);
  const sessions = new SessionStateStore(home);
  const owners = sessions
    .list()
    .filter((state) =>
      state.repos.some((repo) => samePath(repo.worktreePath, context.worktreeRoot))
    );
  if (!context.isSourceCheckout && owners.length !== 1) {
    throw new MonkeError(
      "Resource commands require a source checkout or an owned Session worktree"
    );
  }
  const [session] = owners;
  if (session) {
    validateWorktreeForSession(
      runtime,
      home,
      context.sourceRoot,
      context.worktreeRoot,
      session.session
    );
  }
  const owner = resourceOwner(context.sourceRoot, context.worktreeRoot, session?.session);
  const store = new CheckoutResourceStore(home, sessions.list());
  // Resource modules and declarations belong to the checkout being executed.
  const loadConfig = () =>
    loadResolvedGraph(runtime, context.sourceRoot, {
      readRepoConfig(sourceRoot) {
        const root = samePath(sourceRoot, context.sourceRoot) ? context.worktreeRoot : sourceRoot;
        return readFileSync(path.join(root, "monke.yml"), "utf-8");
      }
    }).reposByRoot.get(context.sourceRoot);
  const sessionRepo = session?.repos.find((repo) =>
    samePath(repo.worktreePath, owner.checkoutPath)
  );
  const pendingInfrastructureCleanup = Boolean(
    sessionRepo?.cleanupEligible && sessionRepo.cleanupCommand
  );
  const dependencyCheckout = (sourceRoot: string) => {
    if (!session) {
      return sourceRoot;
    }
    const dependency = session.repos.find((repo) => samePath(repo.sourceRoot, sourceRoot));
    if (!dependency) {
      throw new MonkeError(`Missing Session dependency ${sourceRoot}; run mt materialize first.`);
    }
    return dependency.worktreePath;
  };
  return { dependencyCheckout, home, loadConfig, owner, pendingInfrastructureCleanup, store };
}

/** Prepare static checkout wiring before local infrastructure; never run acquisition modules. */
export function runCheckoutSetup(runtime: Runtime) {
  withGlobalLock(getMonkeHome(runtime), () => {
    const { dependencyCheckout, home, loadConfig, owner, pendingInfrastructureCleanup, store } =
      resolveCheckout(runtime);
    const unlock = acquireCheckoutResourceLock(home, owner.checkoutPath);
    try {
      const config = loadConfig();
      if (!config) {
        throw new MonkeError("Missing repository resource configuration");
      }
      const record = store.get(owner);
      const values = resolveResourceValues({
        env: runtime.env,
        existingRepoState: record,
        preserveValues: Boolean(record.legacyCleanupCommand || pendingInfrastructureCleanup),
        repoConfig: config,
        rootSourceRoot: owner.sourceRoot,
        session: owner.session ?? "",
        store,
        worktreePath: owner.checkoutPath
      });
      const paths = config.externalInOrder.map((dependency) => ({
        env: dependency.pathEnv,
        value:
          path.relative(owner.checkoutPath, dependencyCheckout(dependency.absoluteRepoRoot)) || "."
      }));
      record.resourceValues = values.values;
      store.save(record);
      syncRootEnvFileWithRemovals(
        owner.checkoutPath,
        [...paths, ...values.values],
        [
          ...values.removedEnvNames,
          ...config.resourceCommandsInOrder.flatMap((command) => command.outputs)
        ]
      );
      createLogger(runtime).success(
        `Updated checkout root .env for ${path.basename(owner.sourceRoot)}`
      );
    } finally {
      unlock();
    }
  });
}

/** Acquire or release current-checkout resources, without tearing down its infrastructure. */
export async function runResources(runtime: Runtime, operation: "acquire" | "release") {
  await withGlobalLockAsync(getMonkeHome(runtime), async () => {
    const { home, loadConfig, owner, pendingInfrastructureCleanup, store } =
      resolveCheckout(runtime);
    const unlock = acquireCheckoutResourceLock(home, owner.checkoutPath);
    try {
      const record = store.get(owner);
      store.save(record);
      if (operation === "release") {
        releaseCheckoutResources(runtime, store, record);
        return;
      }
      const config = loadConfig();
      if (!config) {
        throw new MonkeError("Missing repository resource configuration");
      }
      const values = resolveResourceValues({
        env: runtime.env,
        existingRepoState: record,
        preserveValues: Boolean(record.legacyCleanupCommand || pendingInfrastructureCleanup),
        repoConfig: config,
        rootSourceRoot: owner.sourceRoot,
        session: owner.session ?? "",
        store,
        worktreePath: owner.checkoutPath
      });
      const persist = (commands: CheckoutResources["resourceCommandOutputs"]) => {
        record.resourceValues = values.values;
        record.resourceCommandOutputs = commands;
        delete record.releasedLegacyCleanup;
        if (commands.some((command) => command.legacy) && config.cleanupCommand) {
          record.legacyCleanupCommand ??= config.cleanupCommand;
        }
        store.save(record);
      };
      await resolveResourceCommands({
        acquireExplicit: true,
        existingRepoState: record,
        onResolvedCommandOutputs: persist,
        repoConfig: config,
        resourceValues: values.values,
        rootSourceRoot: owner.sourceRoot,
        runtime,
        session: owner.session ?? "",
        store,
        worktreePath: owner.checkoutPath
      });
      record.resourceValues = values.values;
      store.save(record);
      syncRootEnvFileWithRemovals(
        owner.checkoutPath,
        values.values,
        config.resourceCommandsInOrder.flatMap((command) => command.outputs)
      );
    } finally {
      unlock();
    }
  });
}

/** Validate once under lock, then keep allocations protected until the foreground child exits. */
export async function runResourcesExec(runtime: Runtime, command: string, args: string[]) {
  const prepared = withGlobalLock(getMonkeHome(runtime), () => {
    const { home, loadConfig, owner, store } = resolveCheckout(runtime);
    const unlock = acquireCheckoutResourceLock(home, owner.checkoutPath);
    try {
      const record = store.get(owner);
      const config = loadConfig();
      if (!config) {
        throw new MonkeError("Missing repository resource configuration");
      }
      const outputs = new Map(
        record.resourceCommandOutputs.map((entry) => [
          entry.name,
          new Map(entry.outputs.map((output) => [output.env, output.value]))
        ])
      );
      const missing = config.resourceCommandsInOrder.filter((entry) =>
        entry.outputs.some((name) => !outputs.get(entry.name)?.get(name)?.trim())
      );
      const recordedValues = new Map(
        record.resourceValues.map((entry) => [entry.env, entry.value])
      );
      const missingValues = config.resourceValuesInOrder.filter(
        (entry) => !recordedValues.get(entry.env)?.trim()
      );
      if (missing.length || missingValues.length) {
        throw new MonkeError(
          `Missing resources: ${[...missing.map((entry) => entry.name), ...missingValues.map((entry) => entry.env)].join(", ")}. Run mt resources acquire (or your repository's e2e:setup) first.`
        );
      }
      const env: Record<string, string | undefined> = {};
      for (const entry of config.resourceValuesInOrder) {
        env[entry.env] = recordedValues.get(entry.env);
      }
      for (const entry of config.resourceCommandsInOrder) {
        for (const name of entry.outputs) {
          env[name] = outputs.get(entry.name)?.get(name);
        }
      }
      return { env, unlock };
    } catch (error) {
      unlock();
      throw error;
    }
  });
  try {
    const result = await runtime.execAsync(command, args, {
      allowFailure: true,
      env: prepared.env,
      inheritStdio: true,
      protectProcesses: (pids) => {
        prepared.unlock.protectProcesses(pids);
      }
    });
    return result.exitCode;
  } finally {
    prepared.unlock();
  }
}

/** Called with the global and checkout locks held; saved modules survive configuration changes. */
export function releaseCheckoutResources(
  runtime: Runtime,
  store: CheckoutResourceStore,
  record: CheckoutResources,
  cwd = record.owner.checkoutPath
) {
  for (const command of record.resourceCommandOutputs.toReversed()) {
    // The aggregate legacy hook owns its original outputs; named modules own their releases.
    if (record.legacyCleanupCommand && command.legacy !== false) {
      continue;
    }
    releaseResourceCommand(runtime, record, command, cwd);
    record.resourceCommandOutputs = record.resourceCommandOutputs.filter(
      (entry) => entry.name !== command.name
    );
    store.save(record);
    if (existsSync(record.owner.checkoutPath)) {
      syncRootEnvFileWithRemovals(
        record.owner.checkoutPath,
        [],
        command.outputs.map((entry) => entry.env)
      );
    }
  }
  if (record.legacyCleanupCommand) {
    const outputs = Object.fromEntries(
      record.resourceCommandOutputs.flatMap((command) =>
        command.outputs.map((output) => [output.env, output.value])
      )
    );
    runtime.exec("sh", ["-c", record.legacyCleanupCommand], {
      cwd,
      env: {
        ...Object.fromEntries(record.resourceValues.map((entry) => [entry.env, entry.value])),
        ...outputs,
        MONKE_RESOURCE_OUTPUTS: JSON.stringify(outputs),
        MONKE_SESSION: record.owner.session,
        MONKE_SOURCE_ROOT: record.owner.sourceRoot,
        MONKE_WORKTREE_PATH: record.owner.checkoutPath
      },
      timeoutSeconds: 60
    });
    const names = record.resourceCommandOutputs.flatMap((command) =>
      command.outputs.map((output) => output.env)
    );
    record.resourceCommandOutputs = [];
    record.releasedLegacyCleanup = record.legacyCleanupCommand;
    delete record.legacyCleanupCommand;
    store.save(record);
    if (existsSync(record.owner.checkoutPath)) {
      syncRootEnvFileWithRemovals(record.owner.checkoutPath, [], names);
    }
  }
}
