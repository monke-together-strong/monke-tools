This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged, no backwards compatibility required.

Check [./CONTEXT.md](./CONTEXT.md) for terminology questions.

## Essentials

- Toolchain and package manager: Vite+ (`vp`) backed by Bun
- Install: `vp install`
- Check: `vp check`
- Test: `vp run test` (the package script preserves the Bun runtime)
- Follow git flow, don't create `codex/` branches
- Put clean source clones created for testing under `tmp/`.

## Task Tracking

- [GitHub Issues](https://github.com/monke-together-strong/monke-tools/issues)

## Releases

Add a `.tegami/*.md` entry only for consumer-visible package changes. During
`0.x`, use patch for compatible fixes and minor for policy, API, or consumer
requirement changes. See [issue #86](https://github.com/monke-together-strong/monke-tools/issues/86)
for first-release setup.

## Reference Repos

- Worktrunk (can be referred to as `wt`) for worktrees: https://github.com/max-sixty/worktrunk

Use these as implementation references when needed, clone it to `../libraries/` if not already cloned. Keep it up to date.
