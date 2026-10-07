# Browser Video Proof

Produce an MP4 showing the changed workflow and its successful end state.

## Preferred Path: Playwright Video

Use Playwright when the workflow can be scripted deterministically.

1. Reuse the running manual-test target, or start the app from the PR worktree.

   Completion criterion: the target URL is reachable.

2. Create a clean browser context with video recording.

   ```ts
   const context = await browser.newContext({
     recordVideo: {
       dir: proofDir,
       size: { width: 1280, height: 720 },
     },
   });
   ```

   Completion criterion: the context is isolated from the user's normal browser
   state.

3. Drive the workflow and assert the successful end state.

   ```ts
   const page = await context.newPage();

   await page.goto(targetUrl);
   await page.getByRole("button", { name: "Continue" }).click();

   await expect(page.getByText("Success")).toBeVisible();
   ```

   Completion criterion: URL, text, role, or state assertions prove the final
   state before recording ends.

4. Close the context to flush the video.

   ```ts
   const video = page.video();
   await context.close();
   const webmPath = await video?.path();
   ```

   Completion criterion: a `.webm` file exists and has nonzero duration.

5. Validate the video encoding.

   ```bash
   ffprobe -hide_banner "$webmPath"
   ```

   Completion criterion: the file reports duration, resolution, and a valid
   video stream.

6. Convert to MP4 before uploading to GitHub.

   Playwright records WebM. GitHub previews MP4 more reliably.

   ```bash
   ffmpeg -y \
     -i "$webmPath" \
     -c:v libx264 \
     -pix_fmt yuv420p \
     -movflags +faststart \
     -an \
     proof.mp4
   ```

   Completion criterion: `ffprobe -hide_banner proof.mp4` reports H.264 video in
   an MP4 container.

Deliverable: the final MP4 path, ready for visual inspection.
