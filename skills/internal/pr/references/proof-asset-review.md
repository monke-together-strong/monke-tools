# Review proof assets

1. List every changed view and state and the behavior the reviewer should see.
2. Map each asset to the entries it proves, then inspect the exact final file
   that will be uploaded.
   - Screenshot: inspect at original resolution.
   - Video: inspect frames across the full timeline, then watch the complete
     playback when motion, timing, or transitions carry the claim.
3. Confirm the claimed action and result are visible, unambiguous, and readable.
4. Reject and regenerate an asset when it shows any of these:
   - the claimed behavior is absent, cropped, ambiguous, or only implied
   - a blank, loading, stale, failed, or transitional state contradicts the
     claim
   - an error, warning, broken layout, or unrelated behavior would mislead a
     reviewer
   - sensitive content is visible
   - the final state appears too briefly to evaluate

5. Before publishing, account for every listed view and state with an inspected,
   passing asset or a reason it could not be captured.
