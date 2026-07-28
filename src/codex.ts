import { createLogger } from "./logger.ts";
import { findExecutable } from "./runtime.ts";
import type { Runtime } from "./types.ts";

/** Open a new Codex Desktop thread for a local checkout path. */
export function openCodexThread(runtime: Runtime, targetPath: string): void {
  const logger = createLogger(runtime);
  const url = formatCodexNewThreadUrl(targetPath);
  const opener = getUrlOpener(url);
  if (!canRunUrlOpener(runtime, opener.command)) {
    logger.warning(`Could not open Codex thread: ${opener.command} was not found`);
    return;
  }

  const result = runtime.exec(opener.command, opener.args, { allowFailure: true });
  if (result.exitCode !== 0 || result.timedOut === true) {
    logger.warning(`Could not open Codex thread: ${formatOpenFailure(result)}`);
    return;
  }

  logger.success(`Opened Codex thread for ${targetPath}`);
}

function formatCodexNewThreadUrl(targetPath: string): string {
  return `codex://threads/new?path=${encodeURIComponent(targetPath)}`;
}

function getUrlOpener(url: string): { command: string; args: string[] } {
  if (process.platform === "darwin") {
    return { args: [url], command: "open" };
  }

  if (process.platform === "win32") {
    return { args: ["/c", "start", "", escapeWindowsCmdUrl(url)], command: "cmd" };
  }

  return { args: [url], command: "xdg-open" };
}

function escapeWindowsCmdUrl(url: string): string {
  // cmd expands %NAME% before start sees the URL; preserve percent-encoded paths.
  return url.replaceAll("%", "^%");
}

function canRunUrlOpener(runtime: Runtime, command: string): boolean {
  return process.platform === "win32" && command === "cmd"
    ? true
    : findExecutable(command, runtime.env) !== null;
}

function formatOpenFailure(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}): string {
  if (result.timedOut === true) {
    return "timed out";
  }

  return result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
}
