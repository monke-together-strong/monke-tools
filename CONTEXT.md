# monke-tools

monke-tools manages workspace sessions across a root repo and its dependencies.
This glossary defines the shared language; subsystem references hold detailed
terms and behavior.

## References

Read the relevant reference when working on these areas:

- [Session lifecycle](docs/reference/session-lifecycle.md): preparation,
  materialization retries, state ownership, Chop safety, Swing, Diff, and shell navigation.
- [Resources](docs/reference/resources.md): resource values, command contracts,
  remembered outputs, collision rules, and locking.
- [Installation](docs/reference/installation.md): local and release installs,
  activation, provenance, updates, and recovery.
- [Agent guidance](docs/reference/agent-guidance.md): skill ownership, import
  recipes, target preferences, projections, and managed global instructions.
- [Retrospective](docs/reference/retrospective.md): transcript and PR evidence,
  repo membership, and durable fix proposals.

Use [README.md](README.md) for usage and
[the configuration reference](skills/internal/monke-tools-core/MONKE-YML-REFERENCE.md)
for `monke.yml`. Historical decisions remain in [docs/adr](docs/adr).

## Session topology

**Session**: A named local workspace instance that spans one source repo and any dependency repos using the same branch-aligned identity. _Avoid_: Branch, environment, sandbox

**Source checkout**: The original Git checkout that any working directory resolves to: the canonical non-worktree root and parent of all the repo's linked worktrees. A **Session** is created from one. _Avoid_: Main worktree, root worktree

**Session worktree**: A linked Git worktree created for a specific repo inside a session, stored under the **Monke home** worktree area as `worktrees/<repo-name>/<session>`.

**Ordinary worktree**: A linked Git worktree that is not owned by a **Session**. _Avoid_: Non-Monke worktree, external worktree, unmanaged Session

**Root repo**: The source repo from which a session was requested and whose dependency graph defines the session scope. _Avoid_: Main repo, parent repo

**Dependency repo**: Another repo declared by the root repo that must be materialized into the same session. _Avoid_: External repo, child repo

**Session state**: The persisted record of which repos belong to a session, where their worktrees live, and which ports were assigned. _Avoid_: Cache, registry entry

**Consumer repo**: A repo whose developer or agent uses monke-tools as a local workflow tool.

**Monke home**: The machine-local directory where monke-tools keeps state, preferences, and owned **Session worktrees** shared across **Consumer repos**. Defaults to `~/.monke`; Session worktrees live under `worktrees/<repo-name>/<session>` within this directory.

## Repo configuration

**App**: A configured app directory inside one repo whose env file participates in managed rewrites.

**Managed env file**: The env file inside an app whose mapped variables monke-tools rewrites.

**Seed path**: A repo-relative file or directory copied into a newly spawned session worktree.

**Seed material**: The source-checkout files copied into a newly spawned session worktree before env rewrites, including discovered env files and configured Seed paths.

**Bootstrap command**: A repo-scoped shell command run after env syncing to prepare a materialized worktree.

**Path env**: A root-level env variable that points from one repo to a dependency repo's path.

## Ports

**Port key**: The canonical name for a repo-owned local port slot, always expressed as an env-style `*_PORT` identifier. _Avoid_: Env var, actual port

**Local mapping**: A rule that binds one app env variable to one repo-owned port key.

**External mapping**: A rule that binds one app env variable to a port key owned by a dependency repo.

**Assigned port**: The concrete numeric port chosen for a port key within one session. _Avoid_: Port key, reserved port

**Port reservation**: The persisted numeric block a repo owns so future sessions can allocate stable assigned ports from it. _Avoid_: Port range, sticky ports

**Baseline port**: A numeric port already present in a repo's managed env files that should not be reallocated.

## Operations

**Spawn**: The operation that creates or updates all required session worktrees from a source checkout, using current `HEAD` unless **Default branch spawn mode** is requested.

**Materialize**: The operation that schedules **Worktree preparation** and **Repo materialization** across the Session dependency graph. _Avoid_: Refresh, rebuild

**Setup**: The operation that updates the source checkout root `.env` with dependency path env values. _Avoid_: Materialize, bootstrap

**Chop**: The explicit operation that removes one **Chop target** while preserving local branches. A Session target removes every recorded Session worktree and performs **Session finalization**; an Ordinary-worktree target removes only that worktree. _Avoid_: Cleanup, delete branch, prune

**Cleanup**: The operation that runs registered per-session teardown and removes session-state records whose worktrees no longer exist. _Avoid_: Delete session, prune repos

**Swing**: The operation that navigates the user's current shell to a **Source checkout**, **Session worktree**, or **Ordinary worktree** for the current **Root repo** scope. Ordinary targets must already exist; explicit pull request targets may materialize the matching **Session worktree** after validating the PR head.

**Diff**: The operation that opens Codiff for the current checkout in one repo, showing either local changes alone or changes relative to a **Diff base**.

## Relationships and distinctions

- A Session belongs to one Root repo. Each participating repo contributes one
  Session worktree and one Session-state entry. The Session uses a shared branch
  name across repos; it is the workspace instance, not the Git ref.
- An App belongs to one repo and may have multiple Local mappings. A Port key
  has one owner across the session graph. Local mappings consume that repo's
  keys; External mappings consume dependency-owned keys.
- Each Assigned port belongs to one Port key in a Session. A repo's Port
  reservation survives Session cleanup for future allocations.
- Use Dependency repo in prose; `external` is the configuration section name.
- Distinguish Source checkout root `.env` (Setup) from session root `.env`
  (materialization). Consumer repo describes tool usage, while Root repo and
  Dependency repo describe membership in a particular Session.
