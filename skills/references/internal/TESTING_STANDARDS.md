## Tests
- Keep a test only if it fails when the behavior breaks and passes when only the internals change. See [principle-test-behavior-not-implementation](../../imported/principle-test-behavior-not-implementation/SKILL.md).
- Before adding a test, look for existing coverage, including tests that reach the code through its callers. Extend an existing test or table instead of adding a near-duplicate.
- Test at an existing seam when one reaches the behavior. Add a new seam only when none does, as high as possible; fewer seams is better.
- Follow prior art: match the structure, helpers, and fixtures of similar tests in the codebase.
- Negative controls must fail at the intended guard, next to a case the guard accepts. Assert absence only where the thing could still appear.
- No test-only production code: exports, `if (isTest)` branches, injection parameters, env vars, or routes that exist only for tests. If deleting the tests would leave that code with no caller, test through the real entry point instead.
- Skip a test rather than write a weak one. Weak tests check mocks, freeze implementation details, depend on timing, or need heavy setup to cover a small fix.

## Junk patterns
Reject new matches unless the [retention bar](#retention-bar) identifies an independent contract. Audit existing matches:
- Assertion-free probes, self-comparisons, identity copiers, subject-generated expected values.
- Copied inventories/manifests/export lists; exact source/import/string greps.
- Private predicate/call-shape tests duplicating boundary proof; repeated invocations of shared helpers.
- Mocks implementing asserted behavior or pretending distinct APIs match.
- Fixtures supplying receipts, admission, callback ordering the owner should produce; persistence asserted against a store path it never writes.
- Capability flags asserted instead of promised delivery/acknowledgement.
- Names promising behavior inputs/assertions never exercise.

## Retention bar
- Keep tests that independently guard a public API, SDK, protocol, config, migration, storage, security, platform, default, prompt-byte, generated cross-language, package, release, or architecture contract. Keep tests of observable ordering and of credible regressions.
- A source-inspection test is valid when it is the cheapest independent guard of a user-facing key, byte, or path, and it survives identifier-only refactoring.
- Being static or slow is not a reason to delete a test. A failing test on the base branch may expose a product bug: reproduce it and repair the owning code instead of deleting the test.
