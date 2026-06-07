---
id: TASK-11
title: Simplify docker compose startup for session worktrees
status: To Do
assignee: []
created_date: '2026-06-07 18:14'
updated_date: '2026-06-07 18:15'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Winter's Echo currently needs a long package script to start Docker services from an app worktree:

`infra:up`: `sh -c 'if [ -f ../../.env ]; then dotenvx run --env-file ../../.env -- docker compose -f ../../docker-compose.yml --profile true-ice up -d --wait; else docker compose -f ../../docker-compose.yml --profile true-ice up -d --wait; fi'`

This is hard to read, hard to copy between apps, and exposes repeated knowledge about where the repo root `.env` and `docker-compose.yml` live relative to a session app. Explore a monke-tools utility or config-backed command that lets consumer repos express Docker startup in a shorter, safer way while preserving env-file loading and compose profile support.

The first implementation pass should compare options before building: for example a generic `mt docker up` helper, a reusable command wrapper that resolves session root paths, or `monke.yml`-declared service commands that can be materialized into app scripts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A recommended design is documented for simplifying Docker startup from nested app worktrees, including how it resolves the repo root `.env` and `docker-compose.yml`.
- [ ] #2 The design accounts for compose profiles, `up -d --wait`, missing `.env` fallback behavior, and use from both source checkouts and session worktrees.
- [ ] #3 A narrow implementation path is proposed or built that lets Winter's Echo replace the long `infra:up` shell script with a substantially shorter command.
- [ ] #4 The approach avoids hard-coded `../../` path assumptions in consumer package scripts.
- [ ] #5 Focused tests or documented verification cover env-present and env-absent Docker startup command generation or execution.
<!-- AC:END -->
