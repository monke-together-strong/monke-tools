# Agent guidance distribution

Part of the [domain glossary](../../GLOSSARY.md).

## Language

**User PR guidance**: Machine-local defaults for authoring PRs when **Repo PR guidance** is absent.

**Repo PR guidance**: Repo-owned PR authoring instructions that replace **User PR guidance** and complement the reviewer-facing PR template.

**Model role**: A named kind of agent work, such as writing or code review, with its models in fallback order and at most one per model family. _Avoid_: Agent type, persona

**Spec**: A durable work target that records agreed behavior, implementation decisions, testing decisions, and scope for an agent to execute. A PRD can serve as a Spec when it carries that implementation contract.

**Distributed skill**: Agent guidance exposed through monke-tools **Skill projections** so agents in a **Consumer repo** can use shared or personal workflows.

**Shared distributed skill**: A **Distributed skill** available to every selected compatible **Agent harness**.

**Harness-specific skill**: A **Distributed skill** available only to one **Agent harness**.

**Codex-only skill**: A **Harness-specific skill** available only through the built-in Codex **Skill install target**.

**Agent harness**: A supported agent runtime family whose capabilities determine whether a **Harness-specific skill** applies, such as Codex.

**Skill source tree**: The source collection of **Distributed skills** and **Distributed references**.

**Reference source tree**: The portion of the **Skill source tree** containing **Distributed references**.

**Skill slug**: The directory name of a **Distributed skill** or **Distributed reference** in the **Skill source tree**. _Avoid_: Skill name, package name, agent label

**Agent skill name**: The name declared inside a **Distributed skill** for agent-facing selection and display. _Avoid_: Skill slug, folder name, package skill name

**Model-invoked skill**: A **Distributed skill** whose agent metadata permits the model to select it automatically from its description. _Avoid_: Always-loaded guidance

**User-invoked skill**: A **Distributed skill** whose agent metadata permits a human to invoke it explicitly.

**Explicit-only skill**: A **User-invoked skill** that the model may not select automatically. _Avoid_: Manual-only skill

**Model invocation override**: A local choice recorded by a **Skill import recipe** that replaces an imported skill's upstream model-invocation setting. It may be a source-wide default or a per-skill choice.

**Internal skill**: A monke-tools-owned **Distributed skill** shipped with the tool.

**Imported guidance**: Agent guidance imported from a **Skill import source** and distributed as either an **Imported skill** or an **Imported reference**, whether bundled with monke-tools or registered personally.

**Imported skill**: An **Imported guidance** item distributed as a **Distributed skill**.

**Distributed reference**: Non-invocable agent guidance packaged inside the **Skill source tree** for explicit use by skills or other files.

**Internal reference**: A monke-tools-owned **Distributed reference** packaged with the local install.

**Imported reference**: A non-invocable **Imported guidance** item distributed as a **Distributed reference**.

**Reference-backed skill**: An invocable **Distributed skill** that loads an unchanged **Distributed reference** as its base behavior and applies additional guidance with explicit precedence. _Avoid_: Forked skill, patched imported skill, copied skill

**Global agent instructions**: Team-owned agent guidance installed into selected **Agent harnesses** at user scope and loaded across **Consumer repos**. Repo guidance may specialize or override it.

**Managed instruction section**: The portion of user-level agent instructions owned by monke-tools.

**Team coding baseline**: Minimum Team-owned coding guidance required across all **Consumer repos**; repo rules may add stricter or more specific guidance.

**Repo coding standards**: Repository-owned coding guidance documented by a **Consumer repo**; it supplements the **Team coding baseline** and may override conflicting imported review guidance.

**Skill import**: The operation that brings selected guidance from a **Skill import source** into the **Skill source tree** as **Imported skills** or **Imported references**.

**Skill creation**: The operation that creates a new local **Distributed skill** under Monke's ownership.

**Skill adoption**: The operation that brings existing local skills under Monke's source ownership and **Skill projection** management.

**Skill copy**: A local representation of guidance for one **Skill slug**, held in an independent folder or exposed through a source alias. Matching **Agent skill names** alone do not establish that two folders represent the same skill.

**Skill import source**: An outside collection from which a **Skill import** selects guidance. It may be a repository, an existing local collection, or a collection produced by a **Skill installer command**. _Avoid_: Skill install target, Dependency repo

**Skill installer command**: A remembered command for acquiring or refreshing a **Skill import source**, independent of where its guidance is distributed.

**Skill source folder**: The folder containing the authoritative skill files for a linked or installer-backed **Skill import**, including skills created or adopted into Monke home. _Avoid_: Canonical skill collection, Agent skill root, Skill projection

**Skill import recipe**: The source, selections, and local overrides used to refresh **Imported guidance** from one **Skill import source**. Git recipes also record a commit pin.

**Skill import recipe store**: A collection of **Skill import recipes** for one imported guidance collection.

**Repo import recipes**: The **Skill import recipes** declared in a repo's root `monke.yml` to publish **Imported guidance** alongside its own **Skill source tree**.

**Skill registry**: A local **Skill import recipe store** for an imported guidance collection. A global registry belongs to one **Monke home**. A project registry belongs to one local clone and is shared across its worktrees. _Avoid_: Repo import recipes, monke-tools repository

**Skill lock**: The full Git commit pins that identify accepted versions of repository-backed **Imported guidance**. Linked collections and installer commands do not have immutable source pins.

**Skill source revision**: The accepted version of a repository-backed **Skill import source**, which may advance while its selected **Imported guidance** stays identical.

**Guidance digest**: The content identity of restored **Imported guidance** after local choices are applied. A restore marker uses it to detect edits and reuse matching files.

**Imported guidance snapshot**: A captured state of an **Imported guidance** collection, including its supporting files and **Skill lock**.

**Skill update**: The operation that refreshes **Imported guidance** using its recorded import choices and **Model invocation overrides**.

**Skill update review**: A comparison of **Imported guidance snapshots** before and after a **Skill update**, including both content and source provenance changes.

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

## Relationships

- A global **Skill registry** can include imports from the active Monke install and personal sources. A project registry contains explicitly registered sources for that clone.
- A **Skill import** selects a source collection. **Skill install preferences** select distribution targets; an installer's agent-specific output folder does not restrict those targets.
- Authored skills from linked and installer-backed sources share editing authority with their **Skill source folder**. Their global and project **Skill projections** expose that same guidance; source refreshes may replace instruction edits. Publisher-declared imports and aliases into their generated folders use consumer-owned copies, preserving the publisher's pins and policies.
- A skill may be both **Model-invoked** and **User-invoked**.
- A per-skill **Model invocation override** takes precedence over its source-wide default. Overrides survive source refreshes and selection changes, including a skill disappearing and returning; without an override, upstream invocation metadata remains authoritative.
- A **Skill source revision** may change without changing its **Guidance digest**. The resulting lock-only comparison is still a **Skill update review**.
- Projections and managed instruction sections belong to monke-tools. Other agent guidance remains user-owned.
