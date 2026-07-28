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

## Reference Repos

- Worktrunk (can be referred to as `wt`) for worktrees: https://github.com/max-sixty/worktrunk

Use these as implementation references when needed, clone it to `../libraries/` if not already cloned. Keep it up to date.
