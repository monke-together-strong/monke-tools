import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { getExpectedWorktreePath } from "../src/git.ts";
import { getSessionStateFilePath, loadSessionState } from "../src/session-state-store.ts";
import type { SessionMaterializationCheckpoint } from "../src/types.ts";
import {
  createRepo,
  git,
  makeTempDir,
  runMonke,
  runMonkeCapturingFailure,
  write
} from "./helpers.ts";

interface InterruptionCase {
  checkpoint: SessionMaterializationCheckpoint;
  expectedCleanupEligible: boolean;
  expectedGeneration: "complete" | "incomplete";
  expectedMaterialization: "materialized" | "pending";
  expectedPreparation: "pending" | "prepared";
  expectedResourceOutputs: boolean;
}

const INTERRUPTIONS: InterruptionCase[] = [
  {
    checkpoint: "generation-start",
    expectedCleanupEligible: false,
    expectedGeneration: "incomplete",
    expectedMaterialization: "pending",
    expectedPreparation: "pending",
    expectedResourceOutputs: false
  },
  {
    checkpoint: "worktree-ready",
    expectedCleanupEligible: false,
    expectedGeneration: "incomplete",
    expectedMaterialization: "pending",
    expectedPreparation: "pending",
    expectedResourceOutputs: false
  },
  {
    checkpoint: "preparation",
    expectedCleanupEligible: false,
    expectedGeneration: "incomplete",
    expectedMaterialization: "pending",
    expectedPreparation: "prepared",
    expectedResourceOutputs: false
  },
  {
    checkpoint: "repo-progress",
    expectedCleanupEligible: false,
    expectedGeneration: "incomplete",
    expectedMaterialization: "pending",
    expectedPreparation: "prepared",
    expectedResourceOutputs: false
  },
  {
    checkpoint: "cleanup-eligibility",
    expectedCleanupEligible: true,
    expectedGeneration: "incomplete",
    expectedMaterialization: "pending",
    expectedPreparation: "prepared",
    expectedResourceOutputs: false
  },
  {
    checkpoint: "resource-command-output",
    expectedCleanupEligible: true,
    expectedGeneration: "incomplete",
    expectedMaterialization: "pending",
    expectedPreparation: "prepared",
    expectedResourceOutputs: true
  },
  {
    checkpoint: "repo-result",
    expectedCleanupEligible: true,
    expectedGeneration: "incomplete",
    expectedMaterialization: "materialized",
    expectedPreparation: "prepared",
    expectedResourceOutputs: true
  },
  {
    checkpoint: "generation-completion",
    expectedCleanupEligible: true,
    expectedGeneration: "complete",
    expectedMaterialization: "materialized",
    expectedPreparation: "prepared",
    expectedResourceOutputs: true
  }
];

describe("abrupt Session interruption recovery", () => {
  test.each(INTERRUPTIONS)("spawn recovers after $checkpoint", (interruption) => {
    const sandbox = makeTempDir(`session-interruption-${interruption.checkpoint}`);
    const home = path.join(sandbox, "home");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": `bootstrapCommand: printf b >> bootstrap-runs
cleanupCommand: printf c >> cleanup-runs
resources:
  commands:
    identity:
      run: ./resource.ts
      timeoutSeconds: 30
      outputs:
        - TEST_RESOURCE_ID
apps: {}
`,
      "resource.ts": `import { appendFileSync } from "node:fs";

export default function () {
  appendFileSync("resource-runs", "r");
  return { TEST_RESOURCE_ID: "stable-id" };
}
`
    });

    const interrupted = runMonkeCapturingFailure({
      args: ["spawn", "interrupted"],
      cwd: repoRoot,
      extraEnv: { MONKE_TEST_INTERRUPT_CHECKPOINT: interruption.checkpoint },
      monkeHome: home
    });

    expect(interrupted.error).not.toBeNull();
    const partial = loadSessionState(home, repoRoot, "interrupted");
    const [partialRepo] = partial.repos;
    expect(partial.generation.status).toBe(interruption.expectedGeneration);
    expect(partialRepo?.materializationStatus).toBe(interruption.expectedMaterialization);
    expect(partialRepo?.preparationStatus).toBe(interruption.expectedPreparation);
    expect(partialRepo?.cleanupEligible).toBe(interruption.expectedCleanupEligible);
    expect(partialRepo?.resourceCommandOutputs).toStrictEqual(
      interruption.expectedResourceOutputs
        ? [
            {
              name: "identity",
              outputs: [{ env: "TEST_RESOURCE_ID", value: "stable-id" }]
            }
          ]
        : undefined
    );

    const retried = runMonke({
      args: ["spawn", "interrupted"],
      cwd: repoRoot,
      monkeHome: home
    });

    const worktreeRoot = getExpectedWorktreePath(home, repoRoot, "interrupted");
    const recovered = loadSessionState(home, repoRoot, "interrupted");
    expect(retried.stdout).toBe(`${worktreeRoot}\n`);
    expect(recovered.generation.status).toBe("complete");
    expect(recovered.repos[0]?.materializationStatus).toBe("materialized");
    expect(readIfPresent(worktreeRoot, "resource-runs")).toBe("r");
    expect(readIfPresent(worktreeRoot, "bootstrap-runs")).toBe(
      ["generation-completion", "resource-command-output"].includes(interruption.checkpoint)
        ? "bb"
        : "b"
    );
  });

  test("repo-progress interruption retains Cleanup command A before replacement command B is eligible", () => {
    const sandbox = makeTempDir("session-interruption-retained-cleanup");
    const home = path.join(sandbox, "home");
    const oldCleanupMarker = path.join(sandbox, "old-cleanup-ran");
    const oldEffectMarker = path.join(sandbox, "old-effect-created");
    const newCleanupMarker = path.join(sandbox, "new-cleanup-ran");
    const newEffectMarker = path.join(sandbox, "new-effect-created");
    const repoRoot = createRepo(path.join(sandbox, "root"), {
      "monke.yml": `bootstrapCommand: touch "${oldEffectMarker}"
cleanupCommand: touch "${oldCleanupMarker}"
apps: {}
`
    });

    runMonke({ args: ["spawn", "retained"], cwd: repoRoot, monkeHome: home });
    write(
      repoRoot,
      "monke.yml",
      `bootstrapCommand: touch "${newEffectMarker}"
cleanupCommand: touch "${newCleanupMarker}"
apps: {}
`
    );
    git(repoRoot, ["add", "monke.yml"]);
    git(repoRoot, ["commit", "-m", "replace lifecycle commands"]);

    const interrupted = runMonkeCapturingFailure({
      args: ["spawn", "retained"],
      cwd: repoRoot,
      extraEnv: { MONKE_TEST_INTERRUPT_CHECKPOINT: "repo-progress" },
      monkeHome: home
    });

    expect(interrupted.error).not.toBeNull();
    expect(loadSessionState(home, repoRoot, "retained").repos[0]).toMatchObject({
      cleanupCommand: `touch "${oldCleanupMarker}"`,
      cleanupEligible: true,
      materializationStatus: "pending"
    });

    runMonke({ args: ["chop", "retained", "--force"], cwd: repoRoot, monkeHome: home });

    expect(existsSync(oldCleanupMarker)).toBeTruthy();
    expect(existsSync(newCleanupMarker)).toBeFalsy();
    expect(existsSync(newEffectMarker)).toBeFalsy();
    expect(existsSync(getSessionStateFilePath(home, repoRoot, "retained"))).toBeFalsy();
  });
});

function readIfPresent(root: string, relativePath: string) {
  const filePath = path.join(root, relativePath);
  return existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
}
