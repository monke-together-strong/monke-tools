# Plan 001: Bring TypeScript and lint guidance under CI-safe checks

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report - do not improvise. When done, update the status row for this plan
> in `plans/README.md` - unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 24dee6d..HEAD -- package.json tsconfig.json .github/workflows/pr.yml README.md AGENTS.md vitest.config.ts __tests__/agent-session-retrospective.test.ts __tests__/git.test.ts __tests__/registry.test.ts __tests__/resources.test.ts skills/internal/agent-session-retrospective/scripts/lib/collect.ts skills/internal/agent-session-retrospective/scripts/lib/commit.ts skills/internal/agent-session-retrospective/scripts/lib/pr-analysis.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: tests, dx
- **Planned at**: commit `24dee6d`, 2026-07-02

## Why this matters

The repo has a `typecheck` script, but CI does not run it. Today that script only checks
`src/**/*.ts`; widening the checked surface currently exposes real strictness errors in
tests, `vitest.config.ts`, and the agent-session-retrospective internal scripts. This plan
turns typechecking into a CI gate, expands it to repo-owned TypeScript, and fixes the
known errors so future source-maintenance and test regressions are caught before merge.

This plan also folds in the small lint-guidance drift: `bun run lint` mutates files because
it runs Oxlint with `--fix`, while README and AGENTS present it as the normal verification
command. The repo already has the non-mutating `bun run lint:check`; docs should point
agents there for checks.

## Current state

Relevant files and roles:

- `package.json` - defines scripts. Current excerpt:

  ```json
  // package.json:28-33
  "typecheck": "tsc",
  "test": "bunx --bun vitest run",
  "lint": "oxlint . --fix",
  "lint:check": "oxlint .",
  "fmt": "oxfmt",
  "fmt:check": "oxfmt --check"
  ```

- `.github/workflows/pr.yml` - CI checks format, lint, and tests, but not typecheck:

  ```yaml
  # .github/workflows/pr.yml:35-42
  - name: Format check
    run: bun run fmt:check

  - name: Lint check
    run: bun run lint:check

  - name: Test
    run: bun test
  ```

- `tsconfig.json` - strict config, but only includes `src/**/*.ts`:

  ```json
  // tsconfig.json:13-22
  "strict": true,
  "skipLibCheck": true,
  "noFallthroughCasesInSwitch": true,
  "noUncheckedIndexedAccess": true,
  "noImplicitOverride": true,
  ...
  "include": ["src/**/*.ts"]
  ```

- `README.md` and `AGENTS.md` - verification guidance points at the mutating lint script:

  ```markdown
  # README.md:9-13

  bun install
  bun test
  bun run lint
  bun run fmt:check
  ```

  ```markdown
  # AGENTS.md:5-8

  - Package manager: `bun`
  - Test: `bun test`
  - Lint: `bun run lint`
  - Format check: `bun run fmt:check`
  ```

- A read-only dry run of an expanded strict typecheck at plan time failed with these
  known classes of errors:
  - `__tests__/agent-session-retrospective.test.ts`: unchecked array/index access in test
    assertions and fake data lookups.
  - `__tests__/git.test.ts` and `__tests__/resources.test.ts`: hand-written `Runtime`
    mocks missing `select` and `readLine`.
  - `__tests__/registry.test.ts`: `Bun.serve`/listener options are typed differently under
    the current Bun types.
  - `vitest.config.ts`: destructuring `id.split("?", 1)` leaves `path` typed as possibly
    undefined.
  - `skills/internal/agent-session-retrospective/scripts/lib/collect.ts`,
    `commit.ts`, and `pr-analysis.ts`: nullability and shape drift under strict checking.

Repo conventions to match:

- Package manager is `bun`; use `bun test`, `bun run lint:check`, `bun run fmt:check`.
- Follow git flow and do not create `codex/` branches. Use a `feature/` branch if the
  operator asks you to create one.
- Existing commit messages are concise imperative summaries, for example
  `Avoid clobbering local PR branches`.

## Commands you will need

| Purpose                  | Command              | Expected on success                          |
| ------------------------ | -------------------- | -------------------------------------------- |
| Current source typecheck | `bun run typecheck`  | exit 0, no errors                            |
| Full tests               | `bun test`           | all tests pass                               |
| Lint check               | `bun run lint:check` | exit 0, "Found 0 warnings and 0 errors"      |
| Format check             | `bun run fmt:check`  | exit 0, all matched files use correct format |

## Scope

**In scope**:

- `package.json`
- `tsconfig.json`
- `.github/workflows/pr.yml`
- `README.md`
- `AGENTS.md`
- `vitest.config.ts`
- `__tests__/agent-session-retrospective.test.ts`
- `__tests__/git.test.ts`
- `__tests__/registry.test.ts`
- `__tests__/resources.test.ts`
- `skills/internal/agent-session-retrospective/scripts/lib/collect.ts`
- `skills/internal/agent-session-retrospective/scripts/lib/commit.ts`
- `skills/internal/agent-session-retrospective/scripts/lib/pr-analysis.ts`

**Out of scope**:

- Runtime behavior changes to the CLI.
- Formatting or refactoring tests beyond the minimum needed for type safety.
- Broadly changing TypeScript strictness flags to make errors disappear.
- Updating dependencies. Dependency advisories are not part of this plan.

## Git workflow

- Branch if requested: `feature/typecheck-ci-and-lint-guidance`
- Do not create `codex/` branches.
- Commit style: concise imperative, for example `Add CI typecheck gate`.
- Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Expand the checked TypeScript surface intentionally

Update `tsconfig.json` so `bun run typecheck` covers repo-owned TypeScript, not only
`src/**/*.ts`. Include these paths:

- `src/**/*.ts`
- `scripts/**/*.ts`
- `__tests__/**/*.ts`
- `skills/internal/agent-session-retrospective/scripts/**/*.ts`
- `vitest.config.ts`

Do not include imported skill scripts under `skills/imported/**`; they are mirrored imported
content and not owned by this repo.

**Verify**: `bun run typecheck` should fail only with the known error classes listed in
"Current state". If it reports many unrelated errors or imported-skill errors, STOP and
report the changed baseline.

### Step 2: Fix the strictness errors without weakening strictness

Fix the known expanded-typecheck errors by making local, type-preserving changes:

- In `vitest.config.ts`, avoid destructuring `id.split("?", 1)` into a possibly undefined
  value. Use a string fallback or a direct expression that TypeScript can prove is a string.
- In `__tests__/git.test.ts` and `__tests__/resources.test.ts`, either use `createRuntime`
  where possible or add minimal `select` and `readLine` members to the mock `Runtime` objects.
  The mock behavior should throw if those members are unexpectedly called.
- In `__tests__/registry.test.ts`, update the port-occupying test helper to use a Bun API
  shape accepted by the current `@types/bun`. Preserve the test intent: occupy a TCP port
  so `allocateLocalPorts` skips it.
- In `__tests__/agent-session-retrospective.test.ts`, replace unsafe array/index access with
  explicit checked locals or non-null assertions only where the test data is constructed in
  the same test and the assertion would fail immediately if missing.
- In the agent-session-retrospective script files, fix nullability and declared object shapes
  rather than using `any`. For `pr-analysis.ts`, make `PrWorkItem` and commit-reference shapes
  match what the code actually writes and reads.

**Verify**: `bun run typecheck` exits 0.

### Step 3: Add CI typecheck

Update `.github/workflows/pr.yml` to run `bun run typecheck` after install and before tests.
Either place it before format/lint or between lint and test; keep the existing `fmt:check`,
`lint:check`, and `bun test` gates.

**Verify**: `bun run typecheck` exits 0 locally.

### Step 4: Fix non-mutating lint guidance

Update README quick start and AGENTS essentials so check-oriented guidance uses
`bun run lint:check`. Keep `bun run lint` as the fixer script in `package.json`; do not document
the fixer in README/AGENTS in this plan, so the check-only verification stays machine-checkable.

**Verify**: `! rg -n "bun run lint([^:]|$)" README.md AGENTS.md` exits 0.

### Step 5: Run the full verification gate

Run the full local gate:

```bash
bun run typecheck
bun run lint:check
bun run fmt:check
bun test
```

**Verify**: all four commands exit 0; `bun test` reports all tests passing.

## Test plan

- No new runtime tests are required unless fixing type errors changes test helpers in a way that
  needs coverage.
- Existing tests are the verification surface. Use `bun test` as the final gate.
- The CI workflow change is verified by local command success and by reviewing
  `.github/workflows/pr.yml`.

## Done criteria

- [ ] `tsconfig.json` includes repo-owned TypeScript beyond `src/**/*.ts` and excludes imported
      skill mirrors.
- [ ] `bun run typecheck` exits 0.
- [ ] `.github/workflows/pr.yml` runs `bun run typecheck`.
- [ ] README and AGENTS check guidance uses `bun run lint:check`.
- [ ] `bun run lint:check`, `bun run fmt:check`, and `bun test` all pass.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- Expanding `tsconfig.json` reports imported-skill errors from `skills/imported/**`.
- Fixing type errors appears to require weakening strict compiler options.
- The expanded typecheck reveals more than 10 new files with errors beyond the known classes.
- The fix appears to require touching files outside the in-scope list.
- Any verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- Reviewers should scrutinize any non-null assertions added in tests: they are acceptable only
  when the test constructs the data locally and a missing value would mean the test fixture is
  broken.
- Keep `bun run lint` as a fixer and `bun run lint:check` as the CI/agent check command.
- If new repo-owned TypeScript directories are added later, update `tsconfig.json` in the same PR.
