# Plan 004: Preflight merged cleanup locally and close docs drift

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report - do not improvise. When done, update the status row for this plan
> in `plans/README.md` - unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 24dee6d..HEAD -- src/cleanup-merged.ts src/monke.ts README.md "backlog/tasks/task-14 - PRD-Add-mt-cleanup-merged-for-merge-cleanable-sessions.md" __tests__/cleanup-merged.test.ts __tests__/recovery-bootstrap-cleanup.test.ts docs/adr/0003-remove-only-worktrees-for-merge-cleanable-session-cleanup.md docs/agents/backlog.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: performance, dx, docs
- **Planned at**: commit `24dee6d`, 2026-07-02

## Why this matters

`mt cleanup --merged` has a conservative safety predicate, but the implementation resolves the
default branch and queries GitHub before it has ruled out local-only skips such as missing
worktree paths, wrong repositories, detached worktrees, branch mismatches, and dirty/untracked
files. That makes cleanup slower and more dependent on GitHub for sessions that local Git could
skip immediately. The same feature is also shipped and tested while README and `TASK-14` still
present it as absent or unfinished, which can send future agents into duplicate implementation
work.

This plan keeps the ADR's safety decision intact: no branch deletion, no guessing, no forked PR
proofs, and no cleanup unless the full predicate passes.

## Current state

Relevant files and roles:

- `src/cleanup-merged.ts` - `inspectMergedWorktreeCleanup` currently performs default branch and
  GitHub lookup before building the local snapshot:

  ```ts
  // src/cleanup-merged.ts:91-123
  export function inspectMergedWorktreeCleanup(
    runtime: Runtime,
    candidate: MergedCleanupCandidate,
    options: { refreshDefaultBranch?: boolean } = {},
  ): MergedCleanupDecision {
    const defaultBranch = getDefaultBranch(runtime, candidate.sourceRoot, {
      refresh: options.refreshDefaultBranch ?? true,
    });
    ...
    const repository = getGithubRepositoryFullName(runtime, candidate.sourceRoot);
    const matchingMergedPrs = repository.ok
      ? queryMergedPrs(runtime, {
          sourceRoot: candidate.sourceRoot,
          repositoryFullName: repository.value,
          session: candidate.session,
          defaultBranch: defaultBranch.value,
        })
      : { ok: false as const, error: repository.error };

    const snapshot = buildMergedCleanupSnapshot(runtime, {
      ...candidate,
      defaultBranch: defaultBranch.value,
      repositoryFullName: repository.ok ? repository.value : null,
      matchingMergedPrs: matchingMergedPrs.ok ? matchingMergedPrs.value : [],
      lookupError: matchingMergedPrs.ok ? null : matchingMergedPrs.error,
    });
  ```

- `decideMergedWorktreeCleanup` already separates local identity/branch checks before PR checks
  in decision logic:

  ```ts
  // src/cleanup-merged.ts:135-177
  if (!snapshot.worktreeExists) {
    reasons.push("session worktree path is missing");
  } else if (!snapshot.worktreeIsGitRoot) {
    reasons.push("session worktree path is not a Git worktree root");
  } else if (snapshot.isSourceCheckout) {
    reasons.push("session worktree path points at the source checkout");
  } else if (!snapshot.sameGitRepository) {
    reasons.push("session worktree path belongs to a different Git repository");
  } else {
    evidence.push("worktree belongs to the expected repository");
  }
  ...
  if (!branchMatchesSession) {
    return { eligible: false, reasons, evidence };
  }
  ```

- `buildMergedCleanupSnapshot` already collects the local evidence needed for preflight:

  ```ts
  // src/cleanup-merged.ts:257-299
  const worktreeExists = existsSync(options.worktreePath);
  const expectedCommonDir = tryGit(runtime, options.sourceRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  ...
  const statusResult = worktreeIsGitRoot
    ? tryGit(runtime, options.worktreePath, ["status", "--porcelain", "--untracked-files=normal"])
    : null;
  ```

- `src/monke.ts` wires `cleanup --merged` over every recorded repo state:

  ```ts
  // src/monke.ts:651-672
  for (const state of listSessionStates(home)) {
    if (state.rootSourceRoot !== rootSourceRoot) {
      continue;
    }

    for (const repoState of state.repos) {
      const candidate = {
        sourceRoot: repoState.sourceRoot,
        session: state.session,
        worktreePath: repoState.worktreePath,
      };
      const decision = inspectMergedWorktreeCleanup(runtime, candidate, {
        refreshDefaultBranch: !dryRun,
      });
  ```

- Existing tests prove merged cleanup behavior and dry-run no-fetch behavior:

  ```ts
  // __tests__/recovery-bootstrap-cleanup.test.ts:383-385
  expect(readFileSync(gitLog, "utf8").slice(gitLogBeforeCleanup.length)).not.toContain(
    "fetch --prune origin",
  );
  ```

- README documents only dead-state cleanup:

  ```markdown
  # README.md:55

  - `mt cleanup` removes session records whose worktrees no longer exist.
  ```

- Backlog task 14 is stale: it is still `status: To Do` and all acceptance criteria are
  unchecked, while `src/index.ts` exposes `--merged` and tests cover the behavior.

Repo conventions and constraints:

- ADR 0003 says cleanup removes only eligible Session worktrees and does not delete local branches.
- `docs/agents/backlog.md` says to use `bunx backlog.md ...` for task writes; do not hand-edit
  task markdown directly unless the CLI cannot express the needed update.
- Use domain terms from `CONTEXT.md`: Cleanup, Merge-cleanable Session, Session worktree,
  Merged PR, Source checkout.

## Commands you will need

| Purpose               | Command                                                                                  | Expected on success      |
| --------------------- | ---------------------------------------------------------------------------------------- | ------------------------ |
| Focused cleanup tests | `bun test __tests__/cleanup-merged.test.ts __tests__/recovery-bootstrap-cleanup.test.ts` | all tests pass           |
| Backlog read          | `bunx backlog.md task 14 --plain`                                                        | shows updated task state |
| Typecheck             | `bun run typecheck`                                                                      | exit 0, no errors        |
| Full tests            | `bun test`                                                                               | all tests pass           |
| Lint check            | `bun run lint:check`                                                                     | exit 0                   |
| Format check          | `bun run fmt:check`                                                                      | exit 0                   |

## Scope

**In scope**:

- `src/cleanup-merged.ts`
- `src/monke.ts` only if needed to preserve call signatures
- `README.md`
- `backlog/tasks/task-14 - PRD-Add-mt-cleanup-merged-for-merge-cleanable-sessions.md`
- `__tests__/cleanup-merged.test.ts`
- `__tests__/recovery-bootstrap-cleanup.test.ts`

**Read-only reference while executing**:

- `docs/adr/0003-remove-only-worktrees-for-merge-cleanable-session-cleanup.md`
- `docs/agents/backlog.md`

**Out of scope**:

- Deleting local branches.
- Force-deleting branches.
- Supporting forked or cross-repository PR cleanup proofs.
- Choosing a latest PR when multiple same-branch merged PRs exist.
- Changing Cleanup command retry semantics.
- Replacing Backlog.md as the task tracker.

## Git workflow

- Branch if requested: `feature/cleanup-merged-preflight-docs`
- Do not create `codex/` branches.
- Commit style: concise imperative, for example `Preflight merged cleanup locally`.
- Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Split local snapshot collection from PR lookup

Refactor `src/cleanup-merged.ts` so local evidence is collected before default-branch and GitHub
lookup. One acceptable shape:

1. Add a local snapshot type or builder that collects:
   - `worktreeExists`
   - `worktreeIsGitRoot`
   - `isSourceCheckout`
   - `sameGitRepository`
   - `branch`
   - `localHead`
   - `statusLines`
   - `statusError`
2. Add `decideMergedCleanupLocalPreflight(localSnapshot, session)` that returns a
   `MergedCleanupDecision | null`.
3. In `inspectMergedWorktreeCleanup`, build the local snapshot first. If local preflight returns
   a decision, return it without calling `getDefaultBranch`, `getGithubRepositoryFullName`, or
   `queryMergedPrs`.
4. Only after local preflight passes should the code resolve default branch, query GitHub, build
   the full `MergedCleanupSnapshot`, and call `decideMergedWorktreeCleanup`.

The full final decision must remain equivalent for eligible candidates.

**Verify**: `bun test __tests__/cleanup-merged.test.ts` passes.

### Step 2: Add tests proving local skips do not call GitHub/default-branch fetch

Extend `__tests__/recovery-bootstrap-cleanup.test.ts` with at least two CLI-level tests:

- A dirty/untracked Session worktree under `cleanup --merged` skips without invoking `gh`.
- A missing Session worktree path under `cleanup --merged --dry-run` skips without invoking `gh`
  and without fetching default branch.

Use the existing fake `gh`/git shim patterns in the file. Make the fake `gh` fail loudly if it is
called for these local-skip cases, so the test proves the preflight boundary.

Keep the existing eligible cleanup tests intact; eligible candidates should still query GitHub.

**Verify**:

```bash
bun test __tests__/cleanup-merged.test.ts __tests__/recovery-bootstrap-cleanup.test.ts
```

Expected: all focused cleanup tests pass.

### Step 3: Update README cleanup command docs

Update `README.md` command bullets so they describe:

- `mt cleanup` removes dead Session state.
- `mt cleanup --merged --dry-run` previews Merge-cleanable Session worktrees.
- `mt cleanup --merged` removes only eligible merged Session worktrees, preserves local branch
  refs, then runs the existing dead-state Cleanup behavior.

Keep the wording short; README command bullets are concise.

**Verify**: `rg -n "cleanup --merged|Merge-cleanable|dead Session" README.md` shows the new
cleanup documentation.

### Step 4: Close backlog task 14 through Backlog.md

Use the repo's required Backlog.md CLI, not hand edits, where possible:

```bash
bunx backlog.md task 14 --plain
```

Then update task 14 to reflect reality:

- status `Done`
- acceptance criteria checked
- final summary noting that `mt cleanup --merged`, dry-run, conservative same-repo Merged PR
  predicate, ignored-file removal for eligible worktrees, branch preservation, cleanup command
  retry semantics, and fake-GitHub tests are implemented

Use `bunx backlog.md task edit ...` according to `docs/agents/backlog.md`. If the CLI cannot
check acceptance criteria or append a final summary without damaging the task structure, STOP and
report the exact CLI limitation instead of hand-editing.

**Verify**: `bunx backlog.md task 14 --plain` shows `Done`, checked acceptance criteria, and the
final summary.

### Step 5: Run the full verification gate

Run:

```bash
bun run typecheck
bun run lint:check
bun run fmt:check
bun test
```

**Verify**: all four commands exit 0.

## Test plan

- Preserve existing decision-matrix coverage in `__tests__/cleanup-merged.test.ts`.
- Add CLI-level local-preflight tests in `__tests__/recovery-bootstrap-cleanup.test.ts`.
- Run focused cleanup tests, then full suite.
- Verify task state with Backlog.md CLI.

## Done criteria

- [ ] Local-only skip cases return before default-branch fetch or GitHub lookup.
- [ ] Eligible candidates still require same-repository merged PR proof and matching local HEAD.
- [ ] Focused cleanup tests cover no-`gh` local skip behavior.
- [ ] README documents `mt cleanup --merged` and dry-run behavior.
- [ ] Backlog task 14 is marked Done with checked acceptance criteria and final summary.
- [ ] `bun run typecheck`, `bun run lint:check`, `bun run fmt:check`, and `bun test` pass.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- The refactor weakens any ADR 0003 safety predicate.
- A local skip still requires GitHub metadata to produce the correct reason.
- Backlog.md CLI cannot update task 14 safely.
- The fix requires changing cleanup command retry semantics.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- Reviewers should compare eligible cleanup behavior before and after the refactor; the only
  behavior change should be avoiding remote/default-branch work for local skip cases.
- Keep README in sync whenever new cleanup flags are added.
- If branch deletion is revisited later, create a new ADR or update ADR 0003 first; do not smuggle
  it into this cleanup-preflight change.
