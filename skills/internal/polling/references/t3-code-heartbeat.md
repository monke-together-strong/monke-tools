# Heartbeat for Codex inside T3 Code

Codex has no heartbeat tool inside T3 Code. `scripts/t3-heartbeat.ts` stands in: a detached process that sends `[polled]` into your T3 Code thread as a user message.

```bash
bun <skill-dir>/scripts/t3-heartbeat.ts start <minutes>   # create, or replace this thread's heartbeat
bun <skill-dir>/scripts/t3-heartbeat.ts stop              # remove it
```

- It finds your thread through `CODEX_THREAD_ID`, and needs full access: it reads `~/.t3/userdata` and connects to the local T3 Code server.
- Beats that land while a turn runs are skipped, so each `[polled]` starts a fresh turn.
- Failed beats retry with backoff. It ends on `stop`, reboot, five failed beats in a row, or after 7 days, when its token expires. Logs go to `$TMPDIR/t3-heartbeat/<thread-id>.log`.
- It relies on T3 Code internals. When `start` fails, report the error to the user and stop polling.
