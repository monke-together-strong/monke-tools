---
name: code-review
description: Review changes since a fixed point along separate Standards and Spec axes. Use for branch, PR, or work-in-progress reviews against an issue, PRD, or other spec.
---

Before starting a review, read and follow:

- [Matt Pocock's base review workflow](../../references/imported/code-review/MAIN.md)

Use the base workflow unchanged, with this sentence added to both sub-agent
briefs: "When a correctness finding exposes a broken invariant, inspect
analogous states and directly affected production paths, then report the defect
class and all confirmed instances together."

When the base workflow identifies coding-standards sources, include both:

- [the Team coding baseline](../../references/internal/CODING_STANDARDS.md)
- Repo coding standards discovered by the base workflow

Apply the Team coding baseline as defaults. Repo coding standards take precedence on conflicts.
