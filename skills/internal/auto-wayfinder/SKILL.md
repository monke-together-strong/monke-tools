---
name: auto-wayfinder
description: Advance a Wayfinder map until human input is needed or the map is complete.
disable-model-invocation: true
---

# Auto Wayfinder

Run `/wayfinder` as usual, passing `<mapLink>` when one already exists.

Resolve at most one ticket per thread. Wait here when human input is needed.

After creating a map or closing a ticket, hand off any unblocked, unclaimed frontier: open exactly one fresh thread with `$auto-wayfinder <mapLink>`, confirm dispatch, then finish this thread.
