# `@monke-together-strong/oxc-config`

Shared Oxlint and Oxfmt presets maintained by Monke Together Strong.

The presets compose Ultracite's native Oxc configuration while allowing repository-specific settings to override shared defaults.

## Vite+

```sh
bun add -D @monke-together-strong/oxc-config vite-plus
```

```ts
import { createOxfmtConfig } from "@monke-together-strong/oxc-config/oxfmt";
import { createOxlintConfig } from "@monke-together-strong/oxc-config/oxlint";
import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: createOxfmtConfig({
    ignorePatterns: [".repo-specific-output"],
  }),
  lint: createOxlintConfig({
    ignorePatterns: [".repo-specific-output"],
  }),
});
```

Run checks through Vite+:

```sh
vp check
vp check --fix
```

## Standalone Oxc

```sh
bun add -D @monke-together-strong/oxc-config oxfmt oxlint oxlint-tsgolint
```

```ts
// oxfmt.config.ts
export { default } from "@monke-together-strong/oxc-config/oxfmt";
```

```ts
// oxlint.config.ts
export { default } from "@monke-together-strong/oxc-config/oxlint";
```

The Oxfmt preset uses a print width of 100, ignores team-managed `skills/**` and `AGENTS.md`, and appends consumer `ignorePatterns` after its shared ignores. Other consumer fields override the shared formatter defaults.

The default Oxlint preset composes Ultracite's core and Vitest presets, enables type-aware linting and TypeScript type checking, and assumes files named `*.test.*`, `*.spec.*`, or stored under `__tests__` use Vitest.

Mixed-framework repositories can exclude framework-owned paths from the Vitest preset:

```ts
import { createOxlintConfig } from "@monke-together-strong/oxc-config/oxlint";
import react from "ultracite/oxlint/react";
import tanstack from "ultracite/oxlint/tanstack";

export default createOxlintConfig({
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
```

`extends`, `ignorePatterns`, and `overrides` append after their shared lint values. Consumer `rules` and `options` override shared defaults. Other Oxlint fields pass through at the root.

The presets are published on public npm under the MIT license.
