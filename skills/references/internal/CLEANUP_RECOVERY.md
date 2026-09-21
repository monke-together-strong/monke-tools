# Cleanup recovery contract

## Ownership and execution

Use recorded membership and commands, never today's dependency config or
name-matching unowned paths. Unowned worktrees stay untouched by default.
`--include-unowned` inspects ordinary worktrees with the same committed-work and
age checks; they must be clean and require explicit resource recovery to remove.
Detached ordinary worktrees receive the same retained HEAD ref as Session members.
Removal waits if any known Source’s registrations cannot be inspected; unavailable
registrations cannot prove that another checkout is independent.

With `--include-unowned`, a missing ordinary worktree's stale registration needs
no resource recovery. Cleanup preserves its branch and requires an unlocked
registration with a clean saved index. Detached HEADs, unfinished Git operations,
and unverified metadata remain for manual recovery.

Stale Session registrations need the same saved-index and recovery-metadata checks;
missing directories alone do not authorize deleting their Git metadata.

Optional positional worktree paths restrict cleanup to matching Sessions or ordinary
worktrees. `--recover-with '<command>'` requires explicit paths and replaces recorded
cleanup commands with an audited recovery command, run from each canonical Source.
It receives saved resources and `MONKE_SESSION`, `MONKE_SOURCE_ROOT`, and
`MONKE_WORKTREE_PATH`. Verify resource ownership and make recovery safe to rerun.
A missing worktree with required cleanup blocks eligibility until recovery is supplied.

Nested/overlapping registrations block removal, including Ordinary Chop with
force. Corrupt records block affected Sessions; unbounded ownership blocks all.
Verified absent members count as removed; fully absent Sessions can finalize.
A missing Source checkout or `cleanupHold: true` is a settled blocker.
`cleanupEligible` separately records whether a repo's Cleanup command must run.

`mt cleanup --dry-run` reports “Would clean” without acquiring a lock, creating
Monke home, fetching, or running commands. A foreign operation lock blocks
eligibility. Real cleanup holds and verifies the global lock, refreshes evidence
before each Session, and uses Chop's removal/finalization lifecycle. Initial
inspection alone never authorizes effects.

Revalidate every collected member and retained state after provider calls, even
when a sibling already blocks cleanup. Fingerprint pending paths, the full index,
disk bytes, and modes; recheck at preflight, after process/resource effects, and
immediately before removal. Worktree listings and repository structure may be
memoized per Source during collection; branch, HEAD, cleanliness, and revalidation
are fresh reads. Reuse initial unowned discovery but check overlaps live before
removal. Process inspection failures retain targets. Session process checks refresh before
effects and before each removal, including after resource commands. Monke's lock
cannot make external editor or Git writes atomic.
