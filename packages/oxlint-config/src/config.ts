import type { OxlintConfig } from "vite-plus/lint";

import core from "ultracite/oxlint/core";

const config = {
  extends: [core],
  ignorePatterns: core.ignorePatterns ?? [],
  rules: {
    "func-style": "off",
    "no-nested-ternary": "off",
    "no-use-before-define": "off",
    "unicorn/no-nested-ternary": "off",
  },
} satisfies OxlintConfig;

export default config;
