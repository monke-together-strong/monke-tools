---
id: TASK-8
title: Add nested session resources and resource commands
status: To Do
assignee: []
created_date: '2026-05-10 01:14'
updated_date: '2026-06-07 22:22'
labels:
  - ready-for-agent
dependencies: []
references:
  - 'https://github.com/monke-together-strong/monke-tools/issues/33'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem Statement

Winter's Echo can already use monke-tools to create isolated local workspace sessions with separate session worktrees, dependency paths, and assigned ports. That is enough for web apps and local databases, but not for end-to-end flows that need shared external values to be chosen dynamically.

Literal per-session env strings cover deterministic handles such as Discord channel names, but Winter's Echo also needs repo-owned code to choose exchange symbols based on current availability and values already remembered for other retained session states. The immediate validation target is replacing the local branch's current Bybit symbol-conflict workaround with a monke resource command, then proving two Winter's Echo worktrees can run Bybit-mode E2E concurrently through the real crypto-trading dependency graph.

## Solution

Add a nested resources surface to repo configuration:

~~~yaml
resources:
  values:
    DISCORD_CHANNEL: mt-${user}-${session}
  commands:
    e2e-symbols:
      command: pnpm e2e:allocate-symbols
      timeoutSeconds: 60
      outputs:
        - E2E_FLOW1_SYMBOL
        - E2E_FLOW2_SYMBOL
~~~

resources.values configures deterministic literal session resources. Values support exactly ${session} and ${user} placeholders, are persisted in session state, are reused on later Create or Materialize runs, are written to the session root .env, and are available to cleanup.

resources.commands configures dynamic resource commands. Each command is named with the existing lowercase label style; the command name and declaring repo form the lock and input namespace. A command declares exact env-style output names and may override the default 60 second timeout. The command runs from the target session worktree through sh -lc.

When command output is missing or incomplete for the current session, monke-tools acquires the command lock, builds stdin JSON from retained session states for the same declaring repo and command name, runs the command, validates stdout JSON, persists the validated outputs immediately, and releases the lock. The stdin JSON contains every declared output name with a deduped array of remembered values from other retained session states, using an empty array when no values are remembered for that output:

~~~json
{
  "E2E_FLOW1_SYMBOL": ["ATOM/USDT:USDT"],
  "E2E_FLOW2_SYMBOL": ["NEAR/USDT:USDT"]
}
~~~

The command must return stdout JSON with exactly the declared output keys and non-empty string values:

~~~json
{
  "E2E_FLOW1_SYMBOL": "SOL/USDT:USDT",
  "E2E_FLOW2_SYMBOL": "LINK/USDT:USDT"
}
~~~

monke-tools rejects missing keys, extra keys, non-string or empty values, and same-output collisions where a returned value appears in that output's stdin array. Cross-output uniqueness remains repo-owned. Resource commands do not receive monke-specific metadata, literal resource values, or other command outputs through environment variables; stdin/stdout is the only monke-specific command channel.

Validated command outputs are remembered in session state grouped by command name, reused when complete, written to the session root .env, passed to cleanup, and pruned for the current session when no longer declared. Inputs are derived by scanning retained session states rather than maintaining a separate resource-command index.

Add a repo-level cleanupCommand field. During Cleanup, monke-tools runs the cleanup command only for dead worktrees, from the repo's source checkout, with deterministic resources, resource command outputs, and minimal session metadata in the environment. If cleanup fails, monke-tools keeps the session state so the same resource handles remain available for retry.

## User Stories

1. As a developer running Winter's Echo E2E locally, I want each session worktree to receive non-conflicting Bybit symbols chosen by repo code, so that parallel E2E runs do not collide on the exchange.
2. As a repo maintainer, I want deterministic literal resources and dynamic command-backed resources under one explicit nested resources surface, so that the isolation contract lives next to the repo's existing app, external, bootstrap, and seed path configuration.
3. As a repo maintainer, I want resource command outputs to be declared up front, so that monke-tools can validate the env contract and refuse surprise env writes.
4. As a repo maintainer, I want command input to contain prior remembered values grouped by output env name, so that my script can choose free values without monke-tools understanding the domain.
5. As a developer running multiple agents, I want resource command outputs persisted and reused, so that refreshing a session does not unexpectedly change external handles.
6. As a developer, I want monke-tools to serialize matching resource commands, so that two worktrees cannot read the same prior values and choose the same next value concurrently.
7. As a developer, I want command output persistence to be the durable boundary, so that a later materialization failure does not force a successful allocation command to rerun.
8. As a repo maintainer, I want cleanup to receive both deterministic resources and command outputs, so that repo-owned teardown can use every remembered resource value.
9. As a repo maintainer, I want resource command stdout to be exact and machine-readable, so that script logging cannot accidentally become persisted env data.
10. As a developer, I want failed resource commands to report the command name, command string, failure kind, and stderr, so that allocator failures are debuggable without exposing noisy stdout unless stdout broke the contract.
11. As a repo maintainer, I want command outputs to be pruned when no longer declared, so that old config does not keep influencing new sessions.
12. As a developer, I want command inputs to come from retained session state rather than liveness checks, so that Cleanup remains the only release boundary.
13. As a developer, I want declaring repo scoping across root graphs, so that the repo that owns a resource command also owns its command namespace.
14. As a future implementer, I want the design to avoid providers, pools, claims, per-resource cleanup commands, and app env rewrites, so that the first implementation stays small and generic.

## Implementation Decisions

- Build or modify configuration parsing and typed configuration models so monke.yml accepts optional nested resources.values, resources.commands, and cleanupCommand while rejecting the old flat resources mapping.
- Build a deep resource module that owns literal interpolation, command input construction, stdout validation, same-output collision checks, reuse decisions, pruning, and the state shape for command outputs.
- Build or modify session state handling so deterministic resources and resource command outputs are persisted for the repo that owns them, with command outputs grouped by command name.
- Build or modify materialization orchestration so Create and Materialize resolve deterministic values, run missing or incomplete resource commands, persist validated command outputs immediately, write resources to the session root .env, and reuse complete remembered outputs.
- Build or modify command execution support so resource commands run from the target session worktree through sh -lc, receive stdin JSON, return stdout JSON, enforce a default 60 second timeout, and allow a positive timeoutSeconds override.
- Build or modify locking so the command lock is scoped by declaring repo and resource command name, and covers input construction, command execution, output validation, and immediate persistence.
- Build or modify cleanup behavior so cleanupCommand receives deterministic resources, resource command outputs, MONKE_SESSION, MONKE_SOURCE_ROOT, and MONKE_WORKTREE_PATH while still running only for dead worktrees from the source checkout.
- Keep app managed env rewriting unchanged. Deterministic resources and command outputs are written only to the session root .env.
- Reject resource env name duplicates across resources.values and all resources.commands outputs in the same repo.
- Resource command names use the existing lowercase label style.
- Each resource command has a non-empty command string, optional positive integer timeoutSeconds, and a non-empty outputs array of uppercase env names.
- Resource command stdin includes every declared output name with a deduped array of remembered values from other retained session states for the same declaring repo and command name, using an empty array when no values are remembered for that output. Array order is not guaranteed.
- Resource command stdout must be a JSON object with exactly the declared output keys and non-empty string values.
- Same-output collisions against stdin are rejected. Cross-output uniqueness remains repo-owned.
- Resource commands do not receive monke-specific env vars, deterministic values, or other command outputs. stdin/stdout is the only monke-specific resource command channel.
- Multiple resource commands in one repo run in YAML order, independently, with separate locks.
- Complete remembered command outputs are reused. Missing or incomplete outputs cause the command to rerun for the current session.
- A resource command rename creates a new namespace.
- Inputs are derived by scanning retained session states rather than maintaining a separate resource-command output index.
- This PRD supersedes the earlier flat resources design. No ADR is needed for this design.

## Testing Decisions

- Tests should assert external behavior through config loading, Create and Materialize output, session state persistence, root .env contents, command stdin/stdout, collision failures, and cleanup behavior rather than private helper structure.
- Config tests should cover nested resources.values, nested resources.commands, invalid flat resources, invalid resource keys, invalid values, invalid command names, invalid commands, invalid outputs, duplicate resource env names, valid cleanupCommand, and unknown config keys.
- Resource resolution tests should cover ${session}, ${user}, combined literal interpolation, and unknown placeholder failures.
- Resource command module tests should cover stdin shape, exact stdout validation, non-empty string validation, same-output collision rejection, reuse decisions, stale output pruning, and declaring-repo scoping across multiple root repos.
- Materialization tests should cover writing deterministic resources and command outputs to root .env, persisting them in session state, reusing persisted values on repeated Create or Materialize, and immediate persistence before a later materialization failure.
- Command execution tests should cover timeout, nonzero exit failure, invalid JSON failure, stderr reporting, and stdout reporting only when stdout violates the contract.
- Cleanup tests should cover command execution for dead worktrees, no execution for live worktrees, deterministic resource env, resource command output env, source-checkout cwd, state removal on success, and state retention on failure.
- End-to-end command tests should remain focused and use fake repos and runtime fixtures where existing tests already do so.
- Final consumer validation should refresh the local monke-tools install, wire Winter's Echo to use a resource command for Bybit E2E symbols, include the real crypto-trading dependency graph, and run Bybit-mode E2E concurrently from two Winter's Echo worktrees. Both runs must pass with non-conflicting symbols supplied through monke resource command outputs.

## Out of Scope

- Provider or pool configuration.
- Claims or separate claim persistence.
- Per-resource cleanup commands.
- Writing session resources into app managed env files.
- Cleanup for live worktrees.
- Automatic deletion of Discord channels by monke-tools itself.
- NATS durable management as a monke-tools resource.
- Passing monke-specific metadata, deterministic resources, or other command outputs to resource commands through environment variables.
- Command dependency semantics.
- A separate resource-command output index outside session state.
- ADR creation for this design.

## Further Notes

This PRD should use the repository glossary terms from CONTEXT.md: Resource values, Resource command, Declaring repo, Resource command input, Resource command output, Resource command contract, Command lock, Resource command timeout, Session state, Create, Materialize, and Cleanup.

The final consumer validation is intentionally heavier than the unit and integration tests. It proves the feature against the motivating Winter's Echo branch in Bybit mode, with crypto-trading included in the real dependency graph, and with two concurrent worktrees selecting non-conflicting symbols through the new resource command API.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 monke.yml accepts optional nested resources.values, resources.commands, and cleanupCommand, and rejects flat resources, empty resources, invalid names, invalid values, empty commands, empty outputs, and duplicate resource env names
- [ ] #2 resources.values preserve deterministic literal behavior: ${session} and ${user} interpolation, persisted reuse, collision checks, session root .env writes, and cleanup env
- [ ] #3 resources.commands run only when outputs are missing or incomplete, and complete remembered outputs are reused by Create and Materialize
- [ ] #4 Command namespace is declaring repo plus command name, and the command lock covers input construction, command execution, output validation, and immediate persistence
- [ ] #5 Command stdout must contain exactly the declared output keys with non-empty string values, and same-output collisions against stdin are rejected while cross-output uniqueness remains repo-owned
- [ ] #6 Commands run from the session worktree via sh -lc with a default 60 second timeout and optional positive timeoutSeconds override
- [ ] #7 Valid command outputs are persisted immediately, grouped by command name in session state, written to session root .env, passed to cleanup, and pruned when no longer declared
- [ ] #8 Failures report command name, command string, failure kind, stderr, and stdout only for contract errors
- [ ] #9 Cleanup runs cleanupCommand only for dead worktrees from the repo source checkout, removes state after successful cleanupCommand execution, and keeps state when cleanupCommand fails
- [ ] #10 Focused tests cover config validation, resource interpolation, command stdin/stdout behavior, reuse, locking/input behavior, collision rejection, persistence after later failure, cleanup env, pruning, and multi-root declaring-repo scoping
- [ ] #11 Final consumer validation refreshes the local monke-tools install, creates and wires a Winter's Echo resource command for non-conflicting Bybit E2E symbols, includes the real crypto-trading dependency graph, and passes concurrent Bybit-mode E2E runs from two Winter's Echo worktrees
- [ ] #12 Command stdin is grouped prior values for declared outputs only; it includes every output key with an array, uses empty arrays when no values are remembered, dedupes values, excludes the current session, excludes deterministic values, and is derived from retained session state without a separate index
<!-- AC:END -->
