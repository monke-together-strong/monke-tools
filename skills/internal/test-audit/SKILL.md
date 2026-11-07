---
name: test-audit
description: "Sweep existing tests: remove duplicate or implementation-coupled proof and test-only production seams, without leaving any contract without its only proof. Use when asked to audit, prune, clean up, or dedupe tests."
argument-hint: "[path]"
disable-model-invocation: true
---

# Test Audit

- Audits: remove low-value proof in coherent owner batches; never chase deletion counts.
- Judge every candidate against [testing standards](../../references/internal/TESTING_STANDARDS.md): its rules, junk patterns, and retention bar.
- Discovery read-only; report before edits.
- Audit and cleanup run sections 1–4 in full, including the `F` check; they differ only in whether section 5 edits are applied. Section 4 probes never touch the user's checkout.

## 1. Baseline

Record test and support line counts and every in-scope test file's pass/fail state at a pinned commit. Count shared support once, separately from the audited files; do not attribute it to them. Keep baseline failures in their own list. Baseline failure may be product bug: reproduce and report it; never delete test for it. Repair it only when asked (section 5).

Done when every in-scope test file has a recorded baseline result.

## 2. Candidate evidence

- Before editing: read full test, production owner, entry point, callers, callees, siblings, overlapping proof, CI routing, history. Dependency-backed claims: inspect dependency source/types. Read root/scoped instructions.
- Judge a test by its assertions, not its name.

## 3. Ledger

Each test declaration goes into a written **ledger** with one mark. An `it.each` is one declaration unless its rows need different marks; then mark each row. A declaration or row that needs both a repair and a consolidation is marked `F+C` and needs both proofs.

- `R`: retain, naming the contract and the bug it catches; a retained test that only moves to a better-named file stays `R` with the move noted;
- `F`: retain the contract but repair the assertion, such as a vacuous negative that passes when only one of several items is missing;
- `C`: consolidate, naming the owner that absorbs the assertion first: a sibling table case, a stronger boundary suite, or the shared owner in another package;
- `D`: delete, naming the proof that remains, or why no contract exists.

Check every declaration for `F` before looking for `C` or `D`. Trace each asserted value to where it is produced (helpers, fixtures, mocks, parsers, schemas) and to where the behavior is observed. Name the regression the test most likely misses. Mark `F` when that regression passes the test, or when a behavior-preserving refactor would break it.

For every declaration, record its exact name/location + detectable failure. For each `F`, `C`, and `D`, also record:

- Non-test callers of covered production/support seam.
- Stronger remaining owner proof, or why none needed.
- History/reason it exists + deletion it unlocks.
- Risk + focused validation command.

Missing evidence: no deletion.

Treat the per-test ledger as input, not as the edit list. A second read-only pass, starting from the ledger, looks for the redundant **layer**. Name the **keeper** suite for each contract. Prefer the real transport boundary with a fake network over a mocked collaborator. Correct any ledger errors this pass finds.

Done when every declaration has a mark and an evidence line, and every contract has a keeper.

## 4. Preservation proof

Run probes in a throwaway worktree created with `$monke-worktrees`, never in the user's checkout.

- For each `C` and `D`, make one deliberate **mutation** of the production owner per moved or removed contract, and confirm the keeper goes red. Then restore the source byte for byte. For a `C`, build the keeper change in the probe worktree and prove it there before applying it anywhere else.
- For each `F`, make the mutation for its named regression and confirm the current test stays green. For a refactor-coupled `F`, make a behavior-preserving change instead and confirm the current test fails. Then restore the source byte for byte.
- Look for contracts that lost their only proof, and for new assertions that cannot fail, such as a rejection row the production code never reaches.

Done when every `C` and `D` has a caught mutation per moved or removed contract, or is downgraded to `R` or `F`; and every `F` has a surviving mutation (or, if refactor-coupled, a behavior-preserving change that fails it), or is downgraded to `R`.

## 5. Edit

- Repair each `F` so its section 4 probe flips: the regression now fails the test, or the behavior-preserving change now passes it.
- Delete obsolete seams/dead paths; move retained regressions to owner; consolidate generic package/dependency contracts.
- With each batch, remove the test-only production seams it unlocks: injection parameters, getters, reset exports, and indirection layers.
- Prefer net-negative production LOC. Never add replacement implementation tests or turn uncertainty into cleanup.
- A baseline failure that survives into a keeper is a bug report. Report it; when asked to fix it, fix it at its owner as a separate commit, with a **control** run that reverts the fix and shows the old behavior.

## 6. Validate and report

- Run owner/sibling tests. Removed source greps/plan assertions: exercise owning executable/dry-run.
- Run targeted format, lint, typecheck, and `git diff --check`. Removed tests orphan support files/exports; run the repo's dead-code checks when it has them.
- Inspect `git diff --numstat`.
- Report causes, removed categories/seams, retained false positives, proof/cost, production versus test/support LOC, follow-ups.
- Write the full ledger, with evidence for every row, to a file outside the diff and link it. In the chat report, summarize `R` rows compactly; give full evidence for `F`, `C`, and `D`.
- Commit/push only with task authority; open PRs with `$pr`.
