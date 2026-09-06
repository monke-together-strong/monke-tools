---
subject: Disable noisy conditional empty object spread rule
packages:
  "@monke-together-strong/oxc-config": patch
---

Disable `anti-slop/no-conditional-empty-object-spread` so idiomatic conditional optional fields no longer produce lint errors.
