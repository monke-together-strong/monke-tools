---
name: github-image-upload
description: Upload images or videos to GitHub user-attachments and embed them in a PR, issue, or comment.
license: MIT
---

# GitHub Media Upload

Use `gh image` to upload local images or videos to GitHub `user-attachments`.

Accepted in local testing: `.png`, `.jpg`, `.gif`, `.webp`, `.svg`, `.mp4`, `.mov`, `.webm`.

## Steps

1. Verify `gh` and `gh-image`.

   ```bash
   gh auth status
   gh extension list | grep -q 'drogers0/gh-image' || gh extension install drogers0/gh-image
   ```

   If `gh auth status` fails, stop and ask the user to run `gh auth login`.
   If `gh-image` setup needs manual help, use https://github.com/drogers0/gh-image.

2. Upload absolute paths.

   ```bash
   gh image "/abs/path/asset.png" --repo owner/repo
   ```

   Capture stdout. It prints one Markdown image per asset.

3. Embed the result.

   - For images, use the returned `![name](url)` markdown.
   - For videos, strip the image wrapper and embed the bare `https://github.com/user-attachments/assets/...` URL.
   - Use `--body-file -` when editing or commenting with `gh`.

4. Verify the target contains the uploaded URL.

   ```bash
   gh pr view <pr> --repo owner/repo --json body -q .body
   gh issue view <issue> --repo owner/repo --json body -q .body
   ```

## Notes

- `gh-image` needs a GitHub browser `user_session` cookie, `GH_SESSION_TOKEN`, or `--token`; a normal `gh` token is not enough for the upload endpoint.
- Private repo attachments return 404/403 to anonymous fetches; verify through the PR, issue, or comment instead.
- Text, data files, audio, PDFs, and ZIPs were rejected in local testing.
