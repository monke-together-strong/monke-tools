export const DEFAULT_TOOL_BUILD_IDENTITY =
  // oxlint-disable-next-line node/no-process-env -- Local and Release builds inline this exact access using Bun's define option.
  process.env.MONKE_TOOLS_BUILD_IDENTITY ?? "local+development-dirty";
