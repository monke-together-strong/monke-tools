---
packages:
  "@monke-together-strong/oxc-config": patch
---

### Align error parameter names with anti-slop

Configure `unicorn/catch-error-name` to require `cause`, matching anti-slop's existing exception for `cause: unknown`. Catch clauses and promise rejection callbacks now use the same name. Error helpers that accept `unknown` also use `cause`. This resolves the conflicting naming requirements without changing either rule's implementation.
