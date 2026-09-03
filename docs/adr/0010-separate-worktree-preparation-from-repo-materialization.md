# Separate worktree preparation from repo materialization

Spawn and Materialize schedule a preparation node and a repo-materialization node for every participating repo. All preparation starts independently, while a repo may materialize only after its own preparation and every dependency materialization complete; independent graph branches continue after a failure, successful results are retained within the materialization generation, and retries resume rather than roll back prepared worktrees.

This makes local worktree creation, dirty-state carry, and non-clobbering Seed material projection independent of dependency bootstrap failures without weakening dependency ordering for ports, env rewrites, resources, or repo commands. Prepared-only repos are not cleanup-eligible, and a failed generation reaches quiescence before reporting completed, failed, and blocked nodes.

Preparation guarantees only that its best-effort copy operation completed. It does not provide an atomic snapshot when another process changes Source checkout files during the copy.

The persisted-state change is an intentional v2 cutover with no runtime support for v1. Before activating the v2-only build, directly inspect all existing Sessions, remove worktrees and state proven to contain no useful unmerged work, preserve cleanup obligations, back up the remainder, and manually convert every retained record to validated v2 state.
