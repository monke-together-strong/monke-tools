import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { parse } from "yaml";
import {
  array as arraySchema,
  literal,
  looseObject,
  never as neverSchema,
  record,
  strictObject,
  string as stringSchema,
  unknown as unknownSchema
} from "zod";

const WorkflowStepSchema = looseObject({
  env: record(stringSchema(), unknownSchema()).optional(),
  name: stringSchema(),
  run: stringSchema().optional(),
  uses: stringSchema().optional(),
  with: record(stringSchema(), unknownSchema()).optional()
});

const WorkflowSchema = looseObject({
  jobs: strictObject({
    prepare: looseObject({
      environment: neverSchema().optional(),
      steps: arraySchema(WorkflowStepSchema)
    }),
    publish: looseObject({
      environment: literal("coderabbit-sync"),
      if: stringSchema(),
      steps: arraySchema(WorkflowStepSchema)
    })
  }),
  on: strictObject({
    pull_request: strictObject({}),
    push: strictObject({
      branches: arraySchema(stringSchema())
    })
  }),
  permissions: strictObject({
    contents: literal("read")
  })
});

const workflowPath = path.join(
  import.meta.dirname,
  "..",
  ".github",
  "workflows",
  "sync-coderabbit.yaml"
);

function readWorkflow() {
  const source = readFileSync(workflowPath, "utf-8");
  return { parsed: WorkflowSchema.parse(parse(source)), source };
}

describe("CodeRabbit synchronization workflow", () => {
  test("runs relevance detection for pull requests and main pushes", () => {
    const { parsed } = readWorkflow();

    expect(Object.keys(parsed.on)).toStrictEqual(["pull_request", "push"]);
    expect(parsed.on.pull_request).toStrictEqual({});
    expect(parsed.on.push.branches).toStrictEqual(["main"]);
    expect(parsed.permissions).toStrictEqual({ contents: "read" });

    const relevanceStep = WorkflowStepSchema.parse(
      parsed.jobs.prepare.steps.find((step) => step.name === "Detect relevant changes")
    );
    expect(relevanceStep.env).toStrictEqual({
      AFTER_SHA: `\${{ github.sha }}`,
      BEFORE_SHA: `\${{ github.event.pull_request.base.sha || github.event.before }}`
    });
  });

  test("validates one configuration artifact before publishing", () => {
    const { parsed } = readWorkflow();
    const setupBunIndex = parsed.jobs.prepare.steps.findIndex((step) => step.name === "Setup Bun");
    const installDependenciesIndex = parsed.jobs.prepare.steps.findIndex(
      (step) => step.name === "Install dependencies"
    );
    const setupBunStep = WorkflowStepSchema.parse(parsed.jobs.prepare.steps[setupBunIndex]);
    expect(setupBunStep.uses).toBe("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
    expect(setupBunStep.with).toStrictEqual({ "bun-version-file": "package.json" });
    expect(setupBunIndex).toBeLessThan(installDependenciesIndex);

    const installCliStep = WorkflowStepSchema.parse(
      parsed.jobs.prepare.steps.find((step) => step.name === "Install pinned CodeRabbit CLI")
    );
    expect(installCliStep.run).toContain('chmod 755 "$RUNNER_TEMP/coderabbit-cli/coderabbit"');

    const validateIndex = parsed.jobs.prepare.steps.findIndex(
      (step) => step.name === "Validate configuration"
    );
    const uploadIndex = parsed.jobs.prepare.steps.findIndex(
      (step) => step.name === "Upload validated configuration"
    );
    const uploadStep = WorkflowStepSchema.parse(parsed.jobs.prepare.steps[uploadIndex]);
    expect(uploadStep.uses).toBe(
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"
    );
    expect(uploadStep.with).toStrictEqual({
      "if-no-files-found": "error",
      "include-hidden-files": true,
      name: "coderabbit-configuration",
      path: `\${{ runner.temp }}/coderabbit-generated/.coderabbit.yaml`,
      "retention-days": 1
    });
    expect(validateIndex).toBeLessThan(uploadIndex);

    const downloadStep = WorkflowStepSchema.parse(
      parsed.jobs.publish.steps.find((step) => step.name === "Download validated configuration")
    );
    expect(downloadStep.uses).toBe(
      "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093"
    );
    expect(downloadStep.with).toStrictEqual({
      name: "coderabbit-configuration",
      path: `\${{ runner.temp }}/coderabbit-generated`
    });
    expect(parsed.jobs.publish.steps.map((step) => step.name)).not.toContain("Setup Bun");
    expect(parsed.jobs.publish.steps.map((step) => step.name)).not.toContain(
      "Install pinned CodeRabbit CLI"
    );
  });

  test("keeps the destination credential in the relevant publish job", () => {
    const { parsed, source } = readWorkflow();

    expect(parsed.jobs.publish.if).toBe(
      "github.event_name == 'push' && needs.prepare.outputs.relevant == 'true'"
    );
    expect(parsed.jobs.prepare.environment).toBeUndefined();
    expect(source.match(/CODERABBIT_SYNC_APP_PRIVATE_KEY/gu) ?? []).toHaveLength(1);

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
  });

  test("publishes only the generated central configuration", () => {
    const { parsed, source } = readWorkflow();

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
    expect(source).not.toContain("--force");
  });
});
