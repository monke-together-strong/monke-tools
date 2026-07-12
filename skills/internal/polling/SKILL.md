---
name: polling
description: Poll external waits with a recurring `[polled]` heartbeat. Use when another skill or workflow must monitor asynchronous work without short-polling.
---

# Polling

Use this loop when work reaches an external wait:

1. Ensure exactly one recurring heartbeat sends `[polled]` at the configured interval, then end the turn.
2. On `[polled]` message, check the condition once.
3. If still waiting, end the turn. Leave the heartbeat running.
4. If there is work to do, remove the heartbeat, do the work, then return to step 1.
5. If done, remove the heartbeat and finish.
