import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { createRepo, git, installFakeCodex, makeTempDir, read, write } from "./helpers.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const cliEntrypoint = path.join(projectRoot, "src/index.ts");

function getInvocationPrompts(stdinLog: string): string[] {
  return stdinLog.split(/\n<<<END-OF-INVOKE-\d+>>>\n/).filter(Boolean);
}

test("mt run executes codex from the git repo root, passes the raw plan through, and prints a short summary", () => {
  const sandbox = makeTempDir("run-success");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "nested/feature/.gitkeep": "",
    "README.md": "# sandbox\n",
  });
  const { argsLogPath, cwdLogPath, stdinLogPath, invocationCountPath, phaseLogPath } =
    installFakeCodex(binDirectory);
  const plan = "1. Keep line one\n2. Preserve\n\nFinal line";

  const result = spawnSync("bun", [cliEntrypoint, "run", "--plan", plan], {
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
  expect(read(sandbox, path.relative(sandbox, argsLogPath))).toContain("--cd");
  expect(read(sandbox, path.relative(sandbox, argsLogPath))).toContain(repoRoot);
  const stdinLog = read(sandbox, path.relative(sandbox, stdinLogPath));
  expect(stdinLog).toContain(`<<<MONKE_PLAN_START>>>\n${plan}`);
  expect(stdinLog).not.toContain("<<<MONKE_PLAN_END>>>");
  expect(stdinLog).toContain("You are an task implementer for the specified plan below");
  expect(stdinLog).toContain("You are an expert code reviewer focused on enhancing code clarity, consistency, and maintainability while preserving exact functionality.");
  expect(stdinLog).not.toContain("You are the cleanup checkpointing phase.");
  expect(result.stdout).toContain("fake codex stdout");
  expect(result.stdout).toContain(
    "Implementer finished successfully. Reviewer finished successfully.",
  );
  expect(result.stderr).toContain("fake codex stderr");
});

test("mt run tells the reviewer when there is no implementation diff after a clean implementer run", () => {
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

  const result = spawnSync("bun", [cliEntrypoint, "run", "--plan", "ship it"], {
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

test("mt run tells the reviewer to inspect the working tree diff when implementation leaves the checkout dirty", () => {
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

  const result = spawnSync("bun", [cliEntrypoint, "run", "--plan", "ship it"], {
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

test("mt run checkpoints dirty startup work before running the implementer", () => {
  const sandbox = makeTempDir("run-cleanup-success");
  const binDirectory = path.join(sandbox, "bin");
  const repoRoot = createRepo(path.join(sandbox, "repo"), {
    "README.md": "# sandbox\n",
    "staged.txt": "before\n",
    "unstaged.txt": "before\n",
  });
  const { cwdLogPath, stdinLogPath, invocationCountPath, phaseLogPath } = installFakeCodex(
    binDirectory,
    {
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
    },
  );

  write(repoRoot, "staged.txt", "after staged change\n");
  git(repoRoot, ["add", "staged.txt"]);
  write(repoRoot, "unstaged.txt", "after unstaged change\n");
  write(repoRoot, "untracked.txt", "brand new file\n");

  const result = spawnSync("bun", [cliEntrypoint, "run", "--plan", "ship it"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: [binDirectory, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    },
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  expect(read(sandbox, path.relative(sandbox, invocationCountPath))).toBe("3");
  expect(read(sandbox, path.relative(sandbox, cwdLogPath))).toBe(
    `${repoRoot}\n${repoRoot}\n${repoRoot}\n`,
  );
  expect(read(sandbox, path.relative(sandbox, phaseLogPath))).toBe(
    "cleanup\nimplementer\nreviewer\n",
  );
  const stdinLog = read(sandbox, path.relative(sandbox, stdinLogPath));
  expect(stdinLog).toContain("You are the cleanup checkpointing phase.");
  expect(stdinLog).toContain("You are an task implementer for the specified plan below");
  expect(stdinLog).toContain("You are an expert code reviewer focused on enhancing code clarity, consistency, and maintainability while preserving exact functionality.");
  expect(git(repoRoot, ["show", "-s", "--format=%s", "HEAD"])).toBe(
    "clean up: checkpoint dirty work",
  );
  expect(result.stdout).toContain("cleanup stdout");
  expect(result.stdout).toContain("implementer stdout");
  expect(result.stdout).toContain("reviewer stdout");
  expect(result.stdout).toContain(
    "Cleanup checkpointed existing changes. Implementer finished successfully. Reviewer finished successfully.",
  );
  expect(result.stderr).toContain("cleanup stderr");
  expect(result.stderr).toContain("implementer stderr");
  expect(result.stderr).toContain("reviewer stderr");
  expect(git(repoRoot, ["status", "--porcelain", "--untracked-files=normal"])).toBe("");
});

test("mt run still runs the reviewer after implementer failures and reports both phase outcomes", () => {
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

  const result = spawnSync("bun", [cliEntrypoint, "run", "--plan", "ship it"], {
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

test("mt run aborts before implementation when cleanup does not create the required checkpoint commit", () => {
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

  const result = spawnSync("bun", [cliEntrypoint, "run", "--plan", "ship it"], {
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
    "You are an task implementer for the specified plan below",
  );
  expect(result.stdout).toContain("cleanup attempt");
  expect(result.stderr).toContain("cleanup diagnostics");
  expect(result.stderr).toContain(
    'Cleanup did not create the required checkpoint commit (message must start with "clean up"). Aborting before implementation.',
  );
});

test("mt run aborts before implementation when cleanup exits with failures", () => {
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

  const result = spawnSync("bun", [cliEntrypoint, "run", "--plan", "ship it"], {
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
    "You are an task implementer for the specified plan below",
  );
  expect(result.stdout).toContain("cleanup failed output");
  expect(result.stderr).toContain("cleanup failed diagnostics");
  expect(result.stderr).toContain(
    "Cleanup finished with failures (exit code 7). Aborting before implementation.",
  );
});

test("mt run aborts before implementation when cleanup creates a checkpoint commit with an invalid subject", () => {
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

  const result = spawnSync("bun", [cliEntrypoint, "run", "--plan", "ship it"], {
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
    "You are an task implementer for the specified plan below",
  );
  expect(result.stdout).toContain("cleanup invalid subject output");
  expect(result.stderr).toContain("cleanup invalid subject diagnostics");
  expect(result.stderr).toContain(
    'Cleanup created "checkpoint dirty work" but the commit message must start with "clean up". Aborting before implementation.',
  );
});

test("mt run aborts before implementation when cleanup leaves the checkout dirty", () => {
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

  const result = spawnSync("bun", [cliEntrypoint, "run", "--plan", "ship it"], {
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
    "You are an task implementer for the specified plan below",
  );
  expect(result.stdout).toContain("cleanup partial");
  expect(result.stderr).toContain("cleanup left dirt");
  expect(result.stderr).toContain("Cleanup left the checkout dirty");
  expect(result.stderr).toContain(" M unstaged.txt");
  expect(result.stderr).toContain("?? untracked.txt");
});

test("mt run fails when the implementer creates a commit", () => {
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

  const result = spawnSync("bun", [cliEntrypoint, "run", "--plan", "ship it"], {
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

test("mt run surfaces reviewer failures in the final summary", () => {
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

  const result = spawnSync("bun", [cliEntrypoint, "run", "--plan", "ship it"], {
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

test("mt run fails when the reviewer creates a commit", () => {
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

  const result = spawnSync("bun", [cliEntrypoint, "run", "--plan", "ship it"], {
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
