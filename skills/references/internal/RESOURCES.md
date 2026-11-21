# Resource commands

Run these commands from a Source checkout or a Session worktree.

1. Run `mt setup` before starting infrastructure to write dependency paths and deterministic values.
2. Start any infrastructure required by the repo's resource modules.
3. Run `mt resources acquire` to acquire missing allocations or reuse saved ones.
4. Run `mt resources exec -- <command> [args...]` to use those allocations.
5. Run `mt resources release` after use. It preserves the checkout and infrastructure.

When adding an allocation, define its module in
[resource configuration](../../internal/monke-config/references/monke-yml.md#resources).

Access Resource command outputs through `mt resources exec`, which supplies the
acquired values even when the caller has different values in its environment.
Keep the command in the foreground so its allocations stay protected for as
long as it uses them.

After partial acquisition or release failure, fix the cause and rerun the same
command. Keep recorded release modules available until release succeeds.

Release legacy allocations with the old scripts present before migrating to
named exports. Their recorded cleanup command receives Resource command outputs
as the JSON object `MONKE_RESOURCE_OUTPUTS` and may also stop infrastructure.
