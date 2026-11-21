---
name: council
description: Get opinions on direction and approach from delegates on different providers.
disable-model-invocation: true
---

# Council

Bring in delegates for opinions on the user's request, usually on its
direction and approach. If the user's instructions name council members, use
those. Otherwise convene:

- Claude Opus 5.5 (`claude-opus-5-5`, `xhigh`)
- Codex GPT-6.2 Sol (`gpt-6.2-sol`, `xhigh`)
- Gemini 4 Neon (`gemini-4-neon`, `xhigh`)

In T3 Code, use `orchestrator_capabilities` to resolve the models, then
`delegate_task` to start one delegate per model in parallel. Elsewhere, use
the harness's subagent tools. If a member is unavailable, report it instead of
substituting.

Give each delegate the same brief: the request, relevant context, and the
options in play. State it neutrally and hold back your own preference so their
opinions stay independent. Keep their work read-only.

Collect their responses. When you agree with their recommendations, revise the
direction and ask them again until all delegates are satisfied or only
user-level disagreements remain. Summarize the useful opinions, remaining
disagreements, and recommended next steps.

Hold the request's scope fixed across rounds. Push back on delegate proposals
that add work the request does not need.
