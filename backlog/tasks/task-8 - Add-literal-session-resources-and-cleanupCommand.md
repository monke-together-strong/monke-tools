---
id: TASK-8
title: Add literal session resources and cleanupCommand
status: To Do
assignee: []
created_date: '2026-05-10 01:14'
updated_date: '2026-05-10 01:14'
labels:
  - ready-for-agent
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem Statement

Winters Echo can already use monke-tools to create isolated local workspace sessions with separate session worktrees, dependency paths, and assigned ports. That is enough for web apps and local databases, but it is not enough for end-to-end flows that rely on external identifiers such as Discord test channels.

When multiple sessions share the same Discord channel identifier, Frostbite and TrueIce E2E runs can collide even though their worktrees and ports are separate. The user needs monke-tools to remember deterministic per-session env strings and clean up repo-owned external state after the corresponding session worktrees are gone, without introducing a generic provider, pool, or command-valued resource system.

## Solution

Add literal session resources to repo configuration. A session resource is keyed by an env-style name and has a literal resource value. Resource values support built-in placeholders for the session name and local machine user, allowing values such as `mt-${user}-${session}` to be unique per worktree while remaining deterministic and readable.

During Create and Materialize, monke-tools resolves configured session resources, persists them in session state, checks that same-named resources do not collide across different worktrees for the same root repo, and writes them to the session root `.env`. App-specific managed env files are not rewritten for session resources in this version.

Add a repo-level `cleanupCommand` field. During Cleanup, monke-tools runs the cleanup command only for dead worktrees, from the repo's source checkout, with the resolved session resources and minimal session metadata in the environment. If cleanup fails, monke-tools keeps the session state so the same resource handles remain available for retry.

## User Stories

1. As a developer running Winters Echo E2E locally, I want each session worktree to get a distinct Discord channel identifier, so that parallel E2E runs do not consume or publish through the same channel.
2. As a developer running multiple agents, I want resource strings to include the session name, so that each agent's worktree has a predictable external identifier.
3. As a developer on a shared machine, I want resource strings to include the machine user name, so that my local resource names do not collide with another user's names.
4. As a repo maintainer, I want session resources to be configured in `monke.yml`, so that the isolation contract lives next to the repo's existing app, external, bootstrap, and seed path configuration.
5. As a repo maintainer, I want resource keys to be env variable names, so that the resolved value can be written directly to `.env` without a separate mapping layer.
6. As a repo maintainer, I want resource values to be literal strings, so that monke-tools remains deterministic and does not need to understand external provider lifecycles.
7. As a repo maintainer, I want `${session}` to resolve to the session/worktree name, so that resource values can be unique per session.
8. As a repo maintainer, I want `${user}` to resolve to the local machine user, so that resource values can be unique across developers on the same external system.
9. As a developer, I want Create to persist resolved session resources, so that repeated Create runs keep using the same values.
10. As a developer, I want Materialize to reuse persisted session resources, so that refreshing a worktree does not unexpectedly change external handles.
11. As a developer, I want session resources written to the session root `.env`, so that repo-level scripts can load the same values as the session.
12. As a developer, I do not want session resources written into every managed app env file yet, so that app env rewriting stays narrowly scoped to the existing port and path behavior.
13. As a developer, I want monke-tools to fail when a same-named resource resolves to the same value for two different worktrees, so that E2E isolation problems are caught before processes start.
14. As a developer, I want collisions to be scoped by resource name and resolved value, so that two different resource names may intentionally share a value when needed.
15. As a developer, I want collision checks scoped to sessions for the same root repo, so that unrelated repos do not block each other just because they use the same literal env string.
16. As a repo maintainer, I want a repo-level `cleanupCommand`, so that the repo owns external cleanup semantics while monke-tools supplies the remembered resource handles.
17. As a repo maintainer, I want cleanup to receive resolved resources in environment variables, so that cleanup scripts can use the same names written to root `.env`.
18. As a repo maintainer, I want cleanup to receive `MONKE_SESSION`, so that scripts can log and make decisions based on the session identity.
19. As a repo maintainer, I want cleanup to receive `MONKE_SOURCE_ROOT`, so that scripts can locate repo-local tooling from the source checkout.
20. As a repo maintainer, I want cleanup to receive `MONKE_WORKTREE_PATH`, so that scripts can log which dead worktree caused cleanup.
21. As a developer, I want cleanup commands to run from the source checkout, so that cleanup still works after the session worktree has been deleted.
22. As a developer, I want cleanup commands to run only for dead worktrees, so that `mt cleanup` does not tear down resources for a session I am still using.
23. As a developer, I want failed cleanup to keep session state, so that I can retry cleanup with the same remembered Discord channel identifier.
24. As a developer, I want cleanup failures to be visible, so that external resources are not silently leaked.
25. As a future implementer, I want the design to avoid providers, pools, command-valued resources, and per-resource cleanup, so that the first implementation stays small and easy to reason about.

## Implementation Decisions

- Extend repo configuration with an optional `resources` mapping and optional repo-level `cleanupCommand`.
- A session resource key must be a valid uppercase env name.
- A resource value must be a non-empty literal string.
- Resource value interpolation supports exactly `${session}` and `${user}` in this version.
- Unknown placeholders fail config/resource resolution instead of being passed through silently.
- The machine user placeholder should come from the runtime environment in the same way shell tools normally determine the local user.
- Persist resolved session resources in the existing session state for the repo that owns them.
- Create and Materialize should resolve missing session resources and reuse existing persisted session resources.
- Session resource collision detection should compare same resource name plus same resolved value across different worktrees under the same root repo.
- Collision errors should identify the resource name, resolved value, existing session/worktree owner, and conflicting session/worktree.
- Write session resources to the session root `.env` alongside existing root-level session values.
- Do not write session resources into app managed env files in this version.
- `cleanupCommand` is repo-level, not per-resource.
- Cleanup should run a repo's cleanup command only when that repo's recorded session worktree is dead.
- Cleanup should run from the repo's source checkout, not from the dead worktree path.
- Cleanup command env should include resolved session resources, `MONKE_SESSION`, `MONKE_SOURCE_ROOT`, and `MONKE_WORKTREE_PATH`.
- Cleanup should remove session state only after all required cleanup commands for that dead session have succeeded.
- Cleanup failure should fail the cleanup operation and keep session state intact for retry.
- The design intentionally avoids command-valued resources; external systems such as Discord remain repo-owned and can be created idempotently by repo scripts using the literal resource value.
- The design intentionally avoids a generic provider/pool taxonomy.

## Testing Decisions

- Tests should assert external behavior through config loading, create/materialize output, session state persistence, root `.env` contents, collision failures, and cleanup behavior.
- Config tests should cover valid resources, invalid resource keys, invalid resource values, valid `cleanupCommand`, and unknown config keys.
- Resource resolution tests should cover `${session}`, `${user}`, combined literal interpolation, and unknown placeholder failures.
- Materialization tests should cover writing resources to root `.env`, persisting resources in session state, and reusing persisted values on repeated Create or Materialize.
- Collision tests should cover same-name/same-value failures across different worktrees and allow same-value/different-name cases.
- Cleanup tests should cover command execution for dead worktrees, no execution for live worktrees, env passed to cleanup commands, source-checkout cwd, state removal on success, and state retention on failure.
- Tests should follow the existing Bun/Vitest style and focus on visible outcomes rather than private helper structure.
- A deep resource-resolution module is a good unit-test target because it can encapsulate interpolation, validation, persistence reuse decisions, and collision checks behind a small interface.
- End-to-end command tests should remain focused and use fake repos/runtime fixtures where existing tests already do so.

## Out of Scope

- Command-valued resource acquisition.
- Provider or pool configuration.
- Per-resource cleanup commands.
- Writing session resources into app managed env files.
- Cleanup for live worktrees.
- Automatic deletion of Discord channels by monke-tools itself.
- NATS durable management as a monke-tools resource.
- Global resource uniqueness across unrelated root repos.
- ADR creation for this design.

## Further Notes

The resolved domain language is captured in the repo context: monke-tools can resolve and remember per-session env strings, and run repo-level cleanup when the session worktree is dead. Winters Echo remains responsible for idempotently creating and cleaning its Discord-side E2E channel using the resource string monke-tools provides.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 monke.yml accepts optional literal resources keyed by env-style names and rejects invalid resource definitions
- [ ] #2 Create and Materialize persist resolved session resources and reuse existing persisted values
- [ ] #3 Resolved session resources are written to the session root .env and not to app managed env files
- [ ] #4 Create and Materialize fail when a same-named session resource resolves to the same value for another worktree in the same root repo
- [ ] #5 monke.yml accepts optional repo-level cleanupCommand
- [ ] #6 Cleanup runs cleanupCommand only for dead worktrees from the repo source checkout with resources and MONKE_* metadata in env
- [ ] #7 Cleanup removes session state after successful cleanupCommand execution and keeps session state when cleanupCommand fails
- [ ] #8 Focused tests cover config validation, resource interpolation, persistence, root env writing, collision detection, and cleanup success/failure behavior
- [ ] #9 Resource values resolve built-in ${session} and ${user} placeholders and reject unknown placeholders
<!-- AC:END -->
