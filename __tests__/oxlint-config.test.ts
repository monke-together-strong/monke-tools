import { describe, expect, test } from "vite-plus/test";

import mtsLint from "../packages/oxlint-config/src/config.ts";

describe("shared Oxlint config", () => {
  test("keeps broadly valid syntax while preserving useful checks", () => {
    expect(mtsLint.rules).toMatchObject({
      "no-use-before-define": ["error", { functions: false }],
      "promise/avoid-new": "off",
      "promise/prefer-await-to-callbacks": "off",
      "promise/prefer-await-to-then": "off",
    });
    expect(mtsLint.rules).not.toHaveProperty("no-bitwise");
  });

  test("applies TypeScript and test policy only to matching files", () => {
    const overrides = mtsLint.overrides ?? [];
    const typescriptOverride = overrides.find(
      (override) => override.rules?.["unicorn/no-useless-undefined"] !== undefined,
    );
    const testOverride = overrides.find(
      (override) => override.rules?.["vitest/max-expects"] !== undefined,
    );

    expect(typescriptOverride).toMatchObject({
      files: ["**/*.{ts,tsx}"],
      rules: {
        "unicorn/no-useless-undefined": ["error", { checkArguments: false }],
      },
    });
    expect(testOverride).toMatchObject({
      files: ["**/*.{test,spec}.{ts,tsx,js,jsx}", "**/__tests__/**/*.{ts,tsx,js,jsx}"],
      rules: {
        "no-await-in-loop": "off",
        "vitest/max-expects": "off",
      },
    });
    expect(overrides.some((override) => override.rules?.["sort-keys"] === "off")).toBeFalsy();
  });
});
