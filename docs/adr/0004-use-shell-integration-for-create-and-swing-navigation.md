# Use shell integration for Create and Swing navigation

monke-tools uses a shell adapter to make successful **Create** and **Swing** operations move the user's interactive shell to the target **Session worktree**. A normal CLI subprocess cannot change its parent shell's working directory, so monke-tools uses a file-backed **Shell directory directive**: the shell adapter invokes the real `mt` binary with a directive-file environment variable, `mt` writes the target path to that file, and the adapter runs `cd` after the binary exits.

## Decision

`mt create <session>` always emits a **Shell directory request** for the root repo's **Session worktree** after it succeeds. `mt swing <target>` does the same for an existing root repo **Session worktree**.

`Swing` follows Worktrunk's navigation model rather than Git's branch-switching model. It navigates to existing Session worktrees only. It does not create Session worktrees and does not change which branch an existing worktree has checked out. Users continue to create sessions with `mt create`.

The first Shell integration supports bash and zsh only. `bun run install:local` installs it idempotently as part of the **Local install refresh**, and explicit commands are available to repair or inspect it without reinstalling skills or rebuilding the binary:

```sh
mt shell install
mt shell init bash
mt shell init zsh
```

The directive protocol supports only directory changes. It does not include Worktrunk's arbitrary shell execution directive.

CLI output for these operations goes through a semantic `mt` logger built on `picocolors`. The logger exposes intent-level methods such as `success`, `warning`, `hint`, `info`, and `error`, inspired by Worktrunk's styling layer. It routes all output through `Runtime.writeStdout` and `Runtime.writeStderr`, never through `console.log`.

Status messages go to stderr. Primary data and parseable command output stay on stdout. This keeps CLI output testable through `createRuntime({ onStdout, onStderr })`, avoids global console monkeypatching in tests, preserves stdout for machine-readable data and paths, centralizes color and no-color behavior, keeps shell-integration messages predictable, and avoids accidental extra newlines or mixed status/data output.

monke-tools reports navigation honestly:

- When an **Active shell adapter** accepts the request, it reports that it switched to the target worktree.
- When shell integration is configured but inactive for the current invocation, it reports the target path and explains that the shell must be restarted or `mt` must be invoked through the shell adapter.
- When shell integration is not configured, it reports the target path and explains how to configure automatic switching.

`Swing` accepts Session names, the source-checkout shortcut `^`, the previous target shortcut `-`, same-repo pull request shortcuts such as `pr:123`, and pull request URLs. The `^` shortcut navigates to the root repo's Source checkout without materializing, setting up, creating, or changing branches. Pull request targets resolve through the pull request's same-repo head branch name and then navigate to the existing Session with that name. Fork pull request targets and merge request targets are outside the first contract.

`mt swing <target> --codex` preserves the normal shell navigation behavior and additionally opens a new Codex app thread with the resolved absolute checkout path via `codex://threads/new?path=...`. The Codex app launch reports status on stderr so stdout remains reserved for the target path when shell integration is inactive.

## Considered Options

- Print the path only: rejected because the intended human workflow is immediate navigation after creating or choosing a Session.
- Try to `cd` directly from the binary: impossible for the parent shell in the normal subprocess model.
- Add an arbitrary shell execution directive now: rejected because there is no first-version Monke workflow requiring it, and it expands the trust boundary.
- Support all Worktrunk shells: rejected for the first version because bash and zsh cover the current local workflow while keeping the install surface small.
- Make `Swing` create missing worktrees: rejected because monke-tools already has a dedicated `Create` operation with materialization, resource, and state behavior.
- Use ad hoc `console.log` or free-form color helpers: rejected because shell integration needs predictable stdout/stderr separation and tests need to capture output through the runtime abstraction.

## Consequences

Human users get `mt create` and `mt swing` behavior that matches the workflow expectation: after success, the shell lands in the relevant Session worktree when integration is active.

Automation that invokes the binary without shell integration will receive an explicit target path and guidance instead of a misleading "switched" message.

Agents and non-interactive subprocess callers cannot rely on shell integration to mutate their host process working directory. They should read the target path from command output or run follow-up work with an explicit working directory.

Tests can assert status and data output separately through `Runtime` sinks, and future commands have one place to enforce color, no-color, newline, and stdout/stderr policy.
