# Testing standards

## Tests

- Apply [principle-test-behavior-not-implementation](../../imported/principle-test-behavior-not-implementation/SKILL.md)
  to every candidate.
- Before adding a test, look for existing coverage, including tests that reach the code through its callers. Extend an existing test or table instead of adding a near-duplicate.
- Test at an existing seam when one reaches the behavior. Add a new seam only when none does, as high as possible. Keep the number of seams small.
- Match the structure, helpers, and fixtures of similar tests in the codebase.
- Negative controls must fail at the intended guard, next to a case the guard accepts. Assert absence only where the absent value or effect could otherwise appear.
- No test-only production code: exports, `if (isTest)` branches, injection parameters, env vars, or routes that exist only for tests. If deleting the tests would leave that code with no caller, test through the real entry point instead.
- Skip a test rather than write a weak one. Weak tests check mocks, freeze implementation details, depend on timing, or need heavy setup to cover a small fix.

## Junk patterns

Reject new matches unless the [retention bar](#retention-bar) identifies an independent contract. Audit existing matches:

- Assertion-free probes, self-comparisons, identity copiers, and subject-generated expected values.
- Copied inventories, manifests, or export lists, and exact source, import, or string greps.
- Private predicate or call-shape tests that duplicate boundary proof, and repeated invocations of shared helpers.
- Mocks implementing asserted behavior or pretending distinct APIs match.
- Fixtures supplying receipts, admission, or callback ordering that the owner should produce.
- Persistence asserted against a store path that the code under test never writes.
- Capability flags asserted instead of promised delivery or acknowledgment.
- Test names that promise behavior the inputs and assertions never exercise.

## Retention bar

- Keep tests that independently guard a public API, SDK, protocol, config, migration, storage, security, platform, default, prompt-byte, generated cross-language, package, release, or architecture contract. Keep tests of observable ordering and of credible regressions.
- A source-inspection test is valid when it is the cheapest independent guard of a user-facing key, byte, or path, and it survives identifier-only refactoring.
- Being static or slow is not a reason to delete a test. A failing test on the base branch may expose a product bug. Reproduce it and repair the owning code instead of deleting the test.
