---
subject: Update Ultracite and required Oxc versions
packages:
  "@monke-together-strong/oxc-config": minor
---

## Update Ultracite and required Oxc versions

Upgrade Ultracite from 7.10.4 to 7.10.8 so consumers inherit its updated core, anti-slop, Vitest, and formatting presets. Require Oxlint ^1.79.0 and Oxfmt ^0.64.0 to support the updated rules and configuration types. Existing shared rule overrides remain in place.
