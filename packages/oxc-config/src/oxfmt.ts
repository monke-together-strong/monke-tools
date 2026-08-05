import type { OxfmtConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

const sharedIgnorePatterns = ["skills/**", "AGENTS.md"];

export function createOxfmtConfig(options: OxfmtConfig = {}): OxfmtConfig {
  const { ignorePatterns = [], ...config } = options;

  return {
    ...ultracite,
    jsdoc: true,
    printWidth: 100,
    proseWrap: "preserve",
    trailingComma: "none",
    ...config,
    ignorePatterns: [
      ...(ultracite.ignorePatterns ?? []),
      ...sharedIgnorePatterns,
      ...ignorePatterns
    ]
  };
}

export const oxfmtConfig = createOxfmtConfig();

export default oxfmtConfig;
