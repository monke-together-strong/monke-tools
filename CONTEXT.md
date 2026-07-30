# monke-tools

monke-tools manages isolated local workspace sessions for a root repo and its dependency repos. This context defines the domain language for session topology, repo configuration, port assignment, and session operations.

## Language

### Session topology

**Session**: A named local workspace instance that spans one source repo and any dependency repos using the same branch-aligned identity. _Avoid_: Branch, environment, sandbox

**Source checkout**: The original Git checkout that any working directory resolves to: the canonical non-worktree root and parent of all the repo's linked worktrees. A **Session** is created from one. _Avoid_: Main worktree, root worktree

**Session worktree**: A linked Git worktree created for a specific repo inside a session, stored under the **Monke home** worktree area as `worktrees/<repo-name>/<session>`. _Avoid_: Checkout copy, clone

**Ordinary worktree**: A linked Git worktree that is not owned by a **Session**. _Avoid_: Non-Monke worktree, external worktree, unmanaged Session

**Root repo**: The source repo from which a session was requested and whose dependency graph defines the session scope. _Avoid_: Main repo, parent repo

**Dependency repo**: Another repo declared by the root repo that must be materialized into the same session. _Avoid_: External repo, child repo

**Session state**: The persisted record of which repos belong to a session, where their worktrees live, and which ports were assigned. _Avoid_: Cache, registry entry

**Session state store**: The module that owns **Session state** for one operation: opened under the global lock, it scans retained session states once, serves cross-session queries, and persists repo checkpoints. _Avoid_: Registry, cache, state manager

**Session finalization**: The targeted lifecycle step that runs a Session's Cleanup commands after all its recorded worktrees are logically gone, then removes **Session state** only after every command succeeds. _Avoid_: Worktree removal, broad Cleanup scan, branch deletion

**Session resource**: A per-session string value resolved for a repo, persisted in session state, written to the session root `.env`, and optionally used during cleanup. _Avoid_: Provider, pool item, resolved env value

**Resource value**: The configured literal string that becomes a session resource value, with `${session}` available as the session-name placeholder and `${user}` available as the machine-user placeholder. _Avoid_: Provider acquisition, allocator, command output

**Resource values**: The repo configuration section for deterministic literal session resources. _Avoid_: Resource commands, dynamic resources

**Resource cleanup**: A repo-scoped shell command run during cleanup with the session's resolved resources, resource command outputs, and session metadata available in its environment. _Avoid_: Provider release, per-resource cleanup hook

**Cleanup command**: The `monke.yml` field that configures resource cleanup for one repo. _Avoid_: Resource cleanup command, teardown script

**Resource command**: A named repo-scoped default-export JS/TS module run from a session worktree to choose dynamic session values while monke-tools coordinates concurrent runs. _Avoid_: Provider, allocator, pool

**Declaring repo**: The repo whose `monke.yml` defines a resource command. _Avoid_: Root repo, consumer repo, command worktree

**Resource command output**: The exact required non-empty env-style string values returned by a resource command for one session worktree and remembered as inputs to later matching resource command runs. _Avoid_: Claim, provider result, pool item

**Resource command input**: The remembered values from other retained session states for previous runs of the same resource command, grouped by required resource command output name. _Avoid_: Claim list, session history, lock state

**Resource command contract**: The machine-readable function contract for a resource command: remembered values are passed as the `previous` argument field, and resource command output is returned from the default-export function. _Avoid_: CLI log format, cleanup protocol

**Command lock**: The exclusive concurrency boundary for one declaring repo and one resource command name, preventing matching resource commands from running at the same time across multiple session worktrees. _Avoid_: Claim, resource value, cleanup handle

**Resource command timeout**: The maximum duration a resource command may run while holding its command lock. _Avoid_: Cleanup timeout, lock lifetime

**Dead worktree**: A session worktree recorded in session state whose filesystem path no longer exists. _Avoid_: Inactive worktree, stale checkout

**Merged PR**: A pull request whose GitHub `mergedAt` value is set. _Avoid_: Merged worktree, merged session

**Merge-cleanable Session**: A Session whose session branch is proven by a **Merged PR** and whose recorded session worktrees are eligible for explicit cleanup. _Avoid_: Merged worktree, stale session

### Repo configuration

**App**: A configured app directory inside one repo whose env file participates in managed rewrites. _Avoid_: Service, project

**Managed env file**: The env file inside an app whose mapped variables monke-tools rewrites. _Avoid_: Local env, app config

**Seed path**: A repo-relative file or directory copied into a newly spawned session worktree. _Avoid_: Template, bootstrap asset

**Seed material**: The source-checkout files copied into a newly spawned session worktree before env rewrites, including discovered env files and configured Seed paths. _Avoid_: Default-branch content, tracked source

**Bootstrap command**: A repo-scoped shell command run after env syncing to prepare a materialized worktree. _Avoid_: Setup script, install step

**Path env**: A root-level env variable that points from one repo to a dependency repo's path. _Avoid_: Dependency path, repo link

### Agent guidance

**Consumer repo**: A repo whose developer or agent uses monke-tools as a local workflow tool. _Avoid_: Target repo, downstream repo, using repo

**User PR guidance**: Machine-local PR authoring defaults stored as `instructions/PR.md` under the **Monke home** and applied by the `create-pr` skill when **Repo PR guidance** is absent. _Avoid_: Global monke config, Repo PR guidance, GitHub pull request template

**Repo PR guidance**: Optional agent-facing PR authoring instructions stored as `PR.md` at a **Consumer repo** root; these replace **User PR guidance** and complement the repo's reviewer-facing GitHub pull request template. _Avoid_: User PR guidance, POST_MERGE.md, GitHub pull request template

**Local tool install**: A developer-machine install of monke-tools built from a source checkout and shared by all **Consumer repos** through the `mt` command. _Avoid_: Published package, consumer dependency, package-manager link

**Local install refresh**: The act of rebuilding the **Local tool install** from the current monke-tools source checkout before validating behavior in a **Consumer repo**. _Avoid_: Publish, dependency update, session refresh

**Monke home**: The machine-local directory where monke-tools keeps state, preferences, and owned **Session worktrees** shared across **Consumer repos**. Defaults to `~/.monke`; Session worktrees live under `worktrees/<repo-name>/<session>` within this directory. _Avoid_: OS home, repo root, source checkout

**Global monke config**: Machine-local monke-tools preferences that apply across **Consumer repos** and are stored outside any repo checkout as versioned YAML at `config.yml` under the monke home directory. _Avoid_: Repo config, session state, monke.yml

**Distributed skill**: Agent guidance distributed through the **Local tool install** so agents in a **Consumer repo** can use shared team workflows. _Avoid_: Package skill, copied prompt, generated instruction file

**Skill source tree**: The `skills/` directory in the monke-tools source checkout that packages **Distributed skills** and **Distributed references** for installation into **Agent skill roots**. _Avoid_: Skill registry, source root, package metadata

**Reference source tree**: The `references/` area inside the **Skill source tree** that stores **Distributed references**, separated into internal and imported ownership groups. _Avoid_: Skill source tree, global reference directory, reference cache

**Installed source checkout**: The monke-tools source checkout used by the current **Local tool install**. _Avoid_: Package root, global package link, install directory

**Skill slug**: The filesystem name of one **Distributed skill** inside the **Skill source tree**. _Avoid_: Skill name, package name, agent label

**Agent skill name**: The name declared inside a **Distributed skill** for agent-facing selection and display. _Avoid_: Skill slug, folder name, package skill name

**Core distributed skill**: The monke-tools-owned **Distributed skill** covering the local install, consumer setup, session operations, and repo configuration. _Avoid_: Skill family, split skill set, command reference

**Internal skill**: A monke-tools-owned **Distributed skill** distributed with the local install, whether it helps agents work on monke-tools itself or use monke-tools from a **Consumer repo**. _Avoid_: Repo skill, local skill, source-only skill

**Imported guidance**: Agent guidance brought into monke-tools from outside and distributed as either an **Imported skill** or an **Imported reference**. _Avoid_: Import artifact, external files, vendored docs

**Imported skill**: A discoverable **Imported guidance** item distributed as a **Distributed skill**. _Avoid_: External skill, third-party skill, copied skill

**Distributed reference**: Non-invocable agent guidance packaged inside the **Skill source tree** for explicit use by skills or other files. _Avoid_: Global skill, hidden skill, always-loaded context

**Internal reference**: A monke-tools-owned **Distributed reference** packaged with the local install. _Avoid_: Imported reference, personal reference, internal skill

**Imported reference**: A non-invocable **Imported guidance** item distributed as a **Distributed reference**. _Avoid_: Reference skill, imported skill, global reference

**Reference-backed skill**: An invocable **Distributed skill** that loads an unchanged **Distributed reference** as its base behavior and applies additional guidance with explicit precedence. _Avoid_: Forked skill, patched imported skill, copied skill

**Team coding baseline**: Team-owned coding guidance applied across **Consumer repos** as a fallback when a repo does not define a conflicting standard. _Avoid_: Repo coding standards, personal preferences, lint rules

**Repo coding standards**: Authoritative coding guidance documented by a **Consumer repo**; it overrides conflicting team or imported review baselines. _Avoid_: Team coding baseline, formatter config, inferred conventions

**Shared Oxc presets**: Team-owned lint and format policy distributed for consistent use across **Consumer repos**. _Avoid_: Oxc package, rules package, repo quality config

**Release entry**: A pending description of a consumer-visible package change and its intended version impact. _Avoid_: Changelog fragment, changeset, release note file

**Release PR**: An automatically maintained pull request that applies pending package versions and release notes; merging it authorizes immediate publication. _Avoid_: Version Packages PR, version bump PR, publish PR

**Skill import**: The operation that brings selected upstream skills into the **Skill source tree** as **Imported skills** or **Imported references**. _Avoid_: Skill install, skill add, skill sync

**Skill import recipe**: A remembered description of one **Skill import** that can be rerun to refresh the same **Imported guidance** from the same outside source. _Avoid_: Lock file, update config, import cache

**Skill import recipe store**: A repo-tracked file in the **Skill source tree** that records **Skill import recipes** shared by everyone maintaining monke-tools. _Avoid_: Global monke config, local preference, session state

**Skill import selector**: The upstream-facing skill identifier passed to a **Skill import** to choose one **Imported guidance** item from its outside source. _Avoid_: Skill slug, agent skill name, folder name

**Import kind**: The recipe choice that makes selected **Imported guidance** either an **Imported skill** or an **Imported reference**. _Avoid_: Install target, agent type, source type

**Imported guidance owner**: The one **Skill import recipe** that is allowed to refresh a particular **Imported guidance** item in the **Skill source tree**. _Avoid_: Last import wins, source hint, fallback recipe

**Agent skill root**: An agent-readable directory where monke-tools installs a namespaced set of **Distributed skills**. _Avoid_: Skill discovery surface, package root, compiled executable

**Skill namespace**: The monke-tools-owned directory inside an **Agent skill root** where monke-tools installs its **Distributed skills**. _Avoid_: Root skill folder, agent skill root, flat install

**Managed skill namespace**: A **Skill namespace** that the local install can reconcile as a whole because monke-tools created it and owns its contents. _Avoid_: Skill cache, generated skills, copied namespace

**Skill install target**: An agent-specific or custom destination selected for installing monke-tools **Distributed skills**. _Avoid_: Default agent, package manager, install mode

**Built-in skill install target**: A supported agent destination that monke-tools knows how to resolve without a user-provided path. _Avoid_: Default target, detected target, automatic target

**Custom skill install target**: The one user-provided destination path for installing monke-tools **Distributed skills** outside the built-in agent destinations. _Avoid_: Extra target, external target, arbitrary target

**Skill install preference**: The remembered set of **Skill install targets** used by later local installs. _Avoid_: Default target, agent config, repo preference

### Port assignment

**Port key**: The canonical name for a repo-owned local port slot, always expressed as an env-style `*_PORT` identifier. _Avoid_: Env var, actual port

**Local mapping**: A rule that binds one app env variable to one repo-owned port key. _Avoid_: Port rewrite, internal mapping

**External mapping**: A rule that binds one app env variable to a port key owned by a dependency repo. _Avoid_: Dependency override, foreign mapping

**Assigned port**: The concrete numeric port chosen for a port key within one session. _Avoid_: Port key, reserved port

**Port reservation**: The persisted numeric block a repo owns so future sessions can allocate stable assigned ports from it. _Avoid_: Port range, sticky ports

**Baseline port**: A numeric port already present in a repo's managed env files that should not be reallocated. _Avoid_: Default port, existing assignment

### Session operations

**Spawn**: The operation that creates or updates all required session worktrees from a source checkout, using current `HEAD` unless **Default branch spawn mode** is requested. _Avoid_: Initialize, provision

**Default branch spawn mode**: A **Spawn** mode selected by `mt spawn <session> -m`, `--main`, or `--master`. It creates fresh session branches from each participating repo's default branch content, prefers fetched `origin/main` then `origin/master`, falls back to local `main` then `master`, and rejects existing Session state or Session branches. _Avoid_: Arbitrary base branch, from branch

**Materialize**: The operation that refreshes the current session by reapplying seeding, path syncing, env rewrites, and bootstrap behavior. _Avoid_: Refresh, rebuild

**Chop**: The explicit operation that removes one **Chop target** while preserving local branches. A Session target removes every recorded Session worktree and performs **Session finalization**; an Ordinary-worktree target removes only that worktree. _Avoid_: Cleanup, delete branch, prune

**Chop target**: The **Session** or **Ordinary worktree** selected for one **Chop** invocation. _Avoid_: Branch deletion target, Cleanup candidate

**Swing**: The operation that navigates the user's current shell to a **Source checkout**, **Session worktree**, or **Ordinary worktree** for the current **Root repo** scope. Ordinary targets must already exist; explicit pull request targets may materialize the matching **Session worktree** after validating the PR head. _Avoid_: Switch, git switch, create

**Swing target**: A user-provided **Session**, **Ordinary worktree** branch, navigation shortcut, or pull request identifier that **Swing** resolves to a local checkout path. _Avoid_: Branch selector, create target, git ref

**Swing picker**: The interactive **Swing** mode used when `mt swing` is run without a **Swing target**, letting a user choose from the current **Root repo**'s existing local **Swing targets**. _Avoid_: Branch picker, create picker, worktree creator

**Codex workspace launch**: An optional **Spawn** or **Swing** behavior selected with `--codex` that opens the resolved checkout as a Codex workspace. It does not create a thread. _Avoid_: Codex thread launch, Codex create, Codex worktree materialization, remote agent launch

**Previous Swing target**: The last different **Swing target** remembered for one **Root repo**, used by `mt swing -` to return to a previous source, Session, or Ordinary-worktree checkout. _Avoid_: Global previous branch, shell history, last cwd

**Setup**: The operation that updates the source checkout root `.env` with dependency path env values. _Avoid_: Materialize, bootstrap

**Shell directory request**: A CLI-side request for an active shell adapter to move the user's current shell into a resolved **Source checkout** or **Session worktree** after a session operation determines that navigation is required. Once issued, the request is honored independently of the operation's final success or failure. _Avoid_: cd output, directory switch, shell cd

**Shell adapter**: The human-shell function installed by monke-tools that can honor **Shell directory requests** after an `mt` command exits. _Avoid_: Alias, subprocess, terminal state

**Active shell adapter**: A **Shell adapter** that is intercepting the current `mt` invocation and has provided a writable **Shell directory directive**. _Avoid_: Configured shell, installed shell integration, detected shell

**Shell directory directive**: The file-backed path handoff from the `mt` process to an active **Shell adapter** for one **Shell directory request**. _Avoid_: Exec directive, shell command, printed cd

**Shell integration install**: The operation that installs the shell adapter needed to honor **Shell directory requests** for supported human interactive shells. _Avoid_: rc patch, shell setup, cd enablement

**Shell integration init**: The operation that emits the shell adapter source for one supported shell. _Avoid_: Shell integration install, generated profile

**Skills Configure**: The interactive operation that lets a user choose one or more **Skill install targets** and saves the resulting **Skill install preference** in **Global monke config**. _Avoid_: Skill install, setup, non-interactive config

**Cleanup**: The operation that runs registered per-session teardown and removes session-state records whose worktrees no longer exist. _Avoid_: Delete session, prune repos

### Organization reports

**Report target**: The configured shared organization destination to which monke-tools publishes finalized agent reports. _Avoid_: Setup target, storage backend, upload destination

### Agent retrospective

**Retrospective**: One read-only analysis pass that combines recent **Agent transcript** evidence with required **PR analysis**, then reports **Durable fix proposals**. The transcript lane detects **Friction episodes** and **Repeated asks** grouped by **Source checkout**; the PR lane studies **Implementation trajectories** in the same **Retrospective window**. _Avoid_: Audit, review, trace, session review

**Implementation trajectory**: A pull request lifecycle analyzed from the state when the PR was opened to the merged outcome. _Avoid_: Session, transcript, friction episode

**Trajectory window**: The retrospective time window interpreted by **Merged PR** merge time, not by transcript idle time. _Avoid_: Idle window, session window

**Retrospective window**: The time span analyzed by one agent retrospective run, defaulting from the previous completed retrospective run to now unless explicitly overridden; the first run defaults to the previous two weeks. _Avoid_: Unbounded scan, manual date range

**PR opening snapshot**: The deterministic repository state represented by a pull request when it was first opened, including all commits already present on the PR branch at creation time. _Avoid_: First draft, first attempt, initial candidate

**Opening snapshot confidence**: The evidence level for a **PR opening snapshot**, recorded as exact when GitHub exposes a reliable creation-time head ref, inferred when reconstructed from commit times, and unknown when no opening ref can be identified. _Avoid_: Snapshot certainty, confidence score

**Merged outcome**: The deterministic repository state represented by a **Merged PR** at merge time. _Avoid_: Final draft, final patch, merged session

**Post-opening change**: A change added to a pull request after the **PR opening snapshot** and before the **Merged outcome**. _Avoid_: Follow-up, correction turn, later commit

**Post-opening delta**: The diff between a **PR opening snapshot** and the **Merged outcome**, used as the primary evidence for **PR analysis**. _Avoid_: Follow-up commits, later patch

**Corrective change**: A **Post-opening change** that fixes, tightens, refactors, verifies, cleans up, or removes something from the **PR opening snapshot**, rather than adding unrelated feature scope. _Avoid_: New feature commit, extra work

**PR analysis**: An evidence-grounded analysis of one **Implementation trajectory**, focused on the **Post-opening delta** and recurring **Corrective change** patterns. _Avoid_: Session analysis, transcript analysis

**PR analysis scope**: The GitHub repository set included in required **PR analysis**, currently every accessible non-archived repository under the `monke-together-strong` organization rather than only repositories with eligible **Agent transcripts**. _Avoid_: Bundle repos, known repos

**PR author scope**: The pull request author filter for required **PR analysis**, currently merged pull requests authored by the authenticated GitHub user running the skill. _Avoid_: Agent-authored PRs, all org PRs

**PR analysis report**: An aggregate Markdown report that combines per-PR **PR analysis** findings for one **Trajectory window** before final retrospective synthesis. _Avoid_: Per-PR notes, trajectory hints

**PR analysis gap**: An explicit report entry for a repository whose **PR analysis** could not be completed for a **Trajectory window**, including the reason and the impact on final retrospective synthesis. _Avoid_: Silent fallback, skipped PRs

**Agent transcript**: One recorded Codex or Claude agent conversation, identified by its native agent session id. A resumed conversation is the same transcript; a subagent run is a distinct child transcript linked to its parent. _Avoid_: Session, chat, thread, conversation

**Primary repo**: The **Source checkout** an **Agent transcript**'s working directory resolves to — the repo it was mainly working in. _Avoid_: Root repo, working repo

**Secondary repo**: A different **Source checkout** whose files an **Agent transcript** touched without it being the working directory. _Avoid_: Dependency repo, external repo

**Friction episode**: An observed moment in an **Agent transcript** where the agent hit an issue and changed course — a neutral record of what it was attempting, the blocker, and the pivot. Not a judgment that any rule was broken. _Avoid_: Detour, violation, agent sin, mistake, error

**Durable fix proposal**: A recommended lasting change to the agent working environment — a skill, `AGENTS.md`/`CLAUDE.md`, a hook, a preflight, or a Linear issue — inferred from related **Friction episodes**, **Repeated asks**, and/or recurring **Corrective change** patterns from **PR analysis**, for a human to execute. The retrospective proposes it; it never applies it. _Avoid_: Auto-fix, patch, remediation, action item

**Repeated ask**: A fix/revert/change request the user makes to agents that recurs across multiple **Agent transcripts** — the signal that the same correction keeps being needed. _Avoid_: Nag, recurring prompt, recurring instruction

## Relationships

- A **Session** belongs to exactly one **Root repo**.
- A **Session** may include one or more **Dependency repos**.
- Each participating repo contributes exactly one **Session worktree** per **Session**.
- A **Session state** records one entry per participating repo in the **Session**.
- A **Session state store** is opened once per **Spawn**, **Materialize**, or **Cleanup** and is the only reader and writer of **Session state** during that operation.
- A **Session state store** serves assigned-port usage, remembered **Resource command outputs**, and **Resource value** collision queries from one scan of retained **Session states**.
- A **Resource command** receives its remembered outputs and its checkpoint capability from the **Session state store**, not from direct session-state reads.
- A **Session resource** belongs to exactly one repo within one **Session state**.
- A **Session state** may remember **Resource command outputs** for a repo within one **Session**.
- Remembered **Resource command outputs** are grouped by **Resource command** name in **Session state**.
- A **Resource value** resolves to exactly one **Session resource** value.
- **Resource values** configure deterministic **Session resources**.
- A **Resource cleanup** belongs to one repo and may use any **Session resources** and **Resource command outputs** resolved for that repo.
- **Session resources** for different **Session worktrees** must resolve to distinct values when they use the same resource name.
- **Default branch spawn mode** prefers fetched remote `main` or `master` and may fall back to local `main` or `master`.
- **Default branch spawn mode** requires fresh session branches.
- **Default branch spawn mode** materializes tracked repo content and repo configuration from default-branch content, while copying Seed material from the Source checkout.
- **Spawn** always emits a **Shell directory request** for the root repo's **Session worktree** after the operation succeeds.
- **Chop** without a target selects the current **Session** when run inside one of its managed worktrees.
- An explicit **Chop** target selects that named **Session** within the current **Root repo** scope, even when invoked from a different Session.
- **Chop** requires an explicit **Chop target** when run from a **Source checkout**.
- **Chop** without a target selects the current **Ordinary worktree** when invoked from one.
- An Ordinary-worktree **Chop target** removes only that worktree and does not perform **Session finalization**.
- An explicit Ordinary-worktree **Chop target** may be selected by its checked-out branch name or registered absolute or relative path.
- A **Source checkout** is never a **Chop target**; a target branch or path that resolves to one is rejected.
- When an explicit branch or path resolves to any worktree owned by a Session, **Chop** selects the whole owning Session when valid **Session state** proves ownership and that Session is within the invocation's **Root repo** scope.
- A Session-owned worktree is never removed as an **Ordinary worktree**; a managed target outside the invocation's **Root repo** scope is rejected.
- Explicit **Chop** resolution checks for a Session target in the current **Root repo** scope before resolving an Ordinary-worktree target in the invoking repo.
- An Ordinary-worktree **Chop target** must be registered to the invoking repo; **Chop** does not remove worktrees across unrelated repositories.
- A local branch without a registered worktree is not a **Chop target**, because **Chop** preserves branches.
- A detached **Ordinary worktree** may be a **Chop target** when selected as the current worktree or by its registered path.
- An exact, unlocked Git registration for an Ordinary-worktree **Chop target** whose directory is already absent is treated as already removed and pruned while its branch is preserved.
- A missing Ordinary-worktree target with no matching Git registration is not a **Chop target**, and a locked stale registration fails safety validation.
- A detached or branch-mismatched **Session worktree** fails **Chop** safety validation, and `--force` does not override that failure.
- A worktree in the **Monke home** managed worktree area never falls back to an Ordinary-worktree **Chop target** when its **Session state** is missing or invalid.
- A Session **Chop target** requires valid existing **Session state**; `--force` does not reconstruct or bypass missing or invalid state.
- A partially materialized **Session** remains a valid Session **Chop target**; Chop acts on exactly the repos and resources recorded in valid Session state and does not infer unrecorded worktrees from the current dependency graph.
- **Chop** removes the invoking worktree last when it belongs to the selected Session; otherwise, it removes the selected Session's root worktree last.
- A Session **Chop** preflight resolves and validates every cross-repo prerequisite that can be checked without side effects, including Session-state consistency, Source-checkout identity, and every recorded Session worktree, before removing any worktree.
- Session **Chop** preflight reports every detected participating-repo failure together and removes nothing when any failure exists.
- After the whole-Session preflight passes, **Chop** revalidates each worktree's identity and safety immediately before its removal.
- If a removal-time **Chop** revalidation fails, no later worktrees are intentionally removed and **Session state** remains available for retry.
- **Chop** treats an absent recorded worktree path as already removed only when the recorded path and **Source checkout** identity remain valid, no live worktree carries the Session branch elsewhere, and no locked Git worktree registration remains.
- **Chop** may prune an exact unlocked stale Git registration for an already-missing recorded worktree; checkout-level branch and status checks do not apply when there is no checkout to inspect.
- For a clean worktree with initialized submodules, **Chop** may pass Git's internal `worktree remove --force` solely to bypass Git's submodule restriction after immediately revalidating cleanliness; this does not change the user-facing meaning of `mt chop --force`.
- **Session finalization** runs Cleanup commands in reverse materialization order, from the Root repo toward its dependencies.
- **Session finalization** runs only Cleanup commands recorded in **Session state**; an absent recorded command means that repo has no Cleanup command, regardless of current repo configuration.
- **Session finalization** stops at the first failed Cleanup command, preserves the full **Session state**, and does not run later dependency Cleanup commands.
- Retrying **Session finalization** reruns Cleanup commands from the beginning because individual command successes are not checkpointed.
- An explicit Session **Chop target** remains valid while its **Session state** is retained, even when every recorded worktree is already gone; rerunning `mt chop <session>` retries **Session finalization**.
- **Cleanup** remains the broad operation for discovering and finalizing already-dead Sessions, while **Chop** targets one selected Session. After successful **Session state** removal, a later `mt chop <session>` reports that the target does not exist.
- **Swing** always emits a **Shell directory request** for a resolved root repo **Source checkout**, **Session worktree**, or **Ordinary worktree**.
- A **Codex workspace launch** preserves normal **Spawn** or **Swing** behavior and additionally opens `codex://threads/new` with the resolved absolute checkout path.
- **Swing** does not create worktrees for ordinary **Session** or **Ordinary worktree** targets, or change which branch an existing worktree has checked out.
- A **Swing target** may be a **Session** name, an existing **Ordinary worktree** branch, the `^` source-checkout shortcut, the `-` previous-target shortcut, a `pr:<number>` pull request shortcut, or a pull request URL.
- The `^` **Swing target** resolves to the current **Root repo** **Source checkout** without materializing, setting up, creating, or changing branches.
- The `-` **Swing target** resolves to the **Previous Swing target** for the current **Root repo**.
- The `^` **Swing target** participates in **Previous Swing target** history.
- **Previous Swing target** is scoped to one **Root repo**.
- A pull request **Swing target** resolves through the pull request's same-repo head branch name, fetches the PR head, navigates to an existing matching **Session worktree** or **Ordinary worktree**, creates the **Session** if neither exists, and refuses to navigate when the local branch diverged from the PR head.
- Stored navigation (`mt swing <target>`, picker selections, and `-`) does not revalidate a pull request head.
- **Swing** does not support merge request targets.
- Fork pull request targets are outside the first **Swing** contract.
- A **Shell directory request** uses only a **Shell directory directive**; it does not support arbitrary shell execution.
- An **Active shell adapter** honors a non-empty **Shell directory directive** regardless of the `mt` process's exit status, while preserving an existing nonzero status.
- **Chop** does not require an **Active shell adapter**; when the invoking worktree is removed without one, it reports the destination **Source checkout** path and warns that the parent shell could not be moved.
- When a **Shell directory request** is accepted by an **Active shell adapter**, monke-tools reports that it switched to the target checkout.
- When no active **Shell adapter** can accept the **Shell directory request**, monke-tools reports the target path the user should switch to manually.
- When **Shell integration install** has configured the user's shell but no **Active shell adapter** can accept the current **Shell directory request**, monke-tools reports the target path and explains that the shell integration is configured but inactive.
- When **Shell integration install** has not configured the user's shell, monke-tools reports the target path and explains how to configure automatic switching.
- **Shell integration install** supports bash and zsh.
- **Shell integration install** is idempotent and runs during **Local install refresh**.
- **Shell integration install** can be rerun explicitly without refreshing skills or reinstalling the binary.
- **Shell integration init** supports bash and zsh.
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
- **Spawn** and **Materialize** reuse complete remembered **Resource command outputs** and run the **Resource command** only when outputs are missing or incomplete.
- Persisted **Resource command outputs** are the durable boundary for reuse after a failed **Spawn** or **Materialize** attempt.
- **Resource command outputs** are persisted immediately after they are validated.
- **Spawn** and **Materialize** prune remembered **Resource command outputs** for the current repo and **Session** when they are no longer declared by repo configuration.
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
- **Spawn** and **Materialize** both update **Assigned ports**, **Managed env files**, **Path env** values, **Session resources**, and **Resource command outputs**.
- **Spawn** and **Materialize** both resolve missing **Session resources** and reuse existing **Session resources** from **Session state**.
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
- A **Local tool install** has at most one active **Report target**.
- A **Report target** is shared by an organization, not owned by one user.
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
- A **Distributed reference** belongs to the monke-tools source version that ships it.
- A **Skill source tree** packages **Distributed skills** and **Distributed references** under ownership-specific category paths.
- A **Distributed skill** has a **Skill slug** and may have a different **Agent skill name**.
- The **Core distributed skill** uses `core` as its **Skill slug** and `monke-tools-core` as its **Agent skill name**.
- A **Distributed skill** is either an **Internal skill** or an **Imported skill**.
- An **Imported skill** preserves its upstream **Agent skill name** by default.
- An **Imported guidance** item has exactly one **Import kind**.
- Changing an **Imported guidance** item's **Import kind** migrates it instead of creating a second managed copy.
- Each **Imported guidance** item has exactly one **Imported guidance owner**.
- A **Skill import recipe** belongs to the **Skill import recipe store**.
- A **Skill import recipe** records the **Skill import selector**, **Import kind**, and import metadata needed to reproduce a **Skill import**.
- A **Skill import recipe** can be rerun to refresh all **Imported guidance** it owns.
- A **Skill namespace** packages monke-tools **Distributed skills** and **Distributed references**, but only **Distributed skills** are discoverable.
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
- An **Agent transcript** is identified by its native agent session id, not by its file path or length.
- A resumed conversation appends to the same **Agent transcript**.
- A subagent run is a distinct child **Agent transcript** linked to its parent by parent transcript id.
- A child **Agent transcript** inherits its parent's repo membership by default.
- A retrospective groups **Agent transcripts** by **Source checkout**.
- An **Agent transcript** resolves to a **Source checkout** by resolving its working directory through the same `--git-common-dir` rule monke uses, so a **Session worktree** transcript resolves to its **Source checkout**.
- An **Agent transcript** has exactly one **Primary repo** and zero or more **Secondary repos**.
- A **Secondary repo** is observed from an **Agent transcript**'s tool activity, not declared by `monke.yml`, so it need not be a **Dependency repo** of the **Primary repo**.
- A **Friction episode** belongs to exactly one **Agent transcript** and, once recorded, is never recomputed.
- A **Friction episode** states a neutral observation; interpretive claims belong to a **Durable fix proposal**, not the episode.
- A **Durable fix proposal** is synthesized from one cluster of related **Friction episodes**, **Repeated asks**, and/or recurring **Corrective change** patterns from **PR analysis**, carries its supporting evidence and a confidence, and is regenerated each run rather than frozen.
- The retrospective only emits a **Durable fix proposal**; it never edits a repo, skill, or config.
- A **Durable fix proposal** may conclude that no durable fix is worth making.
- A **Repeated ask** is found by classifying raw user messages as fix/revert/change requests and clustering similar ones across **Agent transcripts**; the messages are extracted deterministically, while the classification and clustering are regenerated each run, not frozen.
- A **Repeated ask** may correlate within one **Primary repo** or, in global synthesis, across repos.
- A **Retrospective** is read-only: it reports **Durable fix proposals** but never edits a repo, skill, or config.
- Every **Friction episode** cites verifiable locations in **Agent transcripts**; every **Durable fix proposal** cites verifiable supporting evidence from **Agent transcripts** and/or **PR analysis**; a citation that cannot be matched to its evidence source is rejected.

## Example dialogue

> **Dev:** "When I run **Spawn** for `banana`, is the **Session** just the branch name?"
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

> **Dev:** "Should **Spawn** write monke-tools instructions into every repo it touches?"
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
- "session" is overloaded across the retrospective. Use **Session** only for a monke workspace instance; use **Agent transcript** for a recorded Codex/Claude conversation. The native `session_id` field is just the **Agent transcript** identity — it does not make a transcript a **Session**.
- "repo_key" is not a domain term. The retrospective's logical-repo identity is the **Source checkout** path; `hashKey(<Source checkout path>)` is only the on-disk filename, mirroring the existing `repo-reservations` convention.
- "primary/secondary repo" describe one **Agent transcript**'s observed activity; "root/dependency repo" describe a **Session**'s declared graph. Do not reuse **Root repo** or **Dependency repo** for transcript membership.
