import { describe, expect, test } from "vitest";
import * as z from "zod";

import {
  CleanupCodeSchema,
  CleanupRepositoryEvidenceSchema,
  decideCleanupEligibility
} from "../src/cleanup-eligibility.ts";
import auditCases from "./fixtures/cleanup-eligibility-audit.json";

// Representatives from the 364-worktree inventory frozen from Git + REST evidence
// before implementation; all 50 original positives were independently cross-checked.
// Removed rows differed only by consistently renamed identifiers, preserving every
// distinct input shape and equality relationship. Original capture: commit 46d1594.
// Paths, repositories, branches, and OIDs remain anonymized without changing equality.
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
      expect(decideCleanupEligibility(snapshot).eligible).toBe(expected);
    }
  );
});
