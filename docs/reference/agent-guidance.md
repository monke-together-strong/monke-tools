# Agent guidance distribution

See [CONTEXT.md](../../CONTEXT.md) for shared session, repo, and port terminology.

## Language

**User PR guidance**: Machine-local PR authoring defaults stored as `instructions/PR.md` under the **Monke home** and applied by the `create-pr` skill when **Repo PR guidance** is absent.

**Repo PR guidance**: Optional agent-facing PR authoring instructions stored as `PR.md` at a **Consumer repo** root; these replace **User PR guidance** and complement the repo's reviewer-facing GitHub pull request template.

**Spec**: A durable work target that records agreed behavior, implementation decisions, testing decisions, and scope for an agent to execute. A PRD can serve as a Spec when it carries that implementation contract.

**Distributed skill**: Agent guidance distributed through the **Active tool install** so agents in a **Consumer repo** can use shared team workflows.

**Shared distributed skill**: A **Distributed skill** available to every selected compatible **Agent harness**.

**Harness-specific skill**: A **Distributed skill** available only to one **Agent harness**.

**Codex-only skill**: A **Harness-specific skill** available only through the built-in Codex **Skill install target**.

**Agent harness**: A supported agent runtime family whose capabilities determine whether a **Harness-specific skill** applies, such as Codex.

**Skill source tree**: The `skills/` directory in the monke-tools source checkout that packages **Distributed skills** and **Distributed references** for installation into **Agent skill roots**.

**Reference source tree**: The `references/` area inside the **Skill source tree** that stores **Distributed references**, separated into internal and imported ownership groups.

**Skill slug**: The filesystem name of one **Distributed skill** inside the **Skill source tree**. _Avoid_: Skill name, package name, agent label

**Agent skill name**: The name declared inside a **Distributed skill** for agent-facing selection and display. _Avoid_: Skill slug, folder name, package skill name

**Model-invoked skill**: A **Distributed skill** whose agent metadata permits the model to select it automatically from its description. This capability is independent of whether a human may invoke the skill explicitly. _Avoid_: User-invoked skill, always-loaded guidance

**User-invoked skill**: A **Distributed skill** whose agent metadata permits a human to invoke it explicitly. This capability is independent of whether the model may select the skill automatically. _Avoid_: Model-invoked skill, manual-only skill

**Model invocation override**: The optional agent-neutral `disableModelInvocation` value in a **Skill import recipe**. An absent value preserves upstream metadata, `true` disables model invocation, and `false` enables it when the **Imported skill** is materialized.

**Core distributed skill**: The monke-tools-owned **Distributed skill** covering the local install, consumer setup, session operations, and repo configuration.

**Internal skill**: A monke-tools-owned **Distributed skill** distributed with the local install, whether it helps agents work on monke-tools itself or use monke-tools from a **Consumer repo**.

**Imported guidance**: Agent guidance brought into monke-tools from outside and distributed as either an **Imported skill** or an **Imported reference**.

**Imported skill**: A discoverable **Imported guidance** item distributed as a **Distributed skill**.

**Distributed reference**: Non-invocable agent guidance packaged inside the **Skill source tree** for explicit use by skills or other files.

**Internal reference**: A monke-tools-owned **Distributed reference** packaged with the local install.

**Imported reference**: A non-invocable **Imported guidance** item distributed as a **Distributed reference**.

**Reference-backed skill**: An invocable **Distributed skill** that loads an unchanged **Distributed reference** as its base behavior and applies additional guidance with explicit precedence. _Avoid_: Forked skill, patched imported skill, copied skill

**Global agent instructions**: Team-owned agent guidance installed into selected **Agent harnesses** at user scope and loaded across **Consumer repos**. Repo guidance may specialize or override it.

**Managed instruction section**: The marker-delimited portion of an **Agent harness** user-level instruction file owned and reconciled by monke-tools.

**Team coding baseline**: Minimum Team-owned coding guidance required across all **Consumer repos**; repo rules may add stricter or more specific guidance.

**Repo coding standards**: Repository-owned coding guidance documented by a **Consumer repo**; it supplements the **Team coding baseline** and may override conflicting imported review guidance.

**Skill import**: The operation that brings selected upstream skills into the **Skill source tree** as **Imported skills** or **Imported references**.

**Skill import recipe**: A remembered description of one **Skill import** that can be rerun to refresh the same **Imported guidance** from the same outside source.

**Skill import recipe store**: A repo-tracked file in the **Skill source tree** that records **Skill import recipes** shared by everyone maintaining monke-tools.

**Skill import selector**: The upstream-facing skill identifier passed to a **Skill import** to choose one **Imported guidance** item from its outside source.

**Import kind**: The recipe choice that makes selected **Imported guidance** either an **Imported skill** or an **Imported reference**.

**Imported guidance owner**: The one **Skill import recipe** that is allowed to refresh a particular **Imported guidance** item in the **Skill source tree**.

**Agent skill root**: An agent-readable directory where monke-tools exposes **Distributed skills** in the layout supported by the selected **Skill install target**. _Avoid_: Skill discovery surface, package root, compiled executable

**Skill namespace**: The monke-tools-owned directory inside an **Agent skill root** where monke-tools installs its **Distributed skills**.

**Managed skill namespace**: A **Skill namespace** whose standard source-folder entries are reconciled by monke-tools while unrelated entries are preserved.

**Skill projection**: The target-specific view of compatible **Distributed skills** and shared **Distributed references** exposed in an **Agent skill root**, either through a **Managed skill namespace** or directly as a **Flat skill projection**.

**Flat skill projection**: A **Skill projection** that exposes each compatible **Distributed skill** directly in the **Agent skill root**, with monke-tools ownership tracked separately from unrelated skills.

**Skill install target**: An agent-specific or custom destination selected for installing monke-tools **Distributed skills**. _Avoid_: Default agent, package manager, install mode

**Built-in skill install target**: A supported agent destination that monke-tools knows how to resolve without a user-provided path.

**Custom skill install target**: The one user-provided destination path for installing monke-tools **Distributed skills** outside the built-in agent destinations.

**Skill install preference**: The remembered set of **Skill install targets** used by later local installs.

**Skills Configure**: The interactive operation that lets a user choose one or more **Skill install targets** and saves the resulting **Skill install preference** in **Global monke config**.

## Target preferences

Global monke config stores the current user-selected set of one or more targets,
including at most one Custom target. Built-in selections store the target kind;
a Custom selection stores an absolute Agent skill root path, not a namespace
path. Input `~` resolves against the OS home, not Monke home.

| Built-in target | Default Agent skill root | Projection        |
| --------------- | ------------------------ | ----------------- |
| Codex           | `~/.codex/skills`        | Managed namespace |
| Claude          | `~/.claude/skills`       | Flat              |
| Cursor          | `~/.cursor/skills`       | Managed namespace |

Custom targets use a Managed namespace. Skills Configure starts with the saved
selection, asks for targets before the custom path, retains that path while
custom remains selected, and removes it when deselected. It saves the selection
before reconciling targets.

## Reconciliation

Local install refresh includes skill installation using saved preferences or
explicit replacement targets. With no saved preference it may run Skills Configure
after installing `mt`. Reconciliation creates missing Agent skill roots and tries
all selected targets; any target failure makes the overall refresh fail.

Global instructions, skills, and references ship with the source version. Codex
and Claude receive the shared Global agent instructions in managed sections,
honoring `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. Cursor and Custom targets receive no
global instructions. User-owned content outside managed sections is preserved;
repo guidance may specialize or override the global instructions.

## Compatibility and ownership

The source tree separates Shared skills by internal/imported ownership and
Harness-specific skills by harness. Currently Codex is the only harness-specific
scope: only the built-in Codex target receives Codex-only skills. All targets
receive Shared skills and references.

The Core skill uses `monke-tools-core` for both slug and agent name; these may
differ for other skills. Imports preserve upstream agent names by default.
Each imported item has one owner recipe and one Import kind. Changing kind
migrates the item instead of creating another managed copy. The tracked recipe
store records selectors, kinds, and metadata needed to refresh each recipe's
owned guidance.

## Projections

A namespace is named `monke-tools`; each Agent skill root may contain one.
A managed namespace contains one projection of compatible skills and shared
references. Only skills are discoverable. Claude projects skills directly into
its root with separate ownership tracking. Local-install projections keep source
changes live without copying skill contents. Release-install projections point
into writable files in the active install, with original hashes retained in its
manifest for update checks.

Refresh may migrate a legacy namespace symlink or relink a projection to a new
source tree. It preserves unrelated entries and refuses to overwrite non-symlinks
at managed source-folder names. Deselecting a target removes only its managed
namespace or flat projection, preserving unrelated skills.
