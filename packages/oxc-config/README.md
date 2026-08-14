# `@monke-together-strong/oxc-config`

Shared TypeScript, Oxlint, and Oxfmt presets maintained by Monke Together Strong.

## TypeScript

```sh
bun add -D @monke-together-strong/oxc-config typescript
```

```json
{
  "extends": "@monke-together-strong/oxc-config/base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true
  }
}
```

The base preset contains runtime-neutral correctness and soundness settings. Consumers remain
responsible for environment-specific options such as `lib`, `module`, `moduleResolution`, JSX,
runtime types, and emit behavior.

## Oxc

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
    ignorePatterns: [".repo-specific-output"]
  }),
  lint: createOxlintConfig({
    ignorePatterns: [".repo-specific-output"]
  })
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

The Oxfmt preset formats JSDoc, uses a print width of 100, ignores team-managed `skills/**` and `AGENTS.md`, and appends consumer `ignorePatterns` after its shared ignores. Other consumer fields override the shared formatter defaults.

The default Oxlint preset composes Ultracite's core, anti-slop, and Vitest presets, enables type-aware linting and TypeScript type checking, rejects console calls and direct environment access, and requires explicit module boundary types. Environment variables should be read and validated through a centralized configuration boundary. It uses `eslint-plugin-perfectionist` to sort object literals, destructuring, object types, interfaces, JSX props, enums, and heritage clauses while treating comments as intentional object and enum partitions, and disables Ultracite's `sort-keys` rule. It also loads `eslint-plugin-jsdoc` through Oxlint's JavaScript-plugin compatibility layer to reject undefined JSDoc types that Oxlint does not yet implement natively. Files named `*.test.*`, `*.spec.*`, or stored under `__tests__` are assumed to use Vitest. Its framework-neutral test policy also covers files under `test/` and `tests/`, where `typescript/no-unsafe-type-assertion` is disabled because typed mock and fixture setup is not yet ergonomic enough to justify the churn.

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
        "vitest/no-disabled-tests": "off"
      }
    }
  ],
  rules: {
    "no-console": "error"
  },
  testFiles: ["tests/**/*.{ts,tsx}"],
  vitestExcludeFiles: ["tests/e2e/**/*.{ts,tsx}"]
});
```

`extends`, `ignorePatterns`, and `overrides` append after their shared lint values. Consumer `rules` and `options` override shared defaults. Other Oxlint fields pass through at the root.

The presets are published on public npm under the MIT license.
