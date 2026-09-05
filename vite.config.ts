import { createRequire } from "node:module";
import path from "node:path";

import { defineConfig } from "vite-plus";

import { createOxfmtConfig } from "./packages/oxc-config/src/oxfmt.ts";
import { createOxlintConfig } from "./packages/oxc-config/src/oxlint.ts";

const workspaceRoot = import.meta.dirname;
const mtsFmt = createOxfmtConfig({
  ignorePatterns: [".tegami/publish-lock.yaml", "**/imported/**"]
});
const mtsLint = createOxlintConfig({
  ignorePatterns: ["**/imported/**"],
  jsPlugins: [
    {
      name: "vite-plus",
      specifier: "vite-plus/oxlint-plugin"
    }
  ]
});

export default defineConfig({
  fmt: mtsFmt,
  lint: mtsLint,
  pack: {
    deps: {
      neverBundle: true
    },
    dts: {
      generator: "tsgo",
      tsgo: {
        path: path.resolve(
          path.dirname(createRequire(import.meta.url).resolve("@typescript/native/package.json")),
          "bin/tsc"
        )
      }
    },
    entry: [
      path.resolve(workspaceRoot, "packages/oxc-config/src/oxfmt.ts"),
      path.resolve(workspaceRoot, "packages/oxc-config/src/oxlint.ts")
    ],
    format: ["esm"],
    outDir: path.resolve(workspaceRoot, "packages/oxc-config/dist")
  },
  staged: {
    "*": "vp check --fix"
  },
  test: {
    fileParallelism: true,
    include: ["tests/**/*.test.ts"],
    maxConcurrency: 1,
    maxWorkers: 2
  }
});
