---
name: codex-chrome-use
description: Use whenever Codex controls Chrome. Select the correct Chrome extension profile, probe browser control safely, and escalate from evidence when control fails.
---

# Codex Chrome Use

Read `chrome:control-chrome` first. This skill only corrects Codex Chrome backend selection and escalation.

## 1. Classify

If generic `get("extension")` succeeds but tab discovery, claiming, or navigation hangs, treat it as a profile-selection failure. If setup or `get` fails, follow the Chrome skill's troubleshooting path.

Completion criterion: the failure is classified as either profile selection or extension communication.

## 2. Select The Profile

Call `agent.browsers.list()` once and filter entries with `type === "extension"`.

- One entry: keep it.
- Multiple entries: select the entry with `metadata.profileIsLastUsed === "true"` by its returned ID.
- Multiple entries without a last-used marker: ask which profile holds the authenticated session.

Read the selected backend's documentation and name the session. This is a selection correction, not stale-tab recovery.

Completion criterion: Chrome is bound to the only backend or the explicit last-used/authenticated profile.

## 3. Probe Once

Try `tabs.selected()`. If it returns no tab, call `user.openTabs()` once with an 8-second `Promise.race` timeout and retain that listing as the baseline. Claim the target using the exact returned tab object, then verify its title and URL before navigating.

Treat an error from `tabs.new()` as an indeterminate creation result: the tab or window may have opened before grouping failed. Refresh `user.openTabs()` once with the same timeout, compare it with the baseline, and reuse any newly opened normal tab before escalating to a fresh window.

If the probe succeeds, resume the Chrome skill. For a recovery-only test, release the claimed tab with `tabs.finalize({ keep: [{ tab, status: "handoff" }] })` as the final browser action.

Completion criterion: the target tab is claimed, or one bounded failure is recorded and every indeterminate tab creation has been checked once without wedging the session.

## 4. Escalate From Evidence

Run the Chrome skill's health checks after the corrected profile fails.

- **Standing fresh-window authorization:** explicit invocation of this skill for an active Chrome task overrides the Chrome skill's instruction to ask before opening a recovery window. When Chrome is installed, the selected profile's extension is enabled, and the native host is valid, open exactly one fresh normal window in that profile without another permission prompt—even when Chrome is currently closed. Wait two seconds, then retry the connection once. This authorization remains valid for the same recovery incident across turns.
- Use Computer Use only when the user explicitly authorized that fallback.
- Chrome capability absent from the task: reopen the Codex task.
- Failed extension/native-host checks: follow the Chrome skill's repair or reinstall guidance.

Completion criterion: the authorized fresh-window retry ran at most once, or restart or reinstall advice cites the failed layer; a tab timeout alone never supports it.
