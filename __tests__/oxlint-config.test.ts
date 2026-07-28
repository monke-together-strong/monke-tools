import { describe, expect, test } from "vite-plus/test";
import type { OxlintConfig, OxlintOverride } from "vite-plus/lint";

import mtsLint, { createOxlintConfig } from "../packages/oxlint-config/src/config.ts";

describe("shared Oxlint config", () => {
  test("keeps broadly valid syntax while preserving useful checks", () => {
    expect(mtsLint.rules).toMatchObject({
      "no-use-before-define": ["error", { functions: false }],
      "prefer-regex-literals": "off",
      "promise/avoid-new": "off",
      "promise/prefer-await-to-callbacks": "off",
      "promise/prefer-await-to-then": "off",
      "typescript/promise-function-async": "off",
    });
    expect(mtsLint.rules).not.toHaveProperty("no-bitwise");
  });

  test("applies TypeScript and test policy only to matching files", () => {
    const overrides = mtsLint.overrides ?? [];
    const typescriptOverride = overrides.find(
      (override) => override.rules?.["unicorn/no-useless-undefined"] !== undefined,
    );
    const vitestOverride = overrides.find(
      (override) => override.rules?.["vitest/max-expects"] !== undefined,
    );
    const testOverride = overrides.find(
      (override) => override.rules?.["no-await-in-loop"] !== undefined,
    );

    expect(typescriptOverride).toMatchObject({
      files: ["**/*.{ts,tsx}"],
      rules: {
        "unicorn/no-useless-undefined": ["error", { checkArguments: false }],
      },
    });
    expect(vitestOverride).toMatchObject({
      files: ["**/*.{test,spec}.{ts,tsx,js,jsx}", "**/__tests__/**/*.{ts,tsx,js,jsx}"],
      rules: {
        "vitest/max-expects": "off",
      },
    });
    expect(vitestOverride?.rules).not.toHaveProperty("no-await-in-loop");
    expect(testOverride).toMatchObject({
      files: ["**/*.{test,spec}.{ts,tsx,js,jsx}", "**/__tests__/**/*.{ts,tsx,js,jsx}"],
      rules: {
        "no-await-in-loop": "off",
      },
    });
    expect(testOverride?.rules).not.toHaveProperty("vitest/max-expects");
    expect(overrides.some((override) => override.rules?.["sort-keys"] === "off")).toBeFalsy();
  });

  test("supports complete test trees while excluding non-Vitest frameworks", () => {
    const config = createOxlintConfig({
      testFiles: ["tests/**/*.{ts,tsx}"],
      vitestExcludeFiles: ["tests/e2e/**/*.{ts,tsx}"],
    });
    const overrides = config.overrides ?? [];
    const vitestOverride = overrides.find(
      (override) => override.rules?.["vitest/max-expects"] !== undefined,
    );
    const testOverride = overrides.find(
      (override) => override.rules?.["no-await-in-loop"] !== undefined,
    );

    expect(vitestOverride).toMatchObject({
      excludeFiles: ["tests/e2e/**/*.{ts,tsx}"],
      files: ["**/*.{test,spec}.{ts,tsx,js,jsx}", "**/__tests__/**/*.{ts,tsx,js,jsx}"],
    });
    expect(testOverride).toMatchObject({
      files: ["tests/**/*.{ts,tsx}"],
      rules: {
        "no-await-in-loop": "off",
      },
    });
  });

  test("composes consumer Oxlint config after shared policy", () => {
    const extension = {
      rules: {
        "no-console": "error",
      },
    } satisfies OxlintConfig;
    const localOverride = {
      files: ["src/routes/**"],
      rules: {
        "sort-keys": "off",
      },
    } satisfies OxlintOverride;
    const config = createOxlintConfig({
      env: {
        node: true,
      },
      extends: [extension],
      ignorePatterns: [".repo-output"],
      overrides: [localOverride],
      rules: {
        "no-bitwise": "off",
      },
    });

    expect(config.extends).toStrictEqual([...(mtsLint.extends ?? []), extension]);
    expect(config.ignorePatterns).toStrictEqual([
      ...(mtsLint.ignorePatterns ?? []),
      ".repo-output",
    ]);
    expect(config.overrides?.at(-1)).toStrictEqual(localOverride);
    expect(config.rules).toMatchObject({
      "no-bitwise": "off",
      "no-use-before-define": ["error", { functions: false }],
    });
    expect(config.env).toMatchObject({
      node: true,
    });
  });
});
