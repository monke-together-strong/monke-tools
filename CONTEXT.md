# monke-tools

monke-tools manages isolated local workspace sessions for a root repo and its dependency repos. This context defines the domain language for session topology, repo configuration, port assignment, and session operations.

## Language

### Session topology

**Session**:
A named local workspace instance that spans one source repo and any dependency repos using the same branch-aligned identity.
_Avoid_: Branch, environment, sandbox

**Source checkout**:
The original Git checkout from which a session is created.
_Avoid_: Main worktree, root worktree

**Session worktree**:
A linked Git worktree created for a specific repo inside a session.
_Avoid_: Checkout copy, clone

**Root repo**:
The source repo from which a session was requested and whose dependency graph defines the session scope.
_Avoid_: Main repo, parent repo

**Dependency repo**:
Another repo declared by the root repo that must be materialized into the same session.
_Avoid_: External repo, child repo

**Session state**:
The persisted record of which repos belong to a session, where their worktrees live, and which ports were assigned.
_Avoid_: Cache, registry entry

**Session resource**:
A per-session string value resolved for a repo, persisted in session state, written to the session root `.env`, and optionally used during cleanup.
_Avoid_: Provider, pool item, resolved env value

**Resource value**:
The configured literal string that becomes a session resource value, with `${session}` available as the session-name placeholder and `${user}` available as the machine-user placeholder.
_Avoid_: Provider acquisition, allocator, command output

**Resource cleanup**:
A repo-scoped shell command run during cleanup with the session's resolved resources and session metadata available in its environment.
_Avoid_: Provider release, per-resource cleanup hook

**Cleanup command**:
The `monke.yml` field that configures resource cleanup for one repo.
_Avoid_: Resource cleanup command, teardown script

**Dead worktree**:
A session worktree recorded in session state whose filesystem path no longer exists.
_Avoid_: Inactive worktree, stale checkout

### Repo configuration

**App**:
A configured app directory inside one repo whose env file participates in managed rewrites.
_Avoid_: Service, project

**Managed env file**:
The env file inside an app whose mapped variables monke-tools rewrites.
_Avoid_: Local env, app config

**Seed path**:
A repo-relative file or directory copied into a newly created session worktree.
_Avoid_: Template, bootstrap asset

**Bootstrap command**:
A repo-scoped shell command run after env syncing to prepare a materialized worktree.
_Avoid_: Setup script, install step

**Path env**:
A root-level env variable that points from one repo to a dependency repo's path.
_Avoid_: Dependency path, repo link

### Agent guidance

**Consumer repo**:
A repo whose developer or agent uses monke-tools as a local workflow tool.
_Avoid_: Target repo, downstream repo, using repo

**Local tool install**:
A developer-machine install of monke-tools built from a source checkout and shared by all **Consumer repos** through the `mt` command.
_Avoid_: Published package, consumer dependency

**Local install refresh**:
The act of rebuilding the **Local tool install** from the current monke-tools source checkout before validating behavior in a **Consumer repo**.
_Avoid_: Publish, dependency update, session refresh

**Package skill**:
Versioned agent guidance distributed with monke-tools so agents in a **Consumer repo** can learn the matching monke-tools workflows.
_Avoid_: Copied prompt, generated instruction file, session guide

**Core package skill**:
The first monke-tools **Package skill**, covering the local install, consumer setup, session operations, repo configuration, and `mt work` workflow together.
_Avoid_: Skill family, split skill set, command reference

**Skill discovery surface**:
A package installation location that agent tooling can scan to find monke-tools **Package skills**.
_Avoid_: CLI binary, shell path, compiled executable

**Global package link**:
A developer-machine package link that points global package discovery back to the monke-tools source checkout.
_Avoid_: Bun global install, copied package, published package

**Skill loading guidance**:
Opt-in agent instructions in a **Consumer repo** that tell agents how to discover and load **Package skills**.
_Avoid_: Session bootstrap, AGENTS rewrite, monke setup

### Port assignment

**Port key**:
The canonical name for a repo-owned local port slot, always expressed as an env-style `*_PORT` identifier.
_Avoid_: Env var, actual port

**Local mapping**:
A rule that binds one app env variable to one repo-owned port key.
_Avoid_: Port rewrite, internal mapping

**External mapping**:
A rule that binds one app env variable to a port key owned by a dependency repo.
_Avoid_: Dependency override, foreign mapping

**Assigned port**:
The concrete numeric port chosen for a port key within one session.
_Avoid_: Port key, reserved port

**Port reservation**:
The persisted numeric block a repo owns so future sessions can allocate stable assigned ports from it.
_Avoid_: Port range, sticky ports

**Baseline port**:
A numeric port already present in a repo's managed env files that should not be reallocated.
_Avoid_: Default port, existing assignment

### Session operations

**Create**:
The operation that creates or updates all required session worktrees from a source checkout.
_Avoid_: Initialize, provision

**Materialize**:
The operation that refreshes the current session by reapplying seeding, path syncing, env rewrites, and bootstrap behavior.
_Avoid_: Refresh, rebuild

**Setup**:
The operation that updates the source checkout root `.env` with dependency path env values.
_Avoid_: Materialize, bootstrap

**Cleanup**:
The operation that runs registered per-session teardown and removes session-state records whose worktrees no longer exist.
_Avoid_: Delete session, prune repos

## Relationships

- A **Session** belongs to exactly one **Root repo**.
- A **Session** may include one or more **Dependency repos**.
- Each participating repo contributes exactly one **Session worktree** per **Session**.
- A **Session state** records one entry per participating repo in the **Session**.
- A **Session resource** belongs to exactly one repo within one **Session state**.
- A **Resource value** resolves to exactly one **Session resource** value.
- A **Resource cleanup** belongs to one repo and may use any **Session resources** resolved for that repo.
- **Session resources** for different **Session worktrees** must resolve to distinct values when they use the same resource name.
- A **Cleanup command** runs from the repo's **Source checkout** when cleanup finds a **Dead worktree**.
- A **Cleanup command** receives **Session resources**, `MONKE_SESSION`, `MONKE_SOURCE_ROOT`, and `MONKE_WORKTREE_PATH` in its environment.
- An **App** belongs to exactly one repo and may own zero or more **Local mappings**.
- A **Port key** is owned by exactly one repo across a resolved session graph.
- A **Local mapping** consumes a **Port key** owned by the same repo.
- An **External mapping** consumes a **Port key** owned by a **Dependency repo**.
- A **Port reservation** belongs to exactly one repo and may back many **Sessions** over time.
- An **Assigned port** belongs to exactly one **Port key** within one repo's **Session state**.
- **Create** and **Materialize** both update **Assigned ports**, **Managed env files**, **Path env** values, and **Session resources** in the session root `.env`.
- **Create** and **Materialize** both resolve missing **Session resources** and reuse existing **Session resources** from **Session state**.
- **Setup** updates **Path env** values in the **Source checkout** but does not create a **Session worktree**.
- **Cleanup** runs **Cleanup commands** for **Dead worktrees** before removing eligible **Session state**.
- **Cleanup** keeps **Session state** when a **Cleanup command** fails so teardown can be retried with the same **Session resources**.
- A **Consumer repo** may use monke-tools without being the **Root repo** of an active **Session**.
- A **Local tool install** can make one `mt` command available to many **Consumer repos** on the same machine.
- A **Local tool install** may also provide one shared **Skill discovery surface** for those **Consumer repos**.
- A **Local install refresh** happens before testing monke-tools changes from any **Consumer repo**.
- The local **Skill discovery surface** is a **Global package link** so Intent's global scan can find monke-tools package metadata and skills.
- A **Package skill** belongs to the monke-tools package version that ships it.
- A **Package skill** is available to **Consumer repos** only through a **Skill discovery surface**.
- The initial monke-tools skill set contains one **Core package skill**.
- **Skill loading guidance** belongs to a **Consumer repo**, not to a **Session**.

## Example dialogue

> **Dev:** "When I run **Create** for `banana`, is the **Session** just the branch name?"
>
> **Domain expert:** "No. The **Session** uses the same name as the branch, but it is the whole workspace instance across the **Root repo** and any **Dependency repos**."
>
> **Dev:** "So each repo gets its own **Session worktree**, and the root app reads dependency ports through an **External mapping**?"
>
> **Domain expert:** "Exactly. The dependency owns the **Port key**, monke-tools assigns the numeric port, then rewrites the root app's **Managed env file** and root-level **Path env** values."
>
> **Dev:** "And **Materialize** keeps those assigned ports sticky because they come from the repo's **Port reservation**, right?"
>
> **Domain expert:** "Right. **Cleanup** can remove dead **Session state**, but the **Port reservation** stays so future sessions stay stable."

> **Dev:** "Should **Create** write monke-tools instructions into every repo it touches?"
>
> **Domain expert:** "No. A **Consumer repo** opts into **Skill loading guidance**, then its agent can load the monke-tools **Package skill** that matches the installed package version."

## Flagged ambiguities

- "session" and "branch" are closely related but not the same thing. Use **Session** for the workspace instance and **branch** only for the Git ref carried by each **Session worktree**.
- The repo uses both "dependency repo" and "external repo" for the same concept. Prefer **Dependency repo** in prose; keep `external` only as the `monke.yml` section name.
- "refresh" appears in prose, but the canonical operation name is **Materialize** because it does more than simple syncing.
- "port", "port key", and "assigned port" should stay distinct: a **Port key** is the symbolic slot, an **Assigned port** is the numeric value, and a raw "port" should only be used when the distinction does not matter.
- "root .env" can mean either the source checkout or a session worktree. Prefer **Source checkout root `.env`** for `setup` output and **session root `.env`** for materialized worktree output.
- "cleanup" previously meant only pruning dead **Session state**. It now also includes registered per-session teardown, such as deleting external state created for that **Session**.
- Failed **Cleanup commands** do not consume **Session resources**. The **Session state** remains the retry handle.
- **Session resource** collisions are scoped by resource name and resolved value. Equal values under different resource names are allowed.
- "repo that uses monke-tools" is ambiguous. Use **Consumer repo** when discussing agent guidance and package installation; use **Root repo** or **Dependency repo** when discussing a concrete session graph.
- "local setup" is ambiguous. Use **Local tool install** for the shared `mt` command and **Skill discovery surface** for where agents find **Package skills**.
- "global install" is ambiguous. Use **Global package link** when the package root points back to the local source checkout; avoid implying a published package has been installed.
