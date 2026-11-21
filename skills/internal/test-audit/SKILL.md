---
name: test-audit
description: "Audit or clean up existing tests with mutation proof, repairing weak assertions and removing redundant tests and test-only production seams."
argument-hint: "[path]"
disable-model-invocation: true
---

# Test audit

- Judge every candidate against [testing standards](../../references/internal/TESTING_STANDARDS.md).
- Work in coherent owner batches guided by contract coverage, not deletion counts.
- Keep discovery read-only and report findings before editing.
- Audit and cleanup run sections 1 to 3 in full, including the `F` check, and differ only in whether section 4 edits are applied.

## 1. Baseline

At a pinned commit, record test and support line counts and each in-scope test file's pass or fail state. Count shared support once, separately from the audited files. List baseline failures separately. Reproduce and report each one, and keep its test.

Done when every in-scope test file has a recorded baseline result.

## 2. Ledger

Before marking, read:

- The full test, its sibling tests, and overlapping proof.
- The production owner, entry point, callers, and callees.
- CI routing, git history, and root and scoped repo instructions.
- For dependency-backed claims, the dependency's source and types.

Judge each test by its assertions, not its name.

Give every test declaration one mark in a written **ledger**. An `it.each` is one declaration unless its rows need different marks. When they do, mark each row.

- `R`: retain, naming the contract and the bug it catches. A test that only moves to a better-named file stays `R` with the move noted.
- `F`: retain the contract but repair the assertion, such as a vacuous negative that passes when only one of several items is missing.
- `C`: consolidate, naming the owner that absorbs the assertion: a sibling table case, a stronger boundary suite, or the shared owner in another package.
- `D`: delete, naming the remaining proof or why no contract exists.
- `F+C`: repair and consolidate. Both marks' requirements apply.

Check every declaration for `F` before looking for `C` or `D`. Trace each asserted value to where it is produced (helpers, fixtures, mocks, parsers, schemas) and to where the behavior is observed. Name the regression the test most likely misses. Mark `F` when that regression passes the test, or when a behavior-preserving refactor would break it.

For every declaration, record its exact name, location, and detectable failure. For each `F`, `C`, and `D`, also record:

- Non-test callers of the covered production or support seam.
- Stronger remaining owner proof, or why none is needed.
- Why the test exists and any deletion it unlocks.
- Risk and a focused validation command.

Treat the ledger as input, not as the edit list. Run a second read-only pass to spot the redundant **layer**, assign one **keeper** suite per contract, and fix ledger errors. Prefer the real transport boundary with a fake network over a mocked collaborator.

Done when every declaration has a mark and complete evidence, and every contract has a keeper.

## 3. Preservation proof

Run probes in a throwaway Session via `$monke-worktrees`, never in the user's checkout. Restore the production source byte for byte after each probe, and remove the Session with `mt chop` when done.

- **Each `C` and `D`.** For a `C`, build the keeper change in the probe worktree, and apply it elsewhere only after it is proven there. Make one deliberate **mutation** of the production owner per moved or removed contract and confirm the keeper goes red.
- **Each `F`.** Introduce its named regression and confirm the current test stays green. For a refactor-coupled `F`, make a behavior-preserving change instead and confirm the current test goes red.
- **New gaps.** Check for contracts that lost their only proof and for new assertions that cannot fail, such as a rejection row the production code never reaches.

Done when both hold:

- Every `C` and `D` has a caught mutation per moved or removed contract, or is downgraded to `R` or `F`.
- Every `F` has a surviving mutation (or, if refactor-coupled, a behavior-preserving change that fails it), or is downgraded to `R`.

## 4. Edit

- Repair each `F` so its probe flips: the regression now fails the test, or the behavior-preserving change now passes it.
- Apply each proven `C` consolidation and `D` deletion. Delete obsolete seams and dead paths, and move retained regressions to their owner.
- With each batch, remove the test-only production seams it unlocks: injection parameters, getters, reset exports, and indirection layers.
- Prefer net-negative production LOC. Never add replacement implementation tests or turn uncertainty into cleanup.
- Fix a baseline failure only when asked, at its owner in a separate commit, with a **control** run that reverts the fix and shows the old behavior.

## 5. Validate and report

Run:

- Owner and sibling tests. If you removed a source grep or plan assertion, also exercise the owning executable or a dry run.
- Targeted format, lint, typecheck, and `git diff --check`.
- The repo's dead-code checks when it has them, since removed tests can orphan support files and exports.
- `git diff --numstat`, for the LOC report.

Write the full ledger with every row's evidence to a file outside the diff and link it. In chat, summarize `R` rows compactly and report:

- Full evidence for `F`, `C`, and `D`.
- Causes.
- Removed categories and seams.
- Retained false positives.
- Proof and cost.
- Production versus test and support LOC.
- Follow-ups.

Commit, push, or open a PR only with task authority. Open PRs with `$pr`.
