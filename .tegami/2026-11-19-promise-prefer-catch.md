---
packages:
  "@monke-together-strong/oxc-config": patch
---

### Allow two-handler `.then(ok, err)`

Disable `promise/prefer-catch`. `.then(ok, err)` and `.then(ok).catch(err)` are not equivalent: the `.catch` also receives failures thrown by `ok`, so the rule pushed deliberate two-handler code toward a behavior change. Oxlint offers no fix for the two-handler form for that reason. Replace `oxlint-disable` and `eslint-disable` comments for `promise/prefer-catch` with plain comments when you upgrade.
