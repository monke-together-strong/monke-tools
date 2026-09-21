# Resource commands

Run from a Source checkout or an MT Session worktree; ordinary worktrees are unsupported.

1. Run `mt setup` before starting infrastructure to write dependency paths and deterministic values.
2. Start any infrastructure required by the repo's resource modules.
3. Run `mt resources acquire` to acquire missing allocations or reuse saved ones.
4. Run `mt resources exec -- <command> [args...]` to use those allocations.
5. Run `mt resources release` after use. It preserves the checkout and infrastructure.

Spawn and Materialize acquire automatic resources after bootstrap; explicit resources
wait for `acquire`. Configure modules using the [configuration reference](../../internal/monke-tools-core/MONKE-YML-REFERENCE.md#resources).

Dynamic outputs live in MT state, not `.env`. `exec` checks required allocations,
overrides inherited values, and blocks conflicting lifecycle operations while the
command uses them. Keep resource use in the foreground; do not detach it.

After partial acquisition or release failure, fix the cause and rerun the same
command. Keep recorded release modules available until release succeeds. Release
before adding required outputs to an existing allocation.

Legacy default-export modules use their recorded aggregate cleanup command, which
may also stop infrastructure. Release with the old scripts present before migrating
to named `acquire`/`release` exports.
