import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { MonkeError } from "./errors.ts";
import { createLogger } from "./logger.ts";
import { ensureDirectory, findExecutable, getHomeDirectory } from "./runtime.ts";
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
export function requestShellDirectory(runtime: Runtime, targetPath: string): boolean {
  const logger = createLogger(runtime);

  if (writeDirectoryDirective(runtime, targetPath)) {
    logger.success(`Switched to ${targetPath}`);
    return true;
  }

  logger.info(`Switch to ${targetPath}`);
  runtime.writeStdout(`${targetPath}\n`);
  if (isShellIntegrationConfigured(runtime)) {
    logger.hint(
      "Shell integration is configured but not active; restart your shell or invoke mt through the shell adapter.",
    );
  } else {
    logger.hint("Enable automatic switching with: mt shell install");
  }
  return false;
}

export function runShellInit(
  runtime: Runtime,
  shellName: string,
  options: ShellInitOptions = {},
): void {
  const shell = requireSupportedShell(shellName);
  runtime.writeStdout(renderShellAdapter(shell, resolveAdapterBinary(runtime, options.binary)));
}

export function runShellInstall(runtime: Runtime, options: ShellInstallOptions = {}): void {
  const home = getHomeDirectory(runtime);
  const binary = resolveAdapterBinary(runtime, options.binary);
  const installedFiles: string[] = [];

  for (const shell of SUPPORTED_SHELLS) {
    const startupFile = getStartupFilePath(home, shell);
    installStartupBlock(startupFile, renderStartupBlock(shell, binary));
    installedFiles.push(startupFile);
  }

  createLogger(runtime).success(
    `Installed shell integration in ${installedFiles.map((file) => path.basename(file)).join(", ")}`,
  );
}

function renderShellAdapter(shell: SupportedShell, binaryPath: string): string {
  return `# monke-tools shell integration for ${shell}
mt() {
  local __monke_mt_directive
  local __monke_mt_status
  local __monke_mt_target

  __monke_mt_directive="$(mktemp "\${TMPDIR:-/tmp}/monke-tools-cd.XXXXXX")" || return
  ${SHELL_DIRECTORY_DIRECTIVE_ENV}="$__monke_mt_directive" ${shellQuote(binaryPath)} "$@"
  __monke_mt_status=$?

  if [ "$__monke_mt_status" -eq 0 ] && [ -s "$__monke_mt_directive" ]; then
    __monke_mt_target="$(cat "$__monke_mt_directive")"
    rm -f "$__monke_mt_directive"
    if [ -n "$__monke_mt_target" ]; then
      cd -- "$__monke_mt_target" || return $?
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

function writeDirectoryDirective(runtime: Runtime, targetPath: string): boolean {
  const directivePath = runtime.env[SHELL_DIRECTORY_DIRECTIVE_ENV];
  if (!directivePath) {
    return false;
  }

  try {
    writeFileSync(directivePath, targetPath, "utf8");
    return true;
  } catch {
    return false;
  }
}

function isShellIntegrationConfigured(runtime: Runtime): boolean {
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
      return readFileSync(startupFile, "utf8").includes(INTEGRATION_START);
    } catch {
      return false;
    }
  });
}

function installStartupBlock(startupFile: string, block: string): void {
  ensureDirectory(path.dirname(startupFile));
  const existing = existsSync(startupFile) ? readFileSync(startupFile, "utf8") : "";
  const startIndex = existing.indexOf(INTEGRATION_START);
  const endIndex = existing.indexOf(INTEGRATION_END);
  let nextContents: string;

  if (startIndex >= 0 && endIndex > startIndex) {
    const afterEnd = endIndex + INTEGRATION_END.length;
    nextContents = `${existing.slice(0, startIndex)}${block}${existing.slice(afterEnd).replace(/^\n/, "")}`;
  } else {
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    nextContents = `${existing}${separator}${block}`;
  }

  writeFileSync(startupFile, nextContents, "utf8");
}

function renderStartupBlock(shell: SupportedShell, binaryPath: string): string {
  return `${INTEGRATION_START}
eval "$(${shellQuote(binaryPath)} shell init ${shell} --binary ${shellQuote(binaryPath)})"
${INTEGRATION_END}
`;
}

function resolveAdapterBinary(runtime: Runtime, binary: string | undefined): string {
  const candidate =
    binary ?? runtime.env.MONKE_TOOLS_BINARY ?? findExecutable("monke-tools", runtime.env);
  if (!candidate) {
    return "monke-tools";
  }

  return path.isAbsolute(candidate) ? candidate : path.resolve(runtime.cwd, candidate);
}

function resolveCurrentShell(runtime: Runtime): SupportedShell | null {
  const shell = path.basename(runtime.env.SHELL ?? "");
  return isSupportedShell(shell) ? shell : null;
}

function requireSupportedShell(shellName: string): SupportedShell {
  if (isSupportedShell(shellName)) {
    return shellName;
  }
  throw new MonkeError("Usage: mt shell init <bash|zsh>");
}

function isSupportedShell(shellName: string): shellName is SupportedShell {
  return SUPPORTED_SHELLS.includes(shellName as SupportedShell);
}

function getStartupFilePath(home: string, shell: SupportedShell): string {
  return path.join(home, shell === "zsh" ? ".zshrc" : ".bashrc");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
