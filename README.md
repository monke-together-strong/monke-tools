# monke-tools

`monke-tools` gives each coding session its own Git worktrees, ports, and environment values across a repo and its dependencies. It also distributes shared agent skills to Codex, Claude, Cursor, and custom agents.

## Install

Install the latest stable release on macOS arm64 or Linux x64.

```bash
curl -fsSL https://raw.githubusercontent.com/monke-together-strong/monke-tools/main/install.sh | sh
```

Follow the installer's shell instructions before starting a Session. For unattended
installation, custom targets, and recovery, see the [installation guide](skills/internal/monke-install/SKILL.md).

## Start a session

Create a Session and review your changes. With `monke.yml`, Spawn also prepares
the repo's configured environment and dependencies.

```bash
mt spawn banana
mt diff
mt swing '^'             # Return to the Source checkout
mt swing banana          # Return to the Session
```

When finished, run `mt chop banana`. It preserves local branches and deletes
ignored files with the worktrees. To find Sessions eligible for removal across
repos, run `mt cleanup --dry-run` before `mt cleanup`. The [Session guide](skills/internal/monke-worktrees/SKILL.md)
covers branch selection, worktree adoption, PR navigation, and cleanup recovery.

### Diff delivery

`mt diff` opens desktop Codiff by default. Run `mt diff configure` to save a
different adapter. With Monke See installed and configured, `mt diff --adapter ms`
prints a browser review link for that invocation.

`mt diff` can use a Session's remembered base or infer one from `main` or `master`
history. On either branch it shows local changes. Run
`mt diff --pick` to choose a base or review local changes only. See
`mt diff --help` for explicit comparisons and the [Diff guide](skills/internal/monke-diff/SKILL.md)
for time-based comparisons.

## Use checkout resources

With resources configured in `monke.yml`, run these commands in a
[Source checkout or Session worktree](GLOSSARY.md#session-topology).

```bash
mt setup
# Start any infrastructure required by the repo's resource modules.
mt resources acquire
mt resources exec -- <command>
mt resources release
```

Release keeps the checkout and its infrastructure. See [resource commands](skills/references/internal/RESOURCES.md)
for reuse and recovery.

## Run post-merge after external merges

In T3 Code, create and track a PR in one command.

```bash
mt prs create --thread <thread-id> --checkout <checkout> -- \
  --base main --head <branch> --title <title> --body-file <body-file>
```

Use `mt prs track` for an existing PR. When a tracked PR merges outside its
owning thread, `mt prs poll` asks the thread to run post-merge. If delivery
fails, the poller attempts to start a thread for it on the first
[`post-merge` model](#model-roles). Untrack a PR before merging it yourself. The [post-merge skill](skills/internal/post-merge/SKILL.md) describes
cleanup and when verification needs a separate thread.

## Configure a repo

Add `monke.yml` at the repo root. This example maps an assigned Session port into
`PORT` in `apps/api/.env`.

```yaml
apps:
  api:
    path: apps/api
    mappings:
      - port: API_PORT
        env: PORT
```

See the [configuration reference](skills/internal/monke-config/references/monke-yml.md)
for dependencies, env files, seed paths, and resources. For `PR.md` and
`POST_MERGE.md`, see the [repo configuration guide](skills/internal/monke-config/SKILL.md).

## Agent skills

Run `mt skills configure` to select agents or change the saved targets. Codex
and Claude also receive shared global instructions in a Monke-managed section.

To use skills from a local checkout in one project, run this inside the Consumer repo.

```bash
mt skills add ../banana-workflows --project
```

See the [skills guide](skills/internal/monke-skills/SKILL.md) to create or adopt a
global skill, import personal skills, or sync project installs to other worktrees.

Imported guidance is generated from the commit pins in `monke.yml`. See [maintain imported guidance](docs/skill-imports.md) for restoration, complete update review, and review-cache cleanup.

### Model roles

Skills and post-merge hand-offs choose models by Model role: `writer`,
`reviewer`, or `post-merge`. `mt models get <role>` prints a role's models in
fallback order, without providers, so a skill may run a model through any
provider that serves it. To override a role, list its models under `models` in
`$(mt home)/config.yml`, at most one per model family. The family is the model
id's leading name, such as `claude` or `gemini`, so use canonical model ids.

```yaml
version: 1
models:
  writer:
    - { provider: antigravity, model: gemini-4-neon, effort: high }
    - { provider: claudeAgent, model: claude-opus-5-5, effort: high }
```

`provider` is the T3 Code provider instance that automatic post-merge starts
use: `antigravity`, `claudeAgent`, or `codex`.

## Update

```bash
mt update --check         # Check without changing the install
mt update                # Activate the latest stable release
```

Updating a local build switches to a release install and preserves the source
checkout. Changes to installed release guidance block updates. See the
[update recovery guide](skills/internal/monke-install/SKILL.md#update-and-recovery).

## Development

Install [Vite+](https://viteplus.dev/guide/), then run these commands from this checkout.

```bash
vp install
vpr install:local
```

Rerun the local install after CLI changes before testing from another repo.
See [repository instructions](AGENTS.md) for checks, terminology, and issue tracking.
