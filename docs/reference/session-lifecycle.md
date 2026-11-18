# Session lifecycle

Part of the [domain glossary](../../GLOSSARY.md).

## Preparation and materialization

**Default branch spawn mode**: A **Spawn** mode that pins each repo's start commit to `main` or `master`, with an optional start ref for the **Root repo**. Retries reuse those commits. The mode starts without carrying local edits.

**Worktree preparation**: Creation or validation of one **Session worktree**, with any permitted incoming edits and **Seed material** applied.

**Prepared worktree**: A **Session worktree** whose preparation is complete but whose **Repo materialization** may still be pending. _Avoid_: Complete worktree, failed worktree

**Preparation warning**: A non-fatal preparation result identifying missing optional **Seed material**.

**Repo materialization**: Preparation of a repo's configured environment, dependencies, and resources for use within a **Session**.

**Blocked repo materialization**: Materialization that cannot begin because a direct dependency's preparation or materialization failed, or because the dependency is itself blocked. _Avoid_: Failed materialization, cancelled materialization

**Worktree adoption**: **Materialize** that records an existing **Ordinary worktree**, at its current path, as the **Root repo**'s **Session worktree** for the Session named after its branch. The adopted worktree then follows the full Session lifecycle, including removal. _Avoid_: Import, borrowed worktree

**Materialization generation**: One retained attempt to materialize every repo in a **Session** dependency graph. _Avoid_: Command invocation, retry run

## Removal

**Cleanup obligation**: A retained requirement to release a Session member's checkout resources or run its recorded **Cleanup command** before finalization. _Avoid_: Cleanup eligibility, prepared state, worktree existence

**Session removal**: Removal of a **Session**'s worktrees and state. **Chop** and **Cleanup** both satisfy retained teardown obligations and preserve local branches. **Cleanup** also preserves work identified for archiving or detached HEAD retention.

**Session finalization**: Completion of **Session removal** after its **Cleanup obligations** are satisfied and all recorded worktrees are gone.

**Missing Session worktree**: A recorded **Session worktree** whose directory no longer exists. _Avoid_: Dead worktree

**Merged PR**: A pull request accepted into its base branch through a recorded merge.

**Cleanup-eligible Session**: A retained **Session** that satisfies **Cleanup**'s removal safety checks. Its work is already preserved or can be preserved during removal. _Avoid_: Merge-cleanable Session

**Chop target**: The **Session** or **Ordinary worktree** selected for one **Chop** operation.

## Navigation and review

**Swing target**: A **Source checkout**, **Session worktree**, or **Ordinary worktree** selected for navigation.

**Swing picker**: The interactive choice among existing **Swing targets** of the invoking checkout's repo.

**Previous Swing target**: The checkout recorded as the departure point of the last **Swing** between distinct checkouts of a repo.

**Diff source**: The Git comparison requested by one **Diff**, identifying working-tree changes, a commit, a branch comparison, a commit range, a pull request, or a merge request.

**Diff adapter**: The selected way a **Diff** is presented, either through a local application or through a browser review identified by a **Diff link**.

**Diff link**: The canonical URL supplied by a browser-based **Diff adapter** for one review.

**Diff base**: The Git revision used as the committed comparison point for **Diff**.

**Diff picker**: The interactive choice of a **Diff base** or local changes only.

**Codex workspace launch**: Opening a checkout as a Codex workspace alongside **Spawn** or **Swing**.

**Shell adapter**: The shell integration that applies monke-tools navigation to the user's current shell.

**Active shell adapter**: A **Shell adapter** participating in the current command invocation.

**Shell directory request**: A request to move the user's current shell to a resolved checkout.

**Shell directory directive**: The destination passed to a **Shell adapter** for one **Shell directory request**.

**Shell integration install**: Configuration of a user's shell to load the **Shell adapter**.

**Shell integration init**: Provision of the **Shell adapter** for a supported shell.

## Relationships

- Each **Session** has one participating worktree per repo. **Worktree preparation** can complete independently; **Repo materialization** depends on that repo's preparation and its dependencies' materialization.
- An incomplete **Materialization generation** retains completed work for resumption. A completed generation may be followed by another.
- A **Prepared worktree** alone creates no **Cleanup obligation**. Repos incur Cleanup obligations during materialization.
- **Spawn** places new Session worktrees under **Monke home**. **Worktree adoption** can record a Session worktree outside Monke home.
- A **Missing Session worktree** can still have a **Cleanup obligation**. Missing directories do not imply finalization.
- The **Shell adapter** applies a navigation request in the parent shell.
