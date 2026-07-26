---
packages:
  "@monke-together-strong/oxlint-config": minor
---

## Apply practical TypeScript and test lint policy

The shared preset now includes Ultracite's Vitest rules, permits sequential awaits and multiple
expectations in behavior tests, supports explicit `undefined` arguments in TypeScript APIs, and
avoids false positives for standard Promise and callback patterns. Hoisted function declarations
remain allowed while other uses before definition are checked.
