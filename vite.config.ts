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
  ],
  overrides: [
    {
      // Tests deliberately manipulate environment state; the remaining files are the centralized
      // environment boundaries for their respective Monke CLIs.
      files: [
        "__tests__/**/*.ts",
        "src/runtime.ts",
        "scripts/import-skills.ts",
        "skills/internal/agent-session-retrospective/scripts/lib/store.ts",
        "skills/internal/betterstack-cli/scripts/betterstack-cli/env.ts",
        "skills/internal/betterstack-cli/scripts/betterstack-cli/index.ts"
      ],
      rules: {
        "node/no-process-env": "off"
      }
    }
  ],
  rules: {
    "vite-plus/prefer-vite-plus-imports": "error"
  },
  vitestExcludeFiles: ["**/__tests__/helpers.ts"]
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
    "*": `sh -c 'vp check --fix "$@" || true' --`
  },
  test: {
    fileParallelism: false,
    include: ["__tests__/**/*.test.ts"],
    maxConcurrency: 1
  }
});
