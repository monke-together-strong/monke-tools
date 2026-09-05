# Session resources

See [CONTEXT.md](../../CONTEXT.md) for shared session, repo, and port terminology.

## Language

**Session resource**: A per-session string value resolved for a repo, persisted in session state, written to the session root `.env`, and optionally used during cleanup.

**Resource value**: The configured literal string that becomes a session resource value, with `${session}` available as the session-name placeholder and `${user}` available as the machine-user placeholder. _Avoid_: Provider acquisition, allocator, command output

**Resource values**: The repo configuration section for deterministic literal session resources.

**Resource cleanup**: A repo-scoped shell command run during cleanup with the session's resolved resources, resource command outputs, and session metadata available in its environment.

**Cleanup command**: The `monke.yml` field that configures resource cleanup for one repo.

**Resource command**: A named repo-scoped default-export JS/TS module run from a session worktree to choose dynamic session values while monke-tools coordinates concurrent runs.

**Declaring repo**: The repo whose `monke.yml` defines a resource command.

**Resource command output**: The exact required non-empty env-style string values returned by a resource command for one session worktree and remembered as inputs to later matching resource command runs. _Avoid_: Claim, provider result, pool item

**Resource command input**: The remembered values from other retained session states for previous runs of the same resource command, grouped by required resource command output name.

**Resource command contract**: The machine-readable function contract for a resource command: remembered values are passed as the `previous` argument field, and resource command output is returned from the default-export function.

**Command lock**: The exclusive concurrency boundary for one declaring repo and one resource command name, preventing matching resource commands from running at the same time across multiple session worktrees. _Avoid_: Claim, resource value, cleanup handle

**Resource command timeout**: The maximum duration a resource command may run while holding its command lock.

## Values and ownership

Resources belong to one repo within one Session state. The nested `resources`
section contains deterministic Resource values, Resource commands, or both, and
must be non-empty. Literal values and command outputs cannot share an env name
within a repo.

Session resources using the same name must have distinct resolved values across
Session worktrees. Command outputs cannot reuse a remembered value for the same
output name. Equal values under different names are allowed; cross-output
uniqueness is repo-owned.

## Command execution

Commands run in configuration order from the target Session worktree. Each has a
lowercase configuration label, a non-empty `run` module path, and one or more
required outputs. Returned non-empty string values must match those names exactly
and are written to the session root `.env`. The timeout defaults to 60 seconds.
See the [configuration reference](../../skills/internal/monke-tools-core/MONKE-YML-REFERENCE.md)
for the module interface and examples.

Deterministic resources arrive through process env; remembered outputs arrive
only through the `previous` function argument. Stdout and stderr are diagnostic
logs, not the result protocol. Failures identify the command, failure kind, and
both output streams.

## Remembered inputs and persistence

Session state groups remembered outputs by command name. Inputs come from other
retained Sessions with the same Declaring repo and command name. Current config
selects the output names; each receives a deduplicated array, empty when nothing
is remembered. The contract does not promise sorted order. There is no separate
resource-command index.

Spawn and Materialize reuse complete remembered outputs, execute commands for
missing or incomplete outputs, and prune outputs no longer declared for the
current repo and Session. Validated outputs are persisted immediately so retries
can reuse them. Removing Session state ends its contribution to later inputs.

Each repo/command-name pair has a separate Command lock covering input reads,
execution, validation, and persistence across Session worktrees. Renaming a
command creates a new input and lock namespace.

## Cleanup

For a Dead worktree, cleanup runs from the repo's Source checkout with Session
resources, command outputs, `MONKE_SESSION`, `MONKE_SOURCE_ROOT`, and
`MONKE_WORKTREE_PATH` in its environment. Failed cleanup retains this state for
retry; [session finalization](session-lifecycle.md#removal-and-finalization) owns
ordering and removal.
