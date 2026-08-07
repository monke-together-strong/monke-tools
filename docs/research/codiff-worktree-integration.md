# Codiff worktree and comparison integration research

Research date: 2026-08-07

Upstream snapshot: `main` at [`3ee0d094`](https://github.com/nkzw-tech/codiff/tree/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2), whose package version is 1.10.1

## Version floor

The local executable currently reports Codiff 1.7.0. That version supports both direct and symmetric commit ranges, but branch comparison routes only to committed branch state and excludes dirty changes. ([v1.7.0 range parser](https://github.com/nkzw-tech/codiff/blob/v1.7.0/bin/arguments.js#L150-L205), [v1.7.0 Git-state routing](https://github.com/nkzw-tech/codiff/blob/v1.7.0/electron/git-state.cjs#L65-L80))

The worktree-against-branch behavior this report recommends depends on Codiff 1.9.0 or newer: upstream commit [`33d92cf`](https://github.com/nkzw-tech/codiff/commit/33d92cf) / PR [#126](https://github.com/nkzw-tech/codiff/pull/126) added it, and the v1.9.0 release explicitly called out “branch + uncommitted vs main.” ([v1.9.0 release](https://github.com/nkzw-tech/codiff/releases/tag/v1.9.0), [v1.9.0 branch-working-tree source](https://github.com/nkzw-tech/codiff/blob/v1.9.0/electron/git-state/commit.cjs#L532-L640))

Monke should therefore require and verify `codiff >= 1.9.0` for this integration. Merely finding `codiff` on `PATH` is insufficient, and an installer that skips an already-present older version would preserve the wrong semantics. The remaining analysis describes current 1.10.1 behavior.

## Executive answer

Monke does not need to Swing into a Session worktree before opening Codiff. Codiff already accepts a repository path after its comparison source, so Monke can resolve a Session worktree and launch an unambiguous command such as:

```sh
codiff --branch <target-branch> /absolute/path/to/session-worktree
```

That command compares three layers together in the selected worktree: the selected worktree's commits since its merge-base with the target branch, its staged changes, and its unstaged/untracked changes. Codiff resolves Git from the supplied path and normalizes it with `git rev-parse --show-toplevel`, so the selected worktree supplies the `HEAD`, index, and filesystem state. The target branch may be checked out in another linked worktree because ordinary branch refs are shared by Git worktrees. ([Codiff CLI parsing](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/bin/arguments.js#L16-L36), [branch-plus-working-tree implementation](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/electron/git-state/commit.cjs#L592-L640), [Git worktree ref rules](https://git-scm.com/docs/git-worktree#_refs))

The important limitation is that Codiff has exactly one live worktree endpoint. It can compare the selected worktree's dirty state with another worktree's **committed branch**, but it cannot compare the index or uncommitted filesystem state of two worktrees. Commit-to-commit ranges are supported, but both ends are Git objects and therefore omit local dirt. Monke can remove the common path/ref bookkeeping, but dirty-vs-dirty comparison would require a new upstream Codiff capability or materializing one side as Git objects.

The recommended first integration has only two command shapes:

```text
mt diff             # use a remembered Diff base or ask when none is available
mt diff -p|--pick   # always choose from the Swing targets
```

Both forms always Diff the checkout containing the current directory; the picker chooses only the committed **Diff base**, never a different current checkout. `mt diff` launches immediately when the current Session repo remembers a resolvable Diff base and otherwise opens the picker. `--pick` forces that same picker. The current checkout is always the live **head** side; the selected Diff base contributes only committed state.

## Supported comparison sources and exact semantics

The public CLI shape is `codiff [options] [<ref> | <pr> | <url>] [path]`. The README documents working-tree, repository-path, commit, branch, GitHub PR, GitLab MR, walkthrough, and share launches. ([README](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/README.md#L26-L103))

| Desired comparison                      | Stable invocation for Monke                                                                  | What Codiff actually compares                                                                                     | Includes selected worktree dirt? |
| --------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Selected worktree only                  | `codiff <worktree-path>`                                                                     | `HEAD` to index (staged), index to files (unstaged), plus untracked files                                         | Yes                              |
| One commit                              | `codiff --commit <ref> <worktree-path>`                                                      | First parent to the commit; a root commit is compared as a root diff                                              | No                               |
| Selected worktree against target branch | `codiff --branch <target-ref> <worktree-path>`                                               | Merge-base of target and selected `HEAD` to selected `HEAD`, then staged/unstaged/untracked sections are appended | Yes                              |
| Two committed snapshots, direct         | `codiff '<base>..<head>' <worktree-path>`                                                    | `base` tree to `head` tree                                                                                        | No                               |
| Proposed changes from divergence point  | `codiff '<base>...<head>' <worktree-path>`                                                   | Merge-base of `base` and `head` to `head`                                                                         | No                               |
| GitHub PR / GitLab MR                   | `codiff pr <n> <worktree-path>`, `codiff mr <n> <worktree-path>`, branch lookup, or full URL | Provider change state resolved using the selected repo's remote                                                   | No local dirt                    |

Details that matter for a wrapper:

- Default working-tree mode enumerates tracked status, reads staged patches with `git diff --cached`, reads unstaged patches with `git diff`, and separately includes ignored-rule-respecting untracked files. It initially caps ordinary untracked files at 1,000 and collapses common generated directories such as `node_modules`, `dist`, and `build`. ([working-tree reader](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/electron/git-state/working-tree.cjs#L133-L225), [working-tree section assembly](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/electron/git-state/working-tree.cjs#L226-L293))
- A commit source resolves the commit, finds its first parent, and diffs the two trees. Merge commits are therefore first-parent comparisons, not combined diffs. ([commit comparison](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/electron/git-state/commit.cjs#L79-L100), [source resolution](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/electron/git-state/commit.cjs#L252-L287))
- A branch source is PR-style: Codiff resolves the selected worktree's `HEAD`, resolves the target, and uses their merge-base as the old side. It does **not** directly compare the target branch tip to the selected branch tip. ([branch resolution](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/electron/git-state/commit.cjs#L207-L250))
- Codiff then unions that committed branch diff with the selected worktree state, preserving separate commit, staged, and unstaged sections. ([state merge](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/electron/git-state/commit.cjs#L549-L640))
- Range syntax is supported even though the README does not currently foreground it. `base..head` is a direct comparison; `base...head` substitutes the merge-base for `base`. Both endpoints must resolve to commits in the selected repository before Codiff treats the argument as a range. ([range parsing and validation](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/bin/arguments.js#L204-L259), [range argument handling](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/bin/arguments.js#L409-L448), [range resolution](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/electron/git-state/commit.cjs#L102-L132))

## Paths, files, and repository-root assumptions

The trailing `path` is a repository location, not a Git pathspec or a file endpoint. Codiff's complete public flag list contains `--branch` and `--commit`, but no `--file`, `--pathspec`, or equivalent; its examples consistently call the positional value a repository path. File narrowing happens after launch through the UI's file filter. ([flag definitions and examples](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/bin/arguments.js#L9-L130), [command-bar file filter](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/README.md#L105-L123))

Codiff resolves an omitted path from `process.cwd()` and an explicit path to an absolute path. It tests refs by running `git -C <path> ...`, and the Git-state layer obtains the worktree root with `git -C <launchPath> rev-parse --show-toplevel`. Consequently:

- Monke may pass the Session worktree root directly and does not need shell navigation.
- A directory nested inside a worktree also resolves to that worktree's root, but it does not scope Diff to that directory.
- A bare repository or a non-repository directory is not a usable Diff endpoint because `--show-toplevel` must succeed.
- Passing an individual existing file as the trailing path is not a supported single-file Diff; Git is invoked with that file as its `-C` directory.

([argument path resolution](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/bin/arguments.js#L231-L259), [final requested-path resolution](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/bin/arguments.js#L424-L474), [Git root resolution](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/electron/git-state/working-tree.cjs#L215-L225))

## What this means for linked Monke worktrees

Git gives each linked worktree its own `HEAD`, index, and filesystem while sharing normal refs under `refs/`. Thus, from Session worktree B, Codiff can resolve Session worktree A's branch without opening A. Git also exposes another linked worktree's `HEAD` through special `worktrees/<name>/HEAD` syntax, but Monke should prefer its known branch or a resolved commit SHA: the worktree administration name is an implementation detail and branch/SHA output produces clearer UI and errors. ([Git worktree description and details](https://git-scm.com/docs/git-worktree#_description), [Git worktree refs](https://git-scm.com/docs/git-worktree#_refs))

Concrete cases:

1. **Diff Session B from its original or parent branch A, including B's local work:** `codiff --branch <A-branch> <B-path>`.
2. **Compare committed tips A versus B directly:** resolve both branch names or SHAs, then launch `codiff '<A>..<B>' <either-worktree-path>`. The path only supplies repository context in this mode.
3. **Diff B as a PR-shaped change from the common ancestor with A:** `codiff '<A>...<B>' <either-worktree-path>`; unlike `--branch A <B-path>`, this omits B's local work.
4. **Diff B's local changes only:** `codiff <B-path>`.
5. **Compare dirty A against dirty B:** unsupported. Selecting B means only B's index/files are live; A can contribute only a branch/commit ref. Reversing the selected path reverses which worktree's dirt is visible.
6. **Diff a Session spanning a root repo and dependency repos:** launch one Codiff window per participating repo. Codiff has a one-repository comparison model and explicitly opens separate native windows for multiple repositories. ([README](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/README.md#L89-L103))

Codiff does not know Monke's Session topology. Git worktrees preserve the current branch and shared refs, but Codiff still needs the target ref supplied. Monke is the appropriate layer to turn a remembered Diff base or selected local Swing target into the path/ref pair.

## Current Monke topology constraints

Today, `mt spawn` cannot spawn a Session from another Session worktree: it explicitly requires invocation from the Source checkout. In normal current-head mode it creates the Session branch at the Source checkout's `HEAD`; `--main` instead uses the resolved default-branch ref. ([spawn boundary](https://github.com/monke-together-strong/monke-tools/blob/3eddf94de3a91fe8192605cf5fb6c7f3a458ec33/src/monke.ts#L112-L137), [current-head branch creation](https://github.com/monke-together-strong/monke-tools/blob/3eddf94de3a91fe8192605cf5fb6c7f3a458ec33/src/git.ts#L326-L342), [CLI modes](https://github.com/monke-together-strong/monke-tools/blob/3eddf94de3a91fe8192605cf5fb6c7f3a458ec33/src/index.ts#L46-L61))

Current-head Spawn copies the Source checkout's staged, unstaged, and untracked state into a newly created Session worktree by default; `--no-dirty` rejects dirty Source checkouts instead. This makes the Session worktree the correct selected/head endpoint for a Codiff >=1.9 branch comparison. It does not make the Source checkout a second live comparison endpoint: later or remaining dirt on the Source checkout still cannot be included alongside Session dirt. ([dirty snapshot capture and application](https://github.com/monke-together-strong/monke-tools/blob/3eddf94de3a91fe8192605cf5fb6c7f3a458ec33/src/monke.ts#L327-L379), [snapshot contents](https://github.com/monke-together-strong/monke-tools/blob/3eddf94de3a91fe8192605cf5fb6c7f3a458ec33/src/monke.ts#L466-L505))

Session state currently records the Session name and participating repos' source roots, worktree paths, ports, resources, and materialization status, but no Diff base. Automatic comparison therefore needs a state-schema addition. ([Session state schema](https://github.com/monke-together-strong/monke-tools/blob/3eddf94de3a91fe8192605cf5fb6c7f3a458ec33/src/state-schema.ts#L29-L45))

The state addition should be per participating repo because every repo can have a different base:

```yaml
repos:
  - sourceRoot: /path/to/repo
    worktreePath: /path/to/session
    diffBaseRef: refs/heads/main
```

When Spawn creates a fresh Session branch from an attached Source checkout, record that full branch ref. Default-branch Spawn records the exact local or remote-tracking ref it selected. A detached Source checkout has no moving Diff base, so Spawn records none. Existing or adopted Sessions are not backfilled during Spawn; Materialize and reuse preserve existing state. The first `mt diff` picker selection may establish or replace a Session repo's Diff base.

Pull-request Sessions initially record no Diff base. Their first `mt diff` uses the picker rather than extending PR metadata or guessing the PR base branch.

At Diff time Codiff resolves the ref's merge-base with the current checkout. This naturally follows rebases onto newer commits from the same base branch without persisting a comparison commit. `mt diff` does not fetch: remote-tracking refs use their locally available value.

## Programmatic and integration affordances

The supported integration boundary is the `codiff` executable. The upstream package is marked `private`, exposes a `bin` entry, and does not declare a library `exports` API. Monke should execute it as an argument array rather than importing internals. ([package manifest](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/package.json#L1-L30))

Use explicit source flags when one exists:

```text
["codiff", "--branch", targetRef, selectedWorktreePath]
["codiff", "--commit", commitRef, selectedWorktreePath]
["codiff", `${baseRef}...${headRef}`, repositoryPath]
```

This avoids Codiff's positional branch/commit/path heuristics, especially for branch names that resemble hashes or paths. Ranges have no public `--range` flag, so they must remain positional. Codiff validates range endpoints against the repository selected by the trailing path. ([source disambiguation](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/bin/arguments.js#L204-L259), [path-aware range validation](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/bin/arguments.js#L409-L448))

The CLI-to-Electron launcher internally transports the repository path and source through `CODIFF_REPOSITORY_PATH`, `CODIFF_BRANCH_REF`, `CODIFF_COMMIT_REF`, and `CODIFF_RANGE`, but these variables are not documented as a public integration API. Invoking documented argv keeps Monke insulated from that transport. ([launcher transport](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/bin/codiff.js#L296-L319))

Normal GUI launches detach Electron, discard its stdio, and return immediately. There is no structured success payload for "the diff finished loading" and no headless JSON diff API; `--share` and plan handoff are separate workflows. Monke can validate the executable/version and preflight its own path/refs before launch, but it should treat a successful spawn as "launch requested," not proof that the GUI rendered the comparison. ([detached launch](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/bin/codiff.js#L333-L358))

Codiff identifies windows by the real worktree root plus source identity. Since each linked worktree has a distinct top-level path, different Session worktrees can have distinct Codiff windows even when they share the same object database. Re-launching the same root/source is designed to address the same logical window. ([window identity](https://github.com/nkzw-tech/codiff/blob/3ee0d09405a01f5c57f7d8e4835e071f4a0ee3d2/electron/window-identity.cjs#L179-L227))

## Recommended Monke UX boundary

The smallest useful integration owns base resolution and delegates rendering to Codiff:

```text
mt diff             # remembered Diff base, otherwise picker
mt diff -p|--pick   # force the Diff base picker
```

Recommended defaults and guardrails:

- Always Diff the repository and checkout containing the current directory. One invocation opens one Codiff window; a multi-repo Session does not fan out.
- A Session repo with a remembered, resolvable Diff base launches immediately. Missing, deleted, or invalid bases open the picker instead of guessing.
- Do not erase an invalid remembered Diff base automatically; it may become valid after a later fetch or branch restoration. Only a successfully launched attached-base selection replaces it.
- Source checkouts and Ordinary worktrees do not persist Diff bases in the first version, so `mt diff` opens the picker for them each time.
- `-p` and `--pick` force the picker even when Session state contains a valid Diff base.
- Reuse the Swing target ordering and labels. The stable picker order is: the current Diff base when present (even when it is not checked out), Source checkout, other Sessions, Ordinary worktrees, then “Local changes only.” Do not add other dormant branches without worktrees in the first version.
- An attached picker target contributes its full branch ref. A detached target contributes its current commit for that launch but is not persisted as a moving Session Diff base.
- Selecting an attached target for a Session repo saves or replaces that repo's Diff base only after Codiff's launcher exits successfully. Selection from a Source checkout or Ordinary worktree is launch-only. “Local changes only” never clears remembered state.
- When “Local changes only” is the sole picker option, explain that no Diff base is available and open local changes without displaying a one-item prompt.
- Label picker targets as committed bases and warn without blocking whenever the chosen or remembered base ref is checked out in a dirty worktree, because only the current checkout's dirt appears.
- Preflight that the selected path and base belong to the same source repository and that a merge-base resolves. Invalid selections return to the picker with an actionable error.
- Do not fetch before launch. Remote-tracking Diff bases use their locally available ref value.
- Verify the official Codiff executable and version 1.9.0 or newer on every invocation. Never install or upgrade from `mt diff`; fail with the explicit bootstrap or Homebrew command instead.
- Resolve the current checkout, read Session state, discover picker candidates, and verify Codiff concurrently where practical. Do not present the picker until Codiff verification succeeds.
- If no Diff base or alternative Swing target exists, open local changes without displaying a one-item picker. When the checkout is also clean, exit successfully with `No Diff base or local changes found for <repo>.` instead of opening an empty window.
- When a valid Diff base exists, launch Codiff even if the comparison may be empty; Codiff owns branch-comparison change detection and its empty state.
- Cancelling the Diff picker performs no launch and no state mutation, using the CLI's standard interactive-cancellation behavior.
- Concurrent Diff commands do not serialize their Codiff launches. Each successful attached-base launch briefly reacquires the global lock to update Session state; the last completed state update becomes the default for the next `mt diff`, while every opened Codiff window remains unaffected.

The key design distinction should be visible in help and picker copy: **the current checkout is the live side; a selected Diff base contributes committed branch state only.**

### Module seam

Do not implement `mt diff` by calling private functions in `swing.ts` or by teaching every caller Codiff syntax. Extract a checkout-target module whose small interface resolves a current/Source/Session/Ordinary-worktree/previous selector without navigating or mutating Swing history. Swing can use the same module and add navigation as its own operation.

Put comparison semantics behind a second small interface that returns a launch plan rather than starting the GUI directly:

```ts
type ComparisonPlan =
  | { kind: "working-tree"; worktreePath: string }
  | { baseRef: string; kind: "branch-working-tree"; worktreePath: string };
```

The Codiff adapter then has a mechanical mapping: local changes to `[path]` and a branch-working-tree comparison to `["--branch", baseRef, path]`. Tests can exercise target resolution and comparison planning without opening Electron, while a small adapter test verifies the final argument array. This module earns its seam by hiding Monke topology, Diff-base persistence, dirty-side asymmetry, ref validation, and Codiff version requirements from both the CLI and future callers.

### Suggested delivery order

1. Raise dependency verification to Codiff 1.9.0 or newer; the currently installed 1.7.0 is insufficient for combined branch and local changes.
2. Record an optional per-repo `diffBaseRef` for newly created Sessions when Spawn has an attached or resolved default-branch ref.
3. Extract side-effect-free checkout-target resolution from Swing.
4. Add `mt diff`, `-p|--pick`, Session-only picker persistence, and focused tests.
5. Leave arbitrary heads, explicit base arguments, dormant branches, committed ranges, PR mode, and multi-repo launches out of the first version.
