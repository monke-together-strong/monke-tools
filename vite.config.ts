import { readFile } from "node:fs/promises";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    {
      name: "markdown-as-text",
      enforce: "pre",
      async load(id) {
        const filePath = id.split("?")[0] ?? "";
        if (!filePath.endsWith(".md")) {
          return null;
        }

        const source = await readFile(filePath, "utf8");
        return `export default ${JSON.stringify(source)};`;
      },
    },
  ],
  test: {
    include: ["__tests__/**/*.test.ts"],
    fileParallelism: false,
    maxConcurrency: 1,
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    printWidth: 100,
    ignorePatterns: ["backlog/**", "skills/**", "AGENTS.md", "CLAUDE.md"],
  },
  lint: {
    ignorePatterns: ["skills/imported/**"],
    categories: {
      correctness: "warn",
    },
    rules: {
      "eslint/no-unused-vars": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
});
