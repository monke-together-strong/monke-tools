# Team coding baseline

## General

- Change a shared contract only for a caller that needs it. Making a private member public, changing a shared base class, and adding a parameter to a shared helper all count.
- Name an exported symbol so it reads correctly where it is imported, without its file for context. The name claims only what the code guarantees, and one name keeps one meaning.
- Scripts and one-off tooling adapt to production code. Do not add a wrapper, alternate implementation, optional dependency, or fallback to production code only so a script can run.

## TypeScript

- Prefer inferred return types. Annotate only when required for a contract or correct inference.
- Fix type and lint issues at the abstraction that owns the behavior. Avoid duplicating data structures or logic to satisfy a check. Types must describe what the implementation guarantees, including changes made by transformations.
- Do not hand-roll reusable generic type guards, assertion helpers, mapped or conditional utility types, type-shaping interfaces, or typed wrappers around standard-library operations. Use built-in TypeScript utilities when they express the intent. Otherwise prefer `@sindresorhus/is` for runtime type predicates and assertion functions, `type-fest` for common data types and type utilities, and `ts-extras` for strongly typed built-ins, property and collection narrowing, nullish guards, and exhaustiveness checks. Check the `preferred-libraries` registry before implementing a generic utility. Create a thin wrapper only when no direct equivalent provides the required behavior.
- Use `ok(...)` from `node:assert/strict` for internal boolean invariants
  that lack a more specific assertion.
- Use a Standard Schema-compatible validation library (such as `zod`) for complete validation of untrusted payloads, persisted data, configuration, and external responses.
- Follow non-conflicting rules in the [Ultracite coding standards](../imported/ultracite/references/code-standards.md).
- Use `try/catch` only for meaningful handling, cleanup, logging, fallback, or preserving `cause`, never only to rethrow.
