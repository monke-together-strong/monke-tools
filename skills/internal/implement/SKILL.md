---
name: implement
description: Only use when explicitly mentioned with /implement or $implement.
---

The user's primary Spec, issue, plan, or direct request is the Work target.
Implement it.

When assigned a checkout, read its repo instructions, use absolute file paths,
and anchor every command to it. Confirm its root and branch before editing.

Follow [Basic Implementation](./BASIC-IMPLEMENTATION.md) for delegated tickets
and non-Spec work. A Parent Spec is background; the ticket defines scope.

For other Specs, discover tickets before choosing the implementation path.
For GitHub Specs, check the body, comments, native sub-issues, and timeline
cross-references; search referencing issues if uncertain. Read candidates to
confirm parent and scope, then record ticket URLs and blockers. An empty native
sub-issue list alone does not establish that no tickets exist.

- If tickets exist, follow [Spec Orchestration](./SPEC-ORCHESTRATION.md).
- If the checked sources establish no tickets, follow
  [Basic Implementation](./BASIC-IMPLEMENTATION.md). Report unavailable discovery
  sources before selecting this path.
