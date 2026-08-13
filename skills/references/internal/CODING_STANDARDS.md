# Team Coding Standards Baseline

## Typescript
- Inferred types over annotations
- Do not hand-roll reusable generic type guards, assertion helpers, mapped or conditional utility types, type-shaping interfaces, or typed wrappers around standard-library operations. Use built-in TypeScript utilities when they express the intent; otherwise prefer `@sindresorhus/is` for shallow runtime guards and assertions, `type-fest` for reusable type transforms, and `ts-extras` for strongly typed built-ins, nullish guards, and exhaustive checks. Check the `preferred-libraries` registry before implementing a generic utility. Create a thin wrapper only when no direct equivalent provides the required behavior.
- Prefer `@sindresorhus/is` assertions when one expresses the invariant. Use `ok(...)` from `node:assert/strict` for arbitrary internal boolean invariants that do not have a more specific assertion.
- Use a Standard Schema-compatible validation library (e.g. zod) for complete validation of untrusted payloads, persisted data, configuration, and external responses.
- Follow non-conflicting rules in the [Ultracite coding standards](../imported/ultracite/references/code-standards.md).
- Do not wrap code in `try/catch` just to rethrow; use `try/catch` only for meaningful handling, cleanup, logging, fallback, or preserving `cause`.
