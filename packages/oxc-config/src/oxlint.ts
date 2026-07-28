import type { OxlintConfig, OxlintOverride } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

const defaultTestFiles = ["**/*.{test,spec}.{ts,tsx,js,jsx}", "**/__tests__/**/*.{ts,tsx,js,jsx}"];

export interface CreateOxlintConfigOptions extends OxlintConfig {
  /** Files receiving framework-neutral test policy, including test helpers. */
  testFiles?: readonly string[];
  /** Non-Vitest test files to exclude from the default Vitest preset. */
  vitestExcludeFiles?: readonly string[];
}

export function createOxlintConfig(options: CreateOxlintConfigOptions = {}): OxlintConfig {
  const {
    extends: extensions = [],
    ignorePatterns = [],
    options: lintOptions = {},
    overrides = [],
    rules = {},
    testFiles = defaultTestFiles,
    vitestExcludeFiles = [],
    ...config
  } = options;
  const vitestOverrides = (vitest.overrides ?? []).map<OxlintOverride>((override) => {
    const excludeFiles = [...(override.excludeFiles ?? []), ...vitestExcludeFiles];

    return {
      ...override,
      ...(excludeFiles.length > 0 ? { excludeFiles } : {}),
      rules: {
        ...override.rules,
        "vitest/max-expects": "off"
      }
    };
  });
  const vitestConfig: OxlintConfig = {
    ...vitest,
    overrides: vitestOverrides
  };

  return {
    ...config,
    extends: [core, vitestConfig, ...extensions],
    ignorePatterns: [...(core.ignorePatterns ?? []), ...ignorePatterns],
    options: {
      typeAware: true,
      typeCheck: true,
      ...lintOptions
    },
    overrides: [
      {
        files: [...testFiles],
        rules: {
          "no-await-in-loop": "off"
        }
      },
      {
        files: ["**/*.{ts,tsx}"],
        rules: {
          "unicorn/no-useless-undefined": ["error", { checkArguments: false }]
        }
      },
      ...overrides
    ],
    rules: {
      "func-style": "off",
      "no-nested-ternary": "off",
      "no-use-before-define": ["error", { functions: false }],
      "prefer-regex-literals": "off",
      "promise/avoid-new": "off",
      "promise/prefer-await-to-callbacks": "off",
      "promise/prefer-await-to-then": "off",
      "typescript/promise-function-async": "off",
      "typescript/return-await": ["error", "in-try-catch"],
      "unicorn/no-nested-ternary": "off",
      ...rules
    }
  };
}

export const oxlintConfig = createOxlintConfig();

export default oxlintConfig;
