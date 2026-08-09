import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { parse } from "yaml";
import * as z from "zod";

const WorkflowStepSchema = z.looseObject({
  name: z.string(),
  run: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional()
});

const WorkflowSchema = z.looseObject({
  jobs: z.looseObject({
    prepare: z.looseObject({
      environment: z.never().optional(),
      steps: z.array(WorkflowStepSchema)
    }),
    publish: z.looseObject({
      environment: z.literal("coderabbit-sync"),
      if: z.string(),
      steps: z.array(WorkflowStepSchema)
    })
  }),
  on: z.strictObject({
    push: z.looseObject({
      branches: z.array(z.string())
    })
  }),
  permissions: z.strictObject({
    contents: z.literal("read")
  })
});

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
    const parsed = WorkflowSchema.parse(parse(workflow));
    expect(Object.keys(parsed.on)).toStrictEqual(["push"]);
    expect(parsed.on.push.branches).toStrictEqual(["main"]);
    expect(parsed.permissions).toStrictEqual({ contents: "read" });

    expect(parsed.jobs.publish.if).toBe("needs.prepare.outputs.relevant == 'true'");
    expect(parsed.jobs.prepare.environment).toBeUndefined();
    expect(workflow.match(/CODERABBIT_SYNC_APP_PRIVATE_KEY/gu) ?? []).toHaveLength(1);

    const tokenStep = WorkflowStepSchema.parse(
      parsed.jobs.publish.steps.find((step) => step.name === "Create destination token")
    );
    expect(tokenStep.with).toStrictEqual({
      "app-id": `\${{ vars.CODERABBIT_SYNC_APP_ID }}`,
      owner: "monke-together-strong",
      "permission-contents": "write",
      "private-key": `\${{ secrets.CODERABBIT_SYNC_APP_PRIVATE_KEY }}`,
      repositories: "coderabbit"
    });

    const checkoutStep = WorkflowStepSchema.parse(
      parsed.jobs.publish.steps.find((step) => step.name === "Checkout central configuration")
    );
    expect(checkoutStep.with).toStrictEqual({
      path: "coderabbit",
      ref: "main",
      repository: "monke-together-strong/coderabbit",
      token: `\${{ steps.app-token.outputs.token }}`
    });

    const publishStep = WorkflowStepSchema.parse(
      parsed.jobs.publish.steps.find(
        (step) => step.name === "Commit and push generated configuration"
      )
    );
    expect(publishStep.run).toContain("if bot_id=");
    expect(publishStep.run).toContain("git add -- .coderabbit.yaml");
    expect(publishStep.run).toContain('changed_paths="$(git diff --cached --name-only)"');
    expect(publishStep.run).toContain('if [ "$changed_paths" != ".coderabbit.yaml" ]; then');
    expect(publishStep.run).toContain("git push origin HEAD:main");
    expect(workflow).not.toContain("--force");
  });
});
