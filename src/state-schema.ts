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

const SessionRepoStateSchema = z.strictObject({
  assignedPorts: z.array(AssignedPortSchema),
  cleanupCommand: NonEmptyStringSchema.optional(),
  diffBaseRef: NonEmptyStringSchema.optional(),
  materializationComplete: z.boolean().optional(),
  resourceCommandOutputs: z.array(ResourceCommandStateSchema).optional(),
  resourceValues: z.array(ResourceValueStateSchema).optional(),
  sourceRoot: NonEmptyStringSchema,
  worktreePath: NonEmptyStringSchema
});

export const SessionStateSchema = z.strictObject({
  graphSource: z.literal("session-branch").optional(),
  repos: z.array(SessionRepoStateSchema),
  rootSourceRoot: NonEmptyStringSchema,
  session: NonEmptyStringSchema,
  spawnSource: z.enum(["default-branch", "session-branch"]).optional(),
  version: z.literal(1)
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
