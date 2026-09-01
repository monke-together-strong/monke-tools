import { createLogger } from "./logger.ts";
import { findExecutable } from "./runtime.ts";
import type { ExecResult, Runtime } from "./types.ts";

/** Open a local checkout as a Codex workspace. */
export function openCodexWorkspace(runtime: Runtime, targetPath: string) {
  const logger = createLogger(runtime);
  const url = formatCodexWorkspaceUrl(targetPath);
  const opener = getUrlOpener(url);
  if (!canRunUrlOpener(runtime, opener.command)) {
    logger.warning(`Could not open workspace in Codex: ${opener.command} was not found`);
    return;
  }

  const result = runtime.exec(opener.command, opener.args, { allowFailure: true });
  if (result.exitCode !== 0 || result.timedOut === true) {
    logger.warning(`Could not open workspace in Codex: ${formatOpenFailure(result)}`);
    return;
  }

  logger.success(`Opened Codex workspace: ${targetPath}`);
}

function formatCodexWorkspaceUrl(targetPath: string) {
  return `codex://threads/new?path=${encodeURIComponent(targetPath)}`;
}

function getUrlOpener(url: string) {
  if (process.platform === "darwin") {
    return { args: [url], command: "open" };
  }

  if (process.platform === "win32") {
    return { args: ["/c", "start", "", escapeWindowsCmdUrl(url)], command: "cmd" };
  }

  return { args: [url], command: "xdg-open" };
}

function escapeWindowsCmdUrl(url: string) {
  // cmd expands %NAME% before start sees the URL; preserve percent-encoded paths.
  return url.replaceAll("%", "^%");
}

function canRunUrlOpener(runtime: Runtime, command: string) {
  return process.platform === "win32" && command === "cmd"
    ? true
    : findExecutable(command, runtime.env) !== null;
}

function formatOpenFailure(result: ExecResult) {
  if (result.timedOut === true) {
    return "timed out";
  }

  return result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
}
