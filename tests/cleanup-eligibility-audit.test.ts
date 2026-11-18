import { describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import {
  CleanupCodeSchema,
  CleanupRepositoryEvidenceSchema,
  decideCleanupEligibility
} from "../src/cleanup-eligibility.ts";
import auditCases from "./fixtures/cleanup-eligibility-audit.json";

// These anonymized cases come from an independent Git and GitHub audit (commit 46d1594).
// The fixture preserves identifier equality, which the eligibility decision uses.
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
  it.each(z.array(AuditCaseSchema).parse(auditCases))(
    "returns $expected for worktree $id",
    ({ expected, snapshot }) => {
      expect(decideCleanupEligibility(snapshot).eligible).toBe(expected);
    }
  );
});
