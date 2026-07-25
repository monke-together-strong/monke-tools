# Proof Asset Review

The Evidence Gate decides whether a final screenshot or video is uploadable;
automated assertions and file-validity checks do not.

## Evidence Gate

1. Name the behavior each asset claims to prove from the work target and diff.
2. Inspect the exact final file that will be uploaded.
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

Completion criterion: each asset's named claim is directly visible in the
inspected upload candidate, and no rejection condition applies.
