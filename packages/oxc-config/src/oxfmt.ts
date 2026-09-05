import type { OxfmtConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

const sharedIgnorePatterns = [
  "skills/imported/**",
  "skills/references/imported/**",
  "skills/**/*.md",
  "AGENTS.md",
  // TanStack Router owns this file and explicitly requires linters and formatters to ignore it.
  "**/routeTree.gen.ts"
];

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
