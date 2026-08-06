---
subject: Share JSDoc type validation
packages:
  "@monke-together-strong/oxc-config": patch
---

## Shared JSDoc validation

Load `eslint-plugin-jsdoc` through Oxlint's JavaScript-plugin compatibility layer and reject
undefined JSDoc types in every consumer while preserving consumer-provided plugins and rule
overrides.
