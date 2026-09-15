---
name: polling
description: Poll external waits with a recurring `[polled]` heartbeat. Use when another skill or workflow must monitor asynchronous work without short-polling. Don't use to wait for native subagents.
---

# Polling

Use this loop when work reaches an external wait (don't use to wait for native subagents):

1. Calculate the next useful observation time. Use the configured interval by
   default. When the source gives a reliable not-before timestamp later than
   that interval and no other condition needs an earlier check, schedule the
   next heartbeat for that boundary, then resume the configured interval from
   that wake.
2. Ensure exactly one recurring heartbeat on that schedule. Set it's prompt to exactly `[polled]`.
   Do not append context or instruction; retain those in the thread. Then end turn.
3. On `[polled]` message, check the condition once.
4. If still waiting, end the turn. Leave the heartbeat running.
5. If there is work to do, remove the heartbeat, do the work, then return to
   step 1.
6. If done, remove the heartbeat and finish.
