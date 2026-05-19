import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import { expect, test } from "vitest";

import {
  createRepo,
  git,
  installFakeCodex,
  installFakeGh,
  installGitShim,
  makeTempDir,
  read,
  write,
} from "./helpers.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const cliEntrypoint = path.join(projectRoot, "src/index.ts");

function getInvocationPrompts(stdinLog: string): string[] {
  return stdinLog.split(/\n<<<END-OF-INVOKE-\d+>>>\n/).filter(Boolean);
}

function getRunLogDirectoryName(repoRoot: string): string {
  const logsRoot = path.join(repoRoot, "logs");

  if (!existsSync(logsRoot)) {
    throw new Error(
      `Expected logs directory to exist at ${logsRoot} before reading runLogDirectoryName.`,
    );
  }

  const [runLogDirectoryName] = readdirSync(logsRoot);

  if (!runLogDirectoryName) {
    throw new Error(`Expected ${logsRoot} to contain a runLogDirectoryName entry.`);
  }

  return runLogDirectoryName;
}

test("mt work executes codex from the git repo root, passes the raw plan through, and prints a short summary", () => {
  const sandbox = makeTempDir("run-success");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "nested/feature/.gitkeep": "",
    "README.md": "# sandbox\n",
  });
  const { argsLogPath, cwdLogPath, stdinLogPath, invocationCountPath, phaseLogPath } =
    installFakeCodex(binDirectory);
  const plan = "1. Keep line one\n2. Preserve\n\nFinal line";

  const result = spawnSync("bun", [cliEntrypoint, "work", "--plan", plan], {
    cwd: path.join(repoRoot, "nested/feature"),
    env: {
      ...process.env,
      PATH: [binDirectory, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    },
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  expect(read(sandbox, path.relative(sandbox, invocationCountPath))).toBe("2");
  expect(read(sandbox, path.relative(sandbox, cwdLogPath))).toBe(`${repoRoot}\n${repoRoot}\n`);
  expect(read(sandbox, path.relative(sandbox, phaseLogPath))).toBe("implementer\nreviewer\n");
  const argsLog = read(sandbox, path.relative(sandbox, argsLogPath));
  expect(argsLog.match(/--dangerously-bypass-approvals-and-sandbox/g)).toHaveLength(2);
  expect(argsLog).toContain("--cd");
  expect(argsLog).toContain(repoRoot);
  expect(argsLog).not.toContain("--full-auto");
  expect(argsLog).not.toContain("model_reasoning_effort");
  const stdinLog = read(sandbox, path.relative(sandbox, stdinLogPath));
  expect(stdinLog).toContain(`<<<MONKE_PLAN_START>>>\n${plan}`);
  expect(stdinLog).not.toContain("<<<MONKE_PLAN_END>>>");
  expect(stdinLog).toContain("You are a task implementer for the specified plan below");
  expect(stdinLog).toContain(
    "You are an expert code reviewer focused on enhancing code clarity, consistency, and maintainability while preserving exact functionality.",
  );
  expect(stdinLog).not.toContain("You are the cleanup checkpointing phase.");
  expect(result.stdout).toContain("fake codex stdout");
  expect(result.stdout).toContain(
    "Implementer finished successfully. Reviewer finished successfully.",
  );
  expect(result.stderr).toContain("fake codex stderr");
});

test("mt work forwards effort and writes attempted phase logs", () => {
  const sandbox = makeTempDir("run-effort-logs");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
  });
  const { argsLogPath } = installFakeCodex(binDirectory, {
    implementer: {
      stdoutText: "implementer streamed stdout",
      stderrText: "implementer streamed stderr",
    },
    reviewer: {
      stdoutText: "reviewer streamed stdout",
      stderrText: "reviewer streamed stderr",
    },
  });

  const result = spawnSync(
    "bun",
    [cliEntrypoint, "work", "--plan", "ship it", "--effort", "high"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: [binDirectory, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
      },
      encoding: "utf8",
    },
  );

  expect(result.status).toBe(0);
  const argsLog = read(sandbox, path.relative(sandbox, argsLogPath));
  expect(argsLog.match(/--dangerously-bypass-approvals-and-sandbox/g)).toHaveLength(2);
  expect(argsLog).not.toContain("--full-auto");
  expect(argsLog.match(/model_reasoning_effort="high"/g)).toHaveLength(2);
  expect(result.stdout).toContain("implementer streamed stdout");
  expect(result.stdout).toContain("reviewer streamed stdout");
  expect(result.stderr).toContain("implementer streamed stderr");
  expect(result.stderr).toContain("reviewer streamed stderr");

  const logsRoot = path.join(repoRoot, "logs");
  const runLogDirectoryName = getRunLogDirectoryName(repoRoot);
  expect(runLogDirectoryName).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{6}$/);
  const runLogDirectory = path.join(logsRoot, runLogDirectoryName);
  expect(result.stdout).toContain(runLogDirectory);
  expect(existsSync(path.join(runLogDirectory, "cleanup.log"))).toBe(false);

  const implementerLog = read(repoRoot, path.join("logs", runLogDirectoryName, "implementer.log"));
  expect(implementerLog).toContain("phase: implementer");
  expect(implementerLog).toContain("provider: codex");
  expect(implementerLog).toContain("effort: high");
  expect(implementerLog).toContain("startedAt:");
  expect(implementerLog).toContain("implementer streamed stdout");
  expect(implementerLog).toContain("implementer streamed stderr");

  const reviewerLog = read(repoRoot, path.join("logs", runLogDirectoryName, "reviewer.log"));
  expect(reviewerLog).toContain("phase: reviewer");
  expect(reviewerLog).toContain("provider: codex");
  expect(reviewerLog).toContain("effort: high");
  expect(reviewerLog).toContain("reviewer streamed stdout");
  expect(reviewerLog).toContain("reviewer streamed stderr");
});

test("mt work --prd plans issues, prints the resolved order, and executes the PRD issue loop", () => {
  const sandbox = makeTempDir("run-prd-dispatch");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
  });
  const { argsLogPath, cwdLogPath, stdinLogPath, invocationCountPath, phaseLogPath } =
    installFakeCodex(binDirectory, {
      jsonOutput: JSON.stringify({
        prdIssueNumber: 22,
        taskIssueNumbers: [27],
      }),
      implementer: {
        stdoutText: "implementer completed issue 27",
        stderrText: "implementer diagnostics",
        commitMessage: "implement issue 27",
      },
      reviewer: {
        stdoutText: "reviewer completed issue 27",
        stderrText: "reviewer diagnostics",
      },
      finalPrdReviewer: {
        stdoutText: "final PRD validation passed",
        stderrText: "final PRD validation diagnostics",
      },
    });
  const ghLogPath = installFakeGh(binDirectory, {
    22: {
      title: "PRD issue-loop workflow",
      body: "Parent PRD context.",
      comments: ["PRD clarification."],
    },
    27: {
      title: "Wire PRD dispatcher",
      body: "Add the late PRD dispatcher path.",
      comments: ["Current issue clarification."],
    },
  });

  const result = spawnSync(
    "bun",
    [
      cliEntrypoint,
      "work",
      "--prd",
      "Use PRD https://github.com/monke-together-strong/monke-tools/issues/22",
      "--effort",
      "high",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: [binDirectory, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
      },
      encoding: "utf8",
    },
  );

  expect(result.status).toBe(0);
  expect(read(sandbox, path.relative(sandbox, invocationCountPath))).toBe("4");
  expect(read(sandbox, path.relative(sandbox, cwdLogPath))).toBe(
    `${repoRoot}\n${repoRoot}\n${repoRoot}\n${repoRoot}\n`,
  );
  expect(read(sandbox, path.relative(sandbox, phaseLogPath))).toBe(
    "planner\nimplementer\nreviewer\nfinal-prd-reviewer\n",
  );
  const argsLog = read(sandbox, path.relative(sandbox, argsLogPath));
  expect(argsLog).toContain("--output-schema");
  expect(argsLog).toContain("-s\nread-only");
  expect(argsLog.match(/--dangerously-bypass-approvals-and-sandbox/g)).toHaveLength(3);
  expect(argsLog.match(/model_reasoning_effort="high"/g)).toHaveLength(4);

  const stdinLog = read(sandbox, path.relative(sandbox, stdinLogPath));
  expect(stdinLog).toContain("<<<MONKE_PRD_INPUT_START>>>\nUse PRD https://github.com");
  expect(stdinLog).toContain("PRD #22: PRD issue-loop workflow");
  expect(stdinLog).toContain("Current issue #27: Wire PRD dispatcher");
  expect(stdinLog).toContain("You are the Final PRD Reviewer for a completed PRD-driven workflow.");
  expect(stdinLog).toContain("# Goal Objective");

  const ghLog = read(sandbox, path.relative(sandbox, ghLogPath));
  expect(ghLog).toContain("repo view --json nameWithOwner --jq .nameWithOwner");
  expect(ghLog).toContain("issue view 22 --repo owner/repo --json number,title,body,comments");
  expect(ghLog).toContain("issue view 27 --repo owner/repo --json number,title,body,comments");
  expect(ghLog).toContain("issue close 27 --repo owner/repo");

  const planIndex = result.stdout.indexOf("PRD #22 planned issues: #27.");
  const executionIndex = result.stdout.indexOf("implementer completed issue 27");
  expect(planIndex).toBeGreaterThanOrEqual(0);
  expect(executionIndex).toBeGreaterThan(planIndex);
  expect(result.stdout).toContain("Issue #27:");
  expect(result.stdout).toContain("Issue closed.");
  expect(result.stdout).toContain("final PRD validation passed");
  expect(result.stdout).toContain("Final PRD validation finished successfully.");
  expect(result.stderr).toContain("implementer diagnostics");
  expect(result.stderr).toContain("reviewer diagnostics");
  expect(result.stderr).toContain("final PRD validation diagnostics");

  const runLogDirectoryName = getRunLogDirectoryName(repoRoot);
  const plannerLog = read(repoRoot, path.join("logs", runLogDirectoryName, "planner.log"));
  expect(plannerLog).toContain("phase: planner");
  expect(plannerLog).toContain("provider: codex-json");
  expect(plannerLog).toContain("effort: high");
  expect(plannerLog).toContain("fake codex stdout");
  const finalPrdReviewLog = read(
    repoRoot,
    path.join("logs", runLogDirectoryName, "final-prd-review-proof.log"),
  );
  expect(finalPrdReviewLog).toContain("phase: final-prd-reviewer");
  expect(finalPrdReviewLog).toContain("final PRD validation passed");
});

test("mt work --prd fails before startup cleanup when gh is missing from PATH", () => {
  const sandbox = makeTempDir("run-prd-missing-gh");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
  });
  const { invocationCountPath } = installFakeCodex(binDirectory);
  installGitShim(binDirectory);

  const result = spawnSync(process.execPath, [cliEntrypoint, "work", "--prd", "issue 22"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: binDirectory,
    },
    encoding: "utf8",
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Could not find `gh` on PATH");
  expect(existsSync(invocationCountPath)).toBe(false);
});

test("mt work --prd checkpoints dirty startup work before planning or executing issues", () => {
  const sandbox = makeTempDir("run-prd-cleanup");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
    "dirty.txt": "before\n",
  });
  const { argsLogPath, stdinLogPath, invocationCountPath, phaseLogPath } = installFakeCodex(
    binDirectory,
    {
      jsonOutput: JSON.stringify({
        prdIssueNumber: 22,
        taskIssueNumbers: [27],
      }),
      cleanup: {
        stdoutText: "cleanup checkpointed startup work",
        stderrText: "cleanup diagnostics",
        commitMessage: "clean up: checkpoint dirty work",
      },
      implementer: {
        stdoutText: "implementer completed issue 27",
        stderrText: "implementer diagnostics",
        commitMessage: "implement issue 27",
      },
      reviewer: {
        stdoutText: "reviewer completed issue 27",
        stderrText: "reviewer diagnostics",
      },
      finalPrdReviewer: {
        stdoutText: "final PRD validation passed",
        stderrText: "final PRD validation diagnostics",
      },
    },
  );
  installFakeGh(binDirectory, {
    22: {
      title: "PRD issue-loop workflow",
      body: "Parent PRD context.",
    },
    27: {
      title: "Wire PRD dispatcher",
      body: "Add the late PRD dispatcher path.",
    },
  });
  write(repoRoot, "dirty.txt", "after\n");

  const result = spawnSync(
    "bun",
    [cliEntrypoint, "work", "--prd", "issue 22", "--effort", "high"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: [binDirectory, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
      },
      encoding: "utf8",
    },
  );

  expect(result.status).toBe(0);
  expect(read(sandbox, path.relative(sandbox, invocationCountPath))).toBe("5");
  expect(read(sandbox, path.relative(sandbox, phaseLogPath))).toBe(
    "cleanup\nplanner\nimplementer\nreviewer\nfinal-prd-reviewer\n",
  );
  expect(
    read(sandbox, path.relative(sandbox, argsLogPath)).match(/model_reasoning_effort="high"/g),
  ).toHaveLength(5);
  expect(read(sandbox, path.relative(sandbox, stdinLogPath))).toContain(
    "You are the cleanup checkpointing phase.",
  );
  expect(git(repoRoot, ["show", "-s", "--format=%s", "HEAD~1"])).toBe(
    "clean up: checkpoint dirty work",
  );
  const planIndex = result.stdout.indexOf("PRD #22 planned issues: #27.");
  const cleanupIndex = result.stdout.indexOf("cleanup checkpointed startup work");
  expect(planIndex).toBeGreaterThanOrEqual(0);
  expect(cleanupIndex).toBeGreaterThanOrEqual(0);
  expect(planIndex).toBeGreaterThan(cleanupIndex);
  expect(result.stdout).toContain(
    "Cleanup checkpointed existing changes. PRD #22 planned issues: #27.",
  );
  expect(result.stdout).toContain("Final PRD validation finished successfully.");
  expect(result.stderr).toContain("cleanup diagnostics");
  expect(result.stderr).toContain("final PRD validation diagnostics");
});

test("mt work --prd aborts before planning when startup cleanup fails", () => {
  const sandbox = makeTempDir("run-prd-cleanup-failure");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
    "dirty.txt": "before\n",
  });
  const { stdinLogPath, invocationCountPath, phaseLogPath } = installFakeCodex(binDirectory, {
    jsonOutput: JSON.stringify({
      prdIssueNumber: 22,
      taskIssueNumbers: [27],
    }),
    cleanup: {
      stdoutText: "cleanup failed before planner",
      stderrText: "cleanup failure diagnostics",
      exitCode: 7,
    },
  });
  installFakeGh(binDirectory, {
    22: {
      title: "PRD issue-loop workflow",
      body: "Parent PRD context.",
    },
    27: {
      title: "Wire PRD dispatcher",
      body: "Add the late PRD dispatcher path.",
    },
  });
  write(repoRoot, "dirty.txt", "after\n");

  const result = spawnSync("bun", [cliEntrypoint, "work", "--prd", "issue 22"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: [binDirectory, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    },
    encoding: "utf8",
  });

  expect(result.status).toBe(1);
  expect(read(sandbox, path.relative(sandbox, invocationCountPath))).toBe("1");
  expect(read(sandbox, path.relative(sandbox, phaseLogPath))).toBe("cleanup\n");
  const stdinLog = read(sandbox, path.relative(sandbox, stdinLogPath));
  expect(stdinLog).toContain("You are the cleanup checkpointing phase.");
  expect(stdinLog).not.toContain("<<<MONKE_PRD_INPUT_START>>>");
  expect(result.stdout).toContain("cleanup failed before planner");
  expect(result.stderr).toContain("cleanup failure diagnostics");
  expect(result.stderr).toContain(
    "Cleanup finished with failures (exit code 7). Aborting before implementation.",
  );
});

test("mt work tells the reviewer when there is no implementation diff after a clean implementer run", () => {
  const sandbox = makeTempDir("run-review-target-no-diff");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
  });
  const { stdinLogPath } = installFakeCodex(binDirectory, {
    implementer: {
      stdoutText: "implementer ok",
      stderrText: "implementer diagnostics",
    },
    reviewer: {
      stdoutText: "reviewer ok",
      stderrText: "reviewer diagnostics",
    },
  });

  const result = spawnSync("bun", [cliEntrypoint, "work", "--plan", "ship it"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: [binDirectory, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    },
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  const reviewerPrompt = getInvocationPrompts(
    read(sandbox, path.relative(sandbox, stdinLogPath)),
  )[1];
  expect(reviewerPrompt).toContain("# Explicit review target");
  expect(reviewerPrompt).toContain(
    "There is no implementation diff to review because the checkout is clean and HEAD did not change during implementation.",
  );
  expect(reviewerPrompt).toContain("HEAD is unchanged at:");
});

test("mt work tells the reviewer to inspect the working tree diff when implementation leaves the checkout dirty", () => {
  const sandbox = makeTempDir("run-review-target-dirty");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
  });
  const { stdinLogPath } = installFakeCodex(binDirectory, {
    implementer: {
      stdoutText: "implementer wrote a change",
      stderrText: "implementer diagnostics",
      dirtyFilePath: "dirty.txt",
      dirtyFileContents: "left in working tree\n",
    },
    reviewer: {
      stdoutText: "reviewer ok",
      stderrText: "reviewer diagnostics",
    },
  });

  const result = spawnSync("bun", [cliEntrypoint, "work", "--plan", "ship it"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: [binDirectory, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    },
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  const reviewerPrompt = getInvocationPrompts(
    read(sandbox, path.relative(sandbox, stdinLogPath)),
  )[1];
  expect(reviewerPrompt).toContain("# Explicit review target");
  expect(reviewerPrompt).toContain(
    "Inspect the current working tree diff because the checkout is dirty after implementation.",
  );
  expect(reviewerPrompt).toContain("Status snapshot: ?? dirty.txt");
  expect(git(repoRoot, ["status", "--porcelain", "--untracked-files=normal"])).toBe("?? dirty.txt");
});

test("mt work checkpoints dirty startup work before running the implementer", () => {
  const sandbox = makeTempDir("run-cleanup-success");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
    "staged.txt": "before\n",
    "unstaged.txt": "before\n",
  });
  const { argsLogPath, cwdLogPath, stdinLogPath, invocationCountPath, phaseLogPath } =
    installFakeCodex(binDirectory, {
      cleanup: {
        stdoutText: "cleanup stdout",
        stderrText: "cleanup stderr",
        commitMessage: "clean up: checkpoint dirty work",
      },
      implementer: {
        stdoutText: "implementer stdout",
        stderrText: "implementer stderr",
      },
      reviewer: {
        stdoutText: "reviewer stdout",
        stderrText: "reviewer stderr",
      },
    });

  write(repoRoot, "staged.txt", "after staged change\n");
  git(repoRoot, ["add", "staged.txt"]);
  write(repoRoot, "unstaged.txt", "after unstaged change\n");
  write(repoRoot, "untracked.txt", "brand new file\n");

  const result = spawnSync(
    "bun",
    [cliEntrypoint, "work", "--plan", "ship it", "--effort", "high"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: [binDirectory, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
      },
      encoding: "utf8",
    },
  );

  expect(result.status).toBe(0);
  expect(read(sandbox, path.relative(sandbox, invocationCountPath))).toBe("3");
  const argsLog = read(sandbox, path.relative(sandbox, argsLogPath));
  expect(argsLog.match(/--dangerously-bypass-approvals-and-sandbox/g)).toHaveLength(3);
  expect(argsLog).not.toContain("--full-auto");
  expect(argsLog.match(/model_reasoning_effort="high"/g)).toHaveLength(3);
  expect(read(sandbox, path.relative(sandbox, cwdLogPath))).toBe(
    `${repoRoot}\n${repoRoot}\n${repoRoot}\n`,
  );
  expect(read(sandbox, path.relative(sandbox, phaseLogPath))).toBe(
    "cleanup\nimplementer\nreviewer\n",
  );
  const stdinLog = read(sandbox, path.relative(sandbox, stdinLogPath));
  expect(stdinLog).toContain("You are the cleanup checkpointing phase.");
  expect(stdinLog).toContain("You are a task implementer for the specified plan below");
  expect(stdinLog).toContain(
    "You are an expert code reviewer focused on enhancing code clarity, consistency, and maintainability while preserving exact functionality.",
  );
  expect(git(repoRoot, ["show", "-s", "--format=%s", "HEAD"])).toBe(
    "clean up: checkpoint dirty work",
  );
  expect(result.stdout).toContain("cleanup stdout");
  expect(result.stdout).toContain("implementer stdout");
  expect(result.stdout).toContain("reviewer stdout");
  expect(result.stdout).toContain(
    "Cleanup checkpointed existing changes. Implementer finished successfully. Reviewer finished successfully.",
  );
  const runLogDirectoryName = getRunLogDirectoryName(repoRoot);
  const cleanupLog = read(repoRoot, path.join("logs", runLogDirectoryName, "cleanup.log"));
  expect(cleanupLog).toContain("phase: cleanup");
  expect(cleanupLog).toContain("cleanup stdout");
  expect(cleanupLog).toContain("cleanup stderr");
  expect(result.stderr).toContain("cleanup stderr");
  expect(result.stderr).toContain("implementer stderr");
  expect(result.stderr).toContain("reviewer stderr");
  expect(git(repoRoot, ["status", "--porcelain", "--untracked-files=normal"])).toBe("");
});

test("mt work still runs the reviewer after implementer failures and reports both phase outcomes", () => {
  const sandbox = makeTempDir("run-failure");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
  });
  const { invocationCountPath, phaseLogPath } = installFakeCodex(binDirectory, {
    implementer: {
      stdoutText: "before failure",
      stderrText: "implementer blew up",
      exitCode: 7,
    },
    reviewer: {
      stdoutText: "reviewer still ran",
      stderrText: "reviewer diagnostics",
    },
  });

  const result = spawnSync("bun", [cliEntrypoint, "work", "--plan", "ship it"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: [binDirectory, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    },
    encoding: "utf8",
  });

  expect(result.status).toBe(1);
  expect(read(sandbox, path.relative(sandbox, invocationCountPath))).toBe("2");
  expect(read(sandbox, path.relative(sandbox, phaseLogPath))).toBe("implementer\nreviewer\n");
  expect(result.stdout).toContain("before failure");
  expect(result.stdout).toContain("reviewer still ran");
  expect(result.stderr).toContain("implementer blew up");
  expect(result.stderr).toContain("reviewer diagnostics");
  expect(result.stderr).toContain(
    "Implementer finished with failures (exit code 7). Reviewer finished successfully.",
  );
});

test("mt work aborts before implementation when cleanup does not create the required checkpoint commit", () => {
  const sandbox = makeTempDir("run-cleanup-abort");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
  });
  const { stdinLogPath, invocationCountPath } = installFakeCodex(binDirectory, {
    cleanup: {
      stdoutText: "cleanup attempt",
      stderrText: "cleanup diagnostics",
    },
    implementer: {
      stdoutText: "implementer should not run",
      stderrText: "implementer should not run",
    },
  });

  write(repoRoot, "dirty.txt", "needs checkpointing\n");

  const result = spawnSync("bun", [cliEntrypoint, "work", "--plan", "ship it"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: [binDirectory, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    },
    encoding: "utf8",
  });

  expect(result.status).toBe(1);
  expect(read(sandbox, path.relative(sandbox, invocationCountPath))).toBe("1");
  expect(read(sandbox, path.relative(sandbox, stdinLogPath))).toContain(
    "You are the cleanup checkpointing phase.",
  );
  expect(read(sandbox, path.relative(sandbox, stdinLogPath))).not.toContain(
    "You are a task implementer for the specified plan below",
  );
  expect(result.stdout).toContain("cleanup attempt");
  expect(result.stderr).toContain("cleanup diagnostics");
  expect(result.stderr).toContain(
    'Cleanup did not create the required checkpoint commit (message must start with "clean up"). Aborting before implementation.',
  );
});

test("mt work aborts before implementation when cleanup exits with failures", () => {
  const sandbox = makeTempDir("run-cleanup-failure");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
  });
  const { stdinLogPath, invocationCountPath } = installFakeCodex(binDirectory, {
    cleanup: {
      stdoutText: "cleanup failed output",
      stderrText: "cleanup failed diagnostics",
      exitCode: 7,
    },
    implementer: {
      stdoutText: "implementer should not run",
      stderrText: "implementer should not run",
    },
  });

  write(repoRoot, "dirty.txt", "needs checkpointing\n");

  const result = spawnSync("bun", [cliEntrypoint, "work", "--plan", "ship it"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: [binDirectory, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    },
    encoding: "utf8",
  });

  expect(result.status).toBe(1);
  expect(read(sandbox, path.relative(sandbox, invocationCountPath))).toBe("1");
  expect(read(sandbox, path.relative(sandbox, stdinLogPath))).toContain(
    "You are the cleanup checkpointing phase.",
  );
  expect(read(sandbox, path.relative(sandbox, stdinLogPath))).not.toContain(
    "You are a task implementer for the specified plan below",
  );
  expect(result.stdout).toContain("cleanup failed output");
  expect(result.stderr).toContain("cleanup failed diagnostics");
  expect(result.stderr).toContain(
    "Cleanup finished with failures (exit code 7). Aborting before implementation.",
  );
});

test("mt work aborts before implementation when cleanup creates a checkpoint commit with an invalid subject", () => {
  const sandbox = makeTempDir("run-cleanup-invalid-subject");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
  });
  const { stdinLogPath, invocationCountPath } = installFakeCodex(binDirectory, {
    cleanup: {
      stdoutText: "cleanup invalid subject output",
      stderrText: "cleanup invalid subject diagnostics",
      commitMessage: "checkpoint dirty work",
    },
    implementer: {
      stdoutText: "implementer should not run",
      stderrText: "implementer should not run",
    },
  });

  write(repoRoot, "dirty.txt", "needs checkpointing\n");

  const result = spawnSync("bun", [cliEntrypoint, "work", "--plan", "ship it"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: [binDirectory, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    },
    encoding: "utf8",
  });

  expect(result.status).toBe(1);
  expect(read(sandbox, path.relative(sandbox, invocationCountPath))).toBe("1");
  expect(read(sandbox, path.relative(sandbox, stdinLogPath))).toContain(
    "You are the cleanup checkpointing phase.",
  );
  expect(read(sandbox, path.relative(sandbox, stdinLogPath))).not.toContain(
    "You are a task implementer for the specified plan below",
  );
  expect(result.stdout).toContain("cleanup invalid subject output");
  expect(result.stderr).toContain("cleanup invalid subject diagnostics");
  expect(result.stderr).toContain(
    'Cleanup created "checkpoint dirty work" but the commit message must start with "clean up". Aborting before implementation.',
  );
});

test("mt work aborts before implementation when cleanup leaves the checkout dirty", () => {
  const sandbox = makeTempDir("run-cleanup-dirty");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
    "staged.txt": "before\n",
    "unstaged.txt": "before\n",
  });
  const { stdinLogPath, invocationCountPath } = installFakeCodex(binDirectory, {
    cleanup: {
      stdoutText: "cleanup partial",
      stderrText: "cleanup left dirt",
      commitMessage: "clean up: partial checkpoint",
      stageAll: false,
    },
    implementer: {
      stdoutText: "implementer should not run",
      stderrText: "implementer should not run",
    },
  });

  write(repoRoot, "staged.txt", "after staged change\n");
  git(repoRoot, ["add", "staged.txt"]);
  write(repoRoot, "unstaged.txt", "after unstaged change\n");
  write(repoRoot, "untracked.txt", "brand new file\n");

  const result = spawnSync("bun", [cliEntrypoint, "work", "--plan", "ship it"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: [binDirectory, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    },
    encoding: "utf8",
  });

  expect(result.status).toBe(1);
  expect(read(sandbox, path.relative(sandbox, invocationCountPath))).toBe("1");
  expect(read(sandbox, path.relative(sandbox, stdinLogPath))).toContain(
    "You are the cleanup checkpointing phase.",
  );
  expect(read(sandbox, path.relative(sandbox, stdinLogPath))).not.toContain(
    "You are a task implementer for the specified plan below",
  );
  expect(result.stdout).toContain("cleanup partial");
  expect(result.stderr).toContain("cleanup left dirt");
  expect(result.stderr).toContain("Cleanup left the checkout dirty");
  expect(result.stderr).toContain(" M unstaged.txt");
  expect(result.stderr).toContain("?? untracked.txt");
});

test("mt work fails when the implementer creates a commit", () => {
  const sandbox = makeTempDir("run-implementer-commit");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
  });

  const { invocationCountPath, phaseLogPath, stdinLogPath } = installFakeCodex(binDirectory, {
    implementer: {
      stdoutText: "implementer committed",
      stderrText: "implementer diagnostics",
      commitMessage: "implementer commit",
    },
    reviewer: {
      stdoutText: "reviewer still ran",
      stderrText: "reviewer diagnostics",
    },
  });

  const result = spawnSync("bun", [cliEntrypoint, "work", "--plan", "ship it"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: [binDirectory, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    },
    encoding: "utf8",
  });

  expect(result.status).toBe(1);
  expect(read(sandbox, path.relative(sandbox, invocationCountPath))).toBe("2");
  expect(read(sandbox, path.relative(sandbox, phaseLogPath))).toBe("implementer\nreviewer\n");
  expect(result.stdout).toContain("implementer committed");
  expect(result.stdout).toContain("reviewer still ran");
  expect(result.stderr).toContain("implementer diagnostics");
  expect(result.stderr).toContain("reviewer diagnostics");
  const reviewerPrompt = getInvocationPrompts(
    read(sandbox, path.relative(sandbox, stdinLogPath)),
  )[1];
  expect(reviewerPrompt).toContain(
    "Inspect the last commit because HEAD changed during implementation and the checkout is now clean.",
  );
  expect(reviewerPrompt).toContain("Commit:");
  expect(reviewerPrompt).toContain("implementer commit");
  expect(result.stderr).toContain(
    'Implementer finished successfully. Implementer created commit "implementer commit" but implementer must not create commits. Reviewer finished successfully.',
  );
});

test("mt work surfaces reviewer failures in the final summary", () => {
  const sandbox = makeTempDir("run-reviewer-failure");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
  });

  installFakeCodex(binDirectory, {
    implementer: {
      stdoutText: "implementer ok",
      stderrText: "implementer diagnostics",
    },
    reviewer: {
      stdoutText: "reviewer blew up",
      stderrText: "reviewer diagnostics",
      exitCode: 9,
    },
  });

  const result = spawnSync("bun", [cliEntrypoint, "work", "--plan", "ship it"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: [binDirectory, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    },
    encoding: "utf8",
  });

  expect(result.status).toBe(1);
  expect(result.stdout).toContain("implementer ok");
  expect(result.stdout).toContain("reviewer blew up");
  expect(result.stderr).toContain("implementer diagnostics");
  expect(result.stderr).toContain("reviewer diagnostics");
  expect(result.stderr).toContain(
    "Implementer finished successfully. Reviewer finished with failures (exit code 9).",
  );
});

test("mt work fails when the reviewer creates a commit", () => {
  const sandbox = makeTempDir("run-reviewer-commit");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
  });

  installFakeCodex(binDirectory, {
    reviewer: {
      stdoutText: "reviewer committed",
      stderrText: "reviewer diagnostics",
      commitMessage: "reviewer commit",
    },
  });

  const result = spawnSync("bun", [cliEntrypoint, "work", "--plan", "ship it"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: [binDirectory, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    },
    encoding: "utf8",
  });

  expect(result.status).toBe(1);
  expect(result.stdout).toContain("reviewer committed");
  expect(result.stderr).toContain("reviewer diagnostics");
  expect(result.stderr).toContain(
    'Implementer finished successfully. Reviewer finished successfully. Reviewer created commit "reviewer commit" but reviewer must not create commits.',
  );
});
