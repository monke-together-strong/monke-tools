---
name: documentation-standards
description: Use when writing or reviewing documentation, code comments, glossaries, or domain terminology.
---

# Documentation standards

Apply these rules to documentation, code comments, and domain terminology.
Repo-specific requirements take precedence on conflicts.

## Reader value

- Keep information that helps the intended reader act, make a decision, or
  understand a contract or constraint.
- Identify unnecessary passages for deletion before suggesting rewrites. Delete
  unnecessary explanations even when technically correct. Leaving useful,
  accurate text unchanged is a valid outcome.
- Write for someone who has not seen the conversation. Keep relevant reasons and
  consequences; put investigation history and reviewer bookkeeping in work records.
- Keep each fact in one authoritative place. Remove implementation narration,
  repeated configuration, and duplicated explanations. Link to the source when
  the reader needs it.

## Code comments

- Explain design reasons, invariants, ordering constraints, surprising behavior,
  and workaround causes that the code does not make clear. State the consequence
  when a constraint matters to future changes. Warnings such as `IMPORTANT` or
  `do not remove` need a concrete reason.
- Document contracts that callers need, including units, failure behavior,
  ownership, and side effects. Include inputs and outputs when their meaning is
  unclear from the signature. A comment can explain what code does when that
  behavior is difficult to infer.
- Prefer clear names and straightforward code when they remove the need for an
  explanation. Keep comments that add context beyond the implementation.
- Prefer types, assertions, or focused tests for constraints they can enforce.
  Use the smallest useful check and keep comments for the rationale it cannot express.
- Put a comment next to the code it explains. Keep reasoning that spans several
  modules in a focused document or ADR and link from the relevant code.
- Preserve TODOs and FIXMEs while the work remains. Remove them only after
  verifying that the underlying issue is resolved.

## Workarounds

Inspect comments and documentation that justify workarounds or lint and type
suppressions. Verify the claimed need against the affected code and actual callers.
Flag avoidable workarounds even when their explanations are accurate. Each finding
must name the comment or document location, the affected code, the underlying
problem, and the smallest proposed fix. Report unresolved external constraints or
uncertainty explicitly. Keep necessary explanations until the underlying code is fixed.
Report code fixes separately when they exceed the task's scope.

## Documentation

- Explain workflows, contracts, decisions, and gotchas that the reader needs.
  Use the code, configuration, or command help as the source for facts they
  already describe.
- Consolidate related new ADRs when they record one decision. Keep separate
  decisions separate.
- Follow the established audience, terminology, and structure. Apply
  [technical-writing](../../imported/technical-writing/SKILL.md) to prose and
  [writing-for-agents](../../imported/writing-for-agents/SKILL.md) to agent-facing
  documents.

## Glossary and terminology

- Read the applicable `GLOSSARY.md`, or follow `GLOSSARY-MAP.md` to the relevant
  domain context. Consult linked domain references and ADRs when they define a term.
- For terms in the review's scope, search their usages across code, docs, comments,
  and user-facing labels. Check definitions against actual behavior, including
  glossary entries that the diff leaves unchanged.
- Flag conflicting names for one concept, one term with conflicting meanings,
  and vague terms that obscure distinctions. Respect intentional differences
  between domain contexts.
- Flag missing or stale glossary entries when they cause ambiguity. Keep glossary
  entries focused on domain definitions and relationships.
- Each finding must cite the conflicting or confusing definitions and usages,
  explain the misunderstanding they cause, and propose a precise term or definition.
  Report unresolved domain decisions explicitly. Use
  [domain-modeling](../../imported/domain-modeling/SKILL.md) when changing the model.
- Keep edits within the task's scope. Report code renames, public-contract changes,
  and other affected usages outside that scope as separate findings.

## Accuracy

- Verify claims against the implementation, actual callers, and relevant evidence.
  Use current symbol names, commands, and paths. Check examples and link targets.
- Update affected documentation and comments when behavior changes. Remove stale
  claims, and distinguish unresolved questions from established behavior.
- Finish a review only after checking all documentation, comments, and domain
  terminology in the requested scope. Report confirmed violations with their
  location and the rule they violate.
