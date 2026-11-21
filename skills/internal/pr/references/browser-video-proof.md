# Browser video proof

Produce an H.264 MP4 showing the changed workflow and its successful end state, ready for visual inspection.

Use Playwright when the workflow can be scripted deterministically:

1. Reuse the running manual-test target, or start the app from the PR worktree and confirm the target URL responds.
2. Record in a fresh context isolated from the user's browser state, assert the end state before closing, and flush the `.webm` recording:

   ```ts
   const context = await browser.newContext({
     recordVideo: {
       dir: proofDir,
       size: { width: 1280, height: 720 },
     },
   });
   const page = await context.newPage();

   await page.goto(targetUrl);
   await page.getByRole("button", { name: "Continue" }).click();
   await expect(page.getByText("Success")).toBeVisible();

   const video = page.video();
   await context.close();
   const webmPath = await video?.path();
   ```

3. Verify the `.webm` stream and convert it to MP4 (GitHub previews MP4 more reliably than WebM):

   ```sh
   ffprobe -hide_banner "$webmPath"
   ffmpeg -y \
     -i "$webmPath" \
     -c:v libx264 \
     -pix_fmt yuv420p \
     -movflags +faststart \
     -an \
     proof.mp4
   ffprobe -hide_banner proof.mp4
   ```

Done when `ffprobe` confirms H.264 video with nonzero duration in `proof.mp4`.
