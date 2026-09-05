import * as z from "zod";

import { samePath } from "./path-identity.ts";

const NonEmptyStringSchema = z.string().min(1);
const GitObjectIdSchema = z.string().regex(/^(?:[\da-f]{40}|[\da-f]{64})$/iu, {
  error: "must be an immutable Git object ID"
});
const PortSchema = z.number().int().min(1).max(65_535);
const PortKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*_PORT$/u, { error: "must be an uppercase env name ending in _PORT" });

const AssignedPortSchema = z.strictObject({
  key: PortKeySchema,
  value: PortSchema
});

const ResourceValueStateSchema = z.strictObject({
  env: NonEmptyStringSchema,
  value: NonEmptyStringSchema
});

const ResourceCommandOutputStateSchema = z.strictObject({
  env: NonEmptyStringSchema,
  value: NonEmptyStringSchema
});

const ResourceCommandStateSchema = z.strictObject({
  name: NonEmptyStringSchema,
  outputs: z.array(ResourceCommandOutputStateSchema)
});

const MaterializationFailureSchema = z.strictObject({
  message: NonEmptyStringSchema,
  phase: z.enum(["worktree-preparation", "repo-materialization"])
});

const SessionRepoStateFieldsSchema = z.strictObject({
  assignedPorts: z.array(AssignedPortSchema),
  blockedBy: NonEmptyStringSchema.optional(),
  cleanupCommand: NonEmptyStringSchema.optional(),
  cleanupEligible: z.boolean(),
  diffBaseRef: NonEmptyStringSchema.optional(),
  dirtyCarryStatus: z.enum(["pending", "complete"]).optional(),
  failure: MaterializationFailureSchema.optional(),
  materializationStatus: z.enum(["pending", "materialized", "failed", "blocked"]),
  pinnedRef: GitObjectIdSchema.optional(),
  preparationStatus: z.enum(["pending", "prepared", "warning", "failed"]),
  preparationWarnings: z.array(NonEmptyStringSchema).optional(),
  resourceCommandOutputs: z.array(ResourceCommandStateSchema).optional(),
  resourceValues: z.array(ResourceValueStateSchema).optional(),
  sourceRoot: NonEmptyStringSchema,
  worktreePath: NonEmptyStringSchema
});

type ParsedSessionRepoState = z.output<typeof SessionRepoStateFieldsSchema>;
type LifecycleIssue = (message: string, path: PropertyKey[]) => void;

const SessionRepoStateSchema = SessionRepoStateFieldsSchema.check((context) => {
  const issue: LifecycleIssue = (message, path) => {
    context.issues.push({ code: "custom", input: context.value, message, path });
  };
  validateMaterializationLifecycle(context.value, issue);
  validatePreparationLifecycle(context.value, issue);
  validateCleanupLifecycle(context.value, issue);
});

function validateCleanupLifecycle(repo: ParsedSessionRepoState, issue: LifecycleIssue) {
  if ((repo.resourceCommandOutputs?.length ?? 0) > 0 && !repo.cleanupEligible) {
    issue("Resource command outputs require Cleanup eligibility", ["cleanupEligible"]);
  }
}

function validateMaterializationLifecycle(repo: ParsedSessionRepoState, issue: LifecycleIssue) {
  const preparationComplete = isPreparationComplete(repo);
  const retainedPreparationFailure = isRetainedPreparationFailure(repo);
  if (repo.materializationStatus === "blocked" && repo.blockedBy === undefined) {
    issue("blocked materialization must identify blockedBy", ["blockedBy"]);
  }
  if (repo.materializationStatus !== "blocked" && repo.blockedBy !== undefined) {
    issue("blockedBy requires blocked materialization", ["blockedBy"]);
  }
  if (repo.materializationStatus === "failed" && repo.failure === undefined) {
    issue("failed materialization must include failure", ["failure"]);
  }
  if (
    repo.failure !== undefined &&
    repo.materializationStatus !== "failed" &&
    !retainedPreparationFailure
  ) {
    issue("failure requires failed materialization", ["failure"]);
  }
  if (
    repo.materializationStatus === "failed" &&
    repo.failure?.phase === "repo-materialization" &&
    !preparationComplete
  ) {
    issue("repo materialization failure requires completed preparation", ["materializationStatus"]);
  }
  if (repo.materializationStatus === "blocked" && !preparationComplete) {
    issue("blocked materialization requires completed preparation", ["materializationStatus"]);
  }
  if (
    repo.materializationStatus === "materialized" &&
    !preparationComplete &&
    !retainedPreparationFailure
  ) {
    issue("materialized repo requires completed or explicitly failed preparation", [
      "materializationStatus"
    ]);
  }
}

function isPreparationComplete(repo: ParsedSessionRepoState) {
  return repo.preparationStatus === "prepared" || repo.preparationStatus === "warning";
}

function isRetainedPreparationFailure(repo: ParsedSessionRepoState) {
  return (
    repo.materializationStatus === "materialized" &&
    repo.preparationStatus === "failed" &&
    repo.failure?.phase === "worktree-preparation"
  );
}

function validatePreparationLifecycle(repo: ParsedSessionRepoState, issue: LifecycleIssue) {
  if (repo.preparationStatus === "failed") {
    if (repo.failure?.phase !== "worktree-preparation") {
      issue("failed preparation requires a Worktree-preparation failure", ["preparationStatus"]);
    }
  } else if (repo.failure?.phase === "worktree-preparation") {
    issue("Worktree-preparation failure requires failed preparation", ["failure"]);
  }
  if (repo.preparationStatus === "pending" && repo.materializationStatus !== "pending") {
    issue("pending preparation requires pending materialization", ["preparationStatus"]);
  }
  if (repo.preparationStatus === "warning" && (repo.preparationWarnings?.length ?? 0) === 0) {
    issue("warning preparation requires preparationWarnings", ["preparationWarnings"]);
  }
  if (repo.preparationStatus !== "warning" && repo.preparationWarnings !== undefined) {
    issue("preparationWarnings require warning preparation", ["preparationWarnings"]);
  }
  if (
    repo.dirtyCarryStatus === "pending" &&
    repo.preparationStatus !== "pending" &&
    repo.preparationStatus !== "failed"
  ) {
    issue("pending dirty carry requires pending or failed preparation", ["dirtyCarryStatus"]);
  }
}

const SessionStateFieldsSchema = z.strictObject({
  copyDirty: z.boolean().optional(),
  generation: z.strictObject({
    number: z.number().int().nonnegative(),
    status: z.enum(["not-started", "incomplete", "complete"])
  }),
  graphSource: z.literal("session-branch").optional(),
  repos: z.array(SessionRepoStateSchema),
  rootSourceRoot: NonEmptyStringSchema,
  session: NonEmptyStringSchema,
  spawnSource: z.enum(["default-branch", "session-branch"]).optional(),
  version: z.literal(2)
});

type ParsedSessionState = z.output<typeof SessionStateFieldsSchema>;

export const SessionStateSchema = SessionStateFieldsSchema.check((context) => {
  const issue: LifecycleIssue = (message, path) => {
    context.issues.push({ code: "custom", input: context.value, message, path });
  };
  validateGeneration(context.value, issue);
  validateRepoSet(context.value, issue);
  validateBlockedByReferences(context.value, issue);
  validateDefaultBranchIdentity(context.value, issue);
  validateSourcePolicy(context.value, issue);
  validateDirtyPolicy(context.value, issue);
});

function validateDirtyPolicy(state: ParsedSessionState, issue: LifecycleIssue) {
  if (state.spawnSource !== undefined && state.copyDirty !== undefined) {
    issue("copyDirty is only valid for current-HEAD Spawn", ["copyDirty"]);
  }
  if (
    state.repos.some((repo) => repo.dirtyCarryStatus === "pending") &&
    (state.spawnSource !== undefined || state.graphSource !== undefined || state.copyDirty !== true)
  ) {
    issue("pending dirty carry requires current-HEAD Spawn with copyDirty enabled", ["copyDirty"]);
  }
}

function validateSourcePolicy(state: ParsedSessionState, issue: LifecycleIssue) {
  if (state.spawnSource !== undefined && state.graphSource !== "session-branch") {
    issue("retained Spawn source policy requires Session-branch graph source", ["graphSource"]);
  }
}

function validateGeneration(state: ParsedSessionState, issue: LifecycleIssue) {
  if (state.generation.status === "not-started") {
    if (state.generation.number !== 0) {
      issue("not-started generation must have number 0", ["generation", "number"]);
    }
    if (state.repos.some((repo) => repo.materializationStatus !== "pending")) {
      issue("not-started generation requires pending repo materialization", [
        "generation",
        "status"
      ]);
    }
    if (state.repos.some((repo) => repo.cleanupEligible)) {
      issue("not-started generation cannot be cleanup-eligible", ["generation", "status"]);
    }
  } else if (state.generation.number === 0) {
    issue("active or complete generation must have a positive number", ["generation", "number"]);
  }
  if (
    state.generation.status === "complete" &&
    state.repos.some(
      (repo) => repo.materializationStatus !== "materialized" || !isPreparationComplete(repo)
    )
  ) {
    issue("complete generation requires every repo to be prepared and materialized", [
      "generation",
      "status"
    ]);
  }
}

function validateRepoSet(state: ParsedSessionState, issue: LifecycleIssue) {
  if (state.repos.length === 0) {
    issue("Session state requires at least the Root repo", ["repos"]);
    return;
  }
  if (!state.repos.some((repo) => repo.sourceRoot === state.rootSourceRoot)) {
    issue("Session state must include its Root repo", ["rootSourceRoot"]);
  }
  const duplicateSourceRoot = findDuplicatePathIndex(state.repos.map((repo) => repo.sourceRoot));
  if (duplicateSourceRoot !== -1) {
    issue("Session state cannot contain duplicate Source checkouts", [
      "repos",
      duplicateSourceRoot,
      "sourceRoot"
    ]);
  }
  const duplicateWorktree = findDuplicatePathIndex(state.repos.map((repo) => repo.worktreePath));
  if (duplicateWorktree !== -1) {
    issue("Session state cannot contain duplicate Session worktrees", [
      "repos",
      duplicateWorktree,
      "worktreePath"
    ]);
  }
  if (state.repos.at(-1)?.sourceRoot !== state.rootSourceRoot) {
    issue("Root repo must follow its dependencies in materialization order", ["repos"]);
  }
}

function validateBlockedByReferences(state: ParsedSessionState, issue: LifecycleIssue) {
  for (const [index, repo] of state.repos.entries()) {
    if (repo.blockedBy === undefined) {
      continue;
    }
    const { blockedBy } = repo;
    const dependency = state.repos.find(
      (candidate) =>
        !samePath(candidate.sourceRoot, repo.sourceRoot) &&
        samePath(candidate.sourceRoot, blockedBy)
    );
    if (dependency === undefined) {
      issue("blockedBy must identify another recorded repo", ["repos", index, "blockedBy"]);
    }
  }
}

function validateDefaultBranchIdentity(state: ParsedSessionState, issue: LifecycleIssue) {
  if (state.spawnSource !== "default-branch") {
    return;
  }
  for (const [index, repo] of state.repos.entries()) {
    if (repo.pinnedRef === undefined) {
      issue("default-branch repo requires pinnedRef", ["repos", index, "pinnedRef"]);
    }
  }
}

function findDuplicatePathIndex(values: string[]) {
  return values.findIndex((value, index) =>
    values.slice(0, index).some((earlier) => samePath(earlier, value))
  );
}

export const RepoReservationSchema = z
  .strictObject({
    blockStart: PortSchema,
    size: z.number().int().positive(),
    sourceRoot: NonEmptyStringSchema,
    version: z.literal(1)
  })
  .check((context) => {
    if (context.value.blockStart + context.value.size - 1 > 65_535) {
      context.issues.push({
        code: "custom",
        input: context.value.size,
        message: "reserved block must end at or below port 65535",
        path: ["size"]
      });
    }
  });

export type AssignedPort = z.output<typeof AssignedPortSchema>;
export type RepoReservation = z.output<typeof RepoReservationSchema>;
export type ResourceCommandState = z.output<typeof ResourceCommandStateSchema>;
export type ResourceValueState = z.output<typeof ResourceValueStateSchema>;
export type SessionRepoState = z.output<typeof SessionRepoStateSchema>;
export type SessionState = z.output<typeof SessionStateSchema>;
