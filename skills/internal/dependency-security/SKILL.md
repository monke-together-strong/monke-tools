---
name: dependency-security
description: Fix repository dependency-audit failures owner-first. Use when a repository security audit or CI audit reports vulnerable packages
---

# Repository Security Audit

Fix audit findings **owner-first**: upgrade the direct dependency owning each
vulnerable path, refresh compatible transitive patches, and use a parent-scoped
override only when the latest owner still pins the vulnerability.

## 1. Map Every Finding

Run the exact failing audit, using structured output when useful. For every
advisory, identify the installed and patched versions, dependency paths, nearest
direct owner, latest owner version, accepted child range, and any release-age or
trust policy holding the patch back.

Completion: every finding maps to an owner upgrade, compatible transitive
refresh, upstream-blocked override, or unavailable fix.

## 2. Remediate Owner-First

Apply one remediation level at a time and rerun the audit:

1. Upgrade the owner and any version-coupled peers.
2. Refresh the vulnerable child when the owner's range accepts the patch.
3. Add a parent-scoped override only when the latest owner pins or excludes it.

Treat automated audit repair as discovery: inspect its diff and replace global
overrides with the highest available level. Each remaining override must name
the parent and exact patched child, pass compatibility checks, and record the
upstream pin plus its removal condition.

Completion: every finding is resolved at the highest available level.

## 3. Preserve Audit Policy

Release-age exclusions, trust bypasses, ignored advisories, and reduced severity
are policy changes. Keep final policy unchanged unless the user explicitly
approves an exception. If policy blocks a patch, present the tradeoff between
waiting, a narrow exception, and a documented parent-scoped override; restore
temporary policy edits before the final diff.

Completion: the final configuration has no unapproved policy bypass.

## 4. Verify And Report

Regenerate checked artifacts, then run a frozen install, the full audit,
dependency-path inspection, relevant formatting/lint/type/build checks, tests,
and a diff check. If an owner upgrade breaks compatibility, isolate the package
and retain the smallest secure version set.

Report owner upgrades, refreshed children, overrides and removal conditions,
policy changes, verification, and unresolved upstream gaps.

Completion: the install is reproducible, the full audit and original failing
command are green, compatibility checks pass, and every non-lockfile change is
explained.
