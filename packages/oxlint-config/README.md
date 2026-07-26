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
Vitest preset from linting tests owned by another framework:

```ts
import { createOxlintConfig } from "@monke-together-strong/oxlint-config";
import { defineConfig } from "vite-plus";

const mtsLint = createOxlintConfig({
  testFiles: ["tests/**/*.{ts,tsx}"],
  vitestExcludeFiles: ["tests/e2e/**/*.{ts,tsx}"],
});

export default defineConfig({
  lint: mtsLint,
});
```

The returned value is a normal Oxlint config. Append repository-specific
settings after the shared values so matching local overrides take precedence:

```ts
lint: {
  ...mtsLint,
  ignorePatterns: [...(mtsLint.ignorePatterns ?? []), ".repo-specific-output"],
  rules: {
    ...mtsLint.rules,
    "no-console": "error",
  },
  overrides: [
    ...(mtsLint.overrides ?? []),
    {
      files: ["tests/unit/**"],
      rules: {
        "vitest/no-disabled-tests": "off",
      },
    },
  ],
},
```

The shared lint preset is published on public npm under the MIT license.
