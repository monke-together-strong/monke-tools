# Checkout resources

Resources belong to one checkout: either the original Source checkout or one
Session worktree. A Session can contain several worktrees, each with its own
resources. Ordinary worktrees are not supported by resource commands.
See [CONTEXT.md](../../CONTEXT.md) for the full glossary.

## Language

**Checkout resource**: A deterministic value or acquired allocation owned by one Source checkout or Session worktree.

**Resource value**: A configured literal string, with supported placeholders, retained for an owning checkout.

**Resource command**: A named repo module that acquires dynamic resources and can release them using its recorded outputs.

**Resource command output**: A declared nonempty string returned by acquisition and retained until release succeeds.

**Resource command input**: The owning checkout's identity under `owner` and recorded outputs from other checkouts of the same repo and command, grouped by output name under `previous`.

**Cleanup command**: The repo's recorded `cleanupCommand` for Session infrastructure teardown after resource release.

## Ownership and configuration

Source checkouts and Session worktrees share collision checks within each repo.
The current checkout's `monke.yml` configures explicit acquisition and execution;
Spawn and Materialize use the canonical Source configuration.

`resources.values` contains deterministic values; `resources.commands` declares
modules and their required outputs. Values and outputs must use different env
names. Values with the same env name cannot collide across retained checkouts of
the same repo. Commands cannot return a value remembered for the same output name
and command in another checkout; cross-output uniqueness belongs to the module.

See the [configuration reference](../../skills/internal/monke-tools-core/MONKE-YML-REFERENCE.md)
for placeholders and the module contract.

## Acquire, execute, release

Run `mt setup` before starting infrastructure in a Source checkout. It prepares
dependency paths and deterministic values such as `COMPOSE_PROJECT_NAME`, without
acquiring live resources. The same command works in Session worktrees using their
recorded dependency paths. Spawn already prepares those values for Sessions.

- `mt resources acquire` acquires every missing command for the current repo,
  including explicit commands, and reuses complete recorded allocations. Spawn
  and Materialize acquire automatic commands only.
- `mt resources exec -- <command> [args...]` requires recorded deterministic values
  and outputs for every declared resource command. It injects them into the child's
  environment, overriding inherited values, and forwards stdio, exit status and
  termination signals. It never acquires resources or changes env files.
- `mt resources release` invokes recorded release modules in reverse order,
  checkpointing each success. The checkout, assigned ports, deterministic values
  and local infrastructure remain available. Failed releases retain their records
  for retry; completed releases are skipped.

Credentials and static wiring stay in normal env files. Dynamic outputs are
recorded in Monke home, not exported to root `.env`. Setup, Acquire and Materialize remove
managed dynamic keys left by older versions; release removes recorded keys.
Commands requiring allocations must run through `exec`: an env file alone is not
proof of ownership.

The checkout lock stays held for the foreground command's lifetime. Concurrent
release, acquisition, materialization and Chop of that checkout fail while it is
in use; commands in other checkouts can proceed. The lock records the foreground
command PID and process group before the command starts, so surviving group
members remain protected if the MT wrapper is killed.
The command keeps its controlling terminal; group termination covers descendants
when the foreground leader exits on a signal. Commands must
keep resource use within their foreground lifetime rather than detach work.

## Persistence and recovery

Records under `$(mt home)/resources/` hold the owner, deterministic values,
outputs and release module paths. Each validated acquisition is saved immediately.
The store includes legacy Session snapshots in collision checks until migrated;
a persisted record, even an empty one, supersedes those snapshots. Session
checkpoints then remove the old duplicated resource fields.

Removing a declaration does not discard its release obligation. Named modules
retain their complete release payload even if the declaration shrinks; adding
required outputs to an existing allocation requires release before reacquisition.
Release uses recorded module paths and values, without loading current config.
Keep the release modules available until their allocations have been released.
Providers must make acquisition and release safe to retry: a process can fail
after a remote side effect but before returning its outputs.

Legacy default-export modules remain supported. Their recorded aggregate
`cleanupCommand`, when present, owns release and may include infrastructure
teardown. A successful legacy cleanup is remembered so later Chop does not replay
it with cleared outputs. Migrate modules to named `acquire`/`release` exports to
separate resource release from infrastructure teardown.

## Chop

Session Chop releases resources, runs recorded infrastructure cleanup, then removes
worktrees. A failure retains pending cleanup obligations. Missing worktrees block
required release or cleanup; deliberate `--cleanup-from-source` recovery can use
the Source checkout after the operator verifies that its code and configuration
are safe. See [Session finalization](session-lifecycle.md#removal-and-finalization).
