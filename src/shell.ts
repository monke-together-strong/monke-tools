import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { MonkeError } from "./errors.ts";
import { createLogger } from "./logger.ts";
import { findExecutable, getHomeDirectory } from "./runtime.ts";
import { SHELL_DIRECTORY_DIRECTIVE_ENV } from "./shell-directive.ts";
import type { Runtime } from "./types.ts";

export { SHELL_DIRECTORY_DIRECTIVE_ENV } from "./shell-directive.ts";

const INTEGRATION_START = "# >>> monke-tools shell integration >>>";
const INTEGRATION_END = "# <<< monke-tools shell integration <<<";
const SUPPORTED_SHELLS = ["bash", "zsh"] as const;

type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

export interface ShellInitOptions {
  binary?: string;
}

export interface ShellInstallOptions {
  binary?: string;
}

/** Request that an active Shell adapter changes directory after mt exits. */
export function requestShellDirectory(runtime: Runtime, targetPath: string) {
  return requestShellDirectoryWithFallback(runtime, targetPath, false);
}

/** Relocate a shell after its current worktree has already been removed. */
export function requestShellDirectoryAfterRemoval(runtime: Runtime, targetPath: string) {
  return requestShellDirectoryWithFallback(runtime, targetPath, true);
}

function requestShellDirectoryWithFallback(
  runtime: Runtime,
  targetPath: string,
  removedCurrentWorktree: boolean
) {
  const logger = createLogger(runtime);

  if (writeDirectoryDirective(runtime, targetPath)) {
    logger.success(`Switched to ${targetPath}`);
    return true;
  }

  if (removedCurrentWorktree) {
    logger.warning(`WARNING: your shell is still in the removed worktree; switch to ${targetPath}`);
  } else {
    logger.info(`Switch to ${targetPath}`);
  }
  runtime.writeStdout(`${targetPath}\n`);
  if (isShellIntegrationConfigured(runtime)) {
    logger.hint(
      "Shell integration is configured but not active; restart your shell or invoke mt through the shell adapter."
    );
  } else {
    logger.hint("Enable automatic switching with: mt shell install");
  }
  return false;
}

export function runShellInit(runtime: Runtime, shellName: string, options: ShellInitOptions = {}) {
  const shell = requireSupportedShell(shellName);
  runtime.writeStdout(renderShellAdapter(shell, resolveAdapterBinary(runtime, options.binary)));
}

export function runShellInstall(runtime: Runtime, options: ShellInstallOptions = {}) {
  const home = getHomeDirectory(runtime);
  const binary = resolveAdapterBinary(runtime, options.binary);
  const shell = resolveCurrentShell(runtime);
  const logger = createLogger(runtime);
  if (shell === null) {
    const currentShell = runtime.env.SHELL || "the current shell";
    logger.warning(`Shell integration is not available for ${currentShell}`);
    logger.hint(
      `No startup file was changed. Add ${path.dirname(binary)} to PATH and switch to paths printed by mt manually.`
    );
    return;
  }

  const startupFile = getStartupFilePath(home, shell);
  installStartupBlock(startupFile, renderStartupBlock(shell, binary));
  logger.success(`Installed shell integration in ${startupFile}`);
  logger.hint("Restart your shell to activate the updated integration.");
}

function renderShellAdapter(shell: SupportedShell, binaryPath: string) {
  return `# monke-tools shell integration for ${shell}
mt() {
  local __monke_mt_cd_status
  local __monke_mt_directive
  local __monke_mt_status
  local __monke_mt_target

  __monke_mt_directive="$(mktemp "\${TMPDIR:-/tmp}/monke-tools-cd.XXXXXX")" || return
  ${SHELL_DIRECTORY_DIRECTIVE_ENV}="$__monke_mt_directive" ${shellQuote(binaryPath)} "$@"
  __monke_mt_status=$?

  if [ -s "$__monke_mt_directive" ]; then
    __monke_mt_target="$(cat "$__monke_mt_directive")"
    rm -f "$__monke_mt_directive"
    if [ -n "$__monke_mt_target" ]; then
      if cd -- "$__monke_mt_target"; then
        __monke_mt_cd_status=0
      else
        __monke_mt_cd_status=$?
      fi
      if [ "$__monke_mt_status" -eq 0 ] && [ "$__monke_mt_cd_status" -ne 0 ]; then
        return "$__monke_mt_cd_status"
      fi
    fi
  else
    rm -f "$__monke_mt_directive"
  fi

  return "$__monke_mt_status"
}

monke() {
  mt "$@"
}
`;
}

function writeDirectoryDirective(runtime: Runtime, targetPath: string) {
  const directivePath = runtime.env[SHELL_DIRECTORY_DIRECTIVE_ENV];
  if (!directivePath) {
    return false;
  }

  try {
    writeFileSync(directivePath, targetPath, "utf-8");
    return true;
  } catch {
    return false;
  }
}

function isShellIntegrationConfigured(runtime: Runtime) {
  const home = getHomeDirectory(runtime);
  const currentShell = resolveCurrentShell(runtime);
  const startupFiles =
    currentShell === null
      ? SUPPORTED_SHELLS.map((shell) => getStartupFilePath(home, shell))
      : [getStartupFilePath(home, currentShell)];

  return startupFiles.some((startupFile) => {
    if (!existsSync(startupFile)) {
      return false;
    }
    try {
      return readFileSync(startupFile, "utf-8").includes(INTEGRATION_START);
    } catch {
      return false;
    }
  });
}

function installStartupBlock(startupFile: string, block: string) {
  mkdirSync(path.dirname(startupFile), { recursive: true });
  const existing = existsSync(startupFile) ? readFileSync(startupFile, "utf-8") : "";
  const startIndex = existing.indexOf(INTEGRATION_START);
  const endIndex = existing.indexOf(INTEGRATION_END);
  let nextContents: string;

  if (startIndex !== -1 && endIndex > startIndex) {
    const afterEnd = endIndex + INTEGRATION_END.length;
    nextContents = `${existing.slice(0, startIndex)}${block}${existing.slice(afterEnd).replace(/^\n/u, "")}`;
  } else {
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    nextContents = `${existing}${separator}${block}`;
  }

  writeFileSync(startupFile, nextContents, "utf-8");
}

function renderStartupBlock(shell: SupportedShell, binaryPath: string) {
  return `${INTEGRATION_START}
eval "$(${shellQuote(binaryPath)} shell init ${shell} --binary ${shellQuote(binaryPath)})"
${INTEGRATION_END}
`;
}

function resolveAdapterBinary(runtime: Runtime, binary: string | undefined) {
  const candidate = binary ?? runtime.env.MONKE_TOOLS_BINARY ?? findExecutable("mt", runtime.env);
  if (!candidate) {
    return "mt";
  }

  return path.isAbsolute(candidate) ? candidate : path.resolve(runtime.cwd, candidate);
}

function resolveCurrentShell(runtime: Runtime) {
  const shell = path.basename(runtime.env.SHELL ?? "");
  return isSupportedShell(shell) ? shell : null;
}

function requireSupportedShell(shellName: string) {
  if (isSupportedShell(shellName)) {
    return shellName;
  }
  throw new MonkeError("Usage: mt shell init <bash|zsh>");
}

function isSupportedShell(shellName: string): shellName is SupportedShell {
  // SAFETY: membership in the immutable literal tuple establishes the SupportedShell union.
  return (SUPPORTED_SHELLS as readonly string[]).includes(shellName);
}

function getStartupFilePath(home: string, shell: SupportedShell) {
  return path.join(home, shell === "zsh" ? ".zshrc" : ".bashrc");
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
