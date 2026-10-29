---
name: monke-config
description: Configure a repo for Monke. Use when authoring monke.yml, resource modules, or a root PR.md or POST_MERGE.md.
---

# Monke configuration

Author root `monke.yml` and its resource modules using the
[configuration reference](references/monke-yml.md).

Monke's workflow skills also read these optional root files, each defined by its skill:

- `PR.md`: the repo's PR requirements for [pr](../pr/SKILL.md), in place of the user's defaults.
- `POST_MERGE.md`: the repository contract for [post-merge](../post-merge/SKILL.md). It states
  the merged PRs it covers and names their environment, deployment gate, and checks.
