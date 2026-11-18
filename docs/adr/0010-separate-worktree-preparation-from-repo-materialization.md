# Separate worktree preparation from repo materialization

Spawn and Materialize schedule worktree preparation independently for every repo.
Each repo's materialization waits for its own preparation and for every direct
dependency to materialize. Both stages limit concurrency. Failures block
dependent materialization, and the operation reports after all runnable work
settles.

Preparation guarantees only that its best-effort copy operation completed. It does not provide an atomic snapshot when another process changes Source checkout files during the copy.

One owner serializes Session state checkpoints while graph work runs concurrently.
A failed Materialization generation resumes incomplete repos and reuses successful
materializations. Materialize starts a fresh generation after completion. Cleanup
runs repo commands only for repos that crossed their persisted external-effect
checkpoint.
