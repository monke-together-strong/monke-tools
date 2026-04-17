# Ubiquitous Language

## Session topology

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Session** | A named local workspace instance that spans one source repo and any dependency repos using the same branch-aligned identity. | Branch, environment, sandbox |
| **Source checkout** | The original Git checkout from which a session is created. | Main worktree, root worktree |
| **Session worktree** | A linked Git worktree created for a specific repo inside a session. | Checkout copy, clone |
| **Root repo** | The source repo from which the session was requested and whose dependency graph defines the session scope. | Main repo, parent repo |
| **Dependency repo** | Another repo declared by the root repo that must be materialized into the same session. | External repo, child repo |
| **Session state** | The persisted record of which repos belong to a session, where their worktrees live, and which ports were assigned. | Cache, registry entry |

## Repo configuration

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **App** | A configured app directory inside one repo whose env file participates in managed rewrites. | Service, project |
| **Managed env file** | The env file inside an app whose mapped variables monke-tools rewrites. | Local env, app config |
| **Seed path** | A repo-relative file or directory copied into a newly created session worktree. | Template, bootstrap asset |
| **Bootstrap command** | A repo-scoped shell command run after env syncing to prepare a materialized worktree. | Setup script, install step |
| **Path env** | A root-level env variable that points from one repo to a dependency repo’s path. | Dependency path, repo link |

## Port assignment

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Port key** | The canonical name for a repo-owned local port slot, always expressed as an env-style `*_PORT` identifier. | Env var, actual port |
| **Local mapping** | A rule that binds one app env variable to one repo-owned port key. | Port rewrite, internal mapping |
| **External mapping** | A rule that binds one app env variable to a port key owned by a dependency repo. | Dependency override, foreign mapping |
| **Assigned port** | The concrete numeric port chosen for a port key within one session. | Port key, reserved port |
| **Port reservation** | The persisted numeric block a repo owns so future sessions can allocate stable assigned ports from it. | Port range, sticky ports |
| **Baseline port** | A numeric port already present in a repo’s managed env files that should not be reallocated. | Default port, existing assignment |

## Session operations

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Create** | The operation that creates or updates all required session worktrees from a source checkout. | Initialize, provision |
| **Materialize** | The operation that refreshes the current session by reapplying seeding, path syncing, env rewrites, and bootstrap behavior. | Refresh, rebuild |
| **Setup** | The operation that updates the source checkout root `.env` with dependency path env values. | Materialize, bootstrap |
| **Cleanup** | The operation that removes session-state records whose worktrees no longer exist. | Delete session, prune repos |

## Relationships

- A **Session** belongs to exactly one **Root repo**.
- A **Session** may include one or more **Dependency repos**.
- Each participating repo contributes exactly one **Session worktree** per **Session**.
- A **Session state** records one entry per participating repo in the **Session**.
- An **App** belongs to exactly one repo and may own zero or more **Local mappings**.
- A **Port key** is owned by exactly one repo across a resolved session graph.
- A **Local mapping** consumes a **Port key** owned by the same repo.
- An **External mapping** consumes a **Port key** owned by a **Dependency repo**.
- A **Port reservation** belongs to exactly one repo and may back many **Sessions** over time.
- An **Assigned port** belongs to exactly one **Port key** within one repo’s **Session state**.
- **Create** and **Materialize** both update **Assigned ports**, **Managed env files**, and **Path env** values.
- **Setup** updates **Path env** values in the **Source checkout** but does not create a **Session worktree**.

## Example dialogue

> **Dev:** "When I run **Create** for `banana`, is the **Session** just the branch name?"
>
> **Domain expert:** "No. The **Session** uses the same name as the branch, but it is the whole workspace instance across the **Root repo** and any **Dependency repos**."
>
> **Dev:** "So each repo gets its own **Session worktree**, and the root app reads dependency ports through an **External mapping**?"
>
> **Domain expert:** "Exactly. The dependency owns the **Port key**, monke-tools assigns the numeric port, then rewrites the root app’s **Managed env file** and root-level **Path env** values."
>
> **Dev:** "And **Materialize** keeps those assigned ports sticky because they come from the repo’s **Port reservation**, right?"
>
> **Domain expert:** "Right. **Cleanup** can remove dead **Session state**, but the **Port reservation** stays so future sessions stay stable."

## Flagged ambiguities

- "session" and "branch" are closely related but not the same thing. Use **Session** for the workspace instance and **branch** only for the Git ref carried by each **Session worktree**.
- The repo uses both "dependency repo" and "external repo" for the same concept. Prefer **Dependency repo** in prose; keep `external` only as the `monke.yml` section name.
- "refresh" appears in prose, but the canonical operation name is **Materialize** because it does more than simple syncing.
- "port", "port key", and "assigned port" should stay distinct: a **Port key** is the symbolic slot, an **Assigned port** is the numeric value, and a raw "port" should only be used when the distinction does not matter.
- "root .env" can mean either the source checkout or a session worktree. Prefer **Source checkout root `.env`** for `setup` output and **session root `.env`** for materialized worktree output.
