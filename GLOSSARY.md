# monke-tools

monke-tools manages workspace Sessions across a root repo and its dependencies,
and distributes shared and personal agent guidance across Consumer repos.
This file and the references below form one glossary, split by domain area.

## Domain references

- [Session lifecycle](docs/reference/session-lifecycle.md): preparation, materialization, removal, and navigation.
- [Resources](docs/reference/resources.md): checkout ownership, values, and allocations.
- [Installation](docs/reference/installation.md): installs, releases, activation, and provenance.
- [Agent guidance](docs/reference/agent-guidance.md): skills, import sources, registries, invocation overrides, projections, and reviews.

Historical decisions live in [docs/adr](docs/adr).

## Session topology

**Checkout**: One local working copy of a repo: a Source checkout, Session worktree, or Ordinary worktree.

**Session**: A named local workspace for one **Root repo** and its **Dependency repos**. Its name is the branch it expects in each participating worktree. _Avoid_: Branch, environment, sandbox

**Source checkout**: The original working copy in a Git clone, shared as the source for its linked worktrees. A **Session** is created from one. _Avoid_: Main worktree, root worktree

**Session worktree**: A linked Git worktree owned by one **Session** for one participating repo.

**Ordinary worktree**: A linked Git worktree that is not owned by a **Session**. _Avoid_: Non-Monke worktree, external worktree, unmanaged Session

**Root repo**: The source repo from which a session was requested and whose dependency graph defines the session scope. _Avoid_: Main repo, parent repo

**Dependency repo**: A repo reachable through the **Root repo**'s declared dependencies, directly or through another dependency. It participates in the same **Session**. _Avoid_: External repo, child repo

**Session state**: The persisted record of a **Session**'s members, worktree paths, port assignments, and lifecycle progress. _Avoid_: Cache, registry entry

**Consumer repo**: A repo whose developer or agent uses monke-tools as a local workflow tool.

**Monke home**: The machine-local directory where monke-tools keeps state, preferences, and owned **Session worktrees** shared across **Consumer repos**.

## Repo configuration

**App**: A named directory in a repo's configuration that can receive port mappings in its env file.

**Managed env file**: The env file inside an app whose mapped variables monke-tools rewrites.

**Seed path**: A configured repo-relative file or directory used to fill missing content during **Worktree preparation**.

**Seed material**: Files from the **Source checkout** used to fill missing content in a **Session worktree** during **Worktree preparation**.

**Bootstrap command**: A repo-scoped shell command run after env syncing to prepare a materialized worktree.

**Path env**: A root-level env variable that points from one repo to a dependency repo's path.

## Ports

**Port key**: The canonical name for a repo-owned local port slot, always expressed as an env-style `*_PORT` identifier. _Avoid_: Env var, actual port

**Local mapping**: A rule that binds one app env variable to one repo-owned port key.

**External mapping**: A rule that binds one app env variable to a port key owned by a dependency repo.

**Assigned port**: The concrete numeric port chosen for a port key within one session. _Avoid_: Port key, reserved port

**Port reservation**: The persisted block of port numbers from which a repo allocates **Assigned ports** to Sessions. _Avoid_: Port range, sticky ports

**Baseline port**: A port read from a **Local mapping**'s env variable in a repo's **Source checkout**. New assignments for that repo avoid these ports.

## Operations

**Spawn**: The operation that creates or completes a **Session** and its participating worktrees.

**Materialize**: The operation that schedules **Worktree preparation** and **Repo materialization** across the Session dependency graph. _Avoid_: Refresh, rebuild

**Setup**: Reconciliation of a checkout's project skill links and, where configured, its dependency paths and deterministic resource values. _Avoid_: Materialize, bootstrap

**Chop**: The explicit operation that removes one **Chop target** while preserving local branches. A Session target performs **Session removal**; an Ordinary-worktree target removes only that worktree. _Avoid_: Cleanup, delete branch, prune

**Cleanup**: The operation that inspects retained Sessions across all Root repos and removes **Cleanup-eligible Sessions** through **Session removal**. _Avoid_: Delete session, prune repos

**Swing**: The operation that selects a checkout of the invoking checkout's repo and requests shell navigation to it. An explicit PR target can create its **Session worktree** after the PR head is validated.

**Diff**: The operation that presents a requested Git comparison for one checkout through its selected **Diff adapter**.

## Relationships and distinctions

- Each participating repo contributes one Session worktree and one entry in
  Session state. The same repo can participate in different Sessions.
- An App belongs to one repo and may have multiple Local mappings. A Port key
  has one owner across the session graph. Local mappings consume that repo's
  keys; External mappings consume dependency-owned keys.
- Each Assigned port belongs to one Port key in a Session. A repo's Port
  reservation survives **Session removal** for future allocations.
- Consumer repo describes tool usage. Root repo and Dependency repo describe
  membership in a particular Session.
