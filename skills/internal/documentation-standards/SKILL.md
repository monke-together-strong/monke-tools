---
name: documentation-standards
description: Use when writing or reviewing documentation, code comments, user-facing messages, glossaries, or domain terminology.
---

# Documentation standards

Repository requirements take precedence on conflicts.

- **Review mode.** Leave text unchanged. Reach a keep, cut, or correct decision for every passage in scope. List kept ranges by location and report each cut or correction as a finding.
- **Edit mode.** Decide what to cut before rewriting or adding, then check what remains for accuracy. Finish only after every passage in scope has a keep, cut, or correct decision.

Each finding names its location, evidence, problem, and smallest fix. Report unresolved questions and out-of-scope changes (code fixes, renames, public-contract changes) separately.

## Reader value

Keep only text that helps the reader act, decide, or understand a contract or constraint. Cut unnecessary explanations even when accurate. Leaving clear, accurate text unchanged is valid.

- **Conversation test.** Does the reader need this without seeing the conversation? Keep reasons and consequences. Move investigation history and review bookkeeping to commits, PRs, or issues.
- **Failure test.** Document an operational failure only when it is silent, misleading, or surfaces after a slow or irreversible step. Skip self-documenting startup or test errors. When a reference must list one, state the failing condition rather than the message text or fix it already prints. Skip unlikely edge cases.
- **Single source of truth.** Keep each fact in one authoritative place and link to it. Let code, configuration, and command help describe themselves. Cut implementation narration, duplicated explanations, and skill indexes (agents already see model-invoked skill descriptions).

## Code comments

Comment only what the code cannot express: design rationale, invariants, ordering constraints, surprising behavior with its consequence for future edits, and caller contracts (failure behavior, ownership, side effects, and unclear inputs or outputs). Warnings such as `IMPORTANT` or `do not remove` need a concrete reason.

- **Enforcement test.** Can a clearer name, type, assertion, or focused test enforce this? Use that first, and keep comments for the rationale it cannot express.
- Put local comments beside the code. Put multi-module rationale in a focused document or ADR and link from the code.
- Keep `TODO` and `FIXME` comments until you verify the underlying work is complete.

## Workarounds

Explain the cause of each necessary workaround or lint and type suppression until the underlying issue is fixed. Check every workaround or suppression against the affected code and actual callers. Flag avoidable workarounds per [principle-fix-root-causes](../../imported/principle-fix-root-causes/SKILL.md), even when their comments are accurate.

## Documentation

- In a how-to or skill, give one recommended path per distinct need with one complete, copyable example. Put details in the example rather than prose, and reuse one example domain across a repository.
- Consumer skills in `skills/` ship without the repository, so keep their references inside `skills/`.
- Consolidate related new ADRs that record one decision. Keep the decision and its reasons, and cut inventories of changed code.
- Use lists for parallel items and paragraphs for connected reasoning. Match the established audience, terminology, and structure.
- Apply [technical-writing](../../imported/technical-writing/SKILL.md) to text you write or correct, and [writing-for-agents](../../imported/writing-for-agents/SKILL.md) to agent-facing documents.

## User-facing messages

State the failing condition and the next action the reader can take. Use terms the reader sees elsewhere, and omit internal identifiers or implementation details the reader cannot act on.

## Glossary and terminology

Read `GLOSSARY.md` (or follow `GLOSSARY-MAP.md`), plus linked domain references and ADRs. Search in-scope terms across code, docs, comments, and user-facing labels, and check definitions against actual behavior, including glossary entries untouched by the diff.

Flag conflicting names for one concept, one term with conflicting meanings, vague terms, and missing or stale entries that cause ambiguity. Respect intentional differences between domain contexts, and keep glossary entries focused on domain definitions and relationships. Cite the conflicting usages, explain the misunderstanding, and propose a precise term or definition. Use [domain-modeling](../../imported/domain-modeling/SKILL.md) when changing the model.

## Accuracy

Verify claims, symbol names, commands, paths, examples, and link targets against the implementation and actual callers. Update affected docs and comments when behavior changes, cut stale claims, and separate unresolved questions from established behavior.
