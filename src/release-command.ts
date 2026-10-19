/** Run a release command with consistent operator-facing failure diagnostics. */
export function runReleaseCommand(
  command: string,
  arguments_: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
) {
  const commandText = [command, ...arguments_].join(" ");
  let result: Bun.ReadableSyncSubprocess;

  try {
    result = Bun.spawnSync({
      cmd: [command, ...arguments_],
      cwd: options.cwd,
      env: options.env,
      stderr: "pipe",
      stdout: "pipe"
    });
  } catch (cause) {
    throw new Error(`${commandText} could not be started`, { cause });
  }

  if (result.signalCode !== undefined) {
    throw new Error(`${commandText} was terminated by signal ${result.signalCode}`);
  }

  if (result.exitCode !== 0) {
    const detail =
      result.stderr.toString().trim() || result.stdout.toString().trim() || "unknown failure";

    throw new Error(`${commandText} failed: ${detail}`);
  }

  return result.stdout.toString();
}
