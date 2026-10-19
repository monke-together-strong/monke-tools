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
import { createOxlintConfig } from "@monke-together-strong/oxc-config/oxlint";

export default createOxlintConfig();
```

The Oxfmt preset formats JSDoc and uses a print width of 100. It formats first-party skill code and metadata while excluding imported skills, imported references, skill Markdown, and `AGENTS.md`. Consumer `ignorePatterns` append after these shared ignores; other consumer fields override the shared formatter defaults.

The default Oxlint preset composes Ultracite's core, anti-slop, and Vitest presets, enables type-aware linting and TypeScript type checking, and rejects console calls and direct environment access. Environment variables should be read and validated through a centralized configuration boundary. It uses `eslint-plugin-perfectionist` to sort object literals, destructuring, object types, interfaces, JSX props, enums, and heritage clauses while treating comments as intentional object and enum partitions, and disables Ultracite's `sort-keys` rule. It disables anti-slop's `no-array-filter-map` because its suggested `flatMap` and iterator-helper rewrites run slower than `filter().map()` on Bun. It also loads `eslint-plugin-jsdoc` through Oxlint's JavaScript-plugin compatibility layer to reject undefined JSDoc types that Oxlint does not yet implement natively. Files named `*.test.*`, `*.spec.*`, or stored under `__tests__` are assumed to use Vitest. Its framework-neutral test policy also covers files under `test/` and `tests/`, where `typescript/no-unsafe-type-assertion` is disabled because typed mock and fixture setup is not yet ergonomic enough to justify the churn.

Catch bindings and promise rejection callbacks use the name `cause`. Annotate rejection callbacks with `cause: unknown` and narrow the value before reading its properties. This aligns `unicorn/catch-error-name` with anti-slop's existing exception for unknown error parameters. Error helpers accepting `unknown` also use `cause`.

### Framework presets

`frameworks` enables Ultracite's React, TanStack, and shadcn presets and React Doctor's rules in the listed directories, relative to the config. `"."` covers the whole repository.

```ts
export default createOxlintConfig({
  frameworks: {
    react: ["apps/web"],
    "react-doctor": ["apps/web"],
    shadcn: ["apps/web"],
    tanstack: ["apps/web"]
  },
  rules: {
    "shadcn/no-raw-colors": ["error", { allow: ["text-body"] }]
  }
});
```

Install `@shadcn/lint` for `shadcn` and `oxlint-plugin-react-doctor` for `react-doctor`. React Doctor's TanStack rules apply where the `react-doctor` and `tanstack` scopes overlap.

`createOxlintConfig` throws when the root or a workspace `package.json` depends on one of these packages without a matching `frameworks` entry:

- `react`, `@tanstack/react-router`, and `@tanstack/react-start` require the framework to cover the package that depends on them.
- `@shadcn/lint` and `oxlint-plugin-react-doctor` require the framework to list at least one directory.

Workspaces come from `workspaces` in `package.json` and `packages` in `pnpm-workspace.yaml`. Set a framework to `false` to decline it. The check reads manifests from `root`, which defaults to the nearest directory at or above the working directory that contains `.git`. If the config is not at the repository root, pass its directory as `root`.

Root `rules` for a directory-scoped framework's plugins, such as `react/*` or `shadcn/*`, apply inside its directories. When `react` is directory-scoped, an `overrides` entry that changes `react/*`, `react-perf/*`, or `jsx-a11y/*` rules must list those plugins in `plugins`. Otherwise Oxlint ignores the change.

### Vitest scope

Mixed-framework repositories can exclude framework-owned paths from the Vitest preset:

```ts
export default createOxlintConfig({
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

`extends`, `ignorePatterns`, `jsPlugins`, and `overrides` append after the preset's values. Consumer `rules`, `options`, and `settings` override the preset's defaults. Other Oxlint fields pass through at the root.

The presets are published on public npm under the MIT license.
