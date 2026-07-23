# Manual-Test Handoff

Use this for a locally runnable UI or API.

Start the app from the PR worktree using its documented command. Open the link
to confirm it works and leave the app running.

In the final response, give 2–5 direct links to changed behavior. For each,
state what to do and what should happen. Include a backing file path only when
the test involves editing that file.

```markdown
## Manual Testing
- [Selected-file reveal](http://localhost:4312/f/fixture/index.md) — Follow
  **Relative Target**; its folder opens and the selected file scrolls into view.
- [Live Markdown update](http://localhost:4312/f/fixture/fresh-view.md) — Edit
  [fresh-view.md](/path/to/fresh-view.md); the open page updates.
```

If the app cannot be started, report `Unavailable: <reason>`.
