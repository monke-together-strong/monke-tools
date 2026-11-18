## Typescript
- Prefer inferred return types. Annotate only when required for a contract or correct inference.
- Fix type and lint issues at the abstraction that owns the behavior. Avoid duplicating data structures or logic to satisfy a check. Types must describe what the implementation guarantees, including changes made by transformations.
- Use built-in TypeScript utilities when they fit. Otherwise, check the
  `preferred-libraries` skill's data and utilities section before adding a
  generic utility. Write a local wrapper only when existing utilities lack the
  required behavior.
- Use `ok(...)` from `node:assert/strict` for internal boolean invariants
  that lack a more specific assertion.
- Use a Standard Schema-compatible validation library (e.g. zod) for complete validation of untrusted payloads, persisted data, configuration, and external responses.
- Follow non-conflicting rules in the [Ultracite coding standards](../imported/ultracite/references/code-standards.md).
- Do not wrap code in `try/catch` just to rethrow; use `try/catch` only for meaningful handling, cleanup, logging, fallback, or preserving `cause`.
