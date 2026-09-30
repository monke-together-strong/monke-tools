# Separate Diff comparison selection from viewer delivery

The agreed target design keeps `mt diff` as the stable review entry point and selects a machine-local Diff adapter through `mt diff configure`, rather than making the command synonymous with desktop Codiff. Monke owns comparison selection and presentation orchestration; the selected viewer owns rendering and the review lifecycle.

Desktop Codiff is implemented; the LFV adapter remains planned in [#203](https://github.com/monke-together-strong/monke-tools/issues/203). This desktop slice does not complete [#199](https://github.com/monke-together-strong/monke-tools/issues/199).

The planned LFV adapter invokes LFV's review CLI and prints its canonical review URL unchanged to stdout so callers and agents can relay it. Diagnostics remain on stderr. Monke does not reconstruct LFV URLs, embed a second web viewer, or take over LFV repository authorization and runtime configuration.

Explicit comparisons follow Codiff's source semantics, while no-target selection retains Monke's remembered-base behavior. Agents resolve historical questions to concrete Git revisions; Monke does not interpret natural-language date ranges.

Refresh behavior follows the requested source: working-tree comparisons and moving references show their current state when refreshed, while comparisons pinned to immutable commit IDs remain fixed. This does not imply automatic refresh.

The LFV contract requires its trusted local review CLI to authorize only the requested checkout for that review, without creating a persistent mount or exposing the entire Monke home. LFV may start its already-installed, configured private viewer and must return the review URL only after it is ready. Review creation must not install software, change network exposure, or silently switch adapters.

LFV owns review-link retention. Its contract requires links to remain usable for 24 hours after their last use, survive LFV restarts, and not be invalidated merely by closing the browser.

There is no explicit `--watch` flag. PR reviews fetch newly pushed commits through the viewer's normal Refresh action, with no background PR polling.

## Desktop range-forwarding limitation

Stock Codiff 1.14 supports ordinary working-tree, commit, branch, and PR/MR commands without a custom fork. The packaged macOS shell launcher in 1.14.0 rewrites `main..feature` and `main...feature` into `--branch RANGE`; the native engine supports ranges, but that launcher does not forward them intact.

Only range plans need additional executable-level assurance. Monke checks the invoked launcher's `--help` for `--capabilities` and `desktop-source-v1` before requesting a version-1 capability response containing `range`. Version numbers or an upstream-only source sync do not establish safe range forwarding. Other source plans use the existing version check and public CLI arguments. Invalid comparisons and launch failures remain errors, never alternate comparisons. Monke does not install a parser shim or modify the user's Codiff installation.
