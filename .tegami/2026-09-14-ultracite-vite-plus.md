---
subject: Update Ultracite and align Oxc with Vite+
packages:
  "@monke-together-strong/oxc-config":
    type: minor
---

## Update Ultracite and Oxc compatibility

Upgrade Ultracite from 7.10.8 to 7.11.1. Require Oxlint ^1.82.0 and require Oxfmt 0.70.0 or newer, matching the minimum bundled with Vite+ 1.0 and allowing future versions. Build the formatter preset against Oxfmt 0.70.0. Existing shared rule overrides remain in place.
