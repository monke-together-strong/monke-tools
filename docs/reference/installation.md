# Tool installation and releases

See [CONTEXT.md](../../CONTEXT.md) for shared session, repo, and port terminology.

## Language

**Local tool install**: A developer-machine install of monke-tools built from a source checkout and shared by all **Consumer repos** through the `mt` command.

**Release install**: A developer-machine install of monke-tools activated from an official tagged release rather than a source checkout.

**Customized release install**: A **Release install** whose projected **Distributed skills** or **Distributed references** differ from their recorded release hashes. A **Release update** reports the changed paths and refuses to replace it.

**Release bundle**: A platform-specific published artifact for one monke-tools release containing the `mt` executable and its matching **Distributed skills**, **Distributed references**, and **Global agent instructions**.

**Release update**: An explicit `mt update` operation that selects the newest stable official **Release bundle** and activates it as a **Release install**, including when replacing a **Local tool install**; it refuses to replace a **Customized release install**.

**Active tool install**: The one **Local tool install** or **Release install** currently selected by the stable `mt` command.

**Tool build identity**: The human-readable identity reported by `mt --version`: an official semantic version for a **Release install**, or `local+<short-commit>` with a `-dirty` suffix when applicable for a **Local tool install**. Update decisions use the **Install manifest**, not this display string.

**Install activation**: The act of selecting one **Local tool install** or **Release install** as the **Active tool install**.

**Install manifest**: Machine-owned provenance stored inside one versioned **Local tool install** or **Release install** and selected with it during **Install activation**. A release manifest records its version, commit, tag, artifact digest, minimum Codiff version, and original guidance hashes; a local manifest records its source checkout and commit. _Avoid_: Global monke config, release notes, lock file

**Update staging directory**: A unique temporary directory under the **Monke home** where a candidate **Release bundle** is downloaded, unpacked, and fully verified before it can participate in **Install activation**.

**Installation mutation lock**: The machine-wide lock that serializes tool-managed changes to installed monke-tools versions, the active-install pointer, and agent guidance projections without blocking ordinary `mt` commands or direct edits to projected guidance.

**Release installer**: The official first-install workflow that creates a **Release install** from a verified **Release bundle**.

**Release bootstrap**: The small public shell entrypoint that detects the platform, discovers and verifies the newest stable **Release bundle**, and delegates installation to bundle-owned code.

**Mainline release**: A stable monke-tools release automatically published after a qualifying push to `main` passes static and artifact validation. It increments the latest `monke-tools-v*` patch version without a **Release PR** or repo version-bump commit.

**Codiff runtime dependency**: The externally released Codiff executable used by `mt diff`, managed through Homebrew on macOS arm64 and accepted when it meets the minimum version required by the **Active tool install**; it is not version-aligned with a **Release bundle**.

**Local install refresh**: The act of rebuilding the **Local tool install** from the current monke-tools source checkout before validating behavior in a **Consumer repo**.

**Global monke config**: Machine-local monke-tools preferences that apply across **Consumer repos** and are stored outside any repo checkout as versioned YAML at `config.yml` under the monke home directory. _Avoid_: Repo config, session state, monke.yml

**Installed source checkout**: The monke-tools source checkout used by the current **Local tool install**.

**Skill authoring mode**: The **Local tool install** state in which installed **Distributed skills** and **Distributed references** remain live-editable in the **Installed source checkout** as tracked source changes.

**Shared Oxc presets**: Team-owned lint and format policy distributed for consistent use across **Consumer repos**.

**Release entry**: A pending description of a consumer-visible package change and its intended version impact.

**Release PR**: An automatically maintained pull request that applies pending package versions and release notes; merging it authorizes immediate publication.

## Installation scope

One tool install serves multiple Consumer repos without a package-manager link.
Monke home may hold worktrees for many repos. Machine preferences live in
`$MONKE_HOME/config.yml` (default `~/.monke/config.yml`, format version `1`).
The Installed source checkout comes from the active local Install manifest; a
missing checkout is an error, not a reason to infer a replacement. It owns the
Skill source tree. See [agent guidance](agent-guidance.md) for target selection
and projection rules.

## Activation and recovery

Refresh the local install before validating source changes in a Consumer repo.
A refresh builds a unique versioned install and records its source checkout in
the manifest before configuring or reconciling skills. It delegates that work to
monke-tools rather than implementing it again in shell. The stable
`~/.local/bin/mt` symlink resolves through the active-install pointer.

The Installation mutation lock serializes refresh, target configuration,
activation, and managed-install cleanup. Activation selects the candidate
atomically. Success retains it and its immediate predecessor, cleaning only
validated older managed installs. Failed activation preserves the prior active
install and performs no predecessor cleanup.

A Codiff reconciliation failure after activation leaves the new install selected;
retry that dependency with `mt install-dependencies`.
