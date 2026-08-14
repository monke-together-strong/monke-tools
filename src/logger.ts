import { createColors } from "picocolors";

import type { Runtime } from "./types.ts";

/** Intent-level CLI logger that keeps status output on stderr. */
export interface Logger {
  error: (message: string) => void;
  hint: (message: string) => void;
  info: (message: string) => void;
  success: (message: string) => void;
  warning: (message: string) => void;
}

export function createLogger(runtime: Runtime): Logger {
  const colors = createColors(shouldUseColor(runtime));

  return {
    error(message) {
      runtime.writeStderr(`${colors.red(message)}\n`);
    },
    hint(message) {
      runtime.writeStderr(`${colors.dim(message)}\n`);
    },
    info(message) {
      runtime.writeStderr(`${message}\n`);
    },
    success(message) {
      runtime.writeStderr(`${colors.green(message)}\n`);
    },
    warning(message) {
      runtime.writeStderr(`${colors.yellow(message)}\n`);
    }
  };
}

function shouldUseColor(runtime: Runtime) {
  if (runtime.env.NO_COLOR !== undefined) {
    return false;
  }

  const forceColor = runtime.env.FORCE_COLOR;
  return Boolean(forceColor && forceColor !== "0");
}
