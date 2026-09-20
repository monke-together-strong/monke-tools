# Checkout-independent Diff base selection

Status: implemented; closeout review pending.

## Problem

Plain `mt diff` skips automatic base inference outside a Session. A feature branch
rebased onto main in the Source checkout therefore gets a picker of other
worktrees. That picker cannot offer main unless it has an attached worktree.
The existing inference function already selects `refs/remotes/origin/main` for
the reported crypto-trading checkout when called directly.

## Agreed behavior

- Run the same Git-history inference in Source checkouts, Ordinary worktrees,
  and Sessions. Checkout ownership controls persistence, not inference.
- On main/master, or a feature branch matching the unambiguous default tip,
  plain Diff shows staged, unstaged, and untracked changes directly. If clean,
  print `No changes.` Other worktrees alone do not trigger a picker.
- For a feature branch with committed changes, open Codiff against the inferred
  base. Preserve the existing ambiguity rules for stacked branches, conflicting
  default histories, unrelated history, and multiple merge bases.
- `--pick` bypasses automatic selection. Include local and remote-tracking
  main/master refs even without worktrees; place defaults before other worktree
  choices and deduplicate identical refs. Retain the remembered base and local
  changes option. Distinct refs remain distinct even when their tips coincide.
- In a Session, remember any explicitly selected branch base after Codiff
  launches successfully, including default refs and Ordinary-worktree branches.
  Local-only selections and failed launches do not overwrite the remembered
  base. Detached targets do not introduce remembered commit IDs.
- Preserve existing automatic replacement of remembered bases when a default
  branch has unambiguously newer shared history after a rebase.
- Source and Ordinary checkouts infer afresh on each invocation. Use available
  local refs without fetching; introduce no new persistence or migration.

## Implementation boundary

`src/diff.ts` owns automatic selection, picker choices, and persistence.
`src/comparison-plan.ts` supplies default-ref discovery and history inference.
Keep Diff-specific ref choices separate from Swing's navigation targets.
Reuse existing launch validation and recoverable picker handling when a ref
disappears between discovery and selection.

Update the Diff behavior reference and internal command guidance with the
implementation. No new flags, arbitrary-branch browser, or general inference
redesign are included. This reversible behavior change does not need an ADR.

## Focused acceptance checks

1. Parameterize a real-Git rebase scenario across Source, Ordinary, and Session
   checkouts: Codiff receives the inferred base without prompting, even when
   other worktrees exist and main has no attached worktree.
2. Main/master and a feature at the default tip open local edits directly;
   clean checkouts print `No changes.` Explicit `--pick` still opens the picker.
3. Default refs without worktrees appear in the picker and launch correctly;
   duplicate representations of the same ref appear once.
4. Every explicit branch choice persists for a Session after successful launch;
   failures and local-only choices preserve the previous base. Source and
   Ordinary invocations create no Session state.
5. Retain existing coverage for stacked/ambiguous histories, remembered-base
   advancement, and picker races. Update expectations enforcing Session-only
   inference or Session-target-only persistence.

Run the focused Diff tests and lint/typecheck for the changed scope. CI owns
repo-wide verification. Recheck inference against the reported checkout without
changing its refs or working files.

## Verification evidence

Review fixed point: `2cbe890d48b7adb1432d8712041def35e4ec520d`.

- CLI rebase cases: `vpr test tests/diff.test.ts -t 'plain Diff infers main after rebasing'`
  failed for Source and Ordinary checkouts before removing the Session gate;
  all three checkout kinds then passed.
- Default-tip cases: `vpr test tests/diff.test.ts -t 'at the default tip shows'`
  failed for main, master, and feature before the local-only path; all passed afterward.
- Picker defaults: `vpr test tests/diff.test.ts -t 'Diff picker offers default refs once'`
  failed with and without an attached main worktree, then both passed.
- Explicit persistence: `vpr test tests/diff.test.ts -t 'a Session remembers a selected'`
  failed for all four branch-choice kinds, then passed with launch failure and
  subsequent plain-Diff checks included.
- Forced local-only picker: `vpr test tests/diff.test.ts -t 'forced Diff picker remains explicit'`
  failed before honoring `--pick` for a single option; passed afterward.
- Final focused suite: `vpr test tests/diff.test.ts` — 50 passed, including
  ambiguity, remembered-base advancement, deleted-ref recovery, detached targets,
  concurrent persistence, and dependency-checkout coverage.
- `vp lint src/diff.ts src/comparison-plan.ts tests/diff.test.ts` and scoped
  `@typescript/native` typechecking passed. The temporary TypeScript config extends
  the repository config and includes these three files and their dependencies.
- The real crypto-trading checkout passed `runDiffInteractive` with real Git reads
  and only the Codiff launch intercepted: no picker, launch arguments
  `--branch refs/remotes/origin/main /Users/hoangbn/Documents/projects/crypto-trading`.

No repo-wide checks were run locally. No tracker target or comment target was supplied.
