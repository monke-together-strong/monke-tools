import { createRequire } from "node:module";
import path from "node:path";

import { defineConfig } from "vite-plus";

import { createOxfmtConfig } from "./packages/oxc-config/src/oxfmt.ts";
import { createOxlintConfig } from "./packages/oxc-config/src/oxlint.ts";

const workspaceRoot = import.meta.dirname;
const mtsFmt = createOxfmtConfig({
  ignorePatterns: [".tegami/publish-lock.yaml"],
});
const mtsLint = createOxlintConfig({
  ignorePatterns: ["skills/imported/**"],
  jsPlugins: [
    {
      name: "vite-plus",
      specifier: "vite-plus/oxlint-plugin",
    },
  ],
  rules: {
    "vite-plus/prefer-vite-plus-imports": "error",
  },
  vitestExcludeFiles: ["**/__tests__/helpers.ts"],
});

export default defineConfig({
  fmt: mtsFmt,
  lint: mtsLint,
  pack: {
    deps: {
      neverBundle: true,
    },
    dts: {
      generator: "tsgo",
      tsgo: {
        path: path.resolve(
          path.dirname(createRequire(import.meta.url).resolve("@typescript/native/package.json")),
          "bin/tsc"
        ),
      },
    },
    entry: [
      path.resolve(workspaceRoot, "packages/oxc-config/src/oxfmt.ts"),
      path.resolve(workspaceRoot, "packages/oxc-config/src/oxlint.ts"),
    ],
    format: ["esm"],
    outDir: path.resolve(workspaceRoot, "packages/oxc-config/dist"),
  },
  staged: {
    "*": `sh -c 'vp check --fix "$@" || true' --`,
  },
  test: {
    fileParallelism: false,
    include: ["__tests__/**/*.test.ts"],
    maxConcurrency: 1,
  },
});
