/** Identity compiled into an mt executable. Local development uses an explicit dirty fallback. */
export const DEFAULT_TOOL_BUILD_IDENTITY =
  // oxlint-disable-next-line node/no-process-env -- Bun replaces this access with the immutable build identity at compile time.
  process.env.MONKE_TOOLS_BUILD_IDENTITY ?? "local+development-dirty";
