## @monke-together-strong/oxc-config@0.4.1

### Align error parameter names with anti-slop

Configure `unicorn/catch-error-name` to require `cause`, matching anti-slop's existing exception for `cause: unknown`. Catch clauses and promise rejection callbacks now use the same name. Error helpers that accept `unknown` also use `cause`. This resolves the conflicting naming requirements without changing either rule's implementation.

## @monke-together-strong/oxc-config@0.4.0

### Add framework presets to oxc-config

#### Add framework presets

`createOxlintConfig` accepts `frameworks`, which enables Ultracite's React, TanStack, and shadcn presets and React Doctor's rules in the listed directories. `"."` covers the whole repository. Consumers no longer need to depend on `ultracite` or wire up plugin settings themselves. Root `rules` for a directory-scoped framework's plugins apply inside its directories.

`createOxlintConfig` now throws when the root or a workspace `package.json` depends on `react`, `@tanstack/react-router`, `@tanstack/react-start`, `@shadcn/lint`, or `oxlint-plugin-react-doctor` without a matching `frameworks` entry. Set the framework to the directories it lints, or to `false` to decline it. Pass `root` when the config is not at the repository root.

The `oxlint` entry point no longer exports `oxlintConfig` or a default config, because building either would run the dependency check on import. Use `export default createOxlintConfig()` instead.

### Update to Ultracite 8

#### Update to Ultracite 8

Upgrade Ultracite from 7.10.8 to 8.0.1. Require Oxlint ^1.86.0 and Oxfmt >=0.71.0 <1, matching Ultracite 8's peer ranges. Require oxlint-tsgolint 7.0.2004 or newer, the version Vite+ 1.3 bundles. Build the presets against Oxlint 1.88.0 and Oxfmt 0.73.0.

Ultracite 8 enables these rules for consumers:

- `anti-slop/require-readable-spacing` requires blank lines between top-level statements, around functions, classes, types, and multiline bindings, before control flow and `return`, and after blocks. Adjacent single-line bindings may stay together. Its autofix only inserts blank lines.
- `vitest/consistent-test-it` requires `test` at the top level and `it` inside `describe`. Its autofix renames calls but not imports.
- `anti-slop/no-reduce-accumulator-copy` rejects copying a growing `reduce` accumulator with `Object.assign`, `Array.from`, or array copy methods.
- `typescript/no-generated-empty-object-type`.

Ultracite's Vitest rules and the preset's test-file policy now also apply to `.mts`, `.cts`, `.mjs`, and `.cjs` test files.

The preset disables `anti-slop/no-array-filter-map` because its suggested rewrites run slower than `filter().map()` on Bun.

## @monke-together-strong/oxc-config@0.3.0

### Update Ultracite and required Oxc versions

#### Update Ultracite and required Oxc versions

Upgrade Ultracite from 7.10.4 to 7.10.8 so consumers inherit its updated core, anti-slop, Vitest, and formatting presets. Require Oxlint ^1.79.0 and Oxfmt ^0.64.0 to support the updated rules and configuration types. Existing shared rule overrides remain in place.

### Disable noisy conditional empty object spread rule

#### Allow conditional optional fields

Disable `anti-slop/no-conditional-empty-object-spread` so idiomatic conditional optional fields no longer produce lint errors.

### Format first-party skill code

#### Format first-party skill code

The shared formatter now checks first-party code and metadata under `skills/`. Imported skills, imported references, and skill Markdown remain excluded so upstream assets and authored instructions retain their formatting.

## @monke-together-strong/oxc-config@0.2.1

### Enable anti-slop validation

#### Broader shared validation

Compose Ultracite's anti-slop preset into the shared Oxlint configuration so consumers catch type
widening, unsafe boundary handling, and unsupported type assertions alongside the existing core and
Vitest rules. Upgrade Ultracite to 7.10.4.

## @monke-together-strong/oxc-config@0.2.0

### Add a shared TypeScript preset

#### Shared TypeScript configuration

Add a runtime-neutral TypeScript base preset with strict checking, checked indexed
access, explicit override markers, consistent returns, and unused-code checks.

### Strengthen shared Oxlint validation

#### Stronger shared validation

Load `eslint-plugin-jsdoc` through Oxlint's JavaScript-plugin compatibility layer and reject
undefined JSDoc types in every consumer while preserving consumer-provided plugins and rule
overrides. Reject console calls and direct environment access, and require explicit module boundary
types across consumers. Replace Ultracite's `sort-keys` rule with comment-aware Perfectionist
sorting.

## @monke-together-strong/oxc-config@0.1.1

### Allow warning comments in the shared Oxlint config

The shared Oxlint config now permits warning comments such as TODO and FIXME.

## @monke-together-strong/oxc-config@0.1.0

### First public release

#### Initial release

Publish shared Oxlint and Oxfmt presets with Ultracite composition, type-aware linting and type checking, shared formatting policy, consumer override factories, and standalone `/oxlint` and `/oxfmt` exports.
