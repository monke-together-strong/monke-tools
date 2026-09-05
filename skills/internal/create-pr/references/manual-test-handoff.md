# Manual-Test Handoff

Start the app from the PR worktree using its documented command. Verify the
changed route or endpoint responds and leave the app running for the handoff.

In the final response, give the smallest set of reproducible steps covering the
changed behavior. Use direct links for a UI and copyable requests for an API;
state the action and expected result for each. Include any required fixture or
access setup, and a backing file path when the test involves editing that file.

```markdown
## Manual Testing

- [Selected-file reveal](http://localhost:4312/f/fixture/index.md) — Follow
  **Relative Target**; its folder opens and the selected file scrolls into view.
- [Live Markdown update](http://localhost:4312/f/fixture/fresh-view.md) — Edit
  [fresh-view.md](/path/to/fresh-view.md); the open page updates.
```

The handoff is complete when the target is responding and each supplied step
has been exercised with its expected result. If unavailable, report the reason;
required proof is still governed by [Choose the evidence](../SKILL.md#choose-the-evidence).
