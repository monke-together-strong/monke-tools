import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vite-plus";

import mtsLint from "./packages/oxlint-config/src/config.ts";

const workspaceRoot = import.meta.dirname;

export default defineConfig({
  fmt: {
    ignorePatterns: ["backlog/**", "skills/**", "AGENTS.md", "CLAUDE.md"],
    printWidth: 100,
  },
  lint: {
    ...mtsLint,
    categories: {
      correctness: "warn",
    },
    ignorePatterns: [...mtsLint.ignorePatterns, "skills/imported/**"],
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
      "eslint/no-unused-vars": "error",
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
  plugins: [
    {
      enforce: "pre",
      async load(id) {
        const filePath = id.split("?")[0] ?? "";
        if (!filePath.endsWith(".md")) {
          return null;
        }

        const source = await readFile(filePath, "utf-8");
        return `export default ${JSON.stringify(source)};`;
      },
      name: "markdown-as-text",
    },
  ],
  staged: {
    "*": "vp check --fix",
  },
  test: {
    fileParallelism: false,
    include: ["__tests__/**/*.test.ts"],
    maxConcurrency: 1,
  },
});
