# Session lifecycle

See [CONTEXT.md](../../CONTEXT.md) for shared session, repo, and port terminology.

## Language

**Session state store**: The module that owns **Session state** for one operation: opened under the global lock, it scans retained session states once, serves cross-session queries, and persists repo checkpoints.

**Session finalization**: The targeted lifecycle step that runs a Session's Cleanup commands after all its recorded worktrees are logically gone, then removes **Session state** only after every command succeeds.

**Dead worktree**: A session worktree recorded in session state whose filesystem path no longer exists.

**Merged PR**: A pull request whose GitHub `mergedAt` value is set.

**Merge-cleanable Session**: A Session whose session branch is proven by a **Merged PR** and whose recorded session worktrees are eligible for explicit cleanup.

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
Missing/invalid state, a managed target outside that scope, or a detached or
branch-mismatched Session worktree fails validation even with `--force`. Paths in
the managed worktree area never fall back to Ordinary targets.

Ordinary targets must be registered to the invoking repo. A detached worktree can
be selected by current location or registered absolute/relative path. An exact
unlocked stale registration can be pruned when its directory is absent; locked
registrations and missing targets without a registration fail. Source checkouts
and bare local branches are never targets. Ordinary removal preserves the branch
and does not finalize a Session.

A partially materialized Session remains a valid target. Use only repos and
resources recorded in its state, not inferred worktrees from today's config.

## Read-only Session inspection

`inspectSessionCleanup` reports Git and retained ownership evidence for all retained
Sessions. `eligibleForSessionCleanup` returns true only when every live member
passes the individual-worktree check and the whole Session has no ownership,
identity, hold, or operation blocker. The Root requires exact merged PR proof;
a dependency can instead prove that it has no commits outside the verified
default branch. Actual member branch names can differ from the Session name.

The report uses recorded membership. Nested worktree paths are overlapping
ownership, including discovered unowned registrations; removing a parent must
not encompass another worktree. Shared Git preflight also rejects nested
registrations for Ordinary Chop, including with force.

The report uses recorded membership. It does not infer dependencies from current
configuration or assign unowned worktrees to Sessions by matching names. Corrupt
records are reported. They block overlapping Sessions; if their ownership cannot
be bounded, they block all Sessions. Verified absent members count as already
removed, following Chop's registration checks. A partially absent Session can
pass for recovery only when every remaining live member passes. Fully absent
Sessions with verified ownership are reported separately as finalization
candidates.

Optional `cleanupHold: true` in Session state blocks this check. This is separate
from each repo's `cleanupEligible`, which records whether its Cleanup command
must run. A present global operation lock also blocks inspection eligibility;
the inspector does not acquire, reclaim, or remove that lock. It rechecks local
member evidence and retained state after provider reads.

This report is not removal authority and does not verify resource teardown. The
new method is not connected to automatic Chop or `mt cleanup --merged`.
`createSessionCleanupReport` supplies the same per-member explanations to JSON
and `formatSessionCleanupReport`. Local checks and committed-work checks report
passed, blocked, unknown, not-checked, or not-needed. A dirty worktree can stop
provider lookup; that is explicitly not-checked. Older saved evidence with
unknown check coverage remains unknown. Retained repository/PR proof can establish
that committed-work inspection ran, but an invalidation must not relabel it as
not-checked.
Ownership errors retain their conflicting Session/path details, and revalidation
errors name the affected member. Collected members are revalidated even when
another member already blocks the Session. Stale registrations retain their
branch identity for that comparison.

Inspection reports eligible (not attempted) or skipped. A later executor can supply
an actual cleaned or failed result; failure names revalidation, teardown,
worktree-removal, or finalization and the affected repo. Failed execution does not
claim the whole Session was retained: earlier steps may already have succeeded.
This reporting contract does not execute teardown or authorize removal.

`scripts/audit-session-cleanup-eligibility.ts <expected.json> <report.json> [report.txt]` compares
live results with independently labeled expectations. Its input has `capturedAt`,
`rows` of `{ file, expected }` (state filename and boolean), and optional
`knownSourceRoots` for reporting additional unowned Git worktrees. It uses
`MONKE_HOME`, writes the JSON report with per-member explanations and optional
text report, and fails if any expected result differs or
any Session was added or disappeared.

## Removal and finalization

Before removing any Session worktree, validate all checkable cross-repo
prerequisites: state consistency, Source-checkout identities, and recorded
worktrees. Report all preflight failures together and remove nothing on failure.
Revalidate each worktree immediately before removing it; on failure, stop later
removals and retain state for retry. Remove the invoking worktree last if it
belongs to the Session, otherwise the Root repo worktree last.

Treat a recorded missing path as already removed only when its path and Source
identity are valid, no live worktree carries the Session branch elsewhere, and
no locked registration remains. Prune only exact unlocked stale registrations;
there is no checkout-level status to inspect for an absent path. For a clean
worktree with initialized submodules, immediately revalidate cleanliness before
using Git's internal removal `--force` to bypass its submodule restriction. This
exception does not broaden the user's `mt chop --force` semantics.

Finalization runs only recorded Cleanup commands in reverse materialization order,
from Root toward dependencies. Missing recorded commands remain absent regardless
of current config. Stop at the first failure, retain full state and resources,
and leave later dependency commands unrun. Retries start from the first command;
individual successes are not checkpointed.

A named Session remains a valid Chop target while state is retained, even after
all worktrees disappear. `mt chop <session>` retries finalization; Cleanup discovers
and finalizes dead Sessions broadly. Successful finalization removes state, after
which another named Chop reports no target.

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
