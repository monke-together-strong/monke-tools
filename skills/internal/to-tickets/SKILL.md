---
name: to-tickets
description: Break a plan, Spec, or the current conversation into tracer-bullet tickets published as GitHub issues.
disable-model-invocation: true
---

Follow [Matt Pocock's base tickets workflow](../../references/imported/to-tickets/MAIN.md), with these overrides.

Instead of quizzing the user, have a subagent on the reviewer model (`mt models get reviewer`) review the breakdown's granularity and blocking edges. If the user names another model, use it instead. Apply the findings you agree with.

Publish without asking, to GitHub Issues with native relationships: `gh issue create --parent <source issue> --blocked-by <issue numbers> --label ready-for-agent`.
