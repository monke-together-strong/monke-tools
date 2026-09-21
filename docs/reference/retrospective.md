# Agent retrospective

Part of the [domain glossary](../../CONTEXT.md).

## Language

**Retrospective**: A read-only analysis of agent and PR evidence that produces **Durable fix proposals**.

**Implementation trajectory**: A pull request lifecycle analyzed from the state when the PR was opened to the merged outcome.

**Trajectory window**: The retrospective time window interpreted by **Merged PR** merge time, not by transcript idle time.

**Retrospective window**: The time span covered by one **Retrospective**.

**PR opening snapshot**: The deterministic repository state represented by a pull request when it was first opened, including all commits already present on the PR branch at creation time.

**Opening snapshot confidence**: The certainty of a **PR opening snapshot**: exact, inferred, or unknown.

**Merged outcome**: The deterministic repository state represented by a **Merged PR** at merge time.

**Post-opening change**: A change added to a pull request after the **PR opening snapshot** and before the **Merged outcome**.

**Post-opening delta**: The diff between a **PR opening snapshot** and the **Merged outcome**, used as the primary evidence for **PR analysis**.

**Corrective change**: A **Post-opening change** that fixes, tightens, refactors, verifies, cleans up, or removes something from the **PR opening snapshot**, rather than adding unrelated feature scope.

**PR analysis**: An evidence-grounded analysis of one **Implementation trajectory**, focused on the **Post-opening delta** and recurring **Corrective change** patterns.

**PR analysis scope**: The repository set included in **PR analysis**.

**PR author scope**: The author set included in **PR analysis**.

**PR analysis report**: An aggregate Markdown report that combines per-PR **PR analysis** findings for one **Trajectory window** before final retrospective synthesis.

**PR analysis gap**: An explicit report entry for a repository whose **PR analysis** could not be completed for a **Trajectory window**, including the reason and the impact on final retrospective synthesis.

**Agent transcript**: One recorded Codex or Claude agent conversation, identified by its native agent session id. A resumed conversation is the same transcript; a subagent run is a distinct child transcript linked to its parent. _Avoid_: Session, chat, thread, conversation

**Primary repo**: The **Source checkout** an **Agent transcript**'s working directory resolves to — the repo it was mainly working in. _Avoid_: Root repo, working repo

**Secondary repo**: A different **Source checkout** whose files an **Agent transcript** touched without it being the working directory. _Avoid_: Dependency repo, external repo

**Friction episode**: An observed moment in an **Agent transcript** where the agent hit an issue and changed course — a neutral record of what it was attempting, the blocker, and the pivot. Not a judgment that any rule was broken.

**Durable fix proposal**: An evidence-backed recommendation for a lasting improvement to the agent working environment. A **Retrospective** proposes the change without applying it.

**Repeated ask**: A request about how code should be written or changed that recurs across multiple **Agent transcripts**, whether or not an agent hit a blocker or produced a defect.

**Standards opportunity**: A **Repeated ask** whose underlying code-writing rule is absent, partial, or scoped incorrectly in the **Team coding baseline** or applicable **Repo coding standards**. It is a guidance gap, not necessarily a defect or standards violation.

## Relationships

- Each **Agent transcript** has one **Primary repo** and zero or more **Secondary repos**. This observed membership is independent of a Session's declared dependency graph.
- A resumed conversation remains one **Agent transcript**; a subagent conversation is a distinct child transcript.
- A **PR opening snapshot** and **Merged outcome** bound the **Post-opening delta** of an **Implementation trajectory**.
- **Friction episodes**, **Repeated asks**, and **Corrective changes** provide evidence for **Durable fix proposals**.
- A **Standards opportunity** is missing or inadequate guidance. Failure to follow an existing standard is an execution or enforcement gap.
