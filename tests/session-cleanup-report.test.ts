import { ok } from "node:assert/strict";

import { describe, expect, test } from "vitest";

import type { SessionCleanupEvidence } from "../src/session-cleanup-eligibility.ts";
import {
  createSessionCleanupReport,
  formatSessionCleanupReport
} from "../src/session-cleanup-report.ts";

const head = "a".repeat(40);
function fixture(): SessionCleanupEvidence {
  return {
    blockers: [],
    filePath: "/home/sessions/session.yml",
    members: ["dependency", "root"].map((name) => ({
      evidence: {
        ancestorOfDefault: true,
        branch: "feature/work",
        candidate: { sourceRoot: `/sources/${name}`, worktreePath: `/worktrees/${name}` },
        committedWorkAttempted: true,
        head,
        localBlock: null,
        repository: {
          defaultBranch: "main",
          defaultHead: head,
          name: `owner/${name}`,
          pullRequests:
            name === "dependency"
              ? []
              : [
                  {
                    base: { ref: "main", repo: { full_name: "owner/root" } },
                    head: { ref: "feature/work", repo: { full_name: "owner/root" }, sha: head },
                    html_url: "https://github.com/owner/root/pull/1",
                    merged_at: "2026-09-06T00:00:00Z",
                    number: 1,
                    state: "closed"
                  }
                ]
        },
        worktreeAgeMs: 2 * 24 * 60 * 60 * 1000
      },
      mode: "live",
      sourceRoot: `/sources/${name}`,
      worktreePath: `/worktrees/${name}`
    })),
    problems: [],
    rootSourceRoot: "/sources/root",
    session: "feature/work"
  };
}

describe("Session cleanup explanations", () => {
  test("a dirty dependency names its path and distinguishes skipped PR checks from passing Root proof", () => {
    const snapshot = fixture();
    const [dependency] = snapshot.members;
    ok(dependency?.evidence, "Missing fixture member");
    dependency.evidence.localBlock = {
      code: "dirty-worktree",
      eligible: false,
      evidence: [],
      status: "ineligible"
    };
    dependency.evidence.committedWorkAttempted = false;
    dependency.evidence.repository = null;
    const report = createSessionCleanupReport(snapshot);
    expect(report.outcome).toBe("skipped");
    expect(report.members[0]?.checks.committedWork.status).toBe("not-checked");
    expect(report.members[1]?.checks.committedWork).toMatchObject({
      code: "exact-merged-pr",
      status: "passed"
    });
    const text = formatSessionCleanupReport(report);
    expect(text).toContain("/worktrees/dependency");
    expect(text).toContain("Committed work [not-checked]");
    expect(text).toContain("Entire Session retained; no removal attempted.");
  });

  test.each([undefined, true])(
    "does not claim skipped PR checks from incomplete or invalidated evidence: %s",
    (attempted) => {
      const snapshot = fixture();
      const [dependency] = snapshot.members;
      ok(dependency?.evidence, "Missing fixture member");
      dependency.evidence.localBlock = {
        code: "dirty-worktree",
        eligible: false,
        evidence: [],
        status: "ineligible"
      };
      dependency.evidence.committedWorkAttempted = attempted;
      const report = createSessionCleanupReport(snapshot);
      expect(report.members[0]?.checks.committedWork.status).toBe("unknown");
    }
  );

  test("retains multiple reasons and identifies conflicting ownership", () => {
    const snapshot = fixture();
    snapshot.blockers = ["ownership-conflict"];
    snapshot.problems = [
      {
        code: "ownership-conflict",
        message: "Worktree /worktrees/dependency is also recorded by Session other"
      }
    ];
    const report = createSessionCleanupReport(snapshot);
    expect(report.outcome).toBe("skipped");
    expect(formatSessionCleanupReport(report)).toContain("also recorded by Session other");
  });

  test("failed member revalidation cannot leave a passing local check in the explanation", () => {
    const snapshot = fixture();
    snapshot.blockers = ["member-changed-during-inspection"];
    snapshot.problems = [
      {
        code: "member-changed-during-inspection",
        message: "Registration changed",
        worktreePath: "/worktrees/dependency"
      }
    ];
    const report = createSessionCleanupReport(snapshot);
    expect(report.members[0]?.checks.local.status).toBe("unknown");
    expect(report.members[0]?.checks.committedWork.status).toBe("unknown");
  });

  test("older evidence with a member problem keeps unknown check coverage", () => {
    const snapshot = fixture();
    const [member] = snapshot.members;
    ok(member?.evidence, "Missing fixture member");
    delete member.evidence.committedWorkAttempted;
    snapshot.blockers = ["member-changed-during-inspection"];
    snapshot.problems = [
      {
        code: "member-changed-during-inspection",
        message: "Registration changed",
        worktreePath: member.worktreePath
      }
    ];
    const report = createSessionCleanupReport(snapshot);
    expect(report.members[0]?.checks.committedWork.status).toBe("unknown");
    expect(formatSessionCleanupReport(report)).not.toContain("Committed work [not-checked]");
  });

  test("verified absent members need no PR check while the remaining member must still pass", () => {
    const snapshot = fixture();
    const [dependency] = snapshot.members;
    ok(dependency, "Missing fixture member");
    dependency.mode = "gone";
    dependency.evidence = null;
    const report = createSessionCleanupReport(snapshot);
    expect(report.outcome).toBe("eligible");
    expect(report.eligibility.kind).toBe("recovery");
    expect(report.members[0]?.checks.committedWork.status).toBe("not-needed");
    expect(formatSessionCleanupReport(report)).toContain("Eligible (not attempted)");
  });

  test("failed teardown reports its step and repo without claiming the whole Session was retained", () => {
    const report = createSessionCleanupReport(fixture(), {
      message: "Channel deletion failed",
      outcome: "failed",
      sourceRoot: "/sources/root",
      step: "teardown"
    });
    expect(report.outcome).toBe("failed");
    const text = formatSessionCleanupReport(report);
    expect(text).toContain("teardown failed in /sources/root: Channel deletion failed");
    expect(text).toContain("earlier steps may have succeeded");
    expect(text).not.toContain("Entire Session retained");
  });

  test("only an execution result can label a Session cleaned", () => {
    const snapshot = fixture();
    expect(createSessionCleanupReport(snapshot).outcome).toBe("eligible");
    expect(createSessionCleanupReport(snapshot, { outcome: "cleaned" }).outcome).toBe("cleaned");
  });
});
