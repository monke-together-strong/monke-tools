# Checkout resources

Part of the [domain glossary](../../CONTEXT.md).

## Language

**Checkout resource**: A deterministic value or acquired allocation owned by one **Source checkout** or **Session worktree**.

**Resource value**: A configured, deterministic value retained for its owning checkout.

**Resource command**: A repo-defined provider of dynamic allocations and their release behavior.

**Resource command output**: A value returned by acquisition and retained until its allocation is released.

**Cleanup command**: A repo-defined operation for **Session** infrastructure teardown after resource release.

## Relationships

- Each **Checkout resource** has one owning checkout. Resources are independent across the worktrees in a **Session**.
- A **Resource value** exists independently of live acquisition. A **Resource command output** represents an acquired allocation.
- Releasing an allocation ends its ownership obligation; it preserves the checkout and its deterministic values.
- Resource release precedes **Cleanup commands** during Session removal.
