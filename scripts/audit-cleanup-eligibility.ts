import pLimit from "p-limit";
import * as z from "zod";

import {
  collectCleanupEvidence,
  createCleanupEvidenceCache,
  decideCleanupEligibility,
  eligibleForCleanup
} from "../src/cleanup-eligibility.ts";
import { createRuntime } from "../src/runtime.ts";

const ExpectedInventorySchema = z.object({
  capturedAt: z.string(),
  rows: z.array(
    z.object({
      branch: z.string().nullable(),
      expected: z.boolean(),
      head: z.string().optional(),
      reason: z.string(),
      role: z.enum(["root", "dependency"]),
      sourceRoot: z.string(),
      worktreePath: z.string()
    })
  )
});

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  throw new Error("Usage: bun scripts/audit-cleanup-eligibility.ts <expected.json> <report.json>");
}
const inventory = ExpectedInventorySchema.parse(await Bun.file(input).json());
const runtime = createRuntime();
const cache = createCleanupEvidenceCache();
const limit = pLimit(4);
let inspected = 0;

// Keep API and local Git pressure bounded while sharing repo-scoped lookup promises.
const results = await Promise.all(
  inventory.rows.map((expected) =>
    limit(async () => {
      const snapshot = await collectCleanupEvidence(
        runtime,
        {
          role: expected.role,
          sourceRoot: expected.sourceRoot,
          worktreePath: expected.worktreePath
        },
        cache
      );
      const actual = eligibleForCleanup(snapshot);
      const decision = decideCleanupEligibility(snapshot);
      // A replay needs only this branch's PRs, not repeated copies of every repo's history.
      const repository = snapshot.repository
        ? {
            ...snapshot.repository,
            pullRequests: snapshot.repository.pullRequests.filter(
              (pr) => pr.head.ref === snapshot.branch
            )
          }
        : null;
      inspected += 1;
      if (inspected % 40 === 0) {
        process.stderr.write(`Inspected ${inspected}/${inventory.rows.length} worktrees\n`);
      }
      return {
        actual,
        decision,
        expected: expected.expected,
        expectedReason: expected.reason,
        matches: actual === expected.expected,
        snapshot: { ...snapshot, repository },
        worktreePath: expected.worktreePath
      };
    })
  )
);

const mismatches = results.filter((result) => !result.matches);
const summary = {
  eligible: results.filter((result) => result.actual).length,
  ineligible: results.filter((result) => result.decision.status === "ineligible").length,
  mismatches: mismatches.map((result) => ({
    actual: result.actual,
    code: result.decision.code,
    expected: result.expected,
    path: result.worktreePath
  })),
  total: results.length,
  unknown: results.filter((result) => result.decision.status === "unknown").length
};
await Bun.write(
  output,
  `${JSON.stringify(
    {
      expectedCapturedAt: inventory.capturedAt,
      inspectedAt: new Date().toISOString(),
      results,
      summary
    },
    null,
    2
  )}\n`
);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (mismatches.length > 0) {
  process.exitCode = 1;
}
