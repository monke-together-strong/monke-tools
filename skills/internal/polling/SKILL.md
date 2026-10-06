---
name: polling
description: Poll external waits with T3 schedules when no native watch or completion notification is available.
---

# Polling

Use this loop when work reaches an external wait. Prefer native watches or
completion notifications when available.

Use `schedule_task` to set up a poller in this thread.

## Loop

1. Calculate the next useful observation time. Use the configured interval by
   default. When the source gives a reliable not-before timestamp later than
   that interval and no other condition needs an earlier check, schedule the
   next check for that boundary, then resume the configured interval from
   that check.
2. Start the poller, then end the turn.
3. On each scheduled run, check the condition once if the wait is still active.
4. If still waiting, leave the schedule running and end the turn.
5. If there is work to do, delete the schedule, do the work, then return to step 1.
6. If done or cancelled, delete the schedule and finish.
