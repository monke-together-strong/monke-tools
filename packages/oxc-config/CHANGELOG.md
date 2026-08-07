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
