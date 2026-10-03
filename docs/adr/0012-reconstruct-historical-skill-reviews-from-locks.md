# Reconstruct historical skill reviews from locks

With imported guidance generated into ignored directories, ordinary Git and GitHub PR diffs will show changes to the tracked skill lock rather than the imported files. Complete historical content review will reconstruct the guidance identified by two committed locks into one separate local snapshot repository, opened through `mt diff` in desktop Codiff or LFV. This keeps imported content out of monke-tools' future source history while preserving one complete comparison across all skills and their supporting files; a full content diff on GitHub is not required.

The reusable review cache retains at most three complete comparisons and automatically reclaims older snapshots. Eviction invalidates the evicted comparison's existing review window or link; a new historical review can be reconstructed when its source content is available. This favors bounded storage over preserving every review session indefinitely.
