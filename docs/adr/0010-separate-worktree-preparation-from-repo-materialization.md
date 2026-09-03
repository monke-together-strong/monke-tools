# Separate worktree preparation from repo materialization

The accepted lifecycle models Spawn and Materialize with a preparation node and a repo-materialization node for every participating repo. All preparation starts independently, while a repo may materialize only after its own preparation and every dependency materialization completes.

The first implementation slice establishes bounded, independently scheduled Worktree preparation shared by Spawn and Materialize. Preparation creates or validates the worktree, carries permitted dirty state, and non-clobberingly fills missing env files and configured Seed material. All preparation attempts settle before an error is returned, and dependency bootstrap failure does not remove already prepared worktrees. Dependency ordering remains authoritative for ports, env rewrites, resources, and repo commands.

Preparation guarantees only that its best-effort copy operation completed. It does not provide an atomic snapshot when another process changes Source checkout files during the copy.

Later implementation slices add dependency-graph failure propagation, retained Materialization generations, Cleanup eligibility checkpoints, receipts, and the intentional v2 state cutover. Those decisions remain part of the accepted target architecture but are not behavior provided by this slice.
