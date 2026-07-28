---
packages:
  "@monke-together-strong/oxlint-config": minor
---

## Apply practical TypeScript and test lint policy

The shared preset now includes Ultracite's Vitest rules, permits sequential awaits and multiple
expectations in behavior tests, supports explicit `undefined` arguments in TypeScript APIs, and
avoids false positives for standard Promise and callback patterns. Hoisted function declarations
remain allowed while other uses before definition are checked. Static `RegExp` constructors remain
available for patterns where literals conflict with control-character linting. Promise-returning
functions may remain non-async when adding `async` would be redundant or change error behavior.

Mixed-framework repositories can use `createOxlintConfig` to apply framework-neutral policy to
complete test trees while excluding Playwright or other framework-owned paths from Vitest rules.
The factory accepts ordinary Oxlint config fields and composes extensions, ignores, overrides, and
rules without manual spreads. The existing default export retains broad Vitest conventions for
Vitest-only repositories. Consumers now provide Oxlint directly instead of installing Vite+ solely
for the preset's configuration types.
