import * as z from "zod";

const NonEmptyStringSchema = z.string().min(1);
const PortSchema = z.number().int().min(1).max(65_535);
const PortKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*_PORT$/, { error: "must be an uppercase env name ending in _PORT" });

export const AssignedPortSchema = z.strictObject({
  key: PortKeySchema,
  value: PortSchema,
});

export const ResourceValueStateSchema = z.strictObject({
  env: NonEmptyStringSchema,
  value: NonEmptyStringSchema,
});

export const ResourceCommandOutputStateSchema = z.strictObject({
  env: NonEmptyStringSchema,
  value: NonEmptyStringSchema,
});

export const ResourceCommandStateSchema = z.strictObject({
  name: NonEmptyStringSchema,
  outputs: z.array(ResourceCommandOutputStateSchema),
});

export const SessionRepoStateSchema = z.strictObject({
  sourceRoot: NonEmptyStringSchema,
  worktreePath: NonEmptyStringSchema,
  assignedPorts: z.array(AssignedPortSchema),
  cleanupCommand: NonEmptyStringSchema.optional(),
  resourceValues: z.array(ResourceValueStateSchema).optional(),
  resourceCommandOutputs: z.array(ResourceCommandStateSchema).optional(),
  materializationComplete: z.boolean().optional(),
});

export const SessionStateSchema = z.strictObject({
  version: z.literal(1),
  rootSourceRoot: NonEmptyStringSchema,
  session: NonEmptyStringSchema,
  graphSource: z.literal("session-branch").optional(),
  repos: z.array(SessionRepoStateSchema),
});

export const RepoReservationSchema = z
  .strictObject({
    version: z.literal(1),
    sourceRoot: NonEmptyStringSchema,
    blockStart: PortSchema,
    size: z.number().int().positive(),
  })
  .check((context) => {
    if (context.value.blockStart + context.value.size - 1 > 65_535) {
      context.issues.push({
        code: "custom",
        input: context.value.size,
        message: "reserved block must end at or below port 65535",
        path: ["size"],
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
