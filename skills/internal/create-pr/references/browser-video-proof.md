# Browser Video Proof

Use this when a PR changes a browser-visible workflow and the reviewer would
benefit from seeing the behavior run end-to-end.

## When To Record

Record video proof when the PR changes one of these:

- Auth, onboarding, navigation, redirects, or routing.
- Upload/download, drag/drop, keyboard shortcuts, or multi-step forms.
- UI state that is hard to trust from screenshots alone.
- A bug fix where the failure was visual, timing-sensitive, or workflow-shaped.

Prefer screenshots instead when one final visual state proves the change.

## Preferred Path: Playwright Video

Use Playwright when the workflow can be scripted deterministically.

1. Start the app under test.

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

   Completion criterion: the script proves the final state with URL, text, role,
   or state assertions before recording ends.

4. Close the context to flush the video.

   ```ts
   const video = page.video();
   await context.close();
   const webmPath = await video?.path();
   ```

   Completion criterion: a `.webm` file exists and has nonzero duration.

5. Verify the video artifact.

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

7. Upload the MP4 with `$github-image-upload`.

   Completion criterion: `$github-image-upload` returns a
   `https://github.com/user-attachments/assets/...` URL for the MP4.
