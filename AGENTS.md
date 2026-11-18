This repository is early in development. Propose broad changes when they improve
maintainability. Backwards compatibility is optional.

Use the [domain glossary](GLOSSARY.md) when naming or reviewing domain concepts.

## Essentials

- Install dependencies with Vite+ (`vp install`).
- Check code changes with `vp check <changed-source-files>`.
- Run focused tests with `vpr test <test-file>`. The package script runs Vitest under Bun.
- Use Git Flow branch prefixes.
- Put clean source clones created for testing under `tmp/`.

## Runtime consistency

- Prefer Bun runtime primitives in production and Bun-run scripts: `Bun.which`, `Bun.spawnSync`, `Bun.spawn`, `Bun.CryptoHasher`, `Bun.file`, `Bun.write`, and Bun's native glob implementations where their semantics fit.
- Route application command execution through `Runtime.exec` and `Runtime.execAsync`; use direct Bun subprocess APIs only at release and developer-script boundaries.
- Retain `node:fs` and `node:path` for synchronous metadata, permissions, symlinks, and atomic filesystem operations.

## Imported guidance

To invoke an explicit-only skill from another skill or workflow, link directly to its `SKILL.md`.

Treat `skills/imported/` and `skills/references/imported/` as upstream snapshots.
Refresh them through the import/update tooling; do not edit their contents locally.
Report findings against imported guidance for an upstream fix and later refresh.

## Task tracking

Track work in [GitHub Issues](https://github.com/monke-together-strong/monke-tools/issues).
