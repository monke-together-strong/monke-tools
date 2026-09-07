# Team Coding Standards Baseline

## Typescript
- Prefer inferred return types. Annotate only when required for a contract or correct inference.
- Fix type and lint issues at the abstraction that owns the behavior. Avoid duplicating data structures or logic to satisfy a check. Types must describe what the implementation guarantees, including changes made by transformations.
- Do not hand-roll reusable generic type guards, assertion helpers, mapped or conditional utility types, type-shaping interfaces, or typed wrappers around standard-library operations. Use built-in TypeScript utilities when they express the intent; otherwise prefer `@sindresorhus/is` for runtime type predicates and assertion functions, `type-fest` for common data types and type utilities, and `ts-extras` for strongly typed built-ins, property and collection narrowing, nullish guards, and exhaustiveness checks. Check the `preferred-libraries` registry before implementing a generic utility. Create a thin wrapper only when no direct equivalent provides the required behavior.
- Prefer `@sindresorhus/is` assertions when one expresses the invariant. Use `ok(...)` from `node:assert/strict` for arbitrary internal boolean invariants that do not have a more specific assertion.
- Use a Standard Schema-compatible validation library (e.g. zod) for complete validation of untrusted payloads, persisted data, configuration, and external responses.
- Follow non-conflicting rules in the [Ultracite coding standards](../imported/ultracite/references/code-standards.md).
- Do not wrap code in `try/catch` just to rethrow; use `try/catch` only for meaningful handling, cleanup, logging, fallback, or preserving `cause`.
