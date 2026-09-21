# Agent guidance distribution

Part of the [domain glossary](../../CONTEXT.md).

## Language

**User PR guidance**: Machine-local defaults for authoring PRs when **Repo PR guidance** is absent.

**Repo PR guidance**: Repo-owned PR authoring instructions that replace **User PR guidance** and complement the reviewer-facing PR template.

**Spec**: A durable work target that records agreed behavior, implementation decisions, testing decisions, and scope for an agent to execute. A PRD can serve as a Spec when it carries that implementation contract.

**Distributed skill**: Agent guidance distributed through the **Active tool install** so agents in a **Consumer repo** can use shared team workflows.

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

**Model invocation override**: A **Skill import recipe** choice that overrides whether the model may invoke imported guidance automatically.

**Core distributed skill**: The monke-tools-owned **Distributed skill** covering the local install, consumer setup, session operations, and repo configuration.

**Internal skill**: A monke-tools-owned **Distributed skill** distributed with the local install, whether it helps agents work on monke-tools itself or use monke-tools from a **Consumer repo**.

**Imported guidance**: Agent guidance brought into monke-tools from outside and distributed as either an **Imported skill** or an **Imported reference**.

**Imported skill**: A discoverable **Imported guidance** item distributed as a **Distributed skill**.

**Distributed reference**: Non-invocable agent guidance packaged inside the **Skill source tree** for explicit use by skills or other files.

**Internal reference**: A monke-tools-owned **Distributed reference** packaged with the local install.

**Imported reference**: A non-invocable **Imported guidance** item distributed as a **Distributed reference**.

**Reference-backed skill**: An invocable **Distributed skill** that loads an unchanged **Distributed reference** as its base behavior and applies additional guidance with explicit precedence. _Avoid_: Forked skill, patched imported skill, copied skill

**Global agent instructions**: Team-owned agent guidance installed into selected **Agent harnesses** at user scope and loaded across **Consumer repos**. Repo guidance may specialize or override it.

**Managed instruction section**: The portion of user-level agent instructions owned by monke-tools.

**Team coding baseline**: Minimum Team-owned coding guidance required across all **Consumer repos**; repo rules may add stricter or more specific guidance.

**Repo coding standards**: Repository-owned coding guidance documented by a **Consumer repo**; it supplements the **Team coding baseline** and may override conflicting imported review guidance.

**Skill import**: The operation that brings selected upstream skills into the **Skill source tree** as **Imported skills** or **Imported references**.

**Skill import recipe**: A remembered description of one **Skill import** that can be rerun to refresh the same **Imported guidance** from the same outside source.

**Skill import recipe store**: The shared collection of **Skill import recipes** maintained with monke-tools.

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
- A skill may be both **Model-invoked** and **User-invoked**.
- **Skill install preferences** select targets. Projections and managed instruction sections belong to monke-tools; unrelated agent guidance remains user-owned.
- **Team coding baseline** applies across repos. **Repo coding standards** add repo-specific constraints.
