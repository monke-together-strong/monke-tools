# Use shell integration for create and swing navigation

monke-tools creates and manages **Session worktrees**, but a normal CLI subprocess cannot change the parent interactive shell's current directory. Navigation after `mt create` and `mt swing` therefore needs an explicit Shell adapter instead of pretending that the binary can `cd` for the caller.

## Decision

`mt` uses a file-backed **Shell directory directive**. The bash and zsh Shell adapter wraps the real monke-tools binary, creates a temporary directive file, invokes the binary with `MONKE_SHELL_DIR_DIRECTIVE` pointing at that file, and changes directory only after the binary exits successfully and the file contains a target path.

The binary treats Shell integration as active only when it can write the requested directory to the directive file. When the directive is accepted, navigation commands report `Switched to <path>` on stderr. When no active adapter accepts the request, they report `Switch to <path>` on stderr and write the path itself to stdout so subprocess callers and agents can use the target explicitly.

Shell integration install is explicit and idempotent. `mt shell install` refreshes managed blocks in `~/.zshrc` and `~/.bashrc`; `mt shell init zsh` and `mt shell init bash` print the generated adapter for inspection. The local install refresh runs `mt shell install` after rebuilding the binary, so the adapter points at the current local executable.

`mt swing` is navigation-only. It resolves existing targets for the current Root repo: a Session name, `^` for the Source checkout, `-` for the Previous Swing target, and same-repo GitHub PR targets (`pr:<number>` or a GitHub pull request URL) whose head branch matches an existing Session. It does not create worktrees or change branches. Previous Swing target history is stored under Monke home and scoped by Root repo.

## Consequences

Create and Swing status text goes to stderr through the semantic logger. Parseable payloads stay on stdout: shell init adapter text and fallback target paths when the shell cannot move the caller.

Configured-but-inactive shells can be distinguished from unconfigured shells by checking the managed startup-file block. This gives users a repair hint without implying that a subprocess changed their working directory.

The first Swing target set deliberately excludes `@`, merge request targets, fork PR mapping, and create-on-demand behavior. Unsupported targets fail clearly so a future version can add them behind explicit behavior rather than accidental branch or worktree mutation.
