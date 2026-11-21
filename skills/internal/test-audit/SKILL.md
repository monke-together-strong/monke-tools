---
name: test-audit
description: "Audit or clean up existing tests with mutation proof, repairing weak assertions and removing redundant tests and test-only production seams."
argument-hint: "[path]"
disable-model-invocation: true
---

# Test audit

- Repair or remove low-value proof in coherent owner batches, guided by contract coverage rather than deletion counts.
- Judge every candidate against [testing standards](../../references/internal/TESTING_STANDARDS.md): its rules, junk patterns, and retention bar.
- Keep discovery read-only and report findings before editing.
- Audit and cleanup run sections 1 to 4 in full, including the `F` check. They differ only in whether section 5 edits are applied. Section 4 probes never touch the user's checkout.

## 1. Baseline

Record test and support line counts and every in-scope test file's pass or fail state at a pinned commit. Count shared support once, separately from the audited files, and do not attribute it to them. Keep baseline failures in their own list. A baseline failure may expose a product bug. Reproduce and report it, keep its test, and repair it only when asked (see section 5).

Done when every in-scope test file has a recorded baseline result.

## 2. Candidate evidence

- Before editing, read the full test, production owner, entry point, callers, callees, sibling tests, overlapping proof, CI routing, git history, and root and scoped repo instructions. For dependency-backed claims, inspect the dependency's source and types.
- Judge a test by its assertions, not its name.

## 3. Ledger

Each test declaration goes into a written **ledger** with one mark. An `it.each` is one declaration unless its rows need different marks. When rows differ, mark each row. A declaration or row that needs both a repair and a consolidation is marked `F+C` and needs both proofs.

- `R`: retain, naming the contract and the bug it catches. A retained test that only moves to a better-named file stays `R` with the move noted.
- `F`: retain the contract but repair the assertion, such as a vacuous negative that passes when only one of several items is missing.
- `C`: consolidate, naming the owner that absorbs the assertion first: a sibling table case, a stronger boundary suite, or the shared owner in another package.
- `D`: delete, naming the proof that remains, or why no contract exists.

Check every declaration for `F` before looking for `C` or `D`. Trace each asserted value to where it is produced (helpers, fixtures, mocks, parsers, schemas) and to where the behavior is observed. Name the regression the test most likely misses. Mark `F` when that regression passes the test, or when a behavior-preserving refactor would break it.

For every declaration, record its exact name, location, and detectable failure. For each `F`, `C`, and `D`, also record:

- Non-test callers of the covered production or support seam.
- Stronger remaining owner proof, or why none is needed.
- History or reason the test exists, and any deletion it unlocks.
- Risk and focused validation command.

Require complete evidence before deleting a test.

Treat the per-test ledger as input, not as the edit list. A second read-only pass, starting from the ledger, looks for the redundant **layer**. Name the **keeper** suite for each contract. Prefer the real transport boundary with a fake network over a mocked collaborator. Correct any ledger errors this pass finds.

Done when every declaration has a mark and an evidence line, and every contract has a keeper.

## 4. Preservation proof

Run probes in a throwaway Session created with `$monke-worktrees`, never in the user's checkout, and remove it with `mt chop` when done.

- For each `C` and `D`, make one deliberate **mutation** of the production owner per moved or removed contract, and confirm the keeper goes red. Then restore the source byte for byte. For a `C`, build the keeper change in the probe worktree and prove it there before applying it anywhere else.
- For each `F`, make the mutation for its named regression and confirm the current test stays green. For a refactor-coupled `F`, make a behavior-preserving change instead and confirm the current test fails. Then restore the source byte for byte.
- Look for contracts that lost their only proof, and for new assertions that cannot fail, such as a rejection row the production code never reaches.

Done when every `C` and `D` has a caught mutation per moved or removed contract, or is downgraded to `R` or `F`. Every `F` must have a surviving mutation (or, if refactor-coupled, a behavior-preserving change that fails it), or be downgraded to `R`.

## 5. Edit

- Repair each `F` so its section 4 probe flips: the regression now fails the test, or the behavior-preserving change now passes it.
- Delete obsolete seams and dead paths. Move retained regressions to their owner. Consolidate generic package and dependency contracts.
- With each batch, remove the test-only production seams it unlocks: injection parameters, getters, reset exports, and indirection layers.
- Prefer net-negative production LOC. Never add replacement implementation tests or turn uncertainty into cleanup.
- A baseline failure that survives into a keeper is a bug report. Report it. When asked to fix it, fix it at its owner as a separate commit, with a **control** run that reverts the fix and shows the old behavior.

## 6. Validate and report

- Run owner and sibling tests. When you remove source greps or plan assertions, exercise the owning executable or a dry run.
- Run targeted format, lint, typecheck, and `git diff --check`. Removed tests can orphan support files and exports. Run the repo's dead-code checks when it has them.
- Inspect `git diff --numstat`.
- Report causes, removed categories and seams, retained false positives, proof and cost, production versus test and support LOC, and follow-ups.
- Write the full ledger, with evidence for every row, to a file outside the diff and link it. In the chat report, summarize `R` rows compactly, and give full evidence for `F`, `C`, and `D`.
- Commit and push only with task authority. Open PRs with `$pr`.
