---
name: council
description: Get opinions on direction and approach from delegates on different providers.
disable-model-invocation: true
---

# Council

Bring in delegates for opinions on the user's request, usually on its
direction and approach. If the user's instructions name council members, use
those. Otherwise convene:

- Claude Opus 5.5 (`xhigh`)
- Codex GPT-6.1 Sol (`xhigh`)

In T3 Code, use `orchestrator_capabilities` to resolve the models, then
`delegate_task` to start one delegate per model in parallel. Elsewhere, use
the harness's subagent tools. If a member is unavailable, report it instead of
substituting.

Give each delegate the same brief: the request, relevant context, and the
options in play, stated neutrally and with your own preference held back, so
their opinions stay independent. Keep their work read-only. Collect their
responses and summarize the useful opinions, disagreements, and recommended
next steps.

If you agree with their recommendations, revise the direction and ask them
again. Continue until all delegates are satisfied with it.

Do not let repeated rounds result in scope creep. It is your job to fight to
keep scope limited.
