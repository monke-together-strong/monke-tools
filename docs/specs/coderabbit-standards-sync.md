# CodeRabbit team coding baseline synchronization

## Objective

Publish the **Team coding baseline** from monke-tools to CodeRabbit's organization-wide central configuration without moving its source of truth out of this repository.

## Source ownership

- `skills/references/internal/CODING_STANDARDS.md` is the authoritative root document.
- The renderer recursively follows repository-relative Markdown links that remain inside `skills/references/`.
- `config/coderabbit/sources.yaml` declares additional excerpt sources without changing or linking them from the authoritative root document.
- The code-review reference remains immutable. Its configured excerpt begins at the unique paragraph whose normalized Markdown text contains `the smell baseline below` and ends before the next heading at depth three or less.
- Configured excerpts render under their synthetic heading without source-path or extraction-anchor metadata, while their source paths remain internal synchronization inputs.
- External links are preserved but never fetched.
- Images, anchors, and non-Markdown links are not traversed.
- Missing or out-of-bound local Markdown links fail generation.
- Already visited documents are emitted once, terminating cycles deterministically.
- The root document is emitted first. Each linked dependency follows with its repository path as provenance; configured excerpts do not emit provenance.
- Repo coding standards and `AGENTS.md` override conflicting Team coding baseline rules.

## Configuration ownership

- `config/coderabbit/template.yaml` is the hand-edited source for central CodeRabbit customization outside the baseline.
- The renderer owns the global `reviews.path_instructions` entry whose path is `**/*` and rejects a template collision on that path.
- Narrower hand-authored path instructions remain supported.
- The template enables repository-local `**/CODING_STANDARDS.md` discovery. CodeRabbit already discovers `AGENTS.md`.
- monke-tools does not add a repository-local `.coderabbit.yaml`.
- The downstream `monke-together-strong/coderabbit/.coderabbit.yaml` is entirely generated and must not be edited manually.

## Publishing

- The unprivileged detection and validation job runs for relevant pull requests and pushes to `monke-tools/main`.
- The credentialed publishing job runs only after a relevant push to `main`; pull requests cannot load its environment or destination credential.
- The unprivileged portion discovers the current dependency graph and compares it with paths changed by the triggering event.
- Irrelevant changes exit before the publishing credential is loaded.
- Relevant changes render the configuration, enforce CodeRabbit's 20,000-character instruction limit, and validate it with a pinned CodeRabbit CLI.
- A private, organization-owned GitHub App installed only on `monke-together-strong/coderabbit` supplies a short-lived token with Contents write access.
- The workflow clones the current downstream `main`, overwrites only `.coderabbit.yaml`, creates a commit containing the monke-tools source SHA, and pushes it as a fast-forward to `main`.
- Identical output produces no downstream commit.
- Publishing never force-pushes.
- To retry a failed publication, an operator re-runs the failed GitHub Actions workflow run.
- Downstream drift remains until the next triggered synchronization, which restores the generated file.
- Rollback happens by reverting `monke-tools/main`.

## Repository and policy setup

- The central repository is the private GitHub repository `monke-together-strong/coderabbit`.
- Its `main` branch is intentionally unprotected while the organization remains on GitHub Free.
- The GitHub App ID is a non-secret Actions environment variable.
- The App PEM private key is an Actions environment secret and is never logged or committed.
- CodeRabbit is installed on the central repository after its initial configuration exists.
- If available, CodeRabbit Global Overrides contains only `inheritance: true` so future repository configs cannot suppress the central fallback.
- Without Global Overrides, current repositories consume central configuration directly; future local `.coderabbit.yaml` files must set `inheritance: true`.

## Verification

- Unit tests cover recursive rendering, linked-document provenance, semantic excerpt extraction, missing and ambiguous excerpt anchors, cycles, missing and out-of-bound links, instruction-size enforcement, template collision, deterministic output, and relevant-change detection.
- `vp check` and the complete test suite pass.
- The generated file passes `cr config validate`.
- Rollout checks CodeRabbit's resolved configuration in one Consumer repo with Repo coding standards and one without them.
