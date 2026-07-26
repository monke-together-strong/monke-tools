# Packaging and distributing team-specific Oxlint rules

Research date: 2026-07-25

## Scope and method

This report answers how `monke-tools` should author, test, package, and
distribute team-specific custom rules and a shared Oxlint configuration.

Only primary sources were used: the current repository, official Oxlint,
Vite+, ESLint, Bun, npm, and GitHub documentation, plus Tegami's documentation
and source at commit
[`fa7b4577`](https://github.com/fuma-nama/tegami/tree/fa7b4577502bb65cf1aefee2a7588a1a01b5f76e).

The current registry versions inspected during this research were Oxlint
1.75.0, ESLint 10.8.0, and Tegami 1.2.6. Oxlint's JavaScript-plugin API is
alpha and explicitly outside its normal semantic-versioning guarantees, so
the version used for compatibility testing matters more than the particular
numbers recorded here.

## Recommendation

Use one package in this repository:

```text
monke-tools/
├── package.json
├── packages/
│   └── oxlint-config/
│       ├── package.json
│       ├── src/
│       │   └── config.ts
│       └── README.md
├── scripts/
│   └── tegami.mts
└── .github/workflows/
    ├── pr.yml
    └── publish.yml
```

The concrete decisions are:

| Decision             | Recommendation                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| Repository           | Keep it in `monke-tools` as a Bun workspace                                                            |
| Package boundary     | One config package; add a plugin entry only with the first genuinely custom rule                       |
| Export shape         | One reusable `OxlintConfig` object as the initial default export                                       |
| Package name         | `@mts/oxlint-config`; registry ownership of the selected `@mts` scope is deferred                      |
| Initial version      | `0.0.0` while private and unreleased                                                                   |
| Base preset          | Compose Ultracite's native `core` preset with the confirmed MTS policy                                 |
| Excluded preset      | Do not include Ultracite's optional JS-plugin preset initially                                         |
| Initial MTS policy   | Disable `func-style`, both nested-ternary rules, and `no-use-before-define`                            |
| Shared ignores       | Copy `core.ignorePatterns`; leave environment globals and additional ignores to consumers              |
| Execution interface  | Use Vite+ `vp check` and `vp check --fix`; do not expose Ultracite's command wrappers                  |
| Host compatibility   | Declare the tested Vite+ `0.2.6` host as a peer because the public declaration uses its lint types     |
| Ultracite dependency | Pin `ultracite` exactly to `7.9.4`; accept its transitive CLI overhead                                 |
| Root activation      | Deferred; building the package must not trigger a repository-wide Ultracite migration                  |
| Current visibility   | Set `"private": true`; registry visibility is deferred until distribution is authorized                |
| Public release       | Only after an explicit decision that the rule source and package API are public                        |
| Registry fallback    | GitHub Packages if the team does not have or want a paid npm organization                              |
| Rule API             | Deferred until a policy cannot be expressed with existing Oxlint rules                                 |
| Authoring            | TypeScript config; future custom rules use standard ESLint `create(context)`                           |
| Build                | Plain ESM JavaScript and declarations with the repository's existing `vp pack` toolchain               |
| Current exit gate    | `vp pack` succeeds and emits the config and declaration entries                                        |
| Unit tests           | Deferred while the package contains configuration only; `RuleTester` begins with the first custom rule |
| Compatibility tests  | Deferred until distribution work introduces a packed-tarball consumer in isolated `tmp/`               |
| Packaging            | Deferred: `bun pm pack`, followed by installation and linting from the actual tarball                  |
| Release automation   | Add Tegami when the first registry-backed release is introduced                                        |
| Release runner       | GitHub-hosted `ubuntu-latest`, not the existing Blacksmith runner                                      |

This gives consumers one dependency without publishing an empty custom-rule
surface. If a future policy cannot be expressed with existing Oxlint rules,
add a plugin subpath to this package and keep it on the same version as the
configuration that enables it.

### Confirmed current boundary

The current goal is a **build-ready package**: the workspace package exists,
its public config entry is configured, and `vp pack` succeeds.
Calling this **distribution-ready** would overstate the guarantee because the
current goal explicitly excludes `bun pm pack`, installation of the resulting
tarball in a clean consumer, registry selection, publishing credentials, and
release automation. Those remain possible follow-up phases, not current exit
criteria.

The confirmed initial package contract has one entry point:
`@mts/oxlint-config` composes Ultracite's native `core` preset with MTS
policy. An empty `./plugin` entry is explicitly excluded. Add that subpath
only with the first concrete rule that Oxlint does not already provide.

Ultracite's optional `js-plugins` preset is excluded from the initial
contract. It carries separate JavaScript plugin installation and resolution
concerns that are unnecessary for the native core baseline.

Ultracite is a configuration source only. Vite+ remains the repository's
execution layer: `vp check` performs the checks and `vp check --fix` applies
format and lint fixes. The MTS workflow does not expose or document
`ultracite check` or `ultracite fix`.

The initial package declares the tested Vite+ `0.2.6` host as a peer
dependency. Its emitted declaration refers to Vite+'s public lint types, so
recording that peer keeps type resolution valid under strict dependency
layouts without installing a second Vite+ copy.

`ultracite` remains an ordinary dependency of `@mts/oxlint-config`, pinned
exactly to `7.9.4`. Vite+ consumer repos do not declare Ultracite separately;
their package manager installs it transitively through the MTS package. The
unused Ultracite CLI overhead is accepted in exchange for keeping upstream
configuration ownership, versioning, and updates explicit instead of copying
or snapshotting its rule assignments. Ultracite upgrades are deliberate
policy changes, reviewed for their effect on lint outcomes before changing
the exact pin.

The monke-tools root does not activate `@mts/oxlint-config` in the current
change. Root activation is a separate adoption step so that enabling
Ultracite's broad core policy cannot expand the package-build task into an
unrelated repository-wide lint migration.

The package manifest uses `"private": true` during incubation. This does not
prevent `vp pack`, but it guards against accidental registry publication. A
future distribution change must remove the flag explicitly after choosing the
registry and access model.

The private package starts at `0.0.0`, matching the repository root and
signalling that no released compatibility contract exists. The first
intentional distribution can establish a `0.1.0` contract.

The initial MTS policy copies only the reusable top-level choices already
made in Local File Viewer:

```ts
rules: {
  "func-style": "off",
  "no-nested-ternary": "off",
  "no-use-before-define": "off",
  "unicorn/no-nested-ternary": "off",
}
```

Local File Viewer's React and TanStack presets, Vitest path scope, generated
output ignores, and per-file rule suppressions remain repository-specific.
They are not part of the MTS package.

The MTS config explicitly assigns `ignorePatterns: core.ignorePatterns`
because Oxlint `extends` inherits only `rules`, `plugins`, and `overrides`.
It does not copy `core.env`: browser or other environment globals remain a
consumer decision. Consumer repos append their own generated-output and
tool-specific ignores to the shared list.

When this repository deliberately adopts the package later, import the config
object into the root `vite.config.ts` and compose it into `lint`. Do **not** add
`oxlint.config.ts` or `.oxlintrc.json`: Vite+ says `vp lint` and `vp check`
read the `lint` block and explicitly recommends keeping Oxlint configuration
there. Vite+ also documents composing that block from objects imported from
nearby files or packages. Root activation is intentionally excluded from the
current build-ready package change.
[Vite+ lint guide](https://viteplus.dev/guide/lint),
[Vite+ monorepo configuration](https://viteplus.dev/guide/monorepo)

## Why the package belongs in this repository

The root is already a private Bun package, uses Bun 1.3.11, and runs Oxlint,
TypeScript, Vitest, and Oxfmt. It describes itself as tooling plus distributed
agent skills. Team lint policy has the same ownership and audience, so placing
it here does not introduce a new governance boundary. See the current
[`package.json`](../../package.json), [`AGENTS.md`](../../AGENTS.md), and
[`CONTEXT.md`](../../CONTEXT.md).

The workspace conversion must also expand the current verification boundaries:
the root lint script names only `src`, `scripts`, `__tests__`, and internal
skills; `tsconfig.json` includes only root source/test paths; and Vitest
includes only `__tests__/**/*.test.ts`. Merely adding `workspaces` would leave
`packages/*` outside lint, typecheck, and test. Add the package paths to those
root checks or invoke the package's own `lint`, `typecheck`, `test`, and
`build` scripts explicitly from the root and CI.

Bun supports a root `workspaces` field, one manifest per workspace,
`workspace:*` dependency references, filtered scripts, and replacement of
workspace protocols with concrete versions during publication. Vite+ likewise
documents a root configuration with workspace-specific overrides and
recursive or filtered package scripts. A `packages/*` workspace therefore
fits both existing tools without adding another monorepo layer.
[Bun workspace documentation](https://bun.com/docs/pm/workspaces)
[Vite+ monorepo guide](https://viteplus.dev/guide/monorepo)

A separate repository becomes preferable only if one of these becomes true:

- lint policy has different maintainers or access controls;
- releases must be independent of `monke-tools` CI and review;
- the plugin becomes a general-purpose public project with its own issue
  tracker and roadmap; or
- the package needs a stability policy that conflicts with this repository's
  explicitly early-WIP status.

None of those conditions is currently established. Starting in another
repository would add duplicated CI, dependency updates, permissions, and
release configuration without improving the package consumed by the team.

## Supported authoring routes

There are two first-party routes, but only one fits a team-owned package:

1. Write a JavaScript plugin using the ESLint v9-compatible API. Oxlint loads
   it from a local path or package specifier. This is the supported route for
   an independently maintained team plugin.
2. Contribute a native Rust rule to Oxlint itself. Oxlint's built-in-plugin
   documentation invites contributions to existing built-in plugins and asks
   authors to open a discussion before proposing a new built-in rule set; it
   does not document an out-of-tree native-plugin loading mechanism.

Use route 1. Upstreaming a broadly useful rule can be reconsidered later, but
it is not a distribution mechanism for private team policy.
[Oxlint JS-plugin documentation](https://oxc.rs/docs/guide/usage/linter/js-plugins.html),
[Oxlint built-in-plugin contribution guidance](https://oxc.rs/docs/guide/usage/linter/plugins#adding-new-plugins)

## Future custom rules stay in the config package

Oxlint accepts a JavaScript plugin as a local path or npm package specifier
under `jsPlugins`. The plugin exposes rule implementations, while rules are
enabled separately by namespace in configuration.
[Oxlint JavaScript-plugin loading](https://oxc.rs/docs/guide/usage/linter/js-plugins.html)

Oxlint can import shared configuration objects from packages. In a standalone
Oxlint project that means importing the object into `oxlint.config.ts`; in
this repository and other Vite+ projects, the same plain `OxlintConfig` object
belongs under `lint` in `vite.config.ts`.
[Oxlint shared configurations](https://oxc.rs/docs/guide/usage/linter/config#extend-shared-configs),
[Vite+ lint configuration](https://viteplus.dev/config/lint)

The initial package exports only the config:

```json
{
  "name": "@mts/oxlint-config",
  "type": "module",
  "exports": {
    ".": "./dist/config.js"
  },
  "files": ["dist", "README.md"]
}
```

The package root default-exports a plain `OxlintConfig` object. If a future
policy needs a genuinely custom rule, add `./plugin` to this same package,
register it under the `mts` alias, and refer to its rules as
`mts/<rule-name>`. Do not create a separate plugin package unless its
ownership or release cadence actually diverges.

Fresh consumers can use it without a second config file:

```ts
import mtsLint from "@mts/oxlint-config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // Other Vite+ settings...
  lint: mtsLint,
});
```

If repository-specific values must remain local, export a small base object
and merge its `rules`, `jsPlugins`, and other fields deliberately in
`vite.config.ts`; avoid a generic deep-merge helper because Oxlint arrays have
field-specific replacement behavior. Vite+ specifically warns that
`plugins` in an override replaces the inherited plugin list.
[Vite+ monorepo override behavior](https://viteplus.dev/guide/monorepo#root-config-with-overrides)

Making the Oxlint preset the primary export matches the package's current
consumer contract and keeps ordinary installation free of an ESLint peer
dependency. The plugin subpath still follows ESLint's plugin object model; a
future `./eslint` config and ESLint peer can be added if direct ESLint
consumption becomes a supported feature.
[ESLint plugin structure and sharing](https://eslint.org/docs/latest/extend/plugins)

Splitting into `eslint-plugin-monke` and `oxlint-config-monke` would add a
cross-package dependency, two versions, and two release surfaces even though
the preset exists primarily to activate these rules. Split only when the
config gains an independent consumer base or release cadence.

## Authoring API and limitations

Oxlint's JavaScript plugins use the ESLint v9-compatible plugin shape. Current
support includes AST traversal, selectors, source text and tokens, scopes,
control flow, options, fixes, suggestions, inline disables, and editor
diagnostics. It does not support custom parsers/file formats or JavaScript
plugin rules that require TypeScript type information.
[Oxlint API support](https://oxc.rs/docs/guide/usage/linter/js-plugins.html#api-support)

That makes these good initial rule candidates:

- enforcing a team import or API convention visible in syntax;
- requiring or banning particular call shapes;
- checking hook arguments;
- requiring generated generic arguments by syntax;
- banning project-specific identifiers or module entry points.

It does not make a suitable implementation path for rules that need the
TypeScript checker to resolve aliases, infer types, or follow generic types.
Those should remain ESLint/type-aware rules or wait for Oxlint support.

Start with normal ESLint rules:

```ts
import type { Rule } from "@oxlint/plugins";

export const rule = {
  meta: {
    type: "problem",
    docs: { description: "..." },
    schema: [],
    messages: { violation: "..." },
  },
  create(context) {
    return {
      CallExpression(node) {
        // Report syntax-level team policy.
      },
    };
  },
} satisfies Rule;
```

ESLint documents `meta.schema` for rule options, `meta.messages` plus
`messageId` for diagnostics, `meta.fixable` for fixes, and
`meta.hasSuggestions` for suggestions.
[ESLint custom-rule documentation](https://eslint.org/docs/latest/extend/custom-rules)

`@oxlint/plugins` publishes the plugin, rule, context, visitor, and ESTree
types plus `defineRule` and `definePlugin` helpers. A type-only import, as
above, keeps the standard `create(context)` plugin free of a runtime helper
dependency. Using the runtime helpers is also valid—Vite+'s own
`vite-plus/oxlint-plugin` is a first-party example—but then the package must
declare `@oxlint/plugins` as a runtime dependency rather than relying on
workspace hoisting.
[`@oxlint/plugins` package source](https://github.com/oxc-project/oxc/tree/main/npm/oxlint-plugins),
[`vite-plus/oxlint-plugin` package export](https://github.com/voidzero-dev/vite-plus/blob/main/packages/cli/package.json)

Oxlint offers a `createOnce` alternative through
`eslintCompatPlugin()` from `@oxlint/plugins`. The wrapper keeps ESLint
compatibility, but a published package must then carry `@oxlint/plugins` as a
runtime dependency. Oxlint says the planned performance benefit is not fully
realized yet, and the API requires different per-file lifecycle handling.
[Oxlint alternative plugin API](https://oxc.rs/docs/guide/usage/linter/writing-js-plugins.html#alternative-api)

Standard `create(context)` is the simpler initial choice. Revisit
`createOnce` only after profiling a rule that has a meaningful runtime cost.

The larger risk is the bridge itself: Oxlint labels JavaScript plugins alpha,
and its versioning policy says JavaScript-plugin APIs are not subject to
semantic versioning. A patch or minor Oxlint update may therefore require a
plugin change.
[Oxlint JavaScript-plugin alpha announcement](https://oxc.rs/blog/2026-03-11-oxlint-js-plugins-alpha),
[Oxlint versioning policy](https://oxc.rs/docs/guide/usage/linter/versioning)

For the first release:

- test and develop against an exact Vite+ host version and record the Oxlint
  version it bundles;
- declare the verified Vite+ range as the peer contract, adding an Oxlint peer
  only if standalone Oxlint use is supported;
- let dependency-update pull requests run the packed-consumer test before
  widening or moving that range; and
- keep rules small enough that ESLint remains a practical fallback.

## Exact development toolchain

Use the tools the repository already has. `@oxlint/plugins` and ESLint become
necessary only when the first custom rule is added:

| Concern                   | Tool                      | Reason                                                                                                                  |
| ------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Workspace/package manager | Bun workspaces            | Already mandated by the repository                                                                                      |
| Config source             | TypeScript                | Matches the repository and gives the exported policy static checking                                                    |
| Build                     | `vp pack`                 | It is the repository's mandated Vite+ toolchain and is designed for publishable libraries, ESM output, and declarations |
| Config assertions         | Vitest                    | Verifies the exported preset and four confirmed MTS overrides                                                           |
| Future rule semantics     | ESLint `RuleTester`       | Add with the first custom rule for valid/invalid cases, messages, locations, fixes, and suggestions                     |
| Future compatibility      | `vp lint` fixture         | Add with the first custom rule to exercise Oxlint's alpha bridge through Vite+                                          |
| Package boundary          | `bun pm pack`             | Tests the exact npm tarball contents and exports                                                                        |
| Formatting/linting        | Existing Oxfmt and Oxlint | No new style stack                                                                                                      |
| Release/versioning        | Tegami at release phase   | Handles workspace discovery, version PRs, changelogs, tags, publishing, and GitHub releases                             |

ESLint's `RuleTester#run()` accepts the rule name, rule object, and valid and
invalid cases. It can assert `messageId`, locations, fixed output, and
suggestions. It can be connected to an existing test framework by assigning
its `describe` and `it` functions.
[ESLint `RuleTester` API](https://eslint.org/docs/latest/integrate/nodejs-api#ruletester)

The package should compile its config to ESM JavaScript instead of publishing
raw TypeScript. Use one `vp pack` entry—`src/config.ts`—with declaration
generation enabled, and map the emitted file through `package.json#exports`.
Vite+ documents `vp pack` as its production library builder, including
declaration and output-format support.
[Oxlint JavaScript-plugin config reference](https://oxc.rs/docs/guide/usage/linter/config-file-reference#jsplugins)
[Vite+ pack guide](https://viteplus.dev/guide/pack)

Do not add ESLint or `@oxlint/plugins` to the initial config-only package.
When the first custom rule arrives, keep ESLint test-only and use type-only
imports from `@oxlint/plugins` unless runtime helpers are deliberately chosen.
For the recommended Vite+-first contract, declare the verified Vite+ range as
the host peer. Add an Oxlint peer only if standalone `oxlint` consumption
becomes a supported contract.

## Future custom-rule test layers

These layers begin with the first custom rule; they are not part of the
initial config-only `vp pack` boundary. `RuleTester` proves rule behavior
against ESLint, while an Oxlint fixture proves the alpha bridge can load the
packaged plugin.

### 1. Rule-level tests

For every rule, test:

- representative valid and invalid syntax;
- aliases, shadowing, optional chaining, computed properties, and unusual
  imports when relevant;
- exact `messageId` and a tight location;
- every option and its schema;
- idempotent fixed output, if the rule fixes;
- no fix when a rewrite could alter behavior.

### 2. Plugin export test

Import the built package root and assert:

- plugin `meta.name`, `meta.version`, and namespace;
- the expected rule keys, without `/` in individual keys;
- every rule has metadata and a `create` function; and
- preset rule IDs refer to rules the plugin actually exports.

ESLint recommends plugin-level name, version, and namespace metadata and
documents `rules` as the rule map.
[ESLint plugin creation](https://eslint.org/docs/latest/extend/plugins)

### 3. Oxlint source fixture

Run `vp lint` against fixtures using the built plugin and the exported config
through a fixture `vite.config.ts`. Also run the pinned Oxlint CLI directly
against at least one fixture if the package claims standalone Oxlint support.
Assert:

- the plugin loads;
- the expected rule ID and diagnostic appear;
- valid input exits successfully;
- invalid input exits non-zero;
- local consumer overrides win after the shared config; and
- safe fixes produce the expected file.

### 4. Packed-consumer test

The release-blocking test should use the actual artifact:

```text
build
  → bun pm pack --dry-run
  → bun pm pack --destination <tmp>
  → create isolated consumer under tmp/
  → install the generated .tgz plus the pinned Vite+
  → import the shared lint object from vite.config.ts
  → run vp lint against valid and invalid fixtures
```

Bun documents `bun pm pack` as creating the npm-publishable tarball using
npm-pack rules, with dry-run and destination options.
[Bun pack documentation](https://bun.com/docs/pm/cli/pm#pack)

This catches missing `files`, incorrect `exports`, unbuilt output, undeclared
runtime dependencies, and resolution behavior that source-tree tests miss.
The repository's own instructions already designate `tmp/` for clean testing
artifacts.

## Distribution decision

### Private npm: recommended default

The repository is private, and inspection of the GitHub organization found no
public repositories. Team-specific rules can disclose internal module names,
architecture, or policy even when they contain no credentials. Public npm
should therefore require an explicit open-source decision.

An npm private package provides standard registry semantics and ordinary
semver installation, but private organization packages require an npm Teams
subscription and team membership. The scoped package must be publishable; a
manifest field of `"private": true` prevents publishing altogether and does
not mean “publish privately.”
[npm package visibility and access](https://docs.npmjs.com/package-scope-access-level-and-visibility/),
[npm private packages](https://docs.npmjs.com/about-private-packages/)

Keep `"private": true` on the `monke-tools` workspace root. Do not put it on
the publishable plugin package. Configure restricted access through the npm
organization/package settings and publishing configuration.

Use this option if the team has, or is willing to create, the corresponding
paid npm organization. It gives consumers the least surprising install and
update behavior, though private dependency installation still requires
read-only npm authentication.

### Public npm: best consumer experience, explicit opt-in

Public npm needs no install credentials and is the simplest option for CI,
local development, and outside consumers. Scoped packages are private by
default unless published with public access, so public intent should be
explicit in `publishConfig.access`.
[npm scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)

Choose this only after reviewing the package contents and deciding that the
rules, examples, module names, and repository association may be public.
Because the source repository is private, npm provenance attestations will
not be generated even when trusted publishing is used.
[npm trusted-publishing limitations](https://docs.npmjs.com/trusted-publishers/)

### GitHub Packages: workable private fallback

GitHub Packages can inherit repository permissions and lets Actions use
`GITHUB_TOKEN` where package access is granted. It is reasonable when the team
wants package access to follow the existing private GitHub organization and
does not want a paid npm organization.

Its npm registry has higher local-consumer friction:

- packages must be scoped;
- consumers need an `.npmrc` scope-to-registry mapping;
- local installs require a classic personal access token with
  `read:packages`; and
- CI access must be granted to consuming repositories or authenticated with
  an appropriate token.

[GitHub Packages npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry),
[GitHub Packages permissions](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages)

Prefer it over making internal policy public merely to avoid npm billing, but
not over private npm when the npm organization is already available.

### Git dependency: reject as the normal channel

Git dependencies avoid a registry but provide a poor team update and release
experience. More importantly, npm's direct Git installation behavior does not
install a repository's workspaces or submodules, so a nested workspace package
is not a clean Git dependency target. A commit can be locked, but consumers
lose the normal package registry's versions, dist-tags, access model, and
discoverable upgrades.
[npm package and dependency formats](https://docs.npmjs.com/about-packages-and-modules/),
[npm lockfile behavior](https://docs.npmjs.com/files/package-lock.json/)

Use a packed tarball or Git reference only for a pre-release trial, not as the
team's durable distribution mechanism.

## Tegami assessment

Tegami is technically applicable and justified once this package begins
registry releases, but it is not required while rules are only being
prototyped locally.

The fit is direct:

- its npm provider discovers the root manifest and npm workspaces;
- it versions manifests, dependency ranges, and the lockfile;
- its GitHub flow turns committed changelog entries into a Version Packages
  pull request, then publishes and creates releases after that PR merges;
- the publish lock makes failed publish jobs retryable; and
- its npm provider can bootstrap a new package for trusted publishing.

[Tegami getting started](https://github.com/fuma-nama/tegami/blob/fa7b4577502bb65cf1aefee2a7588a1a01b5f76e/apps/docs/content/getting-started.mdx),
[Tegami CI flow](https://github.com/fuma-nama/tegami/blob/fa7b4577502bb65cf1aefee2a7588a1a01b5f76e/apps/docs/content/ci.mdx),
[Tegami npm provider](https://github.com/fuma-nama/tegami/blob/fa7b4577502bb65cf1aefee2a7588a1a01b5f76e/apps/docs/content/plugins/npm.mdx),
[Tegami GitHub plugin](https://github.com/fuma-nama/tegami/blob/fa7b4577502bb65cf1aefee2a7588a1a01b5f76e/apps/docs/content/plugins/github.mdx)

The costs are:

- Tegami requires Node 24, while this repository currently declares only Bun;
- it does not build or test packages, so all verification gates still belong
  in the workflow; and
- a single rarely released package could be published with a smaller manual
  workflow.

Those costs are acceptable at the release phase because the repository is
already becoming a workspace and is likely to distribute more team tooling.
Tegami replaces home-grown version-PR, changelog, tag, and release logic. Do
not install or configure it before the package's rule and packed-consumer
tests pass and the registry/visibility choice is approved.

Configure the npm provider with `client: "bun"` and
`updateLockFile: true`. Current Tegami source handles that mode by running
lifecycle scripts with Bun, creating the archive with `bun pm pack`, and then
publishing that tarball with `npm publish`. The final npm command is important
because npm's OIDC authentication applies to `npm publish`.
[Tegami Bun publish implementation](https://github.com/fuma-nama/tegami/blob/fa7b4577502bb65cf1aefee2a7588a1a01b5f76e/packages/tegami/src/providers/npm.ts#L377-L423)

Tegami's versioning, changelog, tag, and GitHub-release workflow remains useful
with GitHub Packages, but its `trustedPublish`/`npm pretrust` path is specific
to npmjs trusted publishing. A GitHub Packages release must instead configure
the GitHub npm registry and authenticate publication with `GITHUB_TOKEN` or an
appropriately scoped classic token; it does not use npmjs OIDC.
[GitHub Packages workflow authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-in-a-github-actions-workflow)

## CI and trusted publishing

The current CI workflow runs on
`blacksmith-2vcpu-ubuntu-2404` with read-only permissions and executes format,
lint, typecheck, and test checks.
[Current PR workflow](../../.github/workflows/pr.yml)

Keep that workflow for ordinary pull requests. Create a separate
`publish.yml` for release operations.

npm trusted publishing uses short-lived OIDC credentials instead of a
long-lived write token. It currently requires npm 11.5.1 or later, Node
22.14.0 or later, `id-token: write`, and a supported cloud runner. For GitHub
Actions, npm supports GitHub-hosted runners and explicitly does not support
self-hosted or third-party runners.
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)

Therefore the release job must use:

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write
      pull-requests: write
```

It must also:

1. check out full history;
2. set up Bun 1.3.11 to match the repository;
3. set up Node 24 and a current npm CLI for Tegami and OIDC;
4. run `bun install --frozen-lockfile`;
5. run format, lint, typecheck, all rule tests, the Oxlint fixture, and the
   packed-consumer test;
6. run `tegami ci` only after every gate passes.

Tegami needs `contents: write` and `pull-requests: write` for its version
branch, pull request, tags, and GitHub releases; npm needs
`id-token: write`.
[Tegami GitHub workflow requirements](https://github.com/fuma-nama/tegami/blob/fa7b4577502bb65cf1aefee2a7588a1a01b5f76e/apps/docs/content/ci.mdx)

Trusted publishing authenticates only publication. Installing private
dependencies still requires a read-only token. After OIDC publishing is
working, npm recommends disabling traditional publish tokens.
[npm trusted-publishing security guidance](https://docs.npmjs.com/trusted-publishers/)

## Phased implementation blueprint

### Phase 1: local package and contract

1. Add `"workspaces": ["packages/*"]` to the private root manifest.
2. Create `packages/oxlint-config` with its own `"private": true` manifest,
   version `0.0.0`, TypeScript source, and ESM output.
3. Expand root lint, typecheck, test, and formatting coverage to include the
   package, or invoke equivalent package scripts from the root.
4. Export one plain `OxlintConfig` object at the package root. Do not add an
   empty plugin entry.
5. Extend Ultracite's native `core` preset from that config; do not include
   Ultracite's optional JS-plugin preset.
6. Explicitly assign `ignorePatterns: core.ignorePatterns`; do not inherit
   `core.env` or add repository-specific ignores.
7. Declare `ultracite` exactly at `7.9.4` as an ordinary package dependency
   rather than snapshotting or bundling its rule assignments.
8. Leave the monke-tools root `vite.config.ts` activation unchanged; adoption
   is a later task.
9. Keep Vite+ as the only execution interface through `vp check` and
   `vp check --fix`.
10. Add the four confirmed MTS overrides for existing native rules.
11. Add config export and policy assertions. Defer `RuleTester` until the
    first custom rule exists.
12. Pin the tested Vite+ version; its package pins the Oxlint runtime used by
    `vp lint`.
13. Build the config entry and declarations into `dist/` with
    `vp pack --dts`.

Current exit criterion: `vp pack` succeeds and emits the configured config and
declaration entries. The additional source-fixture and packed-consumer tests
remain recommended engineering checks, but are not part of the confirmed
current delivery boundary.

### Phase 2: package boundary

This phase is deferred.

1. Add explicit `exports`, `files`, license, repository, and peer dependency
   metadata.
2. Run `bun pm pack --dry-run`.
3. Install the actual tarball into an isolated consumer under `tmp/`.
4. Import `@mts/oxlint-config` from that consumer's
   `vite.config.ts`, run `vp lint`, and verify diagnostics and fixes.
5. Add this packed-consumer test to the existing PR CI.

Exit criterion: a clean consumer can use only the tarball and declared peer
dependencies.

### Phase 3: registry decision and pilot

1. Confirm whether the selected `@mts` scope exists and is controlled on npm.
2. Decide explicitly between:
   - private npm with a paid organization;
   - GitHub Packages with its PAT/`.npmrc` cost; or
   - public npm after source review and approval.
3. Publish a pre-1.0 pilot and install it in one consumer repository.
4. Keep initial rules at warning severity until the consumer is clean, then
   promote deliberate policy violations to errors.

Exit criterion: one real consumer installs, upgrades, and runs the preset in
local development and CI.

### Phase 4: automated releases

1. Add Node 24 and Tegami.
2. Configure `client: "bun"`, lockfile updates, and the GitHub plugin. Enable
   trusted publishing only when the selected registry is npmjs.
3. Add the dedicated GitHub-hosted `publish.yml`.
4. For npmjs, bootstrap the package's trusted publisher, verify one release,
   then remove long-lived publish credentials. For GitHub Packages, configure
   its registry mapping and GitHub token permissions instead.
5. Require a `.tegami/*.md` entry for user-visible rule or preset changes.

Exit criterion: changelog entry → Version Packages PR → merge → OIDC publish
→ tag and GitHub release, with no write token.

### Phase 5: split only with evidence

Consider separate plugin and config packages, or a separate repository, only
after ownership, consumers, or release cadence actually diverge. Until then,
the single workspace package is the smaller and more reliable design.
