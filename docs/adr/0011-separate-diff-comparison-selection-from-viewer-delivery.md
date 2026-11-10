# Separate Diff comparison selection from viewer delivery

`mt diff` remains as the stable review entry point and selects a machine-local Diff adapter through `mt diff configure`, rather than becoming synonymous with desktop Codiff. Monke owns comparison selection and presentation orchestration; the selected viewer owns rendering and the review lifecycle.

The initial adapters use desktop Codiff and Monke See. Monke See owns its review CLI and canonical review URL; the Monke adapter passes the requested comparison to that CLI and prints the returned URL unchanged to stdout so callers and agents can relay it. Diagnostics remain on stderr. Monke does not reconstruct Monke See URLs, embed a second web viewer, or take over Monke See repository authorization and runtime configuration.

Explicit comparisons follow Codiff's source semantics, while no-target selection retains Monke's remembered-base behavior. Agents resolve historical questions to concrete Git revisions; Monke does not interpret natural-language date ranges.

Refresh behavior follows the requested source: working-tree comparisons and moving references show their current state when refreshed, while comparisons pinned to immutable commit IDs remain fixed. This does not imply automatic refresh.

Invoking Monke See's trusted local review CLI authorizes only the requested checkout for that review, without creating a persistent mount or exposing the entire Monke home. Monke See may start its already-installed, configured private viewer and returns the review URL only after it is ready. Review creation does not install software, change network exposure, or silently switch adapters.

Monke See owns review-link retention. Links remain usable for 24 hours after their last use, survive Monke See restarts, and are not invalidated merely by closing the browser.

There is no explicit `--watch` flag. PR reviews fetch newly pushed commits through the viewer's normal Refresh action, with no background PR polling.

Monke verifies adapter compatibility against the executable it invokes, not only Codiff's source parsers: the Codiff 1.14.0 desktop launcher rewrites commit ranges into ordinary ref selectors even though its native parser supports ranges. Invalid or unsupported explicit comparisons fail rather than silently select a different Diff source.
