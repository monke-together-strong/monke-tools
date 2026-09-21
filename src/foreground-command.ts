import { dlopen, FFIType } from "bun:ffi";
import { closeSync, openSync } from "node:fs";
import { constants } from "node:os";

const POSIX_SYMBOLS = {
  setpgid: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  signal: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
  tcgetpgrp: { args: [FFIType.i32], returns: FFIType.i32 },
  tcsetpgrp: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 }
} as const;

const LAUNCHER = String.raw`
import { dlopen } from "bun:ffi";
import { closeSync, openSync } from "node:fs";
import { constants } from "node:os";
const [library, definitions, command, ...args] = process.argv.slice(1);
// No user code runs until MT durably records this PID and future process group.
process.on("disconnect", () => process.exit(1));
process.once("message", (message) => {
  if (message !== "start") process.exit(1);
  const libc = dlopen(library, JSON.parse(definitions));
  if (libc.symbols.setpgid(0, 0) !== 0) throw new Error("Cannot create foreground process group");
  let terminal;
  try { terminal = openSync("/dev/tty", "r+"); }
  catch (error) { if (error.code !== "ENXIO" && error.code !== "ENOENT" && error.code !== "ENODEV") throw error; }
  if (terminal !== undefined) {
    const previous = libc.symbols.signal(constants.signals.SIGTTOU, 1n);
    try {
      if (libc.symbols.tcsetpgrp(terminal, process.pid) !== 0) throw new Error("Cannot attach foreground terminal");
    } finally {
      libc.symbols.signal(constants.signals.SIGTTOU, previous);
      closeSync(terminal);
    }
  }
  const executable = Bun.which(command);
  if (!executable) { console.error("Command not found: " + command); process.exit(127); }
  process.execve(executable, [command, ...args], process.env);
});
`;

/** A separate process group in the same Unix session preserves the controlling terminal. */
export function prepareForegroundCommand(command: string, args: string[]) {
  const library = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
  const libc = dlopen(library, POSIX_SYMBOLS);
  let terminal: number | undefined;
  try {
    terminal = openSync("/dev/tty", "r+");
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        ["ENXIO", "ENOENT", "ENODEV"].includes(String(error.code))
      )
    ) {
      libc.close();
      throw error;
    }
  }
  const originalGroup = terminal === undefined ? undefined : libc.symbols.tcgetpgrp(terminal);
  return {
    args: [
      "--no-env-file",
      "--eval",
      LAUNCHER,
      "--",
      library,
      JSON.stringify(POSIX_SYMBOLS),
      command,
      ...args
    ],
    command: "bun",
    restore() {
      try {
        if (terminal !== undefined && originalGroup !== undefined && originalGroup > 0) {
          const previous = libc.symbols.signal(constants.signals.SIGTTOU, 1n);
          try {
            libc.symbols.tcsetpgrp(terminal, originalGroup);
          } finally {
            libc.symbols.signal(constants.signals.SIGTTOU, previous);
          }
        }
      } finally {
        if (terminal !== undefined) {
          closeSync(terminal);
        }
        libc.close();
      }
    }
  };
}
