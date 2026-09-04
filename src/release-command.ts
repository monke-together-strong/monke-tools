import { spawnSync } from "node:child_process";

/** Run a release command with consistent operator-facing failure diagnostics. */
export function runReleaseCommand(
  command: string,
  arguments_: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf-8",
    env: options.env
  });
  const commandText = `${command} ${arguments_.join(" ")}`;
  if (result.error) {
    throw new Error(`${commandText} could not be started`, { cause: result.error });
  }
  if (result.status === null) {
    throw new Error(`${commandText} was terminated by signal ${result.signal ?? "unknown"}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || "unknown failure";
    throw new Error(`${commandText} failed: ${detail}`);
  }
  return result.stdout ?? "";
}
