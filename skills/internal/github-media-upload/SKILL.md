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

Use Markdown references for assets in the body. Put a video reference such as
`![](./demo.mp4)` in its own paragraph for inline playback.

Supported formats: PNG, JPEG, GIF, WebP, SVG, MP4, MOV, and WebM. Images are limited
to 10 MB; videos to 10 MB on Free plans or 100 MB on paid plans. Prefer H.264 MP4
for browser compatibility.

If some uploads failed, check the published body before retrying. Retry only
the failed files on the existing item.
