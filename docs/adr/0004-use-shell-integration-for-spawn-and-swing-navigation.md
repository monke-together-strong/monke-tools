# Use shell integration for Spawn and Swing navigation

monke-tools uses a shell adapter to make successful **Spawn** and **Swing** operations move the user's interactive shell to the target checkout. A normal CLI subprocess cannot change its parent shell's working directory, so monke-tools uses a file-backed **Shell directory directive**. The shell adapter invokes the real `mt` binary with a directive-file environment variable, `mt` writes the target path to that file, and the adapter runs `cd` after the binary exits.

## Decision

`mt spawn <session>` always emits a **Shell directory request** for the root repo's **Session worktree** after it succeeds. `mt swing <target>` does the same for a resolved root repo **Source checkout**, **Session worktree**, or **Ordinary worktree**.

`Swing` follows Worktrunk's navigation model rather than Git's branch-switching model. It navigates to existing Session worktrees and Ordinary worktrees for branch-name targets, and never changes which branch an existing worktree has checked out. Explicit pull request targets (`mt swing pr:<n>` or a pull request URL) are the one exception. They fetch the PR head, create the Session branch and Session worktree through session-branch spawn when missing, and refuse to navigate whenever the local Session branch diverged from the PR head. Plain branch-name targets, Swing picker selections, and `-` Previous Swing targets do not re-fetch PR heads. Users continue to spawn ordinary sessions with `mt spawn`.

The first shell integration supports Bash and Zsh. A **Local install refresh**
configures the current supported shell. `mt shell install` and `mt shell init`
let users repair or inspect the integration independently of skills and builds.

The directive protocol supports only directory changes. It does not include Worktrunk's arbitrary shell execution directive. Like Worktrunk, the shell adapter honors a non-empty directory directive regardless of the `mt` process's exit status and then returns the original nonzero status. A directory-change failure replaces the status only when `mt` itself succeeded. This lets a teardown operation move the parent shell out of a worktree it removed while still reporting a later Cleanup-command failure.

Use one runtime-backed logger for navigation status and styling. Status goes to
stderr. Data such as a target path goes to stdout for callers to read. Tests can
inspect either stream through the runtime.

monke-tools reports navigation honestly:

- When an **Active shell adapter** accepts the request, it reports that it requested a switch to the target checkout. The shell changes directory after `mt` exits.
- When shell integration is configured but inactive for the current invocation, it reports the target path and explains that the shell must be restarted or `mt` must be invoked through the shell adapter.
- When shell integration is not configured, it reports the target path and explains how to configure automatic switching.

`Swing` accepts branch names for Session worktrees and Ordinary worktrees, the source-checkout shortcut `^`, the previous target shortcut `-`, same-repo pull request shortcuts such as `pr:123`, and pull request URLs. The `^` shortcut navigates to the root repo's Source checkout without materializing, setting up, creating, or changing branches. Pull request targets resolve through the pull request's same-repo head branch name, then create or validate the Session with that name before navigating to it. Fork pull request targets and merge request targets are outside the first contract.

`--codex` opens the resolved checkout as a Codex workspace via `codex://threads/new?path=...`. It does not create a thread. The launch reports status on stderr so stdout remains reserved for the target path when shell integration is inactive.

## Considered options

- Print the path only: rejected because the intended human workflow is immediate navigation after creating or choosing a Session.
- Try to `cd` directly from the binary: impossible for the parent shell in the normal subprocess model.
- Add an arbitrary shell execution directive now: rejected because there is no first-version Monke workflow requiring it, and it expands the trust boundary.
- Support all Worktrunk shells: rejected for the first version because Bash and Zsh cover the current local workflow while keeping the install scope small.
- Make `Swing` create missing worktrees for ordinary session targets: rejected because monke-tools already has a dedicated `Spawn` operation with materialization, resource, and state behavior.
- Carve out pull request targets from the ordinary-session rule: accepted because a PR head is a concrete remote ref that `mt spawn` cannot express.
- Use ad hoc `console.log` or free-form color helpers: rejected because shell integration needs predictable stdout and stderr separation and tests need to capture output through the runtime abstraction.

## Consequences

Automation that calls the binary directly can read the target path on stdout and
use it as the working directory for follow-up commands.
