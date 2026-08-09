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
  jobs: z.object({
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
  on: z.object({
    push: z.looseObject({
      branches: z.array(z.string())
    })
  }),
  permissions: z.object({
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

    expect(parsed.jobs.publish.if).toContain("needs.prepare.outputs.relevant");
    expect(parsed.jobs.prepare.environment).toBeUndefined();
    expect(JSON.stringify(parsed.jobs.prepare.steps)).not.toContain(
      "CODERABBIT_SYNC_APP_PRIVATE_KEY"
    );

    const tokenStep = WorkflowStepSchema.parse(
      parsed.jobs.publish.steps.find((step) => step.name === "Create destination token")
    );
    expect(tokenStep.with).toMatchObject({
      "permission-contents": "write",
      "private-key": `\${{ secrets.CODERABBIT_SYNC_APP_PRIVATE_KEY }}`,
      repositories: "coderabbit"
    });

    const checkoutStep = WorkflowStepSchema.parse(
      parsed.jobs.publish.steps.find((step) => step.name === "Checkout central configuration")
    );
    expect(checkoutStep.with).toMatchObject({
      repository: "monke-together-strong/coderabbit"
    });

    const publishStep = WorkflowStepSchema.parse(
      parsed.jobs.publish.steps.find(
        (step) => step.name === "Commit and push generated configuration"
      )
    );
    expect(publishStep.run).toContain("if bot_id=");
    expect(workflow).not.toContain("--force");
  });
});
