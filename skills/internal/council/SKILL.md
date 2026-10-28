---
name: council
description: Get opinions on direction and approach from delegates on different providers.
disable-model-invocation: true
---

# Council

Bring in delegates for opinions on the user's request, usually on its
direction and approach. Use one strong model from each of three different
providers, at high reasoning effort. If the user's instructions name council
members, use those. Otherwise pick the latest flagship model from each
provider, for example Claude Opus, GPT Sol, and Gemini Pro.

In T3 Code, use `orchestrator_capabilities` to resolve the models, then
`delegate_task` to start one delegate per model in parallel. Elsewhere, use
the harness's subagent tools. When only two providers are available, convene a
two-member council and name the missing one. If a named member is unavailable,
report it instead of substituting.

Give each delegate the same brief: the request, relevant context, and the
options in play, stated neutrally and with your own preference held back, so
their opinions stay independent. Keep their work read-only. Collect their
responses and summarize the useful opinions, disagreements, and recommended
next steps.

If you agree with their recommendations, revise the direction and ask them
again. Continue until all delegates are satisfied with it.

Do not let repeated rounds result in scope creep. It is your job to fight to
keep scope limited.
