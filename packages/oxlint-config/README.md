# `@monke-together-strong/oxlint-config`

Shared lint preset for Vite+ repositories, maintained by Monke Together Strong.

```sh
bun add -D @monke-together-strong/oxlint-config
```

```ts
import mtsLint from "@monke-together-strong/oxlint-config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: mtsLint,
});
```

Run checks through Vite+:

```sh
vp check
vp check --fix
```

The default config composes Ultracite's native core and Vitest presets, carries
the core preset's generic ignore patterns, and leaves environment globals and
repository-specific ignores to the consumer. It assumes files named
`*.test.*`, `*.spec.*`, or stored under `__tests__` use Vitest.

Mixed-framework repositories can keep that default while excluding
framework-owned paths. `testFiles` applies framework-neutral test policy to a
complete test tree, including helpers, while `vitestExcludeFiles` prevents the
Vitest preset from linting tests owned by another framework. The factory also
accepts ordinary Oxlint config fields:

```ts
import { createOxlintConfig } from "@monke-together-strong/oxlint-config";
import { defineConfig } from "vite-plus";
import react from "ultracite/oxlint/react";
import tanstack from "ultracite/oxlint/tanstack";

const mtsLint = createOxlintConfig({
  extends: [react, tanstack],
  ignorePatterns: [".repo-specific-output"],
  overrides: [
    {
      files: ["tests/unit/**"],
      rules: {
        "vitest/no-disabled-tests": "off",
      },
    },
  ],
  rules: {
    "no-console": "error",
  },
  testFiles: ["tests/**/*.{ts,tsx}"],
  vitestExcludeFiles: ["tests/e2e/**/*.{ts,tsx}"],
});

export default defineConfig({
  lint: mtsLint,
});
```

`extends`, `ignorePatterns`, and `overrides` append after their shared values.
Consumer `rules` override shared rules. Other Oxlint fields pass through at the
root.

The shared lint preset is published on public npm under the MIT license.
