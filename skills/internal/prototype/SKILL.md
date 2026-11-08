---
name: prototype
description: Build a throwaway prototype to answer a design question. Use when the user wants to sanity-check whether a state model or logic feels right, or explore what a UI should look like.
---

Follow [Matt Pocock's prototype workflow](../../references/imported/prototype/MAIN.md)
and the branch file it points to.

On the UI branch, invoke the `impeccable` skill before drafting variants: run its
setup and read its craft-floor.md, then write every variant to that floor. Each
variant still takes a structurally different direction, per the prototype workflow.

The prototype workflow's "Skip the polish" still holds for variant code: no tests,
error handling, hardening, or edge-case work. The `impeccable` skill's "Finish the
job" applies when the winner is folded into real code.
