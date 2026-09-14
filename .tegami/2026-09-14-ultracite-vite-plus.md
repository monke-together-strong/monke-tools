---
subject: Update Ultracite and align Oxc with Vite+
packages:
  "@monke-together-strong/oxc-config":
    type: minor
---

## Update Ultracite and Oxc compatibility

Upgrade Ultracite from 7.10.8 to 7.11.1. Require Oxlint ^1.82.0 and Oxfmt ^0.67.0 so the shared presets use the rule names and formatter configuration types shipped with Vite+ 0.3.2. Existing shared rule overrides remain in place.
