---
id: TASK-12
title: 'PRD: Install distributed skills into agent roots'
status: To Do
assignee: []
created_date: '2026-06-07 23:20'
updated_date: '2026-06-07 23:25'
labels:
  - ready-for-agent
dependencies: []
references:
  - CONTEXT.md
  - docs/adr/0001-install-distributed-skills-into-agent-roots.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem Statement

monke-tools is meant to be installed once on a teammate machine and then leveraged from any Consumer repo. The current skill distribution approach is too tied to package-manager and Intent-style loading: it requires a package discovery layer, per-repo skill-loading instructions, and package-manager links that do not match the product model of a single local tool install shared across repos.

The user wants monke-tools to directly distribute shared team skills through the same local install that provides the mt command. Agents should see those skills globally without each Consumer repo carrying extra loading guidance, and the install should work for Codex, Claude, Cursor, and one custom agent skill root.

## Solution

Replace Intent-based skill distribution with direct installation of Distributed skills into selected Agent skill roots. monke-tools keeps a Skill source tree in its source checkout, organized into Internal skills owned by monke-tools and Imported skills brought in from elsewhere. A Local install refresh installs the mt command, records the Installed source checkout in Global monke config, and symlinks the Skill source tree into each selected Agent skill root under an always-named monke-tools Skill namespace.

Add an interactive Skills Configure operation exposed as mt skills configure. It presents a multi-select of Codex, Claude, Cursor, and Custom targets, requires at least one target, prompts for a custom path only when Custom is selected, stores the Skill install preference in Global monke config, and immediately reconciles the selected targets. Later local installs reuse the stored preference. When no preference exists, local install invokes Skills Configure after installing mt.

## User Stories

1. As a teammate installing monke-tools, I want one local install to provide both the mt command and shared team skills, so that I do not need a separate skill-distribution setup.
2. As a teammate working across many Consumer repos, I want Distributed skills to be globally available to my agents, so that every repo can benefit without per-repo loading instructions.
3. As a teammate using Codex, I want monke-tools to install skills into the Codex Agent skill root, so that Codex can use monke-tools guidance anywhere on my machine.
4. As a teammate using Claude, I want monke-tools to install skills into the Claude Agent skill root, so that Claude can use the same team guidance.
5. As a teammate using Cursor, I want monke-tools to install skills into the Cursor Agent skill root, so that Cursor can use the same team guidance.
6. As a teammate with a custom agent environment, I want to provide one custom Agent skill root, so that monke-tools can support tools such as repo-local agent skill folders.
7. As a teammate configuring skills, I want a multi-select target prompt, so that I can choose any combination of supported agents in one flow.
8. As a teammate configuring a custom target, I want to enter a custom path only when Custom is selected, so that the common path stays simple.
9. As a teammate reconfiguring skills, I want the existing Skill install preference to be preselected, so that I can make small changes without rebuilding the whole selection from memory.
10. As a teammate keeping a custom target, I want the existing custom path to be reused by default, so that reconfiguration does not force me to retype it.
11. As a teammate removing a target, I want monke-tools to remove its managed monke-tools namespace from that target, so that deselection actually takes effect.
12. As a teammate installing from a fresh machine, I want local install to prompt me for skill targets when no preference exists, so that first install leaves skills usable.
13. As a teammate refreshing a local install, I want monke-tools to reuse my saved Skill install preference, so that refreshes do not repeatedly ask the same questions.
14. As a teammate moving the monke-tools checkout, I want local install to update the Installed source checkout and relink managed namespaces, so that global skills point to the current source tree.
15. As a teammate whose selected target is missing its skill directory, I want monke-tools to create the Agent skill root, so that a clean machine works without manual mkdir steps.
16. As a teammate with one broken selected target, I want monke-tools to still reconcile the other selected targets, so that one agent problem does not block all skill refreshes.
17. As a teammate running install scripts, I want local install to fail overall if any selected target fails, so that partial failures are visible.
18. As a teammate with existing non-monke files under an agent skill root, I want monke-tools to avoid clobbering real directories or files, so that install is safe.
19. As a teammate with an existing monke-tools symlink namespace, I want monke-tools to treat it as managed, so that relinking after a checkout move is painless.
20. As a teammate reading my agent skill root, I want all monke-tools-installed skills under a monke-tools namespace, so that ownership is obvious.
21. As a maintainer, I want the source Skill source tree and installed Skill namespace to share the same category layout, so that it is obvious where each installed skill came from.
22. As a maintainer, I want Internal skills separated from Imported skills, so that monke-tools-owned guidance and outside guidance have clear ownership boundaries.
23. As a maintainer, I want to call outside skills Imported skills rather than external skills, so that the term external remains reserved for repo dependency configuration.
24. As a maintainer, I want the Core distributed skill to have a globally clear Agent skill name, so that agent-visible names do not collide with generic skills named core.
25. As a maintainer, I want Imported skills to preserve upstream Agent skill names by default, so that imports remain compatible with their source projects.
26. As a maintainer, I want Global monke config to store built-in target kinds rather than derived paths, so that target path resolution can evolve in monke-tools.
27. As a maintainer, I want Global monke config to store the custom path as an absolute path, so that later installs are unambiguous.
28. As a maintainer, I want built-in target paths to resolve against the OS home directory, so that MONKE_HOME only controls monke-tools state and not external agent roots.
29. As a maintainer, I want the Installed source checkout recorded in Global monke config, so that the compiled mt command can reconcile skills from anywhere.
30. As a maintainer, I want monke-tools to fail clearly when the configured Installed source checkout is missing, so that it does not guess the wrong source tree.
31. As a maintainer, I want local install to avoid package-manager links, so that skill distribution does not depend on npm or package-manager global roots.
32. As a maintainer, I want local install to delegate skill rules to monke-tools code, so that YAML config and symlink behavior are tested in TypeScript rather than shell.
33. As a maintainer, I want an ADR describing direct Agent skill root installation, so that future contributors do not reintroduce Intent-style package discovery.
34. As an implementing agent, I want clear glossary terms for Distributed skill, Agent skill root, Skill namespace, Skill install target, and Skill install preference, so that implementation uses the project language consistently.
35. As an implementing agent, I want focused acceptance criteria, so that the feature can be split into independently testable slices.

## Implementation Decisions

- Replace Intent-based package discovery with direct installation into Agent skill roots.
- The Skill namespace is always named monke-tools and is the only path monke-tools owns inside an Agent skill root.
- The Skill namespace is a single symlink to the Skill source tree, not a set of per-skill symlinks.
- Any symlink at the explicit monke-tools Skill namespace path is treated as a Managed skill namespace and may be relinked.
- Real files or directories at the monke-tools Skill namespace path are not managed and must cause that target to fail.
- The Skill source tree is organized as internal and imported categories, and the installed namespace mirrors that category layout.
- The current core skill moves into the internal category and uses monke-tools-core as its Agent skill name.
- Imported skills preserve their upstream Agent skill name by default.
- Global monke config is versioned YAML at config.yml under monke home and stores the Installed source checkout plus the current Skill install preference. With the default monke home, this is ~/.monke/config.yml.
- Global monke config stores only the current preference, not historical preferences.
- Global monke config uses a structured version 1 shape for skill targets: built-ins store only kind, and custom stores kind plus an absolute path.
- Built-in Skill install targets are Codex, Claude, and Cursor.
- Codex resolves to ~/.codex/skills, Claude resolves to ~/.claude/skills, and Cursor resolves to ~/.cursor/skills.
- Built-in target preferences store only the target kind; built-in Agent skill roots are resolved at install time.
- Built-in Agent skill roots resolve against the OS home directory, not monke home.
- A Skill install preference must contain at least one target.
- A Skill install preference may contain at most one Custom skill install target.
- A Custom skill install target path means an Agent skill root, not the monke-tools namespace path itself.
- Custom target input may use home-directory shorthand, but Global monke config stores it as an absolute path.
- Skills Configure is interactive-only in this version.
- Skills Configure starts from the existing Skill install preference when one exists.
- Skills Configure asks for target selection before custom path input.
- Skills Configure saves the preference and then reconciles the selected targets immediately.
- Skills Configure removes Managed skill namespaces from previously selected targets that are no longer selected.
- Local install installs mt before writing the Installed source checkout.
- Local install writes the Installed source checkout before invoking Skills Configure or reconciling targets.
- Local install invokes Skills Configure when no Skill install preference exists.
- Local install always includes skill installation; there is no binary-only escape hatch.
- Local install attempts all selected target reconciliations, then fails overall if any selected target failed.
- Local install does not use package-manager links.
- Local install delegates skill configuration and reconciliation behavior to monke-tools code rather than reimplementing it in shell.
- The CLI command is mt skills configure and should be added through the existing Commander command tree.
- The README and package metadata should remove Intent references and describe direct Distributed skill installation.
- The existing ADR should describe direct Agent skill root installation, not package-manager discovery.

## Testing Decisions

- Tests should verify external behavior through CLI commands, Global monke config contents, symlink state, install output, and exit behavior rather than private helper implementation details.
- Add focused tests for Global monke config loading, saving, validation, and migration-safe defaults.
- Add focused tests for Skill install target resolution, including built-in target kinds, OS-home expansion, custom path normalization, and rejection of invalid custom paths.
- Add focused tests for Skill namespace reconciliation, including missing root creation, missing namespace creation, relinking existing symlinks, refusing real directories or files, and removing deselected managed namespaces.
- Add focused tests for partial target failure behavior: all selected targets are attempted, successful targets remain reconciled, and the overall operation fails when any selected target fails.
- Add CLI tests for mt skills configure through Commander, using test seams for interactive answers instead of relying on a real terminal.
- Add local install tests or script-level smoke coverage for removing package-manager link behavior, writing the Installed source checkout, invoking configure when no preference exists, and reconciling when a preference already exists.
- Add an end-to-end install/configure validation that exercises all four target kinds: Codex, Claude, Cursor, and Custom. The final configure run should select only Claude and Codex, then validate the monke-tools namespace exists for Claude and Codex and is absent for Cursor and Custom.
- Add package metadata and docs checks that no Intent dependency, keyword, or install instruction remains.
- Existing CLI tests are good prior art for Commander command behavior and usage errors.
- Existing registry and materialization tests are good prior art for YAML-backed state and filesystem behavior.
- The deepest testable modules should be Global monke config handling and skill target reconciliation, because they encapsulate a lot of behavior behind stable interfaces.

## Out of Scope

- Multiple custom Skill install targets.
- Non-interactive flags for Skills Configure.
- A binary-only local install mode.
- A separate skills install, skills refresh, or uninstall command.
- Per-Consumer repo skill-loading guidance.
- TanStack Intent integration or package-manager global discovery.
- Package-manager links as part of local install.
- Copying skill files instead of symlinking the Skill source tree.
- Renaming Imported skills by default.
- Supporting additional built-in agents beyond Codex, Claude, and Cursor.
- Automatically searching for a replacement Installed source checkout when the configured checkout is missing.

## Further Notes

The grill-with-docs session updated the glossary and ADR around the new model. The important conceptual shift is that monke-tools no longer exposes skills for discovery by a package tool. It directly installs Distributed skills into explicit Agent skill roots selected by the user and remembered in Global monke config.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Global monke config stores the Installed source checkout and a non-empty current Skill install preference as versioned YAML at config.yml under monke home.
- [ ] #2 The skills source layout uses internal and imported categories, with the current core skill moved under internal and renamed to the monke-tools-core Agent skill name.
- [ ] #3 mt skills configure is implemented as an interactive Commander subcommand that supports Codex, Claude, Cursor, and one Custom target.
- [ ] #4 Skills Configure preselects existing preferences, reuses the existing custom path when custom remains selected, removes custom when deselected, saves the new preference, and reconciles selected targets immediately.
- [ ] #5 Built-in targets resolve to ~/.codex/skills, ~/.claude/skills, and ~/.cursor/skills against the OS home directory while MONKE_HOME continues to affect only monke-tools state and config.
- [ ] #6 Custom target input accepts home-directory shorthand, stores an absolute path, and treats the path as an Agent skill root containing the monke-tools namespace.
- [ ] #7 Target reconciliation creates missing Agent skill roots and creates or relinks the monke-tools namespace as a symlink to the Skill source tree.
- [ ] #8 Target reconciliation refuses to overwrite a real file or directory at the monke-tools namespace path.
- [ ] #9 Deselecting a previously selected target removes its Managed skill namespace when the namespace is a symlink.
- [ ] #10 Local install installs the mt binary, records the Installed source checkout, invokes Skills Configure when no preference exists, and reconciles existing preferences on later runs.
- [ ] #11 Local install attempts every selected target and exits unsuccessfully after reconciliation if any selected target failed.
- [ ] #12 Local install no longer requires npm, runs npm link, creates package-manager links, or references TanStack Intent.
- [ ] #13 README, package metadata, lockfile, and ADR content describe direct Distributed skill installation and contain no Intent distribution instructions.
- [ ] #14 Focused tests cover config handling, target resolution, symlink reconciliation, configure flow, local install behavior, partial failures, and docs/package cleanup.
- [ ] #15 An end-to-end install/configure validation exercises Codex, Claude, Cursor, and Custom, then finishes with a configure run selecting only Claude and Codex and validates Cursor and Custom no longer have a monke-tools namespace.
<!-- AC:END -->
