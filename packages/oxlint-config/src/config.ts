import type { OxlintConfig, OxlintOverride } from "vite-plus/lint";

import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

const testOverrides = (vitest.overrides ?? []).map<OxlintOverride>((override) => ({
  ...override,
  rules: {
    ...override.rules,
    "no-await-in-loop": "off",
    "vitest/max-expects": "off",
  },
}));

const config: OxlintConfig = {
  extends: [core],
  ignorePatterns: core.ignorePatterns ?? [],
  overrides: [
    ...testOverrides,
    {
      files: ["**/*.{ts,tsx}"],
      rules: {
        "unicorn/no-useless-undefined": ["error", { checkArguments: false }],
      },
    },
  ],
  rules: {
    "func-style": "off",
    "no-nested-ternary": "off",
    "no-use-before-define": ["error", { functions: false }],
    "promise/avoid-new": "off",
    "promise/prefer-await-to-callbacks": "off",
    "promise/prefer-await-to-then": "off",
    "unicorn/no-nested-ternary": "off",
  },
};

export default config;
