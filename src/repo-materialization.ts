import path from "node:path";

import {
  collectBaselinePortsFromRoot,
  rewriteManagedEnvFiles,
  syncRootEnvFileWithRemovals
} from "./env.ts";
import { errorMessage, MonkeError } from "./errors.ts";
import { createLogger } from "./logger.ts";
import { resolveResourceCommands, resolveResourceValues } from "./resources.ts";
import {
  allocateLocalPorts,
  getOrCreateReservation,
  toAssignedPorts
} from "./session-state-store.ts";
import type { SessionStateStore } from "./session-state-store.ts";
import type {
  AssignedPort,
  RepoConfig,
  RepoMaterializationResult,
  ResourceCommandState,
  ResourceValueState,
  Runtime,
  SessionMaterializationCheckpoint,
  SessionRepoState
} from "./types.ts";

interface MaterializeRepoOptions {
  baselinePortsRoot: string;
  dependencyResults: Map<string, RepoMaterializationResult>;
  diffBaseRef?: string;
  existingState: SessionRepoState | undefined;
  persistRepoState: (
    repoState: SessionRepoState,
    checkpoint: RepoMaterializationProgressCheckpoint
  ) => void;
  repoConfig: RepoConfig;
  retryCommand: string;
  rootSourceRoot: string;
  runtime: Runtime;
  session: string;
  store: SessionStateStore;
  worktreePath: string;
}

interface RepoMaterializationContext extends MaterializeRepoOptions {
  hasBootstrapCommand: boolean;
  replacementCleanupAuthorityEstablished: boolean;
  resolvedResourceValues: ReturnType<typeof resolveResourceValues>;
}

interface RepoMaterializationAssignments {
  externalAssignments: AssignedPort[];
  externalPathAssignments: { env: string; value: string }[];
  localAssignedPorts: AssignedPort[];
  localAssignments: Map<string, number>;
}

interface RepoMaterializationCheckpoint {
  assignedPorts: AssignedPort[];
  cleanupEligible: boolean;
  resourceCommandOutputs: ResourceCommandState[];
}

/** The Session checkpoints one Repo materialization may persist, including its terminal result. */
type RepoMaterializationCheckpointName = Extract<
  SessionMaterializationCheckpoint,
  "cleanup-eligibility" | "repo-progress" | "repo-result" | "resource-command-output"
>;

/** The subset a repo persists while still materializing. */
type RepoMaterializationProgressCheckpoint = Exclude<
  RepoMaterializationCheckpointName,
  "repo-result"
>;

export async function materializeRepo(options: MaterializeRepoOptions) {
  const context = beginRepoMaterialization(options);
  const commandsBeforeAssignments = await resolveCommandsBeforeAssignments(context);
  const assignments = resolveRepoAssignments(context);
  const commands = await runRepoMaterializationCommands(
    context,
    assignments,
    commandsBeforeAssignments
  );
  const crossedExternalEffectCheckpoint = repoHasMaterializationExternalEffect(context);

  return {
    localAssignments: assignments.localAssignments,
    state: createRepoMaterializationState(
      context,
      {
        assignedPorts: assignments.localAssignedPorts,
        cleanupEligible:
          context.existingState?.cleanupEligible === true || crossedExternalEffectCheckpoint,
        materializationStatus: "materialized",
        resourceCommandOutputs: commands.commands
      },
      "repo-result"
    )
  };
}

function beginRepoMaterialization(options: MaterializeRepoOptions): RepoMaterializationContext {
  const context = {
    ...options,
    diffBaseRef: options.diffBaseRef || options.existingState?.diffBaseRef,
    hasBootstrapCommand: repoHasBootstrapCommand(options.repoConfig),
    replacementCleanupAuthorityEstablished: false,
    resolvedResourceValues: resolveResourceValues({
      env: options.runtime.env,
      existingRepoState: options.existingState,
      repoConfig: options.repoConfig,
      rootSourceRoot: options.rootSourceRoot,
      session: options.session,
      store: options.store
    })
  };
  persistRepoMaterializationState(
    context,
    {
      assignedPorts: options.existingState?.assignedPorts ?? [],
      cleanupEligible: options.existingState?.cleanupEligible ?? false,
      resourceCommandOutputs: options.existingState?.resourceCommandOutputs ?? []
    },
    "repo-progress"
  );
  return context;
}

async function resolveCommandsBeforeAssignments(context: RepoMaterializationContext) {
  if (context.hasBootstrapCommand) {
    return;
  }
  return await resolveRepoResourceCommands(context, context.existingState?.assignedPorts ?? []);
}

function resolveRepoAssignments(
  context: RepoMaterializationContext
): RepoMaterializationAssignments {
  const { baselinePortsRoot, dependencyResults, existingState, repoConfig, store } = context;
  const reservation = getOrCreateReservation(
    store.home,
    repoConfig.sourceRoot,
    repoConfig.localPortOrder.length
  );
  const baselinePorts = collectBaselinePortsFromRoot({
    config: repoConfig,
    sourceRoot: baselinePortsRoot
  });
  const localAssignments = allocateLocalPorts({
    baselinePorts,
    existingRepoState: existingState,
    repoConfig,
    reservation,
    rootSourceRoot: context.rootSourceRoot,
    session: context.session,
    store
  });
  const externalAssignments = resolveExternalAssignments(repoConfig, dependencyResults);
  rewriteManagedEnvFiles(repoConfig, context.worktreePath, localAssignments, externalAssignments);
  return {
    externalAssignments,
    externalPathAssignments: resolveExternalPathAssignments(
      repoConfig,
      context.worktreePath,
      dependencyResults
    ),
    localAssignedPorts: toAssignedPorts(repoConfig, localAssignments),
    localAssignments
  };
}

async function runRepoMaterializationCommands(
  context: RepoMaterializationContext,
  assignments: RepoMaterializationAssignments,
  resolvedCommands: Awaited<ReturnType<typeof resolveResourceCommands>> | undefined
) {
  const { existingState, repoConfig, resolvedResourceValues, worktreePath } = context;
  let commands = resolvedCommands;
  const rootEnvAssignmentsBeforeCommands = [
    ...assignments.externalPathAssignments,
    ...toRootEnvAssignments(assignments.localAssignedPorts),
    ...toRootEnvAssignments(dedupeAssignedPorts(assignments.externalAssignments)),
    ...resolvedResourceValues.values
  ];
  const existingResourceCommandEnvNames = toResourceCommandEnvNames(
    existingState?.resourceCommandOutputs ?? []
  );

  if (context.hasBootstrapCommand) {
    syncRootEnvFileWithRemovals(worktreePath, rootEnvAssignmentsBeforeCommands, [
      ...resolvedResourceValues.removedEnvNames,
      ...existingResourceCommandEnvNames
    ]);
    establishReplacementCleanupAuthority(
      context,
      assignments.localAssignedPorts,
      existingState?.resourceCommandOutputs ?? []
    );
    await runBootstrapCommand(
      context.runtime,
      repoConfig,
      worktreePath,
      assignments.externalPathAssignments,
      context.retryCommand,
      existingResourceCommandEnvNames
    );
    commands = await resolveRepoResourceCommands(context, assignments.localAssignedPorts);
  }
  if (!commands) {
    throw new MonkeError(`Resource commands were not resolved for ${repoConfig.sourceRoot}`);
  }

  syncRootEnvFileWithRemovals(
    worktreePath,
    [...rootEnvAssignmentsBeforeCommands, ...toResourceCommandEnvAssignments(commands.commands)],
    [...resolvedResourceValues.removedEnvNames, ...commands.removedEnvNames]
  );
  return commands;
}

function resolveRepoResourceCommands(
  context: RepoMaterializationContext,
  assignedPorts: AssignedPort[]
) {
  return resolveResourceCommands({
    existingRepoState: context.existingState,
    onCommandExecutionStarting(resourceCommandOutputs) {
      establishReplacementCleanupAuthority(context, assignedPorts, resourceCommandOutputs);
    },
    onResolvedCommandOutputs(resourceCommandOutputs) {
      persistRepoMaterializationState(
        context,
        {
          assignedPorts,
          cleanupEligible: true,
          resourceCommandOutputs
        },
        "resource-command-output"
      );
    },
    repoConfig: context.repoConfig,
    resourceValues: context.resolvedResourceValues.values,
    rootSourceRoot: context.rootSourceRoot,
    runtime: context.runtime,
    session: context.session,
    store: context.store,
    worktreePath: context.worktreePath
  });
}

function establishReplacementCleanupAuthority(
  context: RepoMaterializationContext,
  assignedPorts: AssignedPort[],
  resourceCommandOutputs: ResourceCommandState[]
) {
  if (context.replacementCleanupAuthorityEstablished) {
    return;
  }
  context.replacementCleanupAuthorityEstablished = true;
  persistRepoMaterializationState(
    context,
    {
      assignedPorts,
      cleanupEligible: true,
      resourceCommandOutputs
    },
    "cleanup-eligibility"
  );
}

function persistRepoMaterializationState(
  context: RepoMaterializationContext,
  state: RepoMaterializationCheckpoint,
  checkpoint: Exclude<RepoMaterializationCheckpointName, "repo-result">
) {
  context.persistRepoState(
    createRepoMaterializationState(
      context,
      {
        ...state,
        materializationStatus: "pending"
      },
      checkpoint
    ),
    checkpoint
  );
}

function createRepoMaterializationState(
  context: RepoMaterializationContext,
  state: RepoMaterializationCheckpoint & {
    materializationStatus: SessionRepoState["materializationStatus"];
  },
  checkpoint: RepoMaterializationCheckpointName
) {
  const cleanupAuthority = resolveCleanupAuthority(context, state, checkpoint);
  return buildSessionRepoState({
    ...state,
    ...cleanupAuthority,
    diffBaseRef: context.diffBaseRef,
    existingState: context.existingState,
    sourceRoot: context.repoConfig.sourceRoot,
    worktreePath: context.worktreePath
  });
}

function resolveCleanupAuthority(
  context: RepoMaterializationContext,
  state: RepoMaterializationCheckpoint & {
    materializationStatus: SessionRepoState["materializationStatus"];
  },
  checkpoint: RepoMaterializationCheckpointName
) {
  const retainExistingAuthority =
    context.existingState?.cleanupEligible === true &&
    context.existingState.cleanupCommand !== undefined &&
    !context.replacementCleanupAuthorityEstablished;
  if (retainExistingAuthority) {
    return {
      cleanupCommand: context.existingState?.cleanupCommand,
      cleanupEligible: true,
      resourceCommandOutputs: context.existingState?.resourceCommandOutputs ?? [],
      resourceValues: context.existingState?.resourceValues ?? []
    };
  }
  const retainExistingCleanupCommand =
    context.existingState?.cleanupEligible === true &&
    !context.replacementCleanupAuthorityEstablished;
  return {
    cleanupCommand: retainExistingCleanupCommand
      ? context.existingState?.cleanupCommand
      : (context.repoConfig.cleanupCommand ?? context.existingState?.cleanupCommand),
    cleanupEligible: state.cleanupEligible,
    resourceCommandOutputs: state.resourceCommandOutputs,
    resourceValues:
      state.materializationStatus === "materialized" || checkpoint !== "repo-progress"
        ? context.resolvedResourceValues.values
        : preserveStaleResourceValues(
            context.existingState?.resourceValues ?? [],
            context.resolvedResourceValues.values
          )
  };
}

function repoHasMaterializationExternalEffect(context: RepoMaterializationContext) {
  return context.hasBootstrapCommand || context.repoConfig.resourceCommandsInOrder.length > 0;
}

function repoHasBootstrapCommand(repoConfig: RepoConfig) {
  return Boolean(repoConfig.bootstrapCommand);
}

function resolveExternalAssignments(
  repoConfig: RepoConfig,
  dependencyResults: Map<string, RepoMaterializationResult>
) {
  const assignments: AssignedPort[] = [];
  for (const externalRepo of repoConfig.externalInOrder) {
    const dependency = dependencyResults.get(externalRepo.absoluteRepoRoot);
    if (!dependency) {
      throw new MonkeError(
        `Missing dependency materialization result for ${externalRepo.absoluteRepoRoot}`
      );
    }

    for (const mapping of externalRepo.mappings) {
      const value = dependency.localAssignments.get(mapping.portKey);
      if (value === undefined) {
        throw new MonkeError(
          `Dependency ${externalRepo.absoluteRepoRoot} did not materialize local port ${mapping.portKey}`
        );
      }
      assignments.push({ key: mapping.portKey, value });
    }
  }
  return assignments;
}

function resolveExternalPathAssignments(
  repoConfig: RepoConfig,
  worktreePath: string,
  dependencyResults: Map<string, RepoMaterializationResult>
) {
  return repoConfig.externalInOrder.map((externalRepo) => {
    const dependency = dependencyResults.get(externalRepo.absoluteRepoRoot);
    if (!dependency) {
      throw new MonkeError(
        `Missing dependency materialization result for ${externalRepo.absoluteRepoRoot}`
      );
    }

    const relativePath = path.relative(worktreePath, dependency.state.worktreePath) || ".";
    return {
      env: externalRepo.pathEnv,
      value: relativePath
    };
  });
}

function toRootEnvAssignments(assignments: AssignedPort[]) {
  return assignments.map((assignment) => ({
    env: assignment.key,
    value: String(assignment.value)
  }));
}

function dedupeAssignedPorts(assignments: AssignedPort[]) {
  const deduped = new Map<string, AssignedPort>();
  for (const assignment of assignments) {
    deduped.set(assignment.key, assignment);
  }
  return [...deduped.values()];
}

function toResourceCommandEnvAssignments(commands: ResourceCommandState[]) {
  return commands.flatMap((command) => command.outputs);
}

function toResourceCommandEnvNames(commands: ResourceCommandState[]) {
  return [...new Set(commands.flatMap((command) => command.outputs.map((output) => output.env)))];
}

function buildSessionRepoState(options: {
  assignedPorts: AssignedPort[];
  cleanupCommand?: string;
  cleanupEligible: boolean;
  diffBaseRef?: string;
  existingState?: SessionRepoState;
  materializationStatus: SessionRepoState["materializationStatus"];
  resourceCommandOutputs: ResourceCommandState[];
  resourceValues: ResourceValueState[];
  sourceRoot: string;
  worktreePath: string;
}) {
  const state: SessionRepoState = {
    ...options.existingState,
    assignedPorts: options.assignedPorts,
    cleanupEligible: options.cleanupEligible,
    materializationStatus: options.materializationStatus,
    preparationStatus: options.existingState?.preparationStatus ?? "prepared",
    sourceRoot: options.sourceRoot,
    worktreePath: options.worktreePath
  };

  if (options.cleanupCommand) {
    state.cleanupCommand = options.cleanupCommand;
  } else {
    delete state.cleanupCommand;
  }

  if (options.diffBaseRef) {
    state.diffBaseRef = options.diffBaseRef;
  } else {
    delete state.diffBaseRef;
  }

  if (options.resourceValues.length > 0) {
    state.resourceValues = options.resourceValues;
  } else {
    delete state.resourceValues;
  }

  if (options.resourceCommandOutputs.length > 0) {
    state.resourceCommandOutputs = options.resourceCommandOutputs;
  } else {
    delete state.resourceCommandOutputs;
  }

  return state;
}

export function createInitialRepoLifecycleState(
  repoConfig: Pick<RepoConfig, "cleanupCommand" | "sourceRoot">,
  worktreePath: string,
  existingState?: SessionRepoState
): SessionRepoState {
  return {
    ...existingState,
    assignedPorts: existingState?.assignedPorts ?? [],
    cleanupCommand: existingState?.cleanupEligible
      ? existingState.cleanupCommand
      : repoConfig.cleanupCommand,
    cleanupEligible: existingState?.cleanupEligible ?? false,
    materializationStatus: existingState?.materializationStatus ?? "pending",
    preparationStatus: existingState?.preparationStatus ?? "pending",
    sourceRoot: repoConfig.sourceRoot,
    worktreePath
  };
}

export function toRepoMaterializationResult(state: SessionRepoState): RepoMaterializationResult {
  return {
    localAssignments: new Map(state.assignedPorts.map((entry) => [entry.key, entry.value])),
    state
  };
}

function preserveStaleResourceValues(
  existingValues: ResourceValueState[],
  currentValues: ResourceValueState[]
) {
  const currentEnvNames = new Set(currentValues.map((resource) => resource.env));
  return [
    ...currentValues,
    ...existingValues.filter((resource) => !currentEnvNames.has(resource.env))
  ];
}

async function runBootstrapCommand(
  runtime: Runtime,
  repoConfig: RepoConfig,
  worktreePath: string,
  externalPathAssignments: { env: string; value: string }[],
  retryCommand: string,
  unsetEnvNames: string[]
) {
  if (!repoConfig.bootstrapCommand) {
    return;
  }

  createLogger(runtime).info(`Bootstrapping ${repoConfig.sourceRoot} in ${worktreePath}`);
  try {
    await runtime.execAsync("sh", ["-c", repoConfig.bootstrapCommand], {
      cwd: worktreePath,
      env: Object.fromEntries([
        ...externalPathAssignments.map((assignment) => [assignment.env, assignment.value] as const),
        ...unsetEnvNames.map((env) => [env, undefined] as const)
      ])
    });
  } catch (error) {
    const detail = errorMessage(error);
    throw new MonkeError(
      `Bootstrap command failed for ${repoConfig.sourceRoot}: ${repoConfig.bootstrapCommand}\n${detail}\nPartial Session state was kept; fix the command and re-run ${retryCommand} to resume from this repo.`
    );
  }
}
