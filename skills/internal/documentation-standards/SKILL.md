---
name: documentation-standards
description: Use when writing or reviewing documentation, code comments, caller-facing text (messages, errors, API descriptions), glossaries, or domain terminology.
---

# Documentation standards

Repository requirements take precedence on conflicts.

- **Review mode.** Leave text unchanged. Reach a keep, cut, or correct decision for every claim in scope. List kept ranges by location and report each cut or correction as a finding.
- **Edit mode.** Decide what to cut before rewriting or adding, then check what remains for accuracy. Decide per claim: an accurate passage can still carry claims its reader does not need, and shorter or split sentences keep every claim. Finish only after every claim in scope has a keep, cut, or correct decision, and list the kept passages from the largest down with the reader need each serves.

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

## Caller-facing text

This covers user-facing messages, error text, and API descriptions such as GraphQL descriptions, OpenAPI summaries, and CLI help. The reader is the caller, who sees only requests, responses, and errors. Keep what the caller sends, the errors it can get, what the response shows, whether the outcome can still change after the response, and the next action it can take. Cut each sentence about how the server reaches its result, such as retries, timing bounds, background syncs, cadences, and which code path ran, unless the caller acts differently on it. Rewording an internal concept in plain words keeps the internal detail, so cut the sentence. Caller-facing text is read where the API is used, such as schema docs or editor hovers, not beside the code. When a rule lives only in code, state it in full in one caller-facing description and point the others there. Use terms the reader sees elsewhere. Compare the text with its established siblings, such as other mutations' descriptions, and give a caller reason for each sentence the siblings would not carry.

## Glossary and terminology

Read `GLOSSARY.md` (or follow `GLOSSARY-MAP.md`), plus linked domain references and ADRs. Search in-scope terms across code, docs, comments, and user-facing labels, and check definitions against actual behavior, including glossary entries untouched by the diff.

Flag conflicting names for one concept, one term with conflicting meanings, vague terms, and missing or stale entries that cause ambiguity. Respect intentional differences between domain contexts. Cite the conflicting usages, explain the misunderstanding, and propose a precise term or definition. Use [domain-modeling](../../imported/domain-modeling/SKILL.md) when changing the model or editing a glossary entry.

## Accuracy

Verify claims, symbol names, commands, paths, examples, and link targets against the implementation and actual callers. Separate unresolved questions from established behavior.

When code changes, check every passage that describes it, changed or not. Search docs, ADRs, the glossary, and comments for each changed function's name and the names of the other exports in its module. List the names searched, and each passage found with its decision.

A claim that is false on some path is too specific. Fix it in this order: cut it if its reader does not need it, restate it at the level that holds on every path, or name the code or ADR that owns the rule. Add the path as a new case only when its reader acts differently on it. A summary of a rule kept elsewhere, such as a guard list, a case list, or a selection rule, is a copy that goes stale. Name the owner instead.
