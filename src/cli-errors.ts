import { CommanderError, type OutputConfiguration } from "@commander-js/extra-typings";

interface ConfigurableCliParser {
  configureOutput(configuration: OutputConfiguration): unknown;
  exitOverride(): unknown;
  showSuggestionAfterError(displaySuggestion?: boolean): unknown;
}

/** Configure a testable CLI parser whose executable boundary owns error output. */
export function configureCliParser<T extends ConfigurableCliParser>(program: T): T {
  program.showSuggestionAfterError(false);
  program.configureOutput({
    writeErr: () => undefined,
  });
  program.exitOverride();
  return program;
}

/** Render one failure at an executable boundary. */
export function reportCliFailure(error: unknown): void {
  if (error instanceof CommanderError && error.exitCode === 0) {
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
