---
id: TASK-13
title: Add repo setup validation skill
status: To Do
assignee: []
created_date: '2026-06-11 15:32'
labels:
  - ready-for-agent
dependencies: []
references:
  - skills/internal/monke-tools-core/SKILL.md
modified_files:
  - skills/internal/repo-setup-validation/SKILL.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add a monke-tools-owned internal distributed skill that agents can run in a consumer repo to validate that the repo is correctly configured for monke-tools before creating or refreshing session worktrees.

The skill should make setup failures obvious and actionable: it should verify the expected monke-tools files and commands, inspect the consumer repo configuration, and report precise remediation steps without mutating the repo unless the user explicitly asks for fixes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A new internal distributed skill exists under the monke-tools skill source tree with clear trigger guidance for validating consumer repo setup.
- [ ] #2 The skill validates core readiness signals including mt availability, monke.yml presence and parseability, declared app env files, external dependency paths, port/resource mappings, bootstrapCommand expectations, and cleanupCommand safety where configured.
- [ ] #3 The validation workflow is non-destructive by default and distinguishes checks that only inspect files from checks that would run mt setup, mt create, or mt materialize.
- [ ] #4 Validation output summarizes pass/fail status, names each failing repo setup condition, and provides concrete remediation steps that an agent can follow.
- [ ] #5 The implementation includes focused tests or fixture-based smoke coverage for at least one valid consumer repo setup and multiple invalid setup cases.
- [ ] #6 Relevant docs or skill index references make the new validation skill discoverable alongside monke-tools-core.
<!-- AC:END -->
