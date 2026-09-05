# Agent retrospective

See [CONTEXT.md](../../CONTEXT.md) for shared session, repo, and port terminology.

## Language

**Retrospective**: One read-only analysis pass that combines recent **Agent transcript** evidence with required **PR analysis**, then reports **Durable fix proposals**. The transcript lane detects **Friction episodes**, **Repeated asks**, and **Standards opportunities** grouped by **Source checkout**; the PR lane studies **Implementation trajectories** in the same **Retrospective window**.

**Implementation trajectory**: A pull request lifecycle analyzed from the state when the PR was opened to the merged outcome.

**Trajectory window**: The retrospective time window interpreted by **Merged PR** merge time, not by transcript idle time.

**Retrospective window**: The time span analyzed by one agent retrospective run, defaulting from the previous completed retrospective run to now unless explicitly overridden; the first run defaults to the previous two weeks.

**PR opening snapshot**: The deterministic repository state represented by a pull request when it was first opened, including all commits already present on the PR branch at creation time.

**Opening snapshot confidence**: The evidence level for a **PR opening snapshot**, recorded as exact when GitHub exposes a reliable creation-time head ref, inferred when reconstructed from commit times, and unknown when no opening ref can be identified.

**Merged outcome**: The deterministic repository state represented by a **Merged PR** at merge time.

**Post-opening change**: A change added to a pull request after the **PR opening snapshot** and before the **Merged outcome**.

**Post-opening delta**: The diff between a **PR opening snapshot** and the **Merged outcome**, used as the primary evidence for **PR analysis**.

**Corrective change**: A **Post-opening change** that fixes, tightens, refactors, verifies, cleans up, or removes something from the **PR opening snapshot**, rather than adding unrelated feature scope.

**PR analysis**: An evidence-grounded analysis of one **Implementation trajectory**, focused on the **Post-opening delta** and recurring **Corrective change** patterns.

**PR analysis scope**: The GitHub repository set included in required **PR analysis**, currently every accessible non-archived repository under the `monke-together-strong` organization rather than only repositories with eligible **Agent transcripts**.

**PR author scope**: The pull request author filter for required **PR analysis**, currently merged pull requests authored by the authenticated GitHub user running the skill.

**PR analysis report**: An aggregate Markdown report that combines per-PR **PR analysis** findings for one **Trajectory window** before final retrospective synthesis.

**PR analysis gap**: An explicit report entry for a repository whose **PR analysis** could not be completed for a **Trajectory window**, including the reason and the impact on final retrospective synthesis.

**Agent transcript**: One recorded Codex or Claude agent conversation, identified by its native agent session id. A resumed conversation is the same transcript; a subagent run is a distinct child transcript linked to its parent. _Avoid_: Session, chat, thread, conversation

**Primary repo**: The **Source checkout** an **Agent transcript**'s working directory resolves to — the repo it was mainly working in. _Avoid_: Root repo, working repo

**Secondary repo**: A different **Source checkout** whose files an **Agent transcript** touched without it being the working directory. _Avoid_: Dependency repo, external repo

**Friction episode**: An observed moment in an **Agent transcript** where the agent hit an issue and changed course — a neutral record of what it was attempting, the blocker, and the pivot. Not a judgment that any rule was broken.

**Durable fix proposal**: A recommended lasting change to the agent working environment — a skill, `AGENTS.md`/`CLAUDE.md`, a coding standard, a hook, a preflight, or a Linear issue — inferred from related **Friction episodes**, **Repeated asks**, **Standards opportunities**, and/or recurring **Corrective change** patterns from **PR analysis**, for a human to execute. The retrospective proposes it; it never applies it.

**Repeated ask**: A request about how code should be written or changed that recurs across multiple **Agent transcripts**, whether or not an agent hit a blocker or produced a defect.

**Standards opportunity**: A **Repeated ask** whose underlying code-writing rule is absent, partial, or scoped incorrectly in the **Team coding baseline** or applicable **Repo coding standards**. It is a guidance gap, not necessarily a defect or standards violation.

## Transcript identity

Resolve transcript working directories to Source checkouts using the same
`--git-common-dir` rule as session operations, then group by that identity. Its
hash is only the on-disk filename. Each transcript has one Primary repo and zero
or more Secondary repos observed in tool activity; child transcripts inherit
parent repo membership by default.

Primary/Secondary membership describes observed activity, independently of a
Session's declared Root/dependency graph. Native `session_id` identifies an Agent
transcript, not a monke workspace Session.

## Evidence and proposals

Record each Friction episode once against its transcript, as a neutral
observation. Regenerate Durable fix proposals each run from related episodes,
Repeated asks, Standards opportunities, and PR Corrective change patterns.
Proposals carry evidence and confidence and may conclude no fix is worth making.
The retrospective reports proposals without editing repos, skills, or config.

Extract raw user messages deterministically; regenerate request classification
and clustering each run. Repeated asks may cluster within one Primary repo or
across repos during global synthesis.

Check the Team coding baseline and applicable Repo coding standards before
proposing a standard. An already-covered request indicates an execution or
enforcement gap. Generally applicable rules belong in the team baseline;
stack-, architecture-, or domain-specific rules belong in repo standards.

Every episode needs verifiable transcript locations. Every proposal needs
verifiable transcript or PR-analysis evidence. Reject citations that cannot be
matched to their source.
