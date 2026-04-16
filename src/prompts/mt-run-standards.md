# Coding Standards

<!-- Shared Monke-owned coding standards for mt run.
     Derived from Sandcastle's reviewer templates and loaded for both the
     implementer and reviewer so the workflow shares the same expectations. -->

## Style

- Prefer existing repo patterns, naming, and helper shapes over new abstractions.
- Keep changes tightly scoped to the requested plan.
- Favor straightforward control flow over clever compaction.
- Keep user-facing workflow summaries short and literal.

## Testing

- Add or update focused tests when observable behavior changes.
- Prefer assertions at CLI or module boundaries over brittle snapshots of internal wording.
- Run the checks that are proportionate to the touched code before finishing a pass.

## Architecture

- Keep workflow sequencing separate from prompt and standards loading.
- Treat the user plan as opaque input and pass it through exactly.
- Leave implementer and reviewer edits in the working tree; cleanup is the only phase allowed to commit.
