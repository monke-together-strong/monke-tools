import { createRequire } from "node:module";

import type { OxlintConfig, OxlintOverride } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

const jsdocPlugin = {
  name: "jsdoc-js",
  specifier: createRequire(import.meta.url).resolve("eslint-plugin-jsdoc")
} as const;

const defaultTestFiles = [
  "**/*.{test,spec}.{ts,tsx,js,jsx}",
  "**/__tests__/**/*.{ts,tsx,js,jsx}",
  "**/__mocks__/**/*.{ts,tsx,js,jsx}",
  "**/{test,tests}/**/*.{ts,tsx,js,jsx}"
];

const executableTestFiles = ["**/*.{test,spec}.{ts,tsx,js,jsx}"];

const generatedFileIgnorePatterns = [
  // TanStack Router owns this file and explicitly requires linters and formatters to ignore it.
  "**/routeTree.gen.ts"
];

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
    jsPlugins = [],
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
    ignorePatterns: [
      ...(core.ignorePatterns ?? []),
      ...generatedFileIgnorePatterns,
      ...ignorePatterns
    ],
    jsPlugins: [jsdocPlugin, ...(jsPlugins ?? [])],
    options: {
      typeAware: true,
      typeCheck: true,
      ...lintOptions
    },
    overrides: [
      {
        files: executableTestFiles,
        rules: {
          // Branching assertions and optional-chain probes inflate complexity without obscuring production control flow.
          complexity: "off"
        }
      },
      {
        files: [...testFiles],
        rules: {
          "no-await-in-loop": "off",
          "no-inline-comments": "off",
          "no-script-url": "off",
          "require-await": "off",
          // TODO: Reconsider after test generators and setup provide ergonomic, fully typed mocks and fixtures.
          "typescript/no-dynamic-delete": "off",
          "typescript/no-unsafe-type-assertion": "off",
          "typescript/restrict-template-expressions": "off",
          "typescript/unbound-method": "off",
          "unicorn/consistent-function-scoping": "off",
          "unicorn/no-object-as-default-parameter": "off"
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
      "class-methods-use-this": "off",
      eqeqeq: ["error", "smart"],
      "func-style": "off",
      "jsdoc-js/no-undefined-types": "error",
      "max-classes-per-file": "off",
      "no-eq-null": "off",
      // Negated branches are often clearest for guard clauses and explicit definedness checks.
      "no-negated-condition": "off",
      "no-nested-ternary": "off",
      // Declaration order is a readability choice; TypeScript catches unsafe temporal-dead-zone access.
      "no-use-before-define": ["error", { classes: false, functions: false, variables: false }],
      "no-warning-comments": "off",
      "prefer-regex-literals": "off",
      "promise/avoid-new": "off",
      "promise/prefer-await-to-callbacks": "off",
      "promise/prefer-await-to-then": "off",
      // Optional-result helpers read naturally as an early value return followed by implicit undefined.
      "typescript/consistent-return": "off",
      "typescript/no-extraneous-class": ["error", { allowWithDecorator: true }],
      "typescript/parameter-properties": "off",
      "typescript/prefer-nullish-coalescing": [
        "error",
        {
          ignorePrimitives: {
            string: true
          }
        }
      ],
      "typescript/promise-function-async": "off",
      "typescript/strict-boolean-expressions": [
        "error",
        {
          allowNullableBoolean: true,
          allowNullableObject: true,
          allowNullableString: true
        }
      ],
      // Reduce is often the clearest expression for immutable aggregation and collection folding.
      "unicorn/no-array-reduce": "off",
      "unicorn/no-negated-condition": "off",
      "unicorn/no-nested-ternary": "off",
      ...rules
    }
  };
}

export const oxlintConfig = createOxlintConfig();

export default oxlintConfig;
