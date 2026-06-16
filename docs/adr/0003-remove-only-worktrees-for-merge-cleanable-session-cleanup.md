# Remove only worktrees for merge-cleanable session cleanup

monke-tools cleanup for **Merge-cleanable Sessions** starts by removing only eligible **Session worktree** paths, then relying on existing **Cleanup** behavior to remove dead **Session state**. It does not delete local branches in the first version, even though the real-GitHub prototype proved a safe branch-deletion predicate, because branch deletion changes the user trust boundary and Git's non-force deletion behavior is inconsistent for squash-merged branches.

The behavior belongs in the core lifecycle command as `mt cleanup --merged --dry-run` and `mt cleanup --merged`, rather than only in an agent skill or standalone helper. `--dry-run` is part of the first version so users can see which Sessions are eligible and why others are skipped before any worktree directory is removed.

## Considered Options

- Remove only eligible Session worktrees: accepted for the first version because it reclaims the local checkout, preserves branch refs, and keeps destructive behavior narrow.
- Attempt non-force branch deletion with `git branch -d`: rejected for the first version because it can fail even when GitHub proves the PR was squash-merged.
- Force-delete branches after the validated GitHub predicate passes: rejected for the first version because it is logically safe for the proven case, but it is a stronger destructive action than worktree cleanup and should be introduced only behind an explicit branch policy.

## Consequences

Removing an eligible Session worktree deletes the whole worktree directory, including ignored files inside it. This is acceptable for the first version because the cleanup predicate proves the branch content is represented by a merged PR and the user intent is to reclaim the entire session checkout, while preserving the local branch ref as the recovery boundary.

The merged PR proof is same-repository only in the first version. Cleanup skips forked or cross-repository PR matches because branch-name matching is not enough to prove that a local session branch belongs to a PR head from another repository.

If more than one same-repository merged PR matches the session branch and default branch, cleanup skips the Session. The first version does not choose the latest PR because branch-name reuse means the branch no longer uniquely identifies one merged change.
