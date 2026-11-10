---
name: to-spec
description: "Turn the current conversation into a spec and publish it to the project issue tracker: no interview, just synthesis of what you've already discussed."
disable-model-invocation: true
---

Follow [Matt Pocock's base spec workflow](../../references/imported/to-spec/MAIN.md).

Before presenting a spec for approval, compare it against earlier agreements and relevant ADRs, accounting for intentional exclusions.

Before publishing, commit the session's documentation changes that aren't on the default branch, such as Glossary and ADR edits, to a work branch and push it. Start the spec with `Working branch: <branch URL>`, so the implementation builds on it.

Scope the spec to ship as one PR. List work that must happen after the PR merges in its own section.

When the user says "ship it", after to-spec or to-tickets, start a new thread with `$ship-spec <spec URL>`.
