import { CommanderError } from "@commander-js/extra-typings";
import type { OutputConfiguration } from "@commander-js/extra-typings";
import * as z from "zod";

import { MonkeError } from "./errors.ts";

interface ConfigurableCliParser {
  configureOutput: (configuration: OutputConfiguration) => unknown;
  exitOverride: () => unknown;
  showSuggestionAfterError: (displaySuggestion?: boolean) => unknown;
}

/** Configure a testable CLI parser whose executable boundary owns error output. */
export function configureCliParser<T extends ConfigurableCliParser>(program: T): T {
  program.showSuggestionAfterError(false);
  program.configureOutput({
    writeErr: () => {},
  });
  program.exitOverride();
  return program;
}

/** Render one failure at an executable boundary. */
export function reportCliFailure(error: unknown): void {
  if (error instanceof CommanderError && error.exitCode === 0) {
    return;
  }

  process.stderr.write(`${formatCliFailure(error)}\n`);
  process.exitCode = 1;
}

function formatCliFailure(error: unknown): string {
  if (error instanceof z.ZodError) {
    return `error: invalid input\n${z.prettifyError(error)}`;
  }

  // Expected failures carry a message written for the user.
  if (error instanceof MonkeError || error instanceof CommanderError) {
    return error.message;
  }

  // Anything else is a bug in mt, so keep the stack for whoever debugs it.
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}
