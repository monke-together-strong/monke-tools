import { describe, expect, test } from "vitest";
import * as z from "zod";

import { CleanupCodeSchema, CleanupRepositoryEvidenceSchema } from "../src/cleanup-eligibility.ts";
import { eligibleForSessionCleanup } from "../src/session-cleanup-eligibility.ts";
import type { SessionCleanupEvidence } from "../src/session-cleanup-eligibility.ts";
import cases from "./fixtures/session-cleanup-eligibility-audit.json";

const SnapshotSchema = z.object({
  blockers: z.array(
    z.enum([
      "invalid-state",
      "invalid-state-overlap",
      "ownership-conflict",
      "member-identity-unverified",
      "source-missing",
      "held",
      "operation-lock-present",
      "state-changed-during-inspection",
      "member-changed-during-inspection"
    ])
  ),
  filePath: z.string(),
  members: z.array(
    z.object({
      evidence: z
        .object({
          ancestorOfDefault: z.boolean().nullable(),
          branch: z.string().nullable(),
          candidate: z.object({
            role: z.enum(["root", "dependency"]).optional(),
            sourceRoot: z.string(),
            worktreePath: z.string()
          }),
          head: z.string().nullable(),
          localBlock: z
            .object({
              code: CleanupCodeSchema,
              eligible: z.boolean(),
              evidence: z.array(z.string()),
              status: z.enum(["eligible", "ineligible", "unknown"])
            })
            .nullable(),
          repository: CleanupRepositoryEvidenceSchema.nullable(),
          worktreeAgeMs: z.number().nullable().optional()
        })
        .nullable(),
      mode: z.enum(["live", "gone", "stale", "unverified"]),
      sourceRoot: z.string(),
      worktreePath: z.string()
    })
  ),
  rootSourceRoot: z.string().nullable(),
  session: z.string().nullable()
}) satisfies z.ZodType<SessionCleanupEvidence>;

// 137 local Session expectations from an independent ownership audit. All 16
// live positives were cross-checked with individual GitHub PR/compare requests.
// A seventeenth case is verified partial recovery, independently checked with
// its retained Root branch/merged PR and remaining dependency comparison.
// A corrected capture replaced the first audit's accidentally truncated PR cache;
// expectations were not copied from this method's boolean results. Identifiers
// are anonymized while preserving all equality and Session/member relationships.
const inventory = z
  .array(z.object({ expected: z.boolean(), id: z.string(), snapshot: SnapshotSchema }))
  .parse(cases);

describe("local whole-Session evidence, 2026-09-06", () => {
  test.each(inventory)("Session $id returns $expected", ({ expected, snapshot }) => {
    expect(eligibleForSessionCleanup(snapshot)).toBe(expected);
  });
});
