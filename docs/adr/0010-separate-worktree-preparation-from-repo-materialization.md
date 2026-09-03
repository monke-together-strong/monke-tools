# Separate worktree preparation from repo materialization

The accepted lifecycle models Spawn and Materialize with a preparation node and a repo-materialization node for every participating repo. All preparation starts independently, while a repo may materialize only after its own preparation and every dependency materialization completes.

Worktree preparation is bounded and independently scheduled for Spawn and Materialize. Preparation creates or validates the worktree, carries permitted dirty state, and non-clobberingly fills missing env files and configured Seed material. Repo materialization is also bounded: ready siblings may run concurrently, but each repo waits for its preparation and every direct dependency materialization. Failures block only descendants, and the operation reports after all remaining runnable work settles.

Preparation guarantees only that its best-effort copy operation completed. It does not provide an atomic snapshot when another process changes Source checkout files during the copy.

Strict v2 Session state records preparation, one retained Materialization generation, repo outcomes, pinned default-branch identity, and Cleanup eligibility. One state owner serializes checkpoints while graph work runs concurrently. Failed generations resume incomplete repos and reuse successful materializations; Materialize starts a fresh generation after completion. Cleanup runs repo commands only for repos that crossed their persisted external-effect checkpoint.
