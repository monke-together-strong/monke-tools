import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { parse } from "yaml";

const workflowPath = path.join(
  import.meta.dirname,
  "..",
  ".github",
  "workflows",
  "sync-coderabbit.yaml"
);

describe("CodeRabbit synchronization workflow", () => {
  test("keeps the destination credential in the relevant publish job", () => {
    const workflow = readFileSync(workflowPath, "utf-8");
    expect(() => {
      parse(workflow);
    }).not.toThrow();
    expect(workflow).not.toContain("pull_request_target:");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toContain("schedule:");
    expect(workflow).toContain("environment: coderabbit-sync");
    expect(workflow).toContain("repositories: coderabbit");
    expect(workflow).toContain("permission-contents: write");
    expect(workflow).toContain("repository: monke-together-strong/coderabbit");
    expect(workflow).not.toContain("--force");

    const publishJob = workflow.indexOf("  publish:");
    const privateKey = workflow.indexOf("secrets.CODERABBIT_SYNC_APP_PRIVATE_KEY");
    expect(publishJob).toBeGreaterThan(0);
    expect(privateKey).toBeGreaterThan(publishJob);
  });
});
