---
name: polling
description: Poll external waits with a background watcher or a recurring `[polled]` heartbeat. Use when another skill or workflow must monitor asynchronous work without short-polling. Don't use to wait for native subagents.
---

# Polling

Use this loop when work reaches an external wait (don't use to wait for native subagents).

## Wakes

Each wait gets exactly one wake. Keep context and instructions in the thread, not in the wake.

- **Watcher**: Claude's default when a shell command can observe the wait. Run
  it with `run_in_background`: it checks about once a minute and exits when the
  observed state changes. Any exit wakes you, including a timeout or crash.
- **Heartbeat**: a recurring timer whose prompt is exactly `[polled]`. Codex
  always uses one; Claude uses one only when no command can observe the wait.
  Claude uses `CronCreate`. Codex uses a heartbeat automation, or T3 Code's
  `schedule_task` (interval schedule; remove with `delete_scheduled_task`);
  without either, read [references/t3-code-heartbeat.md](references/t3-code-heartbeat.md).

## Loop

1. Calculate the next useful observation time. Use the configured interval by
   default. When the source gives a reliable not-before timestamp later than
   that interval and no other condition needs an earlier check, schedule the
   next heartbeat for that boundary, then resume the configured interval from
   that wake. A watcher sleeps until that boundary before its first check.
2. Arm the wake, then end the turn.
3. On a wake (watcher exit or `[polled]`), check the condition once.
4. If still waiting, end the turn: re-arm a watcher; leave a heartbeat running.
5. If there is work to do, remove the wake, do the work, then return to step 1.
6. If done, remove the wake and finish.
