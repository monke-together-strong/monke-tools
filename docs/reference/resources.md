# Checkout resources

Part of the [domain glossary](../../GLOSSARY.md).

## Language

**Checkout resource**: A deterministic value or acquired allocation owned by one **Source checkout** or **Session worktree**.

**Resource value**: A configured, deterministic value retained for its owning checkout.

**Resource command**: A repo-defined provider that acquires a checkout's allocation and can release it.

**Resource command output**: A named value returned by resource acquisition and retained until release.

**Cleanup command**: A repo-defined operation for **Session** infrastructure teardown after resource release.

## Relationships

- Resources are independent across the worktrees in a **Session**.
- A **Resource value** exists independently of live acquisition. A **Resource command output** represents an acquired allocation.
- Releasing an allocation ends its ownership obligation. Release preserves the checkout and its deterministic values.
- Resource release precedes **Cleanup commands** during Session removal.
