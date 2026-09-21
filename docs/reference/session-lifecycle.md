# Session lifecycle

Part of the [domain glossary](../../CONTEXT.md).

## Preparation and materialization

**Default branch spawn mode**: A **Spawn** mode whose starting content comes from each participating repo's default branch.

**Worktree preparation**: Creation or validation of one **Session worktree**, including its permitted source changes and **Seed material**.

**Prepared worktree**: A **Session worktree** whose preparation is complete but whose **Repo materialization** may still be pending. _Avoid_: Complete worktree, failed worktree

**Preparation warning**: A non-fatal preparation result identifying missing optional **Seed material**.

**Repo materialization**: Preparation of a repo's configured environment, dependencies, and resources for use within a **Session**.

**Blocked repo materialization**: Materialization that cannot begin because a dependency's materialization failed. _Avoid_: Failed materialization, cancelled materialization

**Materialization generation**: One retained attempt to materialize every repo in a **Session** dependency graph. _Avoid_: Command invocation, retry run

## Removal

**Cleanup eligibility**: A repo's retained obligation to run its **Cleanup command** before its **Session state** can be removed. _Avoid_: Prepared state, worktree existence

**Session finalization**: Completion of Session removal after its cleanup obligations are satisfied and all recorded worktrees are gone.

**Dead worktree**: A recorded **Session worktree** whose directory no longer exists.

**Merged PR**: A pull request accepted into its base branch through a recorded merge.

**Merge-cleanable Session**: A **Session** whose committed and local work is proven preserved and whose members all satisfy removal safety checks.

**Chop target**: The **Session** or **Ordinary worktree** selected for one **Chop** operation.

## Navigation and review

**Swing target**: A **Source checkout**, **Session worktree**, or **Ordinary worktree** selected for navigation.

**Swing picker**: The interactive choice among existing **Swing targets** within one **Root repo** scope.

**Previous Swing target**: The last different **Swing target** remembered for one **Root repo**.

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
- A **Prepared worktree** alone creates no cleanup obligation. **Cleanup eligibility** records obligations incurred during materialization.
- **Chop** selects a whole Session or one Ordinary worktree. Only Session removal includes **Session finalization**.
- A **Dead worktree** can still have cleanup obligations. Missing directories do not imply finalization.
- **Swing** changes the working location; **Diff** changes neither the checkout nor its branch. A **Shell adapter** connects navigation to the user's shell.
