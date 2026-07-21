---
name: codex-chrome-use
description: Recover Codex Chrome control when browser operations hang while Chrome remains open, or when multiple Chrome extension profiles are available.
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

Try `tabs.selected()`. If it returns no tab, call `user.openTabs()` once with an 8-second `Promise.race` timeout. Claim the target using the exact returned tab object, then verify its title and URL before navigating.

If the probe succeeds, resume the Chrome skill. For a recovery-only test, release the claimed tab with `tabs.finalize({ keep: [{ tab, status: "handoff" }] })` as the final browser action.

Completion criterion: the target tab is claimed, or one bounded failure is recorded without wedging the session.

## 4. Escalate From Evidence

Run the Chrome skill's health checks after the corrected profile fails.

- Healthy Chrome, extension, and native host: request a fresh same-profile window, or use Computer Use only when the user explicitly authorized that fallback.
- Chrome capability absent from the task: reopen the Codex task.
- Failed extension/native-host checks: follow the Chrome skill's repair or reinstall guidance.

Completion criterion: restart or reinstall advice cites the failed layer; a tab timeout alone never supports it.
