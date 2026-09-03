import * as z from "zod";

const NonEmptyStringSchema = z.string().min(1);
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
  failure: MaterializationFailureSchema.optional(),
  materializationStatus: z.enum(["pending", "materialized", "failed", "blocked"]),
  pinnedRef: NonEmptyStringSchema.optional(),
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
});

function validateMaterializationLifecycle(repo: ParsedSessionRepoState, issue: LifecycleIssue) {
  if (repo.materializationStatus === "blocked" && repo.blockedBy === undefined) {
    issue("blocked materialization must identify blockedBy", ["blockedBy"]);
  }
  if (repo.materializationStatus !== "blocked" && repo.blockedBy !== undefined) {
    issue("blockedBy requires blocked materialization", ["blockedBy"]);
  }
  if (repo.materializationStatus === "failed" && repo.failure === undefined) {
    issue("failed materialization must include failure", ["failure"]);
  }
  if (repo.materializationStatus !== "failed" && repo.failure !== undefined) {
    issue("failure requires failed materialization", ["failure"]);
  }
  if (
    repo.materializationStatus === "materialized" &&
    repo.preparationStatus !== "prepared" &&
    repo.preparationStatus !== "warning"
  ) {
    issue("materialized repo requires prepared or warning preparation", ["materializationStatus"]);
  }
}

function validatePreparationLifecycle(repo: ParsedSessionRepoState, issue: LifecycleIssue) {
  if (repo.failure?.phase === "worktree-preparation" && repo.preparationStatus !== "failed") {
    issue("preparation failure requires failed preparation", ["failure"]);
  }
  if (repo.preparationStatus === "warning" && (repo.preparationWarnings?.length ?? 0) === 0) {
    issue("warning preparation requires preparationWarnings", ["preparationWarnings"]);
  }
  if (repo.preparationStatus !== "warning" && repo.preparationWarnings !== undefined) {
    issue("preparationWarnings require warning preparation", ["preparationWarnings"]);
  }
}

export const SessionStateSchema = z.strictObject({
  generation: z.strictObject({
    number: z.number().int().positive(),
    status: z.enum(["incomplete", "complete"])
  }),
  graphSource: z.literal("session-branch").optional(),
  repos: z.array(SessionRepoStateSchema),
  rootSourceRoot: NonEmptyStringSchema,
  session: NonEmptyStringSchema,
  spawnSource: z.enum(["default-branch", "session-branch"]).optional(),
  version: z.literal(2)
});

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
export type ResourceCommandOutputState = z.output<typeof ResourceCommandOutputStateSchema>;
export type ResourceCommandState = z.output<typeof ResourceCommandStateSchema>;
export type ResourceValueState = z.output<typeof ResourceValueStateSchema>;
export type SessionRepoState = z.output<typeof SessionRepoStateSchema>;
export type SessionState = z.output<typeof SessionStateSchema>;
