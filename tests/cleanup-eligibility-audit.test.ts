import { describe, expect, test } from "vitest";
import * as z from "zod";

import {
  CleanupCodeSchema,
  CleanupRepositoryEvidenceSchema,
  eligibleForCleanup
} from "../src/cleanup-eligibility.ts";
import auditCases from "./fixtures/cleanup-eligibility-audit.json";

// Expectations were frozen from Git + REST evidence before implementation, then
// all 50 positives were cross-checked through individual PR / commit comparisons.
// Paths, repositories, branches, and OIDs are anonymized without changing equality.
// These snapshots are evidence, never deletion authority.
const AuditCaseSchema = z.object({
  expected: z.boolean(),
  id: z.string(),
  snapshot: z.object({
    ancestorOfDefault: z.boolean().nullable(),
    branch: z.string().nullable(),
    candidate: z.object({
      role: z.enum(["root", "dependency"]),
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
});

describe("independently labeled local worktree inventory, 2026-09-06", () => {
  test.each(z.array(AuditCaseSchema).parse(auditCases))(
    "worktree $id returns $expected",
    ({ expected, snapshot }) => {
      expect(eligibleForCleanup(snapshot)).toBe(expected);
    }
  );
});
