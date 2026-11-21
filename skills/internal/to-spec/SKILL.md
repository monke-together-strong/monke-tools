---
name: to-spec
description: "Turn the current conversation into a Spec without an interview and publish it to the project issue tracker."
disable-model-invocation: true
---

Follow [Matt Pocock's base Spec workflow](../../references/imported/to-spec/MAIN.md).

Present the Spec for approval before publishing. First compare it against earlier agreements and relevant ADRs, and account for intentional exclusions.

Before publishing, commit the session's documentation changes that are not on the default branch, such as `GLOSSARY.md` and ADR edits, to a work branch and push it. Start the Spec with `Working branch: <branch URL>`, so the implementation builds on it.

Scope the Spec to ship as one PR. List work that must happen after the PR merges in its own section.

When the user says "ship it", after to-spec or to-tickets, start a new thread with `$ship-spec <spec URL>`.
