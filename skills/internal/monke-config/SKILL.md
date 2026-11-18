---
name: monke-config
description: Configure a repo for Monke. Use when authoring monke.yml, resource modules, or a root PR.md or POST_MERGE.md.
---

# Monke configuration

Author root `monke.yml` and its resource modules using the
[configuration reference](references/monke-yml.md).

When authoring root `PR.md` or `POST_MERGE.md`, use the contract in the
[PR skill](../pr/SKILL.md#load-pr-requirements) or
[post-merge skill](../post-merge/SKILL.md#load-the-contracts), respectively.
A gitignored `PR.md` can be seeded into a Session from the Source checkout.
The post-merge skill looks for a gitignored `POST_MERGE.md` in the Source
checkout when the merge commit has no copy.
