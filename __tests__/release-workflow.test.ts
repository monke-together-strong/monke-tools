import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { parse } from "yaml";
import {
  array as arraySchema,
  literal,
  looseObject,
  record,
  string as stringSchema,
  union
} from "zod";
import type { output } from "zod";

const StepSchema = looseObject({
  name: stringSchema(),
  run: stringSchema().optional(),
  uses: stringSchema().optional()
});
const JobSchema = looseObject({
  needs: union([stringSchema(), arraySchema(stringSchema())]).optional(),
  steps: arraySchema(StepSchema).default([]),
  strategy: looseObject({
    matrix: looseObject({ include: arraySchema(record(stringSchema(), stringSchema())) })
  }).optional(),
  uses: stringSchema().optional()
});
const WorkflowSchema = looseObject({
  concurrency: looseObject({
    "cancel-in-progress": literal(false),
    group: stringSchema(),
    queue: literal("max")
  }),
  jobs: record(stringSchema(), JobSchema),
  on: looseObject({ push: looseObject({ branches: arraySchema(stringSchema()) }) })
});

const workflowPath = path.join(import.meta.dirname, "..", ".github", "workflows", "publish.yml");
const packageWorkflowPath = path.join(
  import.meta.dirname,
  "..",
  ".github",
  "workflows",
  "publish-packages.yml"
);
const pullRequestWorkflowPath = path.join(
  import.meta.dirname,
  "..",
  ".github",
  "workflows",
  "pr.yml"
);
const setupActionPath = path.join(
  import.meta.dirname,
  "..",
  ".github",
  "actions",
  "setup-mainline",
  "action.yml"
);
const verifyWorkflowPath = path.join(
  import.meta.dirname,
  "..",
  ".github",
  "workflows",
  "verify-mainline.yml"
);

function readWorkflow() {
  const source = readFileSync(workflowPath, "utf-8");
  return { parsed: WorkflowSchema.parse(parse(source)), source };
}

function stepIndex(job: output<typeof JobSchema>, name: string) {
  return job.steps.findIndex((step) => step.name === name);
}

describe("Mainline publication workflow", () => {
  test("serializes qualifying main pushes and derives the patch version inside that boundary", () => {
    const { parsed } = readWorkflow();
    expect(parsed.on.push.branches).toStrictEqual(["main"]);
    expect(parsed.concurrency["cancel-in-progress"]).toBeFalsy();
    expect(parsed.concurrency.queue).toBe("max");

    const prepare = JobSchema.parse(parsed.jobs["prepare-release"]);
    const selection = StepSchema.parse(
      prepare.steps.find((step) => step.name === "Select Mainline release")
    );
    expect(selection.run).toContain("release-bundle.ts relevant");
    expect(selection.run).toContain("release-bundle.ts next-version");
    expect(selection.run).toContain("git cat-file -e");
    expect(selection.run).toContain("relevant=true");
    expect(selection.run).not.toContain("BEFORE_SHA=0000000000000000000000000000000000000000");
  });

  test("checks main without repeating the pull-request unit test command", () => {
    const { source } = readWorkflow();
    const setupAction = readFileSync(setupActionPath, "utf-8");
    const pullRequestSource = readFileSync(pullRequestWorkflowPath, "utf-8");
    const verifySource = readFileSync(verifyWorkflowPath, "utf-8");
    expect(source).toContain("./.github/workflows/verify-mainline.yml");
    expect(verifySource).toContain("./.github/actions/setup-mainline");
    expect(setupAction).toContain("vp install --frozen-lockfile -- --prefer-offline");
    expect(verifySource).toContain("vp check");
    expect(source).not.toContain("vp run test");
    expect(verifySource).not.toContain("vp run test");
    expect(pullRequestSource).toContain("vp run test");
    expect(pullRequestSource).toContain("vp install --frozen-lockfile -- --prefer-offline");
  });

  test("builds and verifies both supported platform archives", () => {
    const { parsed } = readWorkflow();
    const build = JobSchema.parse(parsed.jobs["build-release"]);
    expect(build.strategy?.matrix.include).toStrictEqual([
      { platform: "macos-arm64", runner: "macos-14" },
      { platform: "linux-x64", runner: "ubuntu-24.04" }
    ]);
    expect(stepIndex(build, "Build Release bundle")).toBeGreaterThan(-1);
    expect(stepIndex(build, "Smoke check executable and verify archive")).toBeGreaterThan(
      stepIndex(build, "Build Release bundle")
    );
    expect(stepIndex(build, "Upload verified archive")).toBeGreaterThan(
      stepIndex(build, "Smoke check executable and verify archive")
    );
  });

  test("publishes immutable version assets before advancing the catalog branch", () => {
    const { parsed } = readWorkflow();
    const publish = JobSchema.parse(parsed.jobs["publish-release"]);
    expect(publish.needs).toStrictEqual(["prepare-release", "build-release"]);
    expect(stepIndex(publish, "Generate checksums")).toBeLessThan(
      stepIndex(publish, "Verify complete Release")
    );
    expect(stepIndex(publish, "Verify complete Release")).toBeLessThan(
      stepIndex(publish, "Create draft Release")
    );
    const createDraft = StepSchema.parse(
      publish.steps.find((step) => step.name === "Create draft Release")
    );
    expect(createDraft.run).toContain("gh release delete");
    expect(stepIndex(publish, "Upload all Release assets")).toBeLessThan(
      stepIndex(publish, "Publish immutable Release")
    );
    expect(stepIndex(publish, "Publish immutable Release")).toBeLessThan(
      stepIndex(publish, "Publish stable Release catalog")
    );
    const publishCatalog = StepSchema.parse(
      publish.steps.find((step) => step.name === "Publish stable Release catalog")
    );
    expect(publishCatalog.run).toContain("monke-tools-release-catalog");
    expect(publishCatalog.run).toContain("stable.tsv");
    expect(publishCatalog.run).toContain("release-bundle.ts catalog");
    expect(publishCatalog.run).toContain("git/ref/heads");
    expect(publishCatalog.run).toContain("contents/stable.tsv");
    expect(publishCatalog.run).not.toContain("gh release");
  });

  test("keeps existing package publication independent", () => {
    const { source } = readWorkflow();
    const packageSource = readFileSync(packageWorkflowPath, "utf-8");
    expect(source).not.toContain("vp run tegami ci");
    expect(packageSource).toContain("vp run tegami ci");
    expect(packageSource).toContain("./.github/workflows/verify-mainline.yml");
  });
});
