---
subject: Add framework presets to oxc-config
packages:
  "@monke-together-strong/oxc-config":
    type: minor
---

## Add framework presets

`createOxlintConfig` accepts `frameworks`, which enables Ultracite's React, TanStack, and shadcn presets and React Doctor's rules in the listed directories. `"."` covers the whole repository. Consumers no longer need to depend on `ultracite` or wire up plugin settings themselves. Root `rules` for a directory-scoped framework's plugins apply inside its directories.

`createOxlintConfig` now throws when the root or a workspace `package.json` depends on `react`, `@tanstack/react-router`, `@tanstack/react-start`, `@shadcn/lint`, or `oxlint-plugin-react-doctor` without a matching `frameworks` entry. Set the framework to the directories it lints, or to `false` to decline it. Pass `root` when the config is not at the repository root.

The `oxlint` entry point no longer exports `oxlintConfig` or a default config, because building either would run the dependency check on import. Use `export default createOxlintConfig()` instead.
