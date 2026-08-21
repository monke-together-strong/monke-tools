import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { parse } from "yaml";
import * as z from "zod";

const StepSchema = z.looseObject({
  name: z.string(),
  run: z.string().optional(),
  uses: z.string().optional()
});
const JobSchema = z.looseObject({
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  steps: z.array(StepSchema),
  strategy: z
    .looseObject({
      matrix: z.looseObject({ include: z.array(z.record(z.string(), z.string())) })
    })
    .optional()
});
const WorkflowSchema = z.looseObject({
  concurrency: z.looseObject({
    "cancel-in-progress": z.literal(false),
    group: z.string()
  }),
  jobs: z.record(z.string(), JobSchema),
  on: z.looseObject({ push: z.looseObject({ branches: z.array(z.string()) }) })
});

const workflowPath = path.join(import.meta.dirname, "..", ".github", "workflows", "publish.yml");

function readWorkflow() {
  const source = readFileSync(workflowPath, "utf-8");
  return { parsed: WorkflowSchema.parse(parse(source)), source };
}

function stepIndex(job: z.output<typeof JobSchema>, name: string) {
  return job.steps.findIndex((step) => step.name === name);
}

describe("Mainline publication workflow", () => {
  test("serializes qualifying main pushes and derives the patch version inside that boundary", () => {
    const { parsed } = readWorkflow();
    expect(parsed.on.push.branches).toStrictEqual(["main"]);
    expect(parsed.concurrency["cancel-in-progress"]).toBeFalsy();

    const prepare = JobSchema.parse(parsed.jobs["prepare-release"]);
    const selection = StepSchema.parse(
      prepare.steps.find((step) => step.name === "Select Mainline release")
    );
    expect(selection.run).toContain("release-bundle.ts relevant");
    expect(selection.run).toContain("release-bundle.ts next-version");
  });

  test("checks main without repeating the pull-request unit test command", () => {
    const { source } = readWorkflow();
    expect(source).toContain("vp check");
    expect(source).not.toContain("vp run test");
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

  test("validates every asset before publishing one draft-backed immutable Release", () => {
    const { parsed } = readWorkflow();
    const publish = JobSchema.parse(parsed.jobs["publish-release"]);
    expect(publish.needs).toStrictEqual(["prepare-release", "build-release"]);
    expect(stepIndex(publish, "Generate checksums")).toBeLessThan(
      stepIndex(publish, "Verify complete Release")
    );
    expect(stepIndex(publish, "Verify complete Release")).toBeLessThan(
      stepIndex(publish, "Create draft Release")
    );
    expect(stepIndex(publish, "Upload all Release assets")).toBeLessThan(
      stepIndex(publish, "Publish immutable Release")
    );
  });

  test("keeps existing package publication independent", () => {
    const { source } = readWorkflow();
    expect(source).toContain("vp run tegami ci");
  });
});
