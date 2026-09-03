# Session v2 local cutover receipt

- Work target: [#153](https://github.com/monke-together-strong/monke-tools/issues/153)
- Parent context: [#150](https://github.com/monke-together-strong/monke-tools/issues/150)
- Cutover date: 2026-09-03
- v2 source commit: `1a540d982694fba8f8b3f2611c180ae074128067`

## Inventory and backups

- The live store contained 119 v1 Session records, not the issue snapshot's 116. The cutover inspected all 119 across 11 Root-repo paths.
- Those records contained 160 repo records: 145 recorded worktrees existed and 15 were already missing.
- The complete original state directory was copied byte-for-byte before cleanup or conversion to `/Users/hoangbn/.monke/session-state-backups/issue-153-original-20260903T064327Z`.
- The 94 retained v1 records were copied byte-for-byte immediately before conversion to `/Users/hoangbn/.monke/session-state-backups/issue-153-retained-v1-20260903T064327Z`.

## Inspection and cleanup

- Every reachable Root repo was inspected through serialized `mt cleanup --merged --dry-run` passes. The lifecycle inspection checked registered worktree identity, branch identity, dirty/untracked state, exact merged-PR evidence, local-versus-merged HEAD identity, and missing worktrees.
- Dirty, detached, branch-mismatched, ambiguous-history, missing-Source, and no-exact-PR cases were retained.
- 23 worktrees proven merge-cleanable were removed through `mt cleanup --merged`. Their local branches were preserved.
- 25 Session state records were retired: 23 through the supported lifecycle and 2 missing-Source validation records after their recorded exchange cleanup obligations were resolved directly against the current equivalent entrypoint.
- Seven final cleanup obligations were resolved. Six transient composite-command failures occurred because the first attempts lacked Discord credentials or a legacy record lacked a channel name; all were retried or conservatively resolved. Final cleanup failures: 0.
- Cleanup effects observed during the cutover included three cancelled exchange orders and one closed exchange position. The two missing-Source validations had no remaining orders or positions for their four recorded symbols.
- Retained dirty/useful/ambiguous Sessions: 94.

## Conversion

- Converted Session records: 94.
- Converted repo records: 129, comprising 128 retained v1 repo records plus one explicit pending Root repo for `demo-review-db-skill`, whose old sequential Spawn had recorded only its dirty dependency before the Root worktree was created.
- Lifecycle generations: 43 complete, 23 incomplete, 28 not-started config-less Sessions.
- Repo lifecycle: 77 materialized, 52 pending; 94 cleanup-eligible and 35 cleanup-ineligible.
- Preserved values were compared field-for-field with the retained-v1 backup with zero mismatches: 298 Assigned ports, 59 diff-base refs, 34 Cleanup commands, 31 Resource values, 46 Resource command records, and 152 Resource command outputs. No retained record had a default-branch pinned ref or `spawnSource` identity to preserve.
- No v1 parser, migration command, or conversion utility remains in the checkout.

## Validation and activation

- Strict pre-activation v2 load: 94/94 records passed; final validation failures: 0.
- Deliberate v1 fixture: rejected with `Unsupported Session state version 1 ... monke-tools requires strict v2 Session state` before and after activation.
- Active local install: `/Users/hoangbn/.monke/installs/local-1a540d9-Hb4vTc`, built cleanly from commit `1a540d982694fba8f8b3f2611c180ae074128067`.
- Post-activation live-store load: `mt cleanup` loaded the entire retained store and reported 0 dead Sessions.
- Representative v2 lifecycle proof: configured Spawn, retry of a retained prepared worktree, Swing, explicit Materialize, clean Chop, and Cleanup all succeeded. Swing also resolved the retained `prep-materialization` Session.
