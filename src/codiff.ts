import type { ComparisonPlan } from "./comparison-plan.ts";
import { MonkeError } from "./errors.ts";
import { findExecutable } from "./runtime.ts";
import type { ExecResult, Runtime } from "./types.ts";

const MINIMUM_CODIFF_VERSION = [1, 9, 0] as const;
export const MINIMUM_CODIFF_VERSION_TEXT = MINIMUM_CODIFF_VERSION.join(".");
const CODIFF_CASK = "nkzw-tech/tap/codiff";
const INSTALL_CODIFF = `brew install --cask --require-sha ${CODIFF_CASK}`;

/** Verify and resolve the supported Codiff executable synchronously. */
export function verifyCodiff(runtime: Runtime) {
  const executable = resolveCodiff(runtime);
  validateCodiffVersion(runtime.exec(executable, ["--version"], { allowFailure: true }));
  return executable;
}

/** Verify Codiff while independent Diff discovery continues. */
export async function verifyCodiffAsync(runtime: Runtime) {
  const executable = resolveCodiff(runtime);
  const result = await runtime.execAsync(executable, ["--version"], { allowFailure: true });
  validateCodiffVersion(result);
  return executable;
}

/** Reconcile Codiff to a minimum-compatible version on supported Homebrew platforms. */
export function reconcileCodiff(
  runtime: Runtime,
  minimumVersionText = MINIMUM_CODIFF_VERSION_TEXT
) {
  if (runtime.platform !== "darwin" || runtime.architecture !== "arm64") {
    return;
  }

  const minimumVersion = parseVersionText(minimumVersionText);
  const executable = findExecutable("codiff", runtime.env);
  const inspected = executable === null ? null : inspectCodiff(runtime, executable);
  if (inspected !== null && compareVersions(inspected, minimumVersion) >= 0) {
    return;
  }

  const brew = findExecutable("brew", runtime.env);
  if (brew === null) {
    throw new MonkeError(
      `Homebrew is unavailable. Install Codiff ${minimumVersionText} or newer manually, then retry with: mt install-dependencies`
    );
  }

  if (executable === null) {
    runBrew(runtime, brew, ["install", "--cask", "--require-sha", CODIFF_CASK]);
  } else {
    const ownership = runtime.exec(brew, ["list", "--cask", CODIFF_CASK], {
      allowFailure: true
    });
    if (ownership.exitCode !== 0) {
      throw new MonkeError(
        `Codiff at ${executable} is below ${minimumVersionText} or has an invalid version, and is not owned by Homebrew. Upgrade it manually, then retry with: mt install-dependencies`
      );
    }
    runBrew(runtime, brew, ["upgrade", "--cask", CODIFF_CASK]);
  }

  const installed = findExecutable("codiff", runtime.env);
  if (installed === null) {
    throwCodiffInstallError();
  }
  const installedVersion = inspectCodiff(runtime, installed);
  if (installedVersion === null || compareVersions(installedVersion, minimumVersion) < 0) {
    throw new MonkeError(
      `Codiff ${minimumVersionText} or newer is required after Homebrew reconciliation`
    );
  }
}

/** Map one comparison plan to Codiff's public CLI contract. */
export function launchCodiff(runtime: Runtime, executable: string, plan: ComparisonPlan) {
  const args =
    plan.kind === "branch-working-tree"
      ? ["--branch", plan.baseRef, plan.worktreePath]
      : [plan.worktreePath];
  const result = runtime.exec(executable, args, {
    allowFailure: true,
    cwd: plan.worktreePath
  });
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new MonkeError(
      `Codiff launch failed${detail ? `: ${detail}` : ` with exit code ${result.exitCode}`}`
    );
  }
}

function resolveCodiff(runtime: Runtime) {
  const executable = findExecutable("codiff", runtime.env);
  if (executable === null) {
    throwCodiffInstallError();
  }
  return executable;
}

function validateCodiffVersion(result: ExecResult) {
  const version = parseCodiffResult(result);
  if (version === null) {
    throwCodiffInstallError();
  }

  if (compareVersions(version, MINIMUM_CODIFF_VERSION) < 0) {
    throw new MonkeError(
      `Codiff ${MINIMUM_CODIFF_VERSION_TEXT} or newer is required; found ${version.join(".")}. Upgrade it with: brew upgrade --cask ${CODIFF_CASK}`
    );
  }
}

function parseCodiffResult(result: ExecResult) {
  const plainOutput = `${result.stdout}\n${result.stderr}`.replaceAll(
    // oxlint-disable-next-line no-control-regex -- External CLI output may contain ANSI color codes.
    /\u001B\[[0-?]*[ -/]*[@-~]/gu,
    ""
  );
  const match = /(?:^|\s)codiff v(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:\s|$)/u.exec(
    plainOutput
  );
  if (result.exitCode !== 0 || match?.groups === undefined) {
    return null;
  }

  return [Number(match.groups.major), Number(match.groups.minor), Number(match.groups.patch)];
}

function compareVersions(left: readonly number[], right: readonly number[]) {
  for (const [index, expected] of right.entries()) {
    const difference = (left[index] ?? 0) - expected;
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function throwCodiffInstallError(): never {
  throw new MonkeError(
    `Codiff ${MINIMUM_CODIFF_VERSION_TEXT} or newer is required. Install it with: ${INSTALL_CODIFF}`
  );
}

function inspectCodiff(runtime: Runtime, executable: string) {
  return parseCodiffResult(runtime.exec(executable, ["--version"], { allowFailure: true }));
}

function parseVersionText(value: string) {
  const match = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/u.exec(value);
  if (match?.groups === undefined) {
    throw new MonkeError(`Invalid minimum Codiff version: ${value}`);
  }
  return [Number(match.groups.major), Number(match.groups.minor), Number(match.groups.patch)];
}

function runBrew(runtime: Runtime, brew: string, args: string[]) {
  const result = runtime.exec(brew, args, { allowFailure: true });
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new MonkeError(
      `Homebrew Codiff reconciliation failed${detail ? `: ${detail}` : ` with exit code ${result.exitCode}`}`
    );
  }
}
