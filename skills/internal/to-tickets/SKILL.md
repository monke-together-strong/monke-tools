---
name: to-tickets
description: Break a plan, spec, or the current conversation into tracer-bullet tickets published as GitHub issues.
disable-model-invocation: true
---

Follow [Matt Pocock's base tickets workflow](../../references/imported/to-tickets/MAIN.md), with these overrides.

Instead of quizzing the user, have a GPT 6.1 Sol subagent (unless the user names another model) review the breakdown's granularity and blocking edges. Apply the findings you agree with.

Publish without asking, to GitHub Issues with native relationships: `gh issue create --parent <source issue> --blocked-by <issue numbers> --label ready-for-agent`.
