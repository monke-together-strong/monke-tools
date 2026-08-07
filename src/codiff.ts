import type { ComparisonPlan } from "./comparison-plan.ts";
import { MonkeError } from "./errors.ts";
import { findExecutable } from "./runtime.ts";
import type { ExecResult, Runtime } from "./types.ts";

const MINIMUM_CODIFF_VERSION = [1, 9, 0] as const;
const MINIMUM_CODIFF_VERSION_TEXT = MINIMUM_CODIFF_VERSION.join(".");
const INSTALL_CODIFF = "brew install --cask nkzw-tech/tap/codiff";

/** Verify and resolve the supported Codiff executable synchronously. */
export function verifyCodiff(runtime: Runtime): string {
  const executable = resolveCodiff(runtime);
  validateCodiffVersion(runtime.exec(executable, ["--version"], { allowFailure: true }));
  return executable;
}

/** Verify Codiff while independent Diff discovery continues. */
export async function verifyCodiffAsync(runtime: Runtime): Promise<string> {
  const executable = resolveCodiff(runtime);
  const result = await runtime.execAsync(executable, ["--version"], { allowFailure: true });
  validateCodiffVersion(result);
  return executable;
}

/** Map one comparison plan to Codiff's public CLI contract. */
export function launchCodiff(runtime: Runtime, executable: string, plan: ComparisonPlan): void {
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

function resolveCodiff(runtime: Runtime): string {
  const executable = findExecutable("codiff", runtime.env);
  if (executable === null) {
    throwCodiffInstallError();
  }
  return executable;
}

function validateCodiffVersion(result: ExecResult): void {
  const plainOutput = `${result.stdout}\n${result.stderr}`.replaceAll(
    // oxlint-disable-next-line no-control-regex -- External CLI output may contain ANSI color codes.
    /\u001B\[[0-?]*[ -/]*[@-~]/gu,
    ""
  );
  const match = /(?:^|\s)codiff v(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:\s|$)/u.exec(
    plainOutput
  );
  if (result.exitCode !== 0 || match?.groups === undefined) {
    throwCodiffInstallError();
  }

  const version = [
    Number(match.groups.major),
    Number(match.groups.minor),
    Number(match.groups.patch)
  ];
  if (compareVersions(version, MINIMUM_CODIFF_VERSION) < 0) {
    throw new MonkeError(
      `Codiff ${MINIMUM_CODIFF_VERSION_TEXT} or newer is required; found ${version.join(".")}. Upgrade it with: brew upgrade --cask nkzw-tech/tap/codiff`
    );
  }
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
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
