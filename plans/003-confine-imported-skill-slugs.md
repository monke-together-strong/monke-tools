# Plan 003: Confine imported skill slugs to `skills/imported`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report - do not improvise. When done, update the status row for this plan
> in `plans/README.md` - unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 24dee6d..HEAD -- scripts/import-skills.ts scripts/update-skills.ts __tests__/import-skills-script.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S/M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `24dee6d`, 2026-07-02

## Why this matters

The skill import/update scripts copy staged upstream skills into `skills/imported` and, during
interactive slug replacement, remove the old recorded imported-skill directory. Recipe slugs are
validated only as non-empty strings. A corrupt recipe or unexpected upstream slug containing path
separators could make copy or removal operations resolve outside `skills/imported`. The scripts
are source-maintenance tools, but they still deserve path confinement before recursive deletes.

## Current state

Relevant files and roles:

- `scripts/import-skills.ts` - reads/writes import recipes and copies staged skills. Current
  recipe-skill validation accepts any non-empty slug:

  ```ts
  // scripts/import-skills.ts:1033-1044
  if (typeof input.selector !== "string" || input.selector.trim() === "") {
    throw new Error("Skill import selector must be a non-empty string");
  }

  if (typeof input.slug !== "string" || input.slug.trim() === "") {
    throw new Error("Skill slug must be a non-empty string");
  }

  return {
    selector: input.selector,
    slug: input.slug,
  };
  ```

- `scripts/update-skills.ts` - rejects untracked slugs but later removes old slugs with a raw
  `path.join`:

  ```ts
  // scripts/update-skills.ts:171-175
  const untrackedSlugs = listImportedSkillDirectories(repoRoot).filter(
    (slug) => !ownedSlugs.has(slug),
  );
  if (untrackedSlugs.length > 0) {
    throw new Error(`Untracked imported skill directories: ${untrackedSlugs.join(", ")}`);
  }
  ```

  ```ts
  // scripts/update-skills.ts:276-280
  if (!stagedSlugSet.has(replacement.recordedSlug)) {
    rmSync(path.join(repoRoot, IMPORTED_SKILLS_ROOT, replacement.recordedSlug), {
      recursive: true,
      force: true,
    });
  }
  ```

- `__tests__/import-skills-script.test.ts` already has extensive import/update coverage and a
  fake upstream `skills` CLI helper around lines 1328-1364 that stages skill directories.

Repo conventions to match:

- Source-maintenance scripts are TypeScript run by Bun.
- Tests for these scripts live in `__tests__/import-skills-script.test.ts`.
- Keep imported skills under `skills/imported`; `skills/imported/.monke-imports.json` is the
  recipe store.

## Commands you will need

| Purpose       | Command                                           | Expected on success |
| ------------- | ------------------------------------------------- | ------------------- |
| Focused tests | `bun test __tests__/import-skills-script.test.ts` | all tests pass      |
| Typecheck     | `bun run typecheck`                               | exit 0, no errors   |
| Full tests    | `bun test`                                        | all tests pass      |
| Lint check    | `bun run lint:check`                              | exit 0              |
| Format check  | `bun run fmt:check`                               | exit 0              |

## Scope

**In scope**:

- `scripts/import-skills.ts`
- `scripts/update-skills.ts`
- `__tests__/import-skills-script.test.ts`

**Out of scope**:

- Changing the upstream `skills` CLI invocation.
- Reworking recipe store schema.
- Changing how skill selectors are parsed or displayed.
- Editing files under `skills/imported/**`.

## Git workflow

- Branch if requested: `feature/confine-imported-skill-slugs`
- Do not create `codex/` branches.
- Commit style: concise imperative, for example `Confine imported skill slug paths`.
- Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add slug and path confinement helpers

In `scripts/import-skills.ts`, add exported helpers so `scripts/update-skills.ts` can reuse the
same rules:

- `normalizeImportedSkillSlug(value: unknown, location: string): string`
- `resolveImportedSkillPath(repoRoot: string, slug: string): string`

Minimum rules for a valid imported skill slug:

- string after trimming
- not `"."` or `".."`
- not absolute
- does not contain `/` or `\`
- when resolved under `path.join(repoRoot, "skills", "imported")`, the result remains inside
  that directory

Do not over-constrain to lowercase-only unless tests prove all existing import behavior can keep
working. The important security boundary is path confinement.

**Verify**: `bun run typecheck` exits 0 or only fails with pre-existing expanded-typecheck errors
if Plan 001 has not landed. If Plan 001 has not landed, use `bun test __tests__/import-skills-script.test.ts`
as the focused verification for this step.

### Step 2: Use the helpers for recipe normalization and staged copy

Update `normalizeImportRecipeSkill` so it returns the normalized safe slug.

Update `copyStagedSkillsToImported` so it resolves each `targetPath` with
`resolveImportedSkillPath(repoRoot, skillName)` rather than raw `path.join`. This protects the
copy path even if staged skill names are unexpected.

Also consider validating `listStagedSkillSlugs` output through the same slug helper before
returning it. If the fake upstream helper or real upstream CLI stages an invalid slug, fail before
copying anything.

**Verify**: `bun test __tests__/import-skills-script.test.ts` passes.

### Step 3: Use the helpers for interactive slug replacement deletion

In `scripts/update-skills.ts`, import `resolveImportedSkillPath` or an equivalent exported helper
from `scripts/import-skills.ts`. Replace the raw removal path:

```ts
path.join(repoRoot, IMPORTED_SKILLS_ROOT, replacement.recordedSlug);
```

with the confined resolver. Keep the existing behavior: remove the old recorded slug only when
the new staged slug did not also stage that old slug.

**Verify**: `bun test __tests__/import-skills-script.test.ts` passes.

### Step 4: Add traversal regression tests

Add tests in `__tests__/import-skills-script.test.ts` covering:

- recipe store normalization rejects a slug with `../`
- `copyStagedSkillsToImported` rejects a staged slug with a path separator before copying
- interactive update replacement does not remove anything outside `skills/imported` when a
  recorded slug is invalid

For the deletion test, create a sentinel file outside `skills/imported`, attempt the invalid
operation, and assert the sentinel still exists.

**Verify**: `bun test __tests__/import-skills-script.test.ts` passes.

### Step 5: Run the full verification gate

Run:

```bash
bun run typecheck
bun run lint:check
bun run fmt:check
bun test
```

If Plan 001 has not landed yet and `bun run typecheck` still only checks `src/**/*.ts`, it should
still exit 0. Do not widen typecheck in this plan.

**Verify**: all available gates exit 0.

## Test plan

- Extend `__tests__/import-skills-script.test.ts`; use the existing fake upstream CLI helper as
  the pattern.
- Cover both recipe-store validation and filesystem operation confinement.
- Run the focused test file, then the full suite.

## Done criteria

- [ ] Recipe slugs and staged slugs cannot contain path separators, `"."`, `".."`, or absolute paths.
- [ ] Every copy/remove path for imported skill slugs is resolved and checked to stay under
      `skills/imported`.
- [ ] Traversal regression tests fail before the fix and pass after it.
- [ ] `bun test __tests__/import-skills-script.test.ts` passes.
- [ ] `bun run lint:check`, `bun run fmt:check`, and `bun test` pass.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- Existing real recipe data in `skills/imported/.monke-imports.json` contains a slug that the
  proposed validation rejects.
- A valid upstream skill slug requires path separators.
- The fix requires changing the recipe store schema.
- Any verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- Any future code that turns a skill slug into a filesystem path should reuse the same resolver.
- Reviewers should look specifically for raw `path.join(..., slug)` followed by `rmSync` or `cpSync`.
