import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vite-plus";

import { createOxlintConfig } from "./packages/oxlint-config/src/config.ts";

const workspaceRoot = import.meta.dirname;
const mtsLint = createOxlintConfig({
  vitestExcludeFiles: ["**/__tests__/helpers.ts"],
});

export default defineConfig({
  fmt: {
    ignorePatterns: ["skills/**", "AGENTS.md"],
    printWidth: 100,
  },
  lint: {
    ...mtsLint,
    ignorePatterns: [...(mtsLint.ignorePatterns ?? []), "skills/imported/**"],
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      ...mtsLint.rules,
      "vite-plus/prefer-vite-plus-imports": "error",
    },
  },
  pack: {
    deps: {
      neverBundle: true,
    },
    dts: {
      generator: "tsgo",
      tsgo: {
        path: path.resolve(
          path.dirname(createRequire(import.meta.url).resolve("@typescript/native/package.json")),
          "bin/tsc",
        ),
      },
    },
    entry: [path.resolve(workspaceRoot, "packages/oxlint-config/src/config.ts")],
    format: ["esm"],
    outDir: path.resolve(workspaceRoot, "packages/oxlint-config/dist"),
  },
  staged: {
    "*": "vp check --fix",
  },
  test: {
    fileParallelism: false,
    include: ["__tests__/**/*.test.ts"],
    maxConcurrency: 1,
  },
});
