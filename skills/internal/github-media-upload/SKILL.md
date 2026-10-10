---
name: github-media-upload
description: Upload images or videos to GitHub user-attachments and embed them in a PR, issue, or comment.
---

# GitHub media upload

Prerequisite: `gh` 2.99+ with an authenticated user and repository write access on
GitHub.com or Enterprise Cloud.

Use native `--attach` on `gh pr` or `gh issue` create, edit, and comment commands.

```bash
gh pr edit 123 --repo owner/repo --body-file /tmp/pr-body.md \
	--attach ./screenshot.png --attach ./demo.mp4
```

Local Markdown references are rewritten to uploaded URLs; unreferenced files are
appended. HTML image paths are not rewritten. A video reference such as
`![](./demo.mp4)` must stand alone in a paragraph to become a player.

Supported formats: PNG, JPEG, GIF, WebP, SVG, MP4, MOV, and WebM. Images are limited
to 10 MB; videos to 10 MB on Free plans or 100 MB on paid plans. Prefer H.264 MP4
for browser compatibility.

A partial upload failure can still publish successful attachments before exiting
nonzero. Retry only the failed files.
