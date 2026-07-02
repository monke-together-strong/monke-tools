import { readFile } from "node:fs/promises";
import { defineConfig } from "vitest/config";

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
});
