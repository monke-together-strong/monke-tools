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

**Resource values**:
The repo configuration section for deterministic literal session resources.
_Avoid_: Resource commands, dynamic resources

**Resource cleanup**:
A repo-scoped shell command run during cleanup with the session's resolved resources, resource command outputs, and session metadata available in its environment.
_Avoid_: Provider release, per-resource cleanup hook

**Cleanup command**:
The `monke.yml` field that configures resource cleanup for one repo.
_Avoid_: Resource cleanup command, teardown script

**Resource command**:
A named repo-scoped default-export JS/TS module run from a session worktree to choose dynamic session values while monke-tools coordinates concurrent runs.
_Avoid_: Provider, allocator, pool

**Declaring repo**:
The repo whose `monke.yml` defines a resource command.
_Avoid_: Root repo, consumer repo, command worktree

**Resource command output**:
The exact required non-empty env-style string values returned by a resource command for one session worktree and remembered as inputs to later matching resource command runs.
_Avoid_: Claim, provider result, pool item

**Resource command input**:
The remembered values from other retained session states for previous runs of the same resource command, grouped by required resource command output name.
_Avoid_: Claim list, session history, lock state

**Resource command contract**:
The machine-readable function contract for a resource command: remembered values are passed as the `previous` argument field, and resource command output is returned from the default-export function.
_Avoid_: CLI log format, cleanup protocol

**Command lock**:
The exclusive concurrency boundary for one declaring repo and one resource command name, preventing matching resource commands from running at the same time across multiple session worktrees.
_Avoid_: Claim, resource value, cleanup handle

**Resource command timeout**:
The maximum duration a resource command may run while holding its command lock.
_Avoid_: Cleanup timeout, lock lifetime

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
_Avoid_: Published package, consumer dependency, package-manager link

**Local install refresh**:
The act of rebuilding the **Local tool install** from the current monke-tools source checkout before validating behavior in a **Consumer repo**.
_Avoid_: Publish, dependency update, session refresh

**Monke home**:
The machine-local directory where monke-tools keeps state, preferences, and owned **Session worktrees** shared across **Consumer repos**.
_Avoid_: OS home, repo root, source checkout

**Global monke config**:
Machine-local monke-tools preferences that apply across **Consumer repos** and are stored outside any repo checkout as versioned YAML at `config.yml` under the monke home directory.
_Avoid_: Repo config, session state, monke.yml

**Distributed skill**:
Agent guidance distributed through the **Local tool install** so agents in a **Consumer repo** can use shared team workflows.
_Avoid_: Package skill, copied prompt, generated instruction file

**Skill source tree**:
The `skills/` directory in the monke-tools source checkout that stores **Distributed skills** before they are installed into **Agent skill roots**.
_Avoid_: Skill registry, source root, package metadata

**Installed source checkout**:
The monke-tools source checkout used by the current **Local tool install**.
_Avoid_: Package root, global package link, install directory

**Skill slug**:
The filesystem name of one **Distributed skill** inside the **Skill source tree**.
_Avoid_: Skill name, package name, agent label

**Agent skill name**:
The name declared inside a **Distributed skill** for agent-facing selection and display.
_Avoid_: Skill slug, folder name, package skill name

**Core distributed skill**:
The first monke-tools **Distributed skill**, covering the local install, consumer setup, session operations, repo configuration, and `mt work` workflow together.
_Avoid_: Skill family, split skill set, command reference

**Internal skill**:
A monke-tools-owned **Distributed skill** distributed with the local install, whether it helps agents work on monke-tools itself or use monke-tools from a **Consumer repo**.
_Avoid_: Repo skill, local skill, source-only skill

**Imported skill**:
A monke-tools **Distributed skill** brought in from outside monke-tools and distributed through the same local install.
_Avoid_: External skill, third-party skill, copied skill

**Skill import**:
The operation that brings selected **Imported skills** from an outside source into the **Skill source tree**.
_Avoid_: Skill install, skill add, skill sync

**Agent skill root**:
An agent-readable directory where monke-tools installs a namespaced set of **Distributed skills**.
_Avoid_: Skill discovery surface, package root, compiled executable

**Skill namespace**:
The monke-tools-owned directory inside an **Agent skill root** where monke-tools installs its **Distributed skills**.
_Avoid_: Root skill folder, agent skill root, flat install

**Managed skill namespace**:
A **Skill namespace** that the local install can reconcile as a whole because monke-tools created it and owns its contents.
_Avoid_: Skill cache, generated skills, copied namespace

**Skill install target**:
An agent-specific or custom destination selected for installing monke-tools **Distributed skills**.
_Avoid_: Default agent, package manager, install mode

**Built-in skill install target**:
A supported agent destination that monke-tools knows how to resolve without a user-provided path.
_Avoid_: Default target, detected target, automatic target

**Custom skill install target**:
The one user-provided destination path for installing monke-tools **Distributed skills** outside the built-in agent destinations.
_Avoid_: Extra target, external target, arbitrary target

**Skill install preference**:
The remembered set of **Skill install targets** used by later local installs.
_Avoid_: Default target, agent config, repo preference

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

**Default branch create mode**:
A **Create** mode that creates missing session branches from each participating repo's local default branch instead of the current source checkout commit.
_Avoid_: Arbitrary base branch, from branch

**Materialize**:
The operation that refreshes the current session by reapplying seeding, path syncing, env rewrites, and bootstrap behavior.
_Avoid_: Refresh, rebuild

**Setup**:
The operation that updates the source checkout root `.env` with dependency path env values.
_Avoid_: Materialize, bootstrap

**Skills Configure**:
The interactive operation that lets a user choose one or more **Skill install targets** and saves the resulting **Skill install preference** in **Global monke config**.
_Avoid_: Skill install, setup, non-interactive config

**Cleanup**:
The operation that runs registered per-session teardown and removes session-state records whose worktrees no longer exist.
_Avoid_: Delete session, prune repos

## Relationships

- A **Session** belongs to exactly one **Root repo**.
- A **Session** may include one or more **Dependency repos**.
- Each participating repo contributes exactly one **Session worktree** per **Session**.
- A **Session state** records one entry per participating repo in the **Session**.
- A **Session resource** belongs to exactly one repo within one **Session state**.
- A **Session state** may remember **Resource command outputs** for a repo within one **Session**.
- Remembered **Resource command outputs** are grouped by **Resource command** name in **Session state**.
- A **Resource value** resolves to exactly one **Session resource** value.
- **Resource values** configure deterministic **Session resources**.
- A **Resource cleanup** belongs to one repo and may use any **Session resources** and **Resource command outputs** resolved for that repo.
- **Session resources** for different **Session worktrees** must resolve to distinct values when they use the same resource name.
- **Default branch create mode** resolves `main` and `master` separately for each repo participating in a **Session**.
- **Default branch create mode** only affects missing session branches.
- **Default branch create mode** materializes from default-branch content, not from uncommitted or branch-local source checkout changes.
- A **Cleanup command** runs from the repo's **Source checkout** when cleanup finds a **Dead worktree**.
- A **Cleanup command** receives **Session resources**, **Resource command outputs**, `MONKE_SESSION`, `MONKE_SOURCE_ROOT`, and `MONKE_WORKTREE_PATH` in its environment.
- A **Resource command** belongs to one repo and runs for one **Session worktree**.
- A **Declaring repo** owns the namespace for its **Resource commands**.
- A **Resource command** runs from the target **Session worktree**.
- A **Resource command** name uses the same lowercase label style as repo configuration labels.
- A **Resource command** has a non-empty `run` module path and one or more declared **Resource command outputs**.
- A **Resource command** executes as a repo-authored default-export JS/TS module.
- A **Resource command timeout** defaults to 60 seconds unless the repo config overrides it.
- A **Resource command output** belongs to one **Resource command** run for one **Session worktree**.
- A **Resource command** declares one or more required **Resource command outputs**.
- A **Resource command output** must match the outputs declared by its **Resource command** exactly.
- A **Resource command output** is written to the session root `.env`.
- **Resource values** and **Resource command outputs** for the same repo must not use the same env name.
- Multiple **Resource commands** for one repo run in repo configuration order and use separate **Command locks**.
- A **Resource command input** is grouped by **Resource command output** name.
- A **Resource command input** includes every declared **Resource command output** name with an array of remembered values, using an empty array when no values are remembered for that output.
- A **Resource command input** deduplicates remembered values but does not promise a sorted order.
- A **Resource command input** only includes earlier **Resource command outputs** from other retained **Session states** with the same **Declaring repo** and **Resource command** name.
- A **Resource command input** is derived from retained **Session states**, not from a separate resource-command index.
- Current repo configuration controls which **Resource command output** names appear in **Resource command input**.
- A **Resource command** name defines the input and lock namespace; renaming a **Resource command** creates a new namespace.
- A **Resource command input** does not include **Session resources**.
- A **Resource command output** may not reuse a value already present for the same output name in the **Resource command input**.
- A **Resource command contract** calls a repo-owned default-export module with **Resource command input** under a `previous` field and expects the returned object to contain **Resource command output**.
- **Resource command** failures identify the command, the failure kind, stdout, and stderr; stdout and stderr are diagnostic logs, not the success protocol.
- **Resource commands** receive deterministic **Session resources** through process env, but earlier **Resource command outputs** only through the `previous` function argument.
- **Create** and **Materialize** reuse complete remembered **Resource command outputs** and run the **Resource command** only when outputs are missing or incomplete.
- Persisted **Resource command outputs** are the durable boundary for reuse after a failed **Create** or **Materialize** attempt.
- **Resource command outputs** are persisted immediately after they are validated.
- **Create** and **Materialize** prune remembered **Resource command outputs** for the current repo and **Session** when they are no longer declared by repo configuration.
- A **Command lock** belongs to exactly one **Declaring repo** and one **Resource command** name.
- A **Command lock** serializes matching **Resource commands** across multiple **Session worktrees** for the same **Declaring repo**.
- A **Command lock** covers reading remembered **Resource command outputs**, running the **Resource command**, validating its output, and persisting the new output.
- Remembered **Resource command outputs** stop contributing to **Resource command input** when their **Session state** is removed by **Cleanup**.
- Later matching **Resource command** runs may receive earlier **Resource command outputs** as input.
- An **App** belongs to exactly one repo and may own zero or more **Local mappings**.
- A **Port key** is owned by exactly one repo across a resolved session graph.
- A **Local mapping** consumes a **Port key** owned by the same repo.
- An **External mapping** consumes a **Port key** owned by a **Dependency repo**.
- A **Port reservation** belongs to exactly one repo and may back many **Sessions** over time.
- An **Assigned port** belongs to exactly one **Port key** within one repo's **Session state**.
- **Create** and **Materialize** both update **Assigned ports**, **Managed env files**, **Path env** values, **Session resources**, and **Resource command outputs**.
- **Create** and **Materialize** both resolve missing **Session resources** and reuse existing **Session resources** from **Session state**.
- **Setup** updates **Path env** values in the **Source checkout** but does not create a **Session worktree**.
- **Cleanup** runs **Cleanup commands** for **Dead worktrees** before removing eligible **Session state**.
- **Cleanup** keeps **Session state** when a **Cleanup command** fails so teardown can be retried with the same **Session resources** and **Resource command outputs**.
- A **Consumer repo** may use monke-tools without being the **Root repo** of an active **Session**.
- A **Local tool install** can make one `mt` command available to many **Consumer repos** on the same machine.
- A **Local tool install** may also install **Distributed skills** into one or more **Agent skill roots**.
- A **Local tool install** does not require a package-manager link.
- **Monke home** may contain **Session worktrees** for many **Consumer repos**.
- **Global monke config** belongs to the machine, not to a **Consumer repo** or **Session**.
- **Global monke config** lives at `$MONKE_HOME/config.yml`, defaulting to `~/.monke/config.yml`.
- The initial **Global monke config** format version is `1`.
- The **Installed source checkout** belongs to **Global monke config**.
- A **Skill source tree** belongs to the **Installed source checkout**.
- monke-tools does not infer a replacement **Installed source checkout** when the configured checkout is missing.
- A **Skill install preference** belongs to **Global monke config**.
- A **Skill install preference** contains one or more **Skill install targets** selected by the user.
- A **Skill install preference** must contain at least one **Skill install target**.
- **Global monke config** keeps the current **Skill install preference**, not historical preferences.
- A **Skill install target** resolves to one **Agent skill root** during **Local install refresh**.
- The built-in **Skill install targets** are Codex, Claude, and Cursor.
- The Codex **Skill install target** resolves to `~/.codex/skills`.
- The Claude **Skill install target** resolves to `~/.claude/skills`.
- The Cursor **Skill install target** resolves to `~/.cursor/skills`.
- Built-in **Skill install targets** resolve `~` against the OS home directory, not the monke home directory.
- A **Skill install preference** may include at most one **Custom skill install target**.
- Built-in **Skill install targets** store only the selected target kind in **Global monke config**.
- A **Custom skill install target** stores its destination path in **Global monke config**.
- A **Custom skill install target** path is an **Agent skill root**, not the **Skill namespace** path itself.
- A **Custom skill install target** path may use `~` for the OS home directory.
- A **Custom skill install target** stores its destination path as an absolute path.
- **Skills Configure** creates or replaces the **Skill install preference**.
- **Skills Configure** starts from the existing **Skill install preference** when one exists.
- **Skills Configure** asks for selected **Skill install targets** before asking for a custom path.
- **Skills Configure** reuses the existing **Custom skill install target** path when custom remains selected and removes it when custom is deselected.
- **Skills Configure** reconciles selected **Skill install targets** after saving the **Skill install preference**.
- A **Local install refresh** happens before testing monke-tools changes from any **Consumer repo**.
- A **Local install refresh** installs the `mt` command before writing the **Installed source checkout**.
- A **Local install refresh** writes the **Installed source checkout** before running **Skills Configure** or reconciling **Skill install targets**.
- A **Local install refresh** delegates skill configuration and target reconciliation to monke-tools rather than reimplementing those rules in shell.
- A **Local install refresh** uses the stored **Skill install preference** instead of assuming a default **Skill install target**.
- A **Local install refresh** may run **Skills Configure** after installing the `mt` command when no **Skill install preference** exists.
- A **Local install refresh** always includes skill installation; it is not a binary-only operation.
- Reconciling a **Skill install target** creates the **Agent skill root** when it is missing.
- A **Local install refresh** may succeed for one **Skill install target** and fail for another.
- A failed **Skill install target** does not prevent other selected **Skill install targets** from being reconciled.
- A **Local install refresh** fails overall after reconciliation if any selected **Skill install target** failed.
- A **Distributed skill** belongs to the monke-tools source version that ships it.
- A **Skill source tree** stores **Distributed skills** under the same category path used in installed **Skill namespaces**.
- A **Distributed skill** has a **Skill slug** and may have a different **Agent skill name**.
- The **Core distributed skill** uses `core` as its **Skill slug** and `monke-tools-core` as its **Agent skill name**.
- A **Distributed skill** is either an **Internal skill** or an **Imported skill**.
- An **Imported skill** preserves its upstream **Agent skill name** by default.
- A **Skill namespace** contains only monke-tools **Distributed skills**.
- A **Skill namespace** is always named `monke-tools`.
- A **Managed skill namespace** is a symlink to the **Skill source tree**.
- Any symlink at the explicit monke-tools **Skill namespace** path is treated as a **Managed skill namespace**.
- Each **Agent skill root** may contain one monke-tools **Skill namespace**.
- A **Managed skill namespace** may be reconciled by a **Local install refresh**.
- A **Local install refresh** must not modify an existing **Skill namespace** unless it is a **Managed skill namespace**.
- A **Local install refresh** may relink a **Managed skill namespace** from an old **Skill source tree** to the current **Skill source tree**.
- **Skills Configure** may remove **Managed skill namespaces** from previously selected **Skill install targets** that are no longer selected.
- A **Distributed skill** is available to **Consumer repos** through installed global agent skills.
- The initial monke-tools skill set contains one **Core distributed skill**.

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
> **Domain expert:** "No. **Distributed skills** are installed through the **Local tool install**, so **Consumer repos** do not need per-repo skill loading instructions."

## Flagged ambiguities

- "session" and "branch" are closely related but not the same thing. Use **Session** for the workspace instance and **branch** only for the Git ref carried by each **Session worktree**.
- The repo uses both "dependency repo" and "external repo" for the same concept. Prefer **Dependency repo** in prose; keep `external` only as the `monke.yml` section name.
- "refresh" appears in prose, but the canonical operation name is **Materialize** because it does more than simple syncing.
- "port", "port key", and "assigned port" should stay distinct: a **Port key** is the symbolic slot, an **Assigned port** is the numeric value, and a raw "port" should only be used when the distinction does not matter.
- "root .env" can mean either the source checkout or a session worktree. Prefer **Source checkout root `.env`** for `setup` output and **session root `.env`** for materialized worktree output.
- "cleanup" previously meant only pruning dead **Session state**. It now also includes registered per-session teardown, such as deleting external state created for that **Session**.
- Failed **Cleanup commands** do not consume **Session resources** or **Resource command outputs**. The **Session state** remains the retry handle.
- **Session resource** collisions are scoped by resource name and resolved value. Equal values under different resource names are allowed.
- `resources` uses the nested resource surface. Use **Resource values** for deterministic literals and **Resource commands** for dynamic command outputs; do not use a flat `resources` mapping.
- The nested resource surface may include **Resource values**, **Resource commands**, or both, but it must not be empty when present.
- The nested resource surface ships as one feature slice: deterministic **Resource values** and dynamic **Resource commands** share the same resource surface.
- "claim" is ambiguous in the resource command design. Prefer **Resource command output** for values returned by the command and **Command lock** for monke-tools concurrency control.
- Cross-output uniqueness is repo-owned. monke-tools enforces same-output collisions for **Resource command outputs**, not whether different output names may share a value.
- "repo that uses monke-tools" is ambiguous. Use **Consumer repo** when discussing agent guidance and package installation; use **Root repo** or **Dependency repo** when discussing a concrete session graph.
- "local setup" is ambiguous. Use **Local tool install** for the shared `mt` command and **Agent skill root** for where agents read installed **Distributed skills**.
- "skill discovery surface" describes the old Intent package-scanning model. Use **Agent skill root** because monke-tools installs skills directly.
- "external skill" collides with `external` repo configuration. Use **Imported skill** for skills brought in from outside monke-tools.
- "default skill target" hides user intent. Use **Skill install preference** for the remembered multi-target selection in **Global monke config**.
