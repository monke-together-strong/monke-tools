---
name: auto-wayfinder
description: Advance a Wayfinder map until human input is needed or the map is complete.
disable-model-invocation: true
---

# Auto Wayfinder

Run `/wayfinder` as usual, passing `<mapLink>` when one already exists.

After each Wayfinder turn, open exactly one new thread with `/auto-wayfinder <mapLink>` when no human input is pending, the map has an unblocked, unclaimed frontier, and either:

- the map was created this turn; or
- an existing-map turn closed its ticket.

Then finish.
