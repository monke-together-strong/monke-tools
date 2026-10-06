## Problem Statement

Agents creating global skills usually put them in their own harness's folders.
The user then has to register or move them manually to share them through Monke.
Existing skills can also be copied or linked into several harnesses, so adopting
one copy can collide with another, leave duplicate discovery entries, or discard
local differences. Moving a skill can break supporting references outside its
folder.

The user wants one editable source managed by Monke, appropriate links across
harnesses, and concise reports that a capable agent can act on when consolidation
is ambiguous. Adoption must preserve the complete requested set when a conflict
prevents publication.

## Solution

Make Monke the default owner for newly created global skills unless the user
explicitly requests a particular harness. Provide creation and adoption through
the skills commands while retaining linked import as the option for keeping an
external source location.

Adoption discovers matching skill copies across known global harness roots and
configured custom targets, consolidates identical same-slug copies into one
source, and publishes managed links. It replaces existing matching entries in
unconfigured harnesses without enabling those harnesses as targets or installing
unrelated skills there.

Differing copies, existing-owner conflicts, and detected supporting references
that relocation would break are reported before changes. Adoption leaves the
whole requested set unchanged. Agents reconcile those cases separately and rerun
adoption; the command does not offer interactive resolution or replacement flags.

## User Stories

1. As a user working across harnesses, I want newly created global skills managed by Monke by default, so that the harness that created them does not control their ownership.
2. As a user, I want an explicit request for one harness to take precedence over the default, so that intentional harness-specific installation remains possible.
3. As an agent authoring a skill, I want a creation command that returns its editable entry document, so that I can write the skill at its authoritative source.
4. As a skill author, I want supporting scripts, references, assets, and invocation metadata kept with my skill, so that distribution preserves its complete behavior.
5. As a user, I want configured compatible harnesses linked to one editable source, so that edits through any projection reach the same skill.
6. As a user, I want to adopt one existing skill, so that its files and distribution become managed by Monke.
7. As a user, I want to adopt an existing collection with optional slug selection, so that I can manage several skills without changing unselected ones.
8. As a user, I want adoption to discover matching copies in all known global harness roots and configured custom roots, so that copies outside my current target preference are not overlooked.
9. As a user, I want discovery to preserve my target preferences, so that finding a harness does not enable it or install unrelated skills.
10. As a user, I want existing matching entries in an unconfigured harness replaced with managed links, so that the adopted skill stays usable there without remaining an independent copy.
11. As a user, I want identical same-slug copies consolidated automatically, so that straightforward adoption needs no conflict-resolution interview.
12. As a user, I want redundant discovery entries removed according to each harness's layout, so that a skill is not exposed twice in one harness.
13. As a user, I want aliases to one physical source recognized as that same source, so that multiple links are not treated as independent content.
14. As a user, I want external source folders behind adopted aliases preserved, so that taking ownership of an alias does not remove its external target.
15. As a user, I want complete contents and structure compared, including executable permissions and symlinks, so that equal entry documents do not hide meaningful differences.
16. As an agent, I want metadata-only and formatting-only differences reported conservatively, so that adoption does not guess whether a difference is harmless.
17. As an agent, I want conflict reports to identify the skill slug, relevant paths, differences or reason, and a useful next step, so that I can resolve the problem outside adoption.
18. As a user, I want conflicting copies left untouched, so that I can inspect, preserve, and reconcile their contents deliberately.
19. As a user adopting a collection, I want a conflict in one selected skill to stop the complete batch, so that other selected skills do not move before I resolve it.
20. As a user, I want identical leftover copies of an already-managed skill to converge into its existing owner, so that adoption does not create another source registration.
21. As a user, I want a divergent copy of a registered skill reported without replacing its owner, so that later Git or installer updates retain their established authority.
22. As a user, I want an already-consolidated skill treated as unchanged, so that rerunning adoption or adopting a larger collection does not create duplicate ownership or block unrelated selected skills.
23. As a user, I want differently named folders kept separate even when their agent-facing names match, so that distinct skills are not accidentally merged.
24. As an agent, I want adoption to report detected references or symlinks that relocation would break, so that I can make a skill self-contained before moving it.
25. As a user, I want linked import to remain available, so that a skill with external dependencies can retain its source location while being distributed.
26. As a user, I want a handled publication failure to restore the prior sources, registrations, and affected links for the whole batch, so that failure does not leave a partially adopted collection.
27. As an agent, I want retained recovery material and its location reported when restoration itself fails, so that I can recover the files deliberately.
28. As a user, I want creation and adoption to retain the existing invocation-policy, update, reinstall, reconfiguration, and removal workflows, so that managed skills remain part of Monke's normal lifecycle.
29. As a user, I want unrelated skills and user-owned target entries preserved, so that adoption affects only the requested skills and their matching copies.

## Implementation Decisions

- Source ownership follows the decision to own created and adopted global skills in Monke home. Reuse the personal Skill registry, Skill import recipes, and Skill projections rather than introducing another ownership system.
- Extend CLI command routing, managed local source acquisition, registry publication, and target reconciliation to implement creation and cross-harness adoption. Keep linked import available for external authoritative sources.
- Shared global guidance and the Core distributed skill direct agents to use Monke for global creation and installation unless a particular harness was explicitly requested. Imported guidance remains an upstream snapshot and is not edited locally.
- Select adoption scope from the supplied skill or collection and its optional slug selection. Discover copies of those selected slugs in known global harness roots and configured custom roots; do not automatically search project-local skill roots or arbitrary filesystem locations.
- Keep Skill slug distinct from Agent skill name. Matching uses folder slugs. Agent-facing names, descriptions, and semantic similarity do not establish identity, and differently named folders are not mapped automatically.
- Group aliases by physical source identity. Stage a chosen physical source before changing any entry that could invalidate another alias. Preserve external folders behind adopted aliases.
- Use the existing guidance digest contract as the basis for conservative comparison: delivered paths, file bytes, executable bits, and symlink structure. Formatting-only and invocation-metadata differences count as conflicts; do not normalize them away.
- Consolidate identical unmanaged copies into one authoritative source and remove obsolete discovery entries. Respect flat and namespaced harness layouts so a leftover raw entry does not coexist with its managed projection unnecessarily.
- Existing matching entries in unconfigured harnesses become owned links to the same source. Track their ownership within the existing registry/projection lifecycle while leaving target preferences unchanged and installing no unrelated skills there.
- Reuse an existing registered owner for identical copies. Preserve its source recipe and invocation policies. Divergence from that owner reports a conflict; adoption does not switch ownership or overwrite upstream-managed content.
- Treat already-consolidated skills as unchanged. They must not create duplicate registrations or prevent other selected skills from being adopted.
- Report conflicts and complex cases without interactive resolution. Include the slug, affected paths, differences or reason, and actionable guidance. Stop the batch without changing the skills, registrations, preferences, or projections involved.
- Resolve differing copies outside adoption. Agents may preserve and reconcile them, then rerun adoption. The command has no winner-selection, force-replacement, automatic merge, or divergent-copy archive workflow.
- Adapt the existing packaged Markdown link checker and symlink validation to arbitrary skill folders. Inspect references before relocation or dereferencing, compare original and proposed resolution, and report dependencies the move would break.
- Do not rewrite references or import external dependencies automatically. The checks do not prove dynamically constructed script dependencies or arbitrary plain-text references; reports must not claim complete runtime dependency validation.
- Preflight the entire requested set before publication. Keep originals and rollback material through registry and target publication. A handled failure restores all affected sources, registry state, and links; if restoration fails, retain recovery material and report its location.
- Reuse existing lifecycle behavior and ownership protections for update, reinstall, target reconfiguration, and removal, including links replacing existing copies in unconfigured harnesses. Avoid broad unrelated changes to guidance distribution.

## Testing Decisions

- Use one primary existing seam: the CLI entry point with isolated Monke home and harness directories, real filesystem fixtures, captured output, and the existing Runtime test adapter.
- Test externally observable behavior: source files and contents, discoverable target links, shared edit authority, recorded source ownership, preserved target preferences, command reports, and the final state after success or failure. Do not test private helper structure or mirror the implementation.
- Extend the existing Skill registry CLI behavior tests. Their prior art covers linked imports, command and Git sources, invocation policies, removal, installation retention, destination collisions, and source restoration.
- Cover creation sharing editable files and retaining them through invocation-policy, installation, and removal workflows. Respect explicit harness-specific requests in the distributed guidance.
- Exercise identical Codex and Claude copies, a configured custom root, a matching entry in an unconfigured harness, and the absence of duplicate discovery entries or unrelated installations.
- Verify real supporting files, executable permissions, metadata, and internal symlink behavior. Differences in any of these must report and leave the complete selected batch unchanged, including when another selected skill is otherwise adoptable.
- Cover several aliases to one source and confirm its external physical folder survives adoption while managed edits reach one authoritative source.
- Cover identical and divergent copies of an existing registered source, repeated adoption of an already-consolidated skill, different slugs with matching Agent skill names, and selection preserving unrelated skills.
- Check detected Markdown or symlink dependencies that relocation would break, valid self-contained references, and reports that accurately describe the validation limits.
- Exercise a controlled failure during publication after preparation, verify restoration of sources, registry, and all affected links, and cover retained recovery material when restoration cannot finish. Prefer existing fixtures and failure mechanisms over a new public interface solely for tests.
- Run focused tests and targeted lint, formatting, and typechecking for the changed scope. CI owns repository-wide checks; do not add redundant smoke tests for unchanged behavior.

## Out of Scope

- Automatic merging, semantic equivalence detection, metadata normalization, interactive conflict resolution, winner-selection flags, and force-replacement flags.
- Automatic archives of divergent copies during adoption; reconciliation and preservation of those copies happen outside the command.
- Mapping differently named folders to one skill, matching by Agent skill name, or fuzzy matching from descriptions.
- Enabling additional harness targets during discovery or installing unrelated skills into unconfigured harnesses.
- Automatically scanning project-local roots, arbitrary directories, or harness destinations Monke does not know how to resolve.
- Automatically importing external supporting resources, rewriting their references, or building a general dependency inference engine for scripts and plain-text instructions.
- Replacing an existing Git, installer, or linked source owner through adoption.
- A separate skill ownership category, registry, or distribution system.
- Editing imported upstream skill snapshots locally or performing repository-wide verification.

## Further Notes

The glossary distinguishes Skill slug, Agent skill name, Skill copy, Skill
adoption, Skill source folder, and Skill projection. Source ownership follows the
ADR titled "Own created and adopted skill files in Monke home."
