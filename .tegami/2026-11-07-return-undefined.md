---
packages:
  "@monke-together-strong/oxc-config": patch
---

### Allow `return undefined` in optional-result functions

Disable `unicorn/no-useless-undefined`. When a function returns a value on some paths but not at its end, `noImplicitReturns` rejects falling off the end and `no-useless-return` rejects a final bare `return`. This rule rejected the remaining option, `return undefined`, unless the function annotated its return type. Remove `oxlint-disable` and `eslint-disable` comments for `unicorn/no-useless-undefined` when you upgrade.
