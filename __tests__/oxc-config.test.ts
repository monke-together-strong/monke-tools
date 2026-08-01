import type { OxlintConfig, OxlintOverride } from "vite-plus/lint";
import { describe, expect, test } from "vite-plus/test";

import mtsFmt, { createOxfmtConfig } from "../packages/oxc-config/src/oxfmt.ts";
import mtsLint, { createOxlintConfig } from "../packages/oxc-config/src/oxlint.ts";

function findVitestOverride(config: OxlintConfig): OxlintOverride | undefined {
  return config.extends
    ?.filter((extension): extension is OxlintConfig => typeof extension !== "string")
    .flatMap((extension) => extension.overrides ?? [])
    .find((override) => override.rules?.["vitest/max-expects"] !== undefined);
}

describe("shared Oxfmt config", () => {
  test("composes consumer config after Ultracite", () => {
    const config = createOxfmtConfig({
      ignorePatterns: [".repo-output"],
      printWidth: 120
    });

    expect(mtsFmt.printWidth).toBe(100);
    expect(mtsFmt.proseWrap).toBe("preserve");
    expect(mtsFmt.trailingComma).toBe("none");
    expect(mtsFmt.ignorePatterns).toContain("skills/**");
    expect(mtsFmt.ignorePatterns).toContain("AGENTS.md");
    expect(config).toMatchObject({
      printWidth: 120,
      semi: mtsFmt.semi,
      sortImports: mtsFmt.sortImports
    });
    expect(config.ignorePatterns).toStrictEqual([...(mtsFmt.ignorePatterns ?? []), ".repo-output"]);
  });
});

describe("shared Oxlint config", () => {
  test("keeps broadly valid syntax while preserving useful checks", () => {
    expect(mtsLint.options).toMatchObject({
      typeAware: true,
      typeCheck: true
    });
    expect(mtsLint.rules).toMatchObject({
      "class-methods-use-this": "off",
      eqeqeq: ["error", "smart"],
      "no-eq-null": "off",
      "no-use-before-define": ["error", { functions: false }],
      "no-warning-comments": "off",
      "prefer-regex-literals": "off",
      "promise/avoid-new": "off",
      "promise/prefer-await-to-callbacks": "off",
      "promise/prefer-await-to-then": "off",
      "typescript/parameter-properties": "off",
      "typescript/promise-function-async": "off"
    });
    expect(mtsLint.rules).not.toHaveProperty("no-bitwise");
    expect(mtsLint.rules).not.toHaveProperty("typescript/return-await");
  });

  test("applies TypeScript and test policy only to matching files", () => {
    const overrides = mtsLint.overrides ?? [];
    const typescriptOverride = overrides.find(
      (override) => override.rules?.["unicorn/no-useless-undefined"] !== undefined
    );
    const vitestOverride = findVitestOverride(mtsLint);
    const testOverride = overrides.find(
      (override) => override.rules?.["no-await-in-loop"] !== undefined
    );

    expect(typescriptOverride).toMatchObject({
      files: ["**/*.{ts,tsx}"],
      rules: {
        "unicorn/no-useless-undefined": ["error", { checkArguments: false }]
      }
    });
    expect(vitestOverride).toMatchObject({
      files: ["**/*.{test,spec}.{ts,tsx,js,jsx}", "**/__tests__/**/*.{ts,tsx,js,jsx}"],
      rules: {
        "vitest/max-expects": "off"
      }
    });
    expect(vitestOverride?.rules).not.toHaveProperty("no-await-in-loop");
    expect(testOverride).toMatchObject({
      files: ["**/*.{test,spec}.{ts,tsx,js,jsx}", "**/__tests__/**/*.{ts,tsx,js,jsx}"],
      rules: {
        "no-await-in-loop": "off"
      }
    });
    expect(testOverride?.rules).not.toHaveProperty("vitest/max-expects");
    expect(overrides.some((override) => override.rules?.["sort-keys"] === "off")).toBeFalsy();
  });

  test("supports complete test trees while excluding non-Vitest frameworks", () => {
    const config = createOxlintConfig({
      testFiles: ["tests/**/*.{ts,tsx}"],
      vitestExcludeFiles: ["tests/e2e/**/*.{ts,tsx}"]
    });
    const overrides = config.overrides ?? [];
    const vitestOverride = findVitestOverride(config);
    const testOverride = overrides.find(
      (override) => override.rules?.["no-await-in-loop"] !== undefined
    );

    expect(vitestOverride).toMatchObject({
      excludeFiles: ["tests/e2e/**/*.{ts,tsx}"],
      files: ["**/*.{test,spec}.{ts,tsx,js,jsx}", "**/__tests__/**/*.{ts,tsx,js,jsx}"]
    });
    expect(testOverride).toMatchObject({
      files: ["tests/**/*.{ts,tsx}"],
      rules: {
        "no-await-in-loop": "off"
      }
    });
  });

  test("composes consumer Oxlint config after shared policy", () => {
    const extension = {
      rules: {
        "no-console": "error"
      }
    } satisfies OxlintConfig;
    const localOverride = {
      files: ["src/routes/**"],
      rules: {
        "sort-keys": "off"
      }
    } satisfies OxlintOverride;
    const config = createOxlintConfig({
      env: {
        node: true
      },
      extends: [extension],
      ignorePatterns: [".repo-output"],
      options: {
        typeAware: false
      },
      overrides: [localOverride],
      rules: {
        "no-bitwise": "off"
      }
    });

    expect(config.extends).toStrictEqual([...(mtsLint.extends ?? []), extension]);
    expect(config.ignorePatterns).toStrictEqual([
      ...(mtsLint.ignorePatterns ?? []),
      ".repo-output"
    ]);
    expect(config.options).toMatchObject({
      typeAware: false,
      typeCheck: true
    });
    expect(config.overrides?.at(-1)).toStrictEqual(localOverride);
    expect(config.rules).toMatchObject({
      "no-bitwise": "off",
      "no-use-before-define": ["error", { functions: false }]
    });
    expect(config.env).toMatchObject({
      node: true
    });
  });
});
