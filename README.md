# monke-tools

`monke-tools` gives each coding session its own Git worktrees, ports, and environment values across a repo and its dependencies. It also distributes shared agent skills to Codex, Claude, Cursor, and custom agents.

## Install

Install the latest stable release on macOS arm64 or Linux x64:

```bash
curl -fsSL https://raw.githubusercontent.com/monke-together-strong/monke-tools/main/install.sh | sh
```

The installer asks which agents should receive skills and configures your current Bash or Zsh shell. Follow its shell instructions before starting a session. To choose skill targets later, run `mt skills configure`.

For unattended installation, replace the trailing `sh` with `sh -s -- --targets codex claude cursor`. See the [installation guide](skills/internal/monke-tools-core/INSTALLATION.md) for custom targets, local builds, and recovery.

## Start a session

From a repo with `monke.yml`:

```bash
mt spawn banana          # Prepare this repo and its dependencies
mt diff                  # Review the current checkout through its machine-local adapter
mt swing '^'             # Return to the source checkout
mt swing banana          # Return to the session
mt materialize           # Refresh the session's env and bootstrap
```

Spawn from the source checkout or any linked worktree to copy its `HEAD` and edits into a new session, leaving the original untouched. `--no-dirty` requires clean checkouts; `-m` uses default branches and resumes pinned refs on retry. Add `--codex` to open the session in Codex. See [Spawn usage](skills/internal/monke-tools-core/SKILL.md#create-and-resume-work) for details.

When finished, `mt chop banana` removes the session's worktrees and runs its recorded cleanup commands, preserving local branches. Dirty files block removal; ignored files are deleted with the worktrees. Preview eligible Sessions across all Roots with `mt cleanup --dry-run`, then run `mt cleanup` to execute. Both commands work outside a repository and accept `--json`. Optional worktree paths restrict scope. Use `--archive-untracked` to preserve untracked notes before removal; see the reference below for missing-worktree recovery and `--include-unowned`. Global scope never bypasses whole-Session eligibility.

The [session command reference](skills/internal/monke-tools-core/SKILL.md) covers branch reuse, PR navigation, diff bases, and cleanup recovery. Use `mt <command> --help` for available flags.

### Diff delivery

Desktop Codiff remains the default. `mt diff configure --adapter codiff` or
`mt diff configure --adapter lfv` saves the
machine-local preference in `$MONKE_HOME/config.yml`; `mt diff configure` offers a
picker. `mt diff --adapter codiff` or `--adapter lfv` overrides delivery for that
invocation without rewriting the preference.

The LFV adapter prints LFV's canonical review URL unchanged; diagnostics stay on
stderr. It requires an installed LFV CLI
with the version-1 review JSON contract and a configured viewer. LFV owns authentication,
rendering, Refresh, and link expiry. PR/MR shorthand requires authenticated `gh` or
`glab` to resolve a full review URL; full URLs need no Monke provider lookup. Diff never
installs LFV, changes its exposure, or falls back to another adapter on failure.

Bare `mt diff` retains its remembered-base selection, and `mt diff --pick` chooses
another base or local changes only. Explicit sources bypass both automatic selection
and the picker, and never replace the remembered base:

```sh
mt diff --working-tree                 # Staged, unstaged, and untracked changes only
mt diff --commit HEAD                  # One commit, including its parent comparison
mt diff --branch main                  # Branch contribution plus working-tree edits
mt diff main..HEAD                     # Direct endpoint comparison
mt diff main...HEAD                    # Merge base of main/HEAD against HEAD
mt diff '#42'                          # GitHub PR in the selected repository
mt diff pr 42                          # Alternate PR number form
mt diff pr owner:feature               # Open GitHub PR for a branch
mt diff mr 42                          # GitLab MR in the selected repository
mt diff https://github.com/owner/repo/pull/42
mt diff https://gitlab.example.com/group/repo/-/merge_requests/42
mt diff --path /existing/checkout --commit HEAD
```

A positional branch or commit ref follows the same semantics with either adapter. Use flags
to disambiguate. `--path` accepts an existing Checkout or one of its nested
directories; Diff never switches its branch or creates a worktree. Clean working
trees and equal-endpoint ranges are honest empty reviews, not HEAD substitutions.
Explicit sources cannot be combined with each other or `--pick`.

Codiff **1.14.0 or newer is required** for desktop Diff. Stock 1.14.0 supports
ordinary working-tree, commit, branch, and PR/MR commands without a custom fork or
capability extension. Older launchers can misclassify provider URLs with trailing
paths or query strings as branch requests; Monke rejects them before launching.
PR/MR access and normal provider refresh remain Codiff-owned, including
provider-reader failures.

**Range-forwarding limitation:** the packaged macOS shell launcher in Codiff 1.14.0
rewrites positional `main..feature` and `main...feature` into `--branch RANGE`,
even though the Codiff engine supports native ranges. Monke therefore opens ranges
only when the invoked launcher advertises `desktop-source-v1` in `--help` and a
version-1 `--capabilities` response containing `range`. The help probe avoids
invoking an unknown capability flag on stock launchers. An upstream-only source
sync or a newer version string alone does not prove this launcher defect is fixed.
Unsupported ranges, invalid targets, and failed launches report errors without
substituting another viewer, comparison, or picker.

## Use checkout resources

With resources configured in `monke.yml`, run these commands in a
[Source checkout or Session worktree](CONTEXT.md#session-topology):

```bash
mt setup                        # Write dependency paths and static resource values
# Start any infrastructure required by the repo's resource modules.
mt resources acquire            # Acquire missing allocations; reuse existing ones
mt resources exec -- <command>  # Run with the recorded resource values
mt resources release            # Release allocations after use
```

See [resource commands](skills/references/internal/RESOURCES.md) for execution and recovery. Release keeps the checkout and infrastructure; `mt chop` removes
the whole Session.

## Configure a repo

Add `monke.yml` at the repo root. For example, this maps an assigned session port into `PORT` in `apps/api/.env`:

```yaml
apps:
  api:
    path: apps/api
    mappings:
      - port: API_PORT
        env: PORT
```

The [configuration reference](skills/internal/monke-tools-core/MONKE-YML-REFERENCE.md) covers dependency repos, custom env files, bootstrap, seed files, and checkout resources.

## Agent skills

Run `mt skills configure` to select agents or change the saved targets. Codex and Claude also receive shared global instructions; existing guidance outside the managed section is preserved.

The [monke-tools-core skill](skills/internal/monke-tools-core/SKILL.md) guides agents through session work, configuration, and installation. Other workflows live in [internal skills](skills/internal) and [imported skills](skills/imported). See [agent guidance distribution](docs/reference/agent-guidance.md) for domain terminology and ownership.

## Update

```bash
mt update --check         # Check without changing the install
mt update                # Activate the latest stable release
```

Updating a local build switches to a release install while preserving the source checkout. Edits to installed release skills or references block updates; follow the [recovery guide](skills/internal/monke-tools-core/INSTALLATION.md#update-recovery) to preserve them.

## Development

Install [Vite+](https://viteplus.dev/guide/), then run from this checkout:

```bash
vp install
vpr install:local
```

Rerun the local install after CLI changes before testing from another repo. Locally installed skills link to source, so edits are visible immediately; adding or removing skill directories requires `mt skills configure` to refresh links.

Run `vp check <changed-files>` for scoped formatting, lint, and type checks. Use `vpr test -- <test-file>` for focused tests: the package script runs Vitest under Bun. PR CI owns the full suite. Build the standalone executable through `install:local`.

For domain terminology, start with [CONTEXT.md](CONTEXT.md). Track work in [GitHub Issues](https://github.com/monke-together-strong/monke-tools/issues).
