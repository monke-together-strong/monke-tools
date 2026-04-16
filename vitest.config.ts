import { readFile } from "node:fs/promises";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "markdown-as-text",
      enforce: "pre",
      async load(id) {
        const [path] = id.split("?", 1);
        if (!path.endsWith(".md")) {
          return null;
        }

        const source = await readFile(path, "utf8");
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
