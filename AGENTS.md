This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged, no backwards compatibility required.

Check [./CONTEXT.md](./CONTEXT.md) for terminology questions.

## Essentials

- Toolchain and package manager: Vite+ (`vp`) backed by Bun
- Install: `vp install`
- Check: `vp check`
- Test: `vp run test` (the package script preserves the Bun runtime)
- Follow git flow, don't create `codex/` branches
- Put clean source clones created for testing under `tmp/`.

## Runtime consistency

- Prefer Bun runtime primitives in production and Bun-run scripts: `Bun.which`, `Bun.spawnSync`, `Bun.spawn`, `Bun.CryptoHasher`, `Bun.file`, `Bun.write`, and Bun's native glob implementations where their semantics fit.
- Route application command execution through `Runtime.exec` and `Runtime.execAsync`; use direct Bun subprocess APIs only at release and developer-script boundaries.
- Retain `node:fs` and `node:path` for synchronous metadata, permissions, symlinks, and atomic filesystem operations.

## Task Tracking

- [GitHub Issues](https://github.com/monke-together-strong/monke-tools/issues)

## Reference Repos

- Worktrunk (can be referred to as `wt`) for worktrees: https://github.com/max-sixty/worktrunk

Use these as implementation references when needed, clone it to `../libraries/` if not already cloned. Keep it up to date.
