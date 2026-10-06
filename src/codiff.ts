import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import * as z from "zod";

import type { ComparisonPlan } from "./comparison-plan.ts";
import { MonkeError } from "./errors.ts";
import { addInstallGuidance } from "./install-guidance.ts";
import { findExecutable } from "./runtime.ts";
import type { ExecResult, Runtime } from "./types.ts";

const MINIMUM_CODIFF_VERSION = [1, 14, 0] as const;
export const MINIMUM_CODIFF_VERSION_TEXT = MINIMUM_CODIFF_VERSION.join(".");
const CODIFF_CASK = "nkzw-tech/tap/codiff";
const INSTALL_CODIFF = `brew install --cask --require-sha ${CODIFF_CASK}`;

/** Verify Codiff while independent Diff discovery continues. */
export async function verifyCodiffAsync(runtime: Runtime) {
  const executable = resolveCodiff(runtime);
  const result = await runtime.execAsync(executable, ["--version"], { allowFailure: true });
  validateCodiffVersion(runtime, result);
  return executable;
}

export async function verifyCodiffRangeSupport(runtime: Runtime, executable: string) {
  const help = await runtime.execAsync(executable, ["--help"], { allowFailure: true });
  if (
    help.exitCode !== 0 ||
    !help.stdout.includes("--capabilities") ||
    !help.stdout.includes("desktop-source-v1")
  ) {
    throw new MonkeError(
      `Codiff at ${executable} does not advertise safe range forwarding. Use a launcher with desktop-source-v1 range support; no comparison was opened.`
    );
  }
  const result = await runtime.execAsync(executable, ["--capabilities"], { allowFailure: true });
  let capabilities: unknown;
  try {
    capabilities = JSON.parse(result.stdout);
  } catch {
    capabilities = undefined;
  }
  const parsed = z
    .object({ sources: z.array(z.string()), version: z.literal(1) })
    .safeParse(capabilities);
  if (result.exitCode !== 0 || !parsed.success || !parsed.data.sources.includes("range")) {
    throw new MonkeError(
      `Codiff at ${executable} does not advertise safe range forwarding. Use a launcher with desktop-source-v1 range support; no comparison was opened.`
    );
  }
}

/** Reconcile Codiff to a minimum-compatible version on supported Homebrew platforms. */
export function reconcileCodiff(
  runtime: Runtime,
  minimumVersionText: string | undefined = MINIMUM_CODIFF_VERSION_TEXT
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
    const prefix = runtime.exec(brew, ["--prefix"], { allowFailure: true });
    const homebrewCodiff = path.join(prefix.stdout.trim(), "bin", "codiff");
    if (
      prefix.exitCode !== 0 ||
      !prefix.stdout.trim() ||
      !sameExecutable(executable, homebrewCodiff)
    ) {
      throw new MonkeError(
        `Codiff at ${executable} is below ${minimumVersionText} or has an invalid version, and is not owned by Homebrew. Upgrade it manually, then retry with: mt install-dependencies`
      );
    }
    runBrew(runtime, brew, ["upgrade", "--cask", CODIFF_CASK]);
  }

  const installed =
    findExecutable("codiff", runtime.env) ?? resolveInstalledHomebrewCodiff(runtime, brew);
  if (installed === null) {
    throwCodiffInstallError(runtime);
  }
  const installedVersion = inspectCodiff(runtime, installed);
  if (installedVersion === null || compareVersions(installedVersion, minimumVersion) < 0) {
    throw new MonkeError(
      `Codiff ${minimumVersionText} or newer is required after Homebrew reconciliation`
    );
  }
}

function resolveInstalledHomebrewCodiff(runtime: Runtime, brew: string) {
  const prefix = runtime.exec(brew, ["--prefix"], { allowFailure: true });
  if (prefix.exitCode !== 0) {
    return null;
  }
  const prefixPath = prefix.stdout.trim();
  if (!prefixPath) {
    return null;
  }
  const executable = path.join(prefixPath, "bin", "codiff");
  return existsSync(executable) ? executable : null;
}

function sameExecutable(left: string, right: string) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/** Map one comparison plan to Codiff's public CLI contract. */
export function launchCodiff(runtime: Runtime, executable: string, plan: ComparisonPlan) {
  const sourceArgs =
    plan.kind === "branch-working-tree"
      ? ["--branch", plan.baseRef]
      : plan.kind === "commit"
        ? ["--commit", plan.ref]
        : plan.kind === "range"
          ? [`${plan.base}${plan.symmetric ? "..." : ".."}${plan.head}`]
          : plan.kind === "pull-request"
            ? plan.target
            : [];
  const args = [...sourceArgs, plan.worktreePath];
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
    throwCodiffInstallError(runtime);
  }
  return executable;
}

function validateCodiffVersion(runtime: Runtime, result: ExecResult) {
  const version = parseCodiffResult(result);
  if (version === null) {
    throwCodiffInstallError(runtime);
  }

  if (compareVersions(version, MINIMUM_CODIFF_VERSION) < 0) {
    throw addInstallGuidance(
      runtime,
      new MonkeError(
        `Codiff ${MINIMUM_CODIFF_VERSION_TEXT} or newer is required; found ${version.join(".")}. Upgrade it with: brew upgrade --cask ${CODIFF_CASK}`
      )
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

function throwCodiffInstallError(runtime: Runtime): never {
  throw addInstallGuidance(
    runtime,
    new MonkeError(
      `Codiff ${MINIMUM_CODIFF_VERSION_TEXT} or newer is required. Install it with: ${INSTALL_CODIFF}`
    )
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
