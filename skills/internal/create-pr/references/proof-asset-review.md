# Proof Asset Review

The Evidence Gate decides whether a final screenshot or video is uploadable;
automated assertions and file-validity checks do not.

## Evidence Gate

1. List the views and states the diff changes and the behavior each carries.
   This list, not the assets already in hand, sets what the PR must show.
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

5. When an entry cannot be captured, write that where its asset would have gone.
   An unevidenced entry left silent reads as covered.

Completion criterion: every listed view and state has a passing asset or a
stated reason it has none, each asset's claim is directly visible in the
inspected upload candidate, and no rejection condition applies.
