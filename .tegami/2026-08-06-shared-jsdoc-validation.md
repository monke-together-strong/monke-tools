---
subject: Strengthen shared Oxlint validation
packages:
  "@monke-together-strong/oxc-config": patch
---

## Stronger shared validation

Load `eslint-plugin-jsdoc` through Oxlint's JavaScript-plugin compatibility layer and reject
undefined JSDoc types in every consumer while preserving consumer-provided plugins and rule
overrides. Reject console calls and direct environment access, and require explicit module boundary
types across consumers. Replace Ultracite's `sort-keys` rule with comment-aware Perfectionist
sorting.
