---
name: documentation-standards
description: Use when writing or reviewing documentation, code comments, glossaries, or domain terminology.
---

# Documentation standards

Repo-specific requirements take precedence on conflicts. When asked to review,
report findings and leave the text unchanged; otherwise, edit passages in scope.
Decide what to delete before rewrites or additions, then check what remains for
accuracy. Finish only after deciding whether every passage in scope is kept,
cut, or corrected.

Each finding names its location, the evidence, the problem, and the smallest fix.
Report unresolved questions explicitly. Keep edits within the task's scope, and
report changes outside it, such as code fixes, renames, and public-contract
changes, as separate findings.

## Reader value

- Keep information that helps the intended reader act, make a decision, or
  understand a contract or constraint.
- Delete unnecessary explanations even when technically correct. Leaving useful,
  accurate text unchanged is a valid outcome.
- Document an operational failure only when it is silent, misleading, or surfaces
  only after a slow or irreversible step. A startup or test failure whose error
  names the cause documents itself. Leave out edge cases the reader is unlikely
  to hit.
- Write for someone who has not seen the conversation. Keep relevant reasons and
  consequences; put investigation history and reviewer bookkeeping in commit
  messages, PRs, or issues.
- Keep each fact in one authoritative place, and link to it when the reader would
  not otherwise reach it. Use code, configuration, and command help as the source
  for facts they already describe. Remove implementation narration and duplicated
  explanations. Skill indexes and related-skill lists add nothing, since agents
  already see the descriptions of model-invoked skills.

## Code comments

- Explain design reasons, invariants, ordering constraints, and surprising
  behavior that the code does not make clear. State the consequence when a
  constraint matters to future changes. Warnings such as `IMPORTANT` or
  `do not remove` need a concrete reason.
- Document contracts that callers need, including failure behavior,
  ownership, and side effects. Include inputs and outputs when their meaning is
  unclear from the signature. A comment can explain what code does when that
  behavior is difficult to infer.
- Prefer clear names and straightforward code when they remove the need for an
  explanation.
- Prefer types, assertions, or focused tests for constraints they can enforce.
  Use the smallest useful check and keep comments for the rationale it cannot
  express.
- Put a comment next to the code it explains. Keep reasoning that spans several
  modules in a focused document or ADR and link from the relevant code.
- Preserve TODOs and FIXMEs while the work remains. Remove them only after
  verifying that the underlying issue is resolved.

## Workarounds

- Explain the cause of each necessary workaround or lint and type suppression
  when the code does not make it clear. Keep the explanation until the underlying
  code is fixed.
- Check each comment or document that justifies a workaround or suppression
  against the affected code and actual callers. Identify avoidable workarounds
  even when their explanations are accurate. Judge whether a workaround is
  avoidable per
  [principle-fix-root-causes](../../imported/principle-fix-root-causes/SKILL.md),
  and target the fix at its root cause.

## Documentation

- Explain workflows, contracts, decisions, and gotchas that the reader needs.
- In a how-to or skill, give the recommended way for each distinct need, with an
  example the reader can copy.
- Put details in the example instead of describing them in prose, and prefer one
  complete example to several fragments. Pick one example domain and reuse
  it across a repository's documentation.
- Put skills for consumers of the repository in `skills/`. They ship without the
  repository, so keep references contained in that directory.
- Consolidate related new ADRs when they record one decision. When trimming an
  ADR, keep the decision and its reasons; cut inventories of changed code.
- Follow the established audience, terminology, and structure. Apply
  [technical-writing](../../imported/technical-writing/SKILL.md) to prose and
  [writing-for-agents](../../imported/writing-for-agents/SKILL.md) to agent-facing
  documents.

## Glossary and terminology

- Read the applicable `GLOSSARY.md`, or follow `GLOSSARY-MAP.md` to the relevant
  domain context. Consult linked domain references and ADRs when they define a term.
- For terms in scope, search their usages across code, docs, comments,
  and user-facing labels. Check definitions against actual behavior, including
  glossary entries that the diff leaves unchanged.
- Identify conflicting names for one concept, one term with conflicting meanings,
  and vague terms that obscure distinctions. Respect intentional differences
  between domain contexts.
- Identify missing or stale glossary entries when they cause ambiguity. Keep
  glossary entries focused on domain definitions and relationships.
- For each finding, cite the conflicting or confusing definitions and usages,
  explain the misunderstanding they cause, and propose a precise term or
  definition. Use [domain-modeling](../../imported/domain-modeling/SKILL.md) when
  changing the model.

## Accuracy

- Verify claims against the implementation, actual callers, and relevant evidence.
  Use current symbol names, commands, and paths. Check examples and link targets.
- Update affected documentation and comments when behavior changes. Remove stale
  claims, and distinguish unresolved questions from established behavior.
