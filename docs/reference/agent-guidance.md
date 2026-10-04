# Agent guidance distribution

Part of the [domain glossary](../../CONTEXT.md).

## Language

**User PR guidance**: Machine-local defaults for authoring PRs when **Repo PR guidance** is absent.

**Repo PR guidance**: Repo-owned PR authoring instructions that replace **User PR guidance** and complement the reviewer-facing PR template.

**Spec**: A durable work target that records agreed behavior, implementation decisions, testing decisions, and scope for an agent to execute. A PRD can serve as a Spec when it carries that implementation contract.

**Distributed skill**: Agent guidance exposed through monke-tools **Skill projections** so agents in a **Consumer repo** can use shared or personal workflows.

**Shared distributed skill**: A **Distributed skill** available to every selected compatible **Agent harness**.

**Harness-specific skill**: A **Distributed skill** available only to one **Agent harness**.

**Codex-only skill**: A **Harness-specific skill** available only through the built-in Codex **Skill install target**.

**Agent harness**: A supported agent runtime family whose capabilities determine whether a **Harness-specific skill** applies, such as Codex.

**Skill source tree**: The source collection of **Distributed skills** and **Distributed references**.

**Reference source tree**: The portion of the **Skill source tree** containing **Distributed references**.

**Skill slug**: The filesystem name of one **Distributed skill** inside the **Skill source tree**. _Avoid_: Skill name, package name, agent label

**Agent skill name**: The name declared inside a **Distributed skill** for agent-facing selection and display. _Avoid_: Skill slug, folder name, package skill name

**Model-invoked skill**: A **Distributed skill** whose agent metadata permits the model to select it automatically from its description. This capability is independent of whether a human may invoke the skill explicitly. _Avoid_: User-invoked skill, always-loaded guidance

**User-invoked skill**: A **Distributed skill** whose agent metadata permits a human to invoke it explicitly. This capability is independent of whether the model may select the skill automatically. _Avoid_: Model-invoked skill, manual-only skill

**Explicit-only skill**: A **User-invoked skill** that the model may not select automatically.

**Model invocation override**: A local choice recorded by a **Skill import recipe** that replaces an imported skill's upstream model-invocation setting. It may be a source-wide default or a per-skill choice.

**Core distributed skill**: The monke-tools-owned **Distributed skill** covering the local install, consumer setup, session operations, and repo configuration.

**Internal skill**: A monke-tools-owned **Distributed skill** distributed with the local install, whether it helps agents work on monke-tools itself or use monke-tools from a **Consumer repo**.

**Imported guidance**: Agent guidance imported from a **Skill import source** and distributed as either an **Imported skill** or an **Imported reference**, whether bundled with monke-tools or registered personally.

**Imported skill**: A discoverable **Imported guidance** item distributed as a **Distributed skill**.

**Distributed reference**: Non-invocable agent guidance packaged inside the **Skill source tree** for explicit use by skills or other files.

**Internal reference**: A monke-tools-owned **Distributed reference** packaged with the local install.

**Imported reference**: A non-invocable **Imported guidance** item distributed as a **Distributed reference**.

**Reference-backed skill**: An invocable **Distributed skill** that loads an unchanged **Distributed reference** as its base behavior and applies additional guidance with explicit precedence. _Avoid_: Forked skill, patched imported skill, copied skill

**Global agent instructions**: Team-owned agent guidance installed into selected **Agent harnesses** at user scope and loaded across **Consumer repos**. Repo guidance may specialize or override it.

**Managed instruction section**: The portion of user-level agent instructions owned by monke-tools.

**Team coding baseline**: Minimum Team-owned coding guidance required across all **Consumer repos**; repo rules may add stricter or more specific guidance.

**Repo coding standards**: Repository-owned coding guidance documented by a **Consumer repo**; it supplements the **Team coding baseline** and may override conflicting imported review guidance.

**Skill import**: The operation that brings selected guidance from a **Skill import source** into the **Skill source tree** as **Imported skills** or **Imported references**.

**Skill import source**: An outside collection from which a **Skill import** selects guidance. It may be a repository, an existing local collection, or a collection produced by a **Skill installer command**. _Avoid_: Skill install target, Dependency repo

**Skill installer command**: A remembered command for acquiring or refreshing a **Skill import source**, independent of where its guidance is distributed.

**Skill source folder**: The folder containing the authoritative skill files for a linked or installer-backed **Skill import**. _Avoid_: Canonical skill collection, Agent skill root, Skill projection

**Skill import recipe**: The remembered source, selection, import-kind, and invocation choices for refreshing **Imported guidance** from one **Skill import source**.

**Skill import recipe store**: A collection of **Skill import recipes** for one imported guidance collection.

**Bundled import recipes**: The repo-owned **Skill import recipes** for **Imported guidance** distributed with monke-tools. _Avoid_: Bundled skill import store, Skill registry

**Skill registry**: The machine-local **Skill import recipe store** for a user's imported guidance collection, including bundled imports and personal or private sources. _Avoid_: Bundled import recipes, monke-tools repository

**Skill lock**: The recorded source revisions, guidance identities, and import choices for accepted **Imported guidance**. Repository-backed entries identify reproducible versions; installer commands and linked collections record where guidance comes from without promising an immutable source version.

**Skill source revision**: The accepted version of a repository-backed **Skill import source**, which may advance while its selected **Imported guidance** stays identical.

**Guidance digest**: The content identity of selected **Imported guidance** after local import choices are applied.

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

**Skills Configure**: Selection of **Skill install targets** as the user's **Skill install preference**.

## Relationships

- A **Skill projection** exposes compatible skills and references in one **Agent skill root**. A **Managed skill namespace** groups them; a **Flat skill projection** exposes skills directly.
- **Shared distributed skills** apply across compatible harnesses; **Harness-specific skills** apply only to their named harness.
- Each **Imported guidance** item has one **Imported guidance owner** and one **Import kind**. Its recipe retains the source and choices needed to refresh it.
- **Bundled import recipes** belong to monke-tools; a **Skill registry** belongs to one machine's user. A registry starts with bundled imports and then retains its own recipes and invocation choices independently.
- A **Skill import** selects a source collection. **Skill install preferences** select distribution targets; an installer's agent-specific output folder does not restrict those targets.
- Linked and installer-backed **Imported skills** share editing authority with their **Skill source folder**. Their global **Skill projections** expose that same guidance; source refreshes may replace instruction edits.
- A skill may be both **Model-invoked** and **User-invoked**.
- A per-skill **Model invocation override** takes precedence over its source-wide default. Overrides survive source refreshes and selection changes, including a skill disappearing and returning; without an override, upstream invocation metadata remains authoritative.
- A **Skill source revision** may change without changing its **Guidance digest**. The resulting lock-only comparison is still a **Skill update review**.
- **Skill install preferences** select targets. Projections and managed instruction sections belong to monke-tools; unrelated agent guidance remains user-owned.
- **Team coding baseline** applies across repos. **Repo coding standards** add repo-specific constraints.
