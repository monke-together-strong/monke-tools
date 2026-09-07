Only packages listed in `scripts/tegami.mts` are published with Tegami. Today that is
`@monke-together-strong/oxc-config` alone. A change to one of those packages must include a
`.tegami/` release entry naming that package with its version impact. The `monke-tools` CLI is
released through its own bundle workflow, so its changes never add a `.tegami/` entry.
Put the release-note body under a Markdown heading (e.g. `## Fix configuration`) after the YAML
frontmatter.
