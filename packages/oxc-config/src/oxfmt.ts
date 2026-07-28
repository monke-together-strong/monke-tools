import type { OxfmtConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

const sharedIgnorePatterns = ["skills/**", "AGENTS.md"];

export function createOxfmtConfig(options: OxfmtConfig = {}): OxfmtConfig {
  const { ignorePatterns = [], ...config } = options;

  return {
    ...ultracite,
    printWidth: 100,
    proseWrap: "preserve",
    ...config,
    ignorePatterns: [
      ...(ultracite.ignorePatterns ?? []),
      ...sharedIgnorePatterns,
      ...ignorePatterns,
    ],
  };
}

export const oxfmtConfig = createOxfmtConfig();

export default oxfmtConfig;
