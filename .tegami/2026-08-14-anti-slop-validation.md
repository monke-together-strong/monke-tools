---
subject: Enable anti-slop validation
packages:
  "@monke-together-strong/oxc-config": patch
---

## Broader shared validation

Compose Ultracite's anti-slop preset into the shared Oxlint configuration so consumers catch type
widening, unsafe boundary handling, and unsupported type assertions alongside the existing core and
Vitest rules. Upgrade Ultracite to 7.10.4.
