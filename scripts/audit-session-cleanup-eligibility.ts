import path from "node:path";

import * as z from "zod";

import { createRuntime, getMonkeHome } from "../src/runtime.ts";
import { inspectSessionCleanup } from "../src/session-cleanup-eligibility.ts";
import {
  createSessionCleanupReport,
  formatSessionCleanupReport
} from "../src/session-cleanup-report.ts";

const [input, output, textOutput] = process.argv.slice(2);
if (!input || !output) {
  throw new Error(
    "Usage: bun scripts/audit-session-cleanup-eligibility.ts <expected.json> <report.json> [report.txt]"
  );
}
const inventory = z
  .object({
    capturedAt: z.string(),
    knownSourceRoots: z.array(z.string()).optional(),
    rows: z.array(z.object({ expected: z.boolean(), file: z.string() }))
  })
  .parse(await Bun.file(input).json());
const runtime = createRuntime();
const report = await inspectSessionCleanup(
  runtime,
  getMonkeHome(runtime),
  inventory.knownSourceRoots
);
const actual = new Map(
  report.sessions.map((result) => [path.basename(result.snapshot.filePath), result])
);
const expected = new Map(inventory.rows.map((row) => [row.file, row.expected]));
const mismatches = [...new Set([...expected.keys(), ...actual.keys()])].flatMap((file) => {
  const expectedValue = expected.get(file);
  const result = actual.get(file);
  return expectedValue === undefined || !result || expectedValue !== result.decision.eligible
    ? [{ actual: result?.decision.eligible ?? null, expected: expectedValue ?? null, file }]
    : [];
});
const summary = {
  eligible: report.sessions.filter((result) => result.decision.eligible).length,
  ineligible: report.sessions.filter((result) => result.decision.status === "ineligible").length,
  mismatches,
  sessions: report.sessions.length,
  unavailableSources: report.unavailableSources.length,
  unknown: report.sessions.filter((result) => result.decision.status === "unknown").length,
  unownedWorktrees: report.unownedWorktrees.length
};
const explanations = report.sessions.map((result) => createSessionCleanupReport(result.snapshot));
await Bun.write(
  output,
  `${JSON.stringify({ expectedCapturedAt: inventory.capturedAt, explanations, summary, ...report }, null, 2)}\n`
);
if (textOutput) {
  await Bun.write(textOutput, explanations.map(formatSessionCleanupReport).join("\n"));
}
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (mismatches.length > 0) {
  process.exitCode = 1;
}
