---
name: auto-wayfinder
description: Advance a Wayfinder map until human input is needed or the map is complete.
disable-model-invocation: true
---

# Auto Wayfinder

Run `/wayfinder <mapLink>` as usual.

After each Wayfinder turn, open exactly one new thread with `/auto-wayfinder <mapLink>` if and only if wayfinder for that turn was done - the ticket is closed, no human input is pending, and the map has an unblocked, unclaimed frontier. Then finish.
