import type { OxlintConfig, OxlintOverride } from "vite-plus/lint";

import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

const defaultTestFiles = ["**/*.{test,spec}.{ts,tsx,js,jsx}", "**/__tests__/**/*.{ts,tsx,js,jsx}"];

export interface CreateOxlintConfigOptions {
  /** Files receiving framework-neutral test policy, including test helpers. */
  testFiles?: readonly string[];
  /** Non-Vitest test files to exclude from the default Vitest preset. */
  vitestExcludeFiles?: readonly string[];
}

export function createOxlintConfig(options: CreateOxlintConfigOptions = {}): OxlintConfig {
  const vitestExcludeFiles = options.vitestExcludeFiles ?? [];
  const vitestOverrides = (vitest.overrides ?? []).map<OxlintOverride>((override) => {
    const excludeFiles = [...(override.excludeFiles ?? []), ...vitestExcludeFiles];

    return {
      ...override,
      ...(excludeFiles.length > 0 ? { excludeFiles } : {}),
      rules: {
        ...override.rules,
        "vitest/max-expects": "off",
      },
    };
  });

  return {
    extends: [core],
    ignorePatterns: core.ignorePatterns ?? [],
    overrides: [
      ...vitestOverrides,
      {
        files: [...(options.testFiles ?? defaultTestFiles)],
        rules: {
          "no-await-in-loop": "off",
        },
      },
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
}

export default createOxlintConfig();
