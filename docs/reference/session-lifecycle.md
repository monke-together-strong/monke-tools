# Session lifecycle

See [CONTEXT.md](../../CONTEXT.md) for shared session, repo, and port terminology.

## Language

**Session state store**: The module that owns **Session state** for one operation: opened under the global lock, it scans retained session states once, serves cross-session queries, and persists repo checkpoints.

**Session finalization**: The targeted lifecycle step that removes **Session state** after Cleanup commands succeed and all recorded worktrees are logically gone.

**Dead worktree**: A session worktree recorded in session state whose filesystem path no longer exists.

**Merged PR**: A pull request whose GitHub `mergedAt` value is set.

**Merge-cleanable Session**: A Session whose live members each pass committed-work proof and local-work checks. Committed work qualifies by an exact **Merged PR**, default-branch ancestry, a complete change matching a qualifying landed PR, or complete-tree equality in verified default history. Local work must be clean or satisfy one of the narrow pending-work checks below. All Session-level safety gates still apply.

**Default branch spawn mode**: A **Spawn** mode selected by `mt spawn <session> -m`, `--main`, or `--master`. It creates a new Session from each participating repo's resolved default branch content, or resumes an incomplete Session from retained worktrees and pinned Session refs.

**Worktree preparation**: The dependency-independent phase that creates or validates one participating **Session worktree**, carries permitted source changes, and non-clobberingly projects **Seed material**. Preparation is initiated for every participating repo without waiting for dependency materialization.

**Prepared worktree**: A **Session worktree** whose **Worktree preparation** completed but whose dependency-ordered repo materialization may still be pending. _Avoid_: Complete worktree, failed worktree

**Preparation warning**: A non-fatal **Worktree preparation** result that identifies missing optional **Seed material** while leaving the worktree prepared. Copy failures are preparation failures, not warnings.

**Repo materialization**: The phase that resolves session values, rewrites env, runs repo commands, and produces the results consumed by dependent repos. It begins only after the repo's own **Worktree preparation** and every dependency's **Repo materialization** complete.

**Blocked repo materialization**: A repo materialization that cannot begin because a dependency's materialization failed. It is a consequence of another repo's failure, not a failure of the blocked repo. _Avoid_: Failed materialization, cancelled materialization

**Cleanup eligibility**: The persisted indication that **Repo materialization** reached an externally relevant side effect and the repo's **Cleanup command** must run before its Session state can be removed. A **Prepared worktree** alone is not cleanup-eligible. _Avoid_: Prepared state, worktree existence

**Materialization generation**: One retained attempt to materialize every repo in a Session dependency graph. An incomplete generation resumes by reusing completed repo materializations; a new generation begins only after the previous generation completes. _Avoid_: Command invocation, retry run

**Chop target**: The **Session** or **Ordinary worktree** selected for one **Chop** invocation.

**Swing target**: A user-provided **Session**, **Ordinary worktree** branch, navigation shortcut, or pull request identifier that **Swing** resolves to a local checkout path.

**Swing picker**: The interactive **Swing** mode used when `mt swing` is run without a **Swing target**, letting a user choose from the current **Root repo**'s existing local **Swing targets**.

**Diff base**: The Git branch ref used as the committed side of a Diff, resolved through its merge-base with the reviewed checkout. A Session repo may remember one in Session state.

**Diff picker**: The interactive Diff mode that selects the committed **Diff base** from local **Swing targets** without changing the reviewed checkout or navigating the shell.

**Codex workspace launch**: An optional **Spawn** or **Swing** behavior selected with `--codex` that opens the resolved checkout as a Codex workspace. It does not create a thread.

**Previous Swing target**: The last different **Swing target** remembered for one **Root repo**, used by `mt swing -` to return to a previous source, Session, or Ordinary-worktree checkout.

**Shell directory request**: A CLI-side request for an active shell adapter to move the user's current shell into a resolved **Source checkout** or **Session worktree** after the operation establishes that the target is navigation-ready. A prepared-only Session worktree is not navigation-ready and a failed operation does not issue a request.

**Shell adapter**: The human-shell function installed by monke-tools that can honor **Shell directory requests** after an `mt` command exits.

**Active shell adapter**: A **Shell adapter** that is intercepting the current `mt` invocation and has provided a writable **Shell directory directive**.

**Shell directory directive**: The file-backed path handoff from the `mt` process to an active **Shell adapter** for one **Shell directory request**.

**Shell integration install**: The operation that installs the shell adapter needed to honor **Shell directory requests** for supported human interactive shells.

**Shell integration init**: The operation that emits the shell adapter source for one supported shell.

## State ownership

Spawn, Materialize, and Cleanup each open one Session state store under the global
lock. It owns state reads and writes, scans retained states once, and serves port
usage, remembered outputs, and resource-collision queries. Resource commands get
inputs and checkpoint capabilities from the store rather than reading state.

## Preparation and materialization

Default branch spawn mode prefers fetched remote `main` or `master`, falling back
to local refs. New Sessions require fresh branches; incomplete ones resume pinned
refs and retained worktrees. Tracked content and configuration come from those
refs; Seed material comes from the Source checkout.

Preparation runs independently across repos and fills missing Seed material
without overwriting Session-local content. Missing configured paths produce
warnings; copy errors fail preparation. Repo materialization waits for its own
preparation and all dependencies. A failure blocks dependents while independent
work continues until no work is runnable.

An incomplete generation reuses completed repo materializations. After completion,
Materialize starts another persisted attempt over the recorded worktrees.
Materialization updates ports, managed env, path env, resources, and command
outputs, reusing remembered values. See [resources](resources.md) for persistence
and collision rules.

Cleanup eligibility is recorded immediately before materialization may create an
external side effect. Prepared-only repos are removed without cleanup commands.

## Chop targets

| Invocation                              | Target                                                      |
| --------------------------------------- | ----------------------------------------------------------- |
| No argument inside a Session            | Current Session                                             |
| No argument inside an Ordinary worktree | That worktree                                               |
| From a Source checkout                  | Explicit target required                                    |
| Explicit Session name                   | Named Session within the current Root repo scope            |
| Registered branch or path               | Owning Session if managed; otherwise that Ordinary worktree |

Resolve Session names before Ordinary targets. A managed path or branch selects
the whole owning Session only with valid state and matching Root repo scope.
Missing/invalid state or a managed target outside that scope fails validation
even with `--force`. Detached or branch-mismatched retained members produce a
warning. Managed paths never fall back to Ordinary targets.

Ordinary targets must be registered to the invoking repo. A detached worktree can
be selected by current location or registered absolute/relative path. An exact
unlocked stale registration can be pruned when its directory is absent; locked
registrations and missing targets without a registration fail. Source checkouts
and bare local branches are never targets. Ordinary removal preserves the branch
and does not finalize a Session.

A partially materialized Session remains a valid target. Use only repos and
resources recorded in its state, not inferred worktrees from today's config.

## Session cleanup

Cleanup inspects all retained Sessions across all Roots from Monke home, even
outside a repository. Every live member must pass local-work and committed-work
checks; the whole Session must pass ownership, identity, hold, and operation
checks. Actual member branches may differ from the Session name.

### Committed work

An open PR on the current branch blocks removal. Otherwise, committed work needs
one of these proofs against the verified default branch:

| Proof             | Requirement                                                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current-branch PR | Exact same-repository PR HEAD, merged into default.                                                                                                                   |
| Ancestry          | Member HEAD is an ancestor of default HEAD.                                                                                                                           |
| Cross-branch PR   | Exact PR HEAD, both repositories match Source, default base, and merge commit reachable from default HEAD. Intermediate-commit association is insufficient.           |
| Complete diff     | The nonempty change from HEAD's sole merge base exactly matches a qualifying PR merge's change from its first parent: paths, modes, and full before/after object IDs. |
| Complete tree     | HEAD's full tree ID equals a commit's tree reachable from default HEAD, including modes and submodule commits.                                                        |

All proofs except a clean current-branch merged PR require a worktree age of at
least one day, measured from its `.git` file. Complete-diff proof rejects divergent
merges, shallow history, and missing objects; it never normalizes whitespace or
ignores binary/submodule changes. Inspection does not fetch missing objects.

Unique commits without qualifying evidence are a settled skip. GitHub compare
404 for an unpushed commit means not-an-ancestor; provider/inspection failures
remain unknown. Commit lookups share a per-inspection cache keyed by Source,
repository, HEAD, and verified default HEAD.

### Pending and detached work

Only verified retained Session members may use these pending-work exceptions:

- **Forward preservation:** one strict descendant of member HEAD, reachable from
  verified default HEAD, contains the entire pending bundle together: exact raw
  disk blobs and modes, with deletions absent. Changed index entries must equal
  disk; unchanged entries may equal HEAD. Historical-only or per-path witnesses,
  split staged/unstaged edits, conflicts, hidden index flags, dirty submodules,
  and unsupported filesystem states do not qualify.
- **pnpm bootstrap residue:** the sole dirty path is `pnpm-lock.yaml`, matching
  the reproduced pnpm 12.1.0 native-bootstrap deletion in its first YAML document.
  The `packageManager` pin must match, application-document bytes and file modes
  must be unchanged, and index/disk states must agree. Inspection never runs pnpm.

Both exceptions still require committed-work proof and at least one day of age,
even with an exact merged PR. They authorize Git force only for the proven member.

Detached members qualify only by ancestry or complete-tree equality. An open
same-repository PR on the retained Session branch or exact HEAD blocks removal.
Before removal, Cleanup compare-and-sets `refs/monke/retained/<HEAD>` and verifies
the ref and worktree HEAD. A failure or collision retains the worktree; the ref
survives success or partial failure. Reports include its recovery command.

### Ownership and execution

Use recorded membership and commands, never today's dependency config or
name-matching unowned paths. Unowned worktrees are listed and left untouched.
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
removal. Monke's lock cannot make external editor or Git writes atomic.

### Reports

Both modes accept `--json`, emitting one object with `schemaVersion: 1`,
`dryRun`, `inspectedAt`, `sessions`, `unownedWorktrees`, `unavailableSources`,
`globalFailure`, and `exitCode`. Command output is captured separately.
Human output starts with outcome/error/unowned/unavailable counts and shows up
to five dirty paths per member. `--eligible` filters human output only; JSON
always includes all Sessions. Neither `--merged` nor `--all` is supported.

- **Exit 0:** inspection/execution completed, including settled skips.
- **Exit 1:** unavailable evidence, execution failure, or a global safety stop.
  Details remain in the report, with a short stderr error.
- **Member checks:** local and committed-work checks are passed, blocked, unknown,
  not-checked, or not-needed. A dirty member may prevent provider lookup.
  Older evidence with unknown coverage stays unknown; retained repository/PR
  proof may establish coverage, and invalidation must not erase it.
- **Actions:** planned, completed this attempt, and remaining. Inspection reports
  eligible or skipped; execution reports cleaned, skipped before any effect
  attempt, or failed after an attempt starts. Failures identify the member and
  phase: revalidation, process-stop, teardown, removal, or finalization.

Reports preserve ownership conflicts, stale-registration branch identities, and
partial effects; a failed command may have external effects despite unverified
completion. `createSessionCleanupReport` supplies the same explanations to JSON
and `formatSessionCleanupReport`. Bounded failures allow independent Sessions
to continue. Lost lock ownership, changed retained state, or unbounded corrupt
ownership stops execution and reports remaining Sessions as skipped.

The audit command
`scripts/audit-session-cleanup-eligibility.ts <expected.json> <report.json> [report.txt]`
compares live results with independent labels. Input contains `capturedAt`,
`rows: [{ file, expected }]` (state filename and boolean), and optional
`knownSourceRoots` for additional unowned discovery. It uses `MONKE_HOME`, writes
JSON and optional text explanations, and fails on mismatches or added/missing
Sessions.

## Removal and finalization

Validate all Session state, Source identities, and recorded worktrees before
effects; report all preflight failures together. Revalidate after commands/process
stops and before each removal. Failure stops later removals and retains state.
Remove the invoking member last, otherwise the Root last.

Cleanup scans managed-area working directories once per run, grouping processes
by parent. A tree is attached if any command line names a worktree path; its age
is its oldest member's age. Any tree under one day old blocks the Session and is
listed. Before Cleanup commands, old attached roots receive SIGTERM, then SIGKILL
after a grace period; completed stops are reported. Old unattached trees, such as
idle shells, remain running and are reported. Chop does not stop processes.

Run only recorded Cleanup commands, before any removals, in reverse
materialization order (Root toward dependencies). Commands run in their Session
worktree; a missing required-command worktree blocks all commands unless explicit
Chop recovery uses `--cleanup-from-source`. Stop at the first failure and retain
full state/resources. Retries restart all commands, including earlier successes;
individual successes are not checkpointed.

An absent path counts as removed only with valid path/Source identity, no live
Session branch elsewhere, and no locked registration. Prune only exact unlocked
stale registrations. Clean initialized submodules permit internal Git removal
`--force` after an immediate cleanliness recheck; this does not broaden user
`mt chop --force` semantics.

Finalize state only after required commands succeed and all recorded worktrees
are gone. Retained state keeps a named Session choppable, including after all
worktrees disappear. Restore missing required-command worktrees or deliberately
use `mt chop <session> --cleanup-from-source`. After finalization, named Chop
reports no target.

## Diff

For a Session repo without a remembered base, Diff may infer a distinct local or
remote-tracking `main` or `master` only if the current branch is neither, the ref
is unambiguous with one merge-base, and no non-default branch has nearer or
incomparable shared history. Remember that base only after Codiff launches.

Warn when the Session branch is attached elsewhere and the current worktree does
not carry it; the current checkout remains the reviewed side.

## Navigation readiness

Spawn requests navigation only after Root repo materialization succeeds. A
config-less prepared Root fails with a retry receipt. Swing navigates only after
resolving a ready Source checkout, Session worktree, or Ordinary worktree; embedded
PR Spawn failures do not navigate. `--codex` additionally opens
`codex://threads/new` with the absolute checkout path after success. A prepared-only
failure does not launch it.

## Swing

Ordinary Session and worktree targets must exist; Swing neither creates them nor
changes their checked-out branch. Targets include Session names, Ordinary branches,
`^` for the Root repo Source checkout, `-` for the previous target, `pr:<number>`,
and PR URLs. History is scoped to one Root repo and includes `^`; source navigation
runs no setup or materialization.

Explicit PR navigation fetches the same-repo PR head, uses a matching existing
Session or Ordinary worktree, or creates the Session when neither exists. Refuse
diverged local heads. Stored navigation, picker selections, and `-` do not
revalidate PR heads. Fork PRs and merge requests are unsupported.

## Shell integration

The adapter consumes a file-backed directory directive, never arbitrary shell
commands. It honors a non-empty directive even after a nonzero CLI exit and
preserves that exit status. Successful navigation reports the new checkout. With
no active adapter, report the target path and whether integration is configured
but inactive or needs installing. Chop can remove the invoking worktree without
an adapter, but reports the Source checkout destination and warns that the parent
shell could not move.

Install and init support bash and zsh. Install targets the user's current supported
`$SHELL`, reports the startup file even when unchanged, and is idempotent. It runs
during local refresh and interactive release installation, or independently when
requested. Unsupported shells receive manual instructions without startup edits.
