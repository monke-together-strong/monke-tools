import { createRequire } from "node:module";

import { describe, expect, test } from "vitest";

import { createOxlintConfig } from "../packages/oxc-config/src/oxlint.ts";

const oxcConfigRequire = createRequire(
  new URL("../packages/oxc-config/package.json", import.meta.url)
);

describe("shared Oxlint config", () => {
  test("enables Ultracite's anti-slop preset", () => {
    const config = createOxlintConfig();
    const configuredAntiSlop = config.extends?.find(
      (extension) =>
        extension.rules?.["anti-slop/require-safety-comment-for-type-assertion"] === "error"
    );

    expect(configuredAntiSlop?.rules).toMatchObject({
      "anti-slop/require-safety-comment-for-type-assertion": "error"
    });
  });

  test("owns JSDoc type validation while preserving consumer plugins", () => {
    const consumerPlugin = {
      name: "consumer",
      specifier: "consumer-plugin"
    } as const;
    const config = createOxlintConfig({ jsPlugins: [consumerPlugin] });
    const [jsdocPlugin, perfectionistPlugin, configuredConsumerPlugin] = config.jsPlugins ?? [];

    expect(jsdocPlugin).toMatchObject({
      name: "jsdoc-js",
      specifier: oxcConfigRequire.resolve("eslint-plugin-jsdoc")
    });
    expect(perfectionistPlugin).toMatchObject({ name: "perfectionist" });
    expect(configuredConsumerPlugin).toStrictEqual(consumerPlugin);
    expect(config.rules).toMatchObject({
      "jsdoc-js/no-undefined-types": "error",
      "no-console": "error",
      "node/no-process-env": "error",
      "perfectionist/sort-objects": ["error", { partitionByComment: true }],
      "sort-keys": "off",
      "typescript/explicit-module-boundary-types": "off"
    });
  });

  test("permits process environment access in tests and skills", () => {
    const config = createOxlintConfig();
    const testOverride = config.overrides?.find((override) =>
      override.files?.includes("**/__tests__/**/*.{ts,tsx,js,jsx}")
    );
    const skillsOverride = config.overrides?.find((override) =>
      override.files?.includes("**/skills/**")
    );

    expect(testOverride?.rules?.["node/no-process-env"]).toBe("off");
    expect(skillsOverride?.rules?.["node/no-process-env"]).toBe("off");
  });
});
