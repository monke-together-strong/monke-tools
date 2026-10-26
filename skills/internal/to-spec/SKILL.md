---
name: to-spec
description: "Turn the current conversation into a spec and publish it to the project issue tracker: no interview, just synthesis of what you've already discussed."
disable-model-invocation: true
---

Follow [Matt Pocock's base spec workflow](../../references/imported/to-spec/MAIN.md).

Before publishing, commit the session's documentation changes that aren't on the default branch, such as Glossary and ADR edits, to a work branch and push it. Start the spec with `Working branch: <branch URL>`, so the implementation builds on it.
