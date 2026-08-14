import { CommanderError } from "@commander-js/extra-typings";
import type { OutputConfiguration } from "@commander-js/extra-typings";
import * as z from "zod";

import { MonkeError } from "./errors.ts";

interface ConfigurableCliParser {
  configureOutput: (configuration: OutputConfiguration) => unknown;
  exitOverride: (callback?: (error: CommanderError) => never) => unknown;
  showSuggestionAfterError: (displaySuggestion?: boolean) => unknown;
}

/** Configure a testable CLI parser whose executable boundary owns error output. */
export function configureCliParser<T extends ConfigurableCliParser>(program: T) {
  let errorOutput = "";

  program.showSuggestionAfterError(false);
  program.configureOutput({
    writeErr: (message) => {
      errorOutput += message;
    }
  });
  program.exitOverride((error) => {
    throw new CommanderError(error.exitCode, error.code, errorOutput.trimEnd() || error.message);
  });
  return program;
}

/** Render one failure at an executable boundary. */
export function reportCliFailure(error: unknown) {
  if (error instanceof CommanderError && error.exitCode === 0) {
    return;
  }

  process.stderr.write(`${formatCliFailure(error)}\n`);
  process.exitCode = 1;
}

function formatCliFailure(error: unknown) {
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
