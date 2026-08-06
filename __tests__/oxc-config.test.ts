import { describe, expect, test } from "vite-plus/test";

import { createOxlintConfig } from "../packages/oxc-config/src/oxlint.ts";

describe("shared Oxlint config", () => {
  test("owns JSDoc type validation while preserving consumer plugins", () => {
    const consumerPlugin = {
      name: "consumer",
      specifier: "consumer-plugin"
    } as const;
    const config = createOxlintConfig({ jsPlugins: [consumerPlugin] });
    const [sharedPlugin, configuredConsumerPlugin] = config.jsPlugins ?? [];

    expect(sharedPlugin).toMatchObject({ name: "jsdoc-js" });
    expect(
      typeof sharedPlugin === "object" && sharedPlugin.specifier.includes("eslint-plugin-jsdoc")
    ).toBeTruthy();
    expect(configuredConsumerPlugin).toStrictEqual(consumerPlugin);
    expect(config.rules).toMatchObject({
      "jsdoc-js/no-undefined-types": "error",
      "no-console": "error",
      "typescript/explicit-module-boundary-types": "error"
    });
  });
});
