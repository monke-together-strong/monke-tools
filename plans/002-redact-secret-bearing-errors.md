# Plan 002: Redact secret-bearing values from errors

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report - do not improvise. When done, update the status row for this plan
> in `plans/README.md` - unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 24dee6d..HEAD -- src/env.ts src/resources.ts __tests__/env.test.ts __tests__/single-repo.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `24dee6d`, 2026-07-02

## Why this matters

monke-tools reads and rewrites local env files, Resource values, and DSNs. Several failure
messages currently include the raw invalid value, and Resource value collisions print the
colliding value. If a managed env var contains credentials or a token-shaped Resource value,
that value can be copied into terminal logs, CI logs, or agent transcripts. The fix should
preserve actionable locations and env names while redacting the sensitive value itself.

## Current state

Relevant files and roles:

- `src/env.ts` - parses and rewrites managed env files. Current error paths include raw values:

  ```ts
  // src/env.ts:421-424
  } else if (innerValue.includes("://")) {
    nextInnerValue = replaceUrlPort(innerValue, newPort, location);
  } else {
    throw new MonkeError(`Unsupported env value at ${location}: ${innerValue}`);
  }
  ```

  ```ts
  // src/env.ts:431-437
  function replaceUrlPort(value: string, newPort: number, location: string): string {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new MonkeError(`Malformed URL or DSN at ${location}: ${value}`);
    }
  ```

  ```ts
  // src/env.ts:499-507
  if (!unwrapped.includes("://")) {
    throw new MonkeError(`Unsupported env value at ${location}: ${unwrapped}`);
  }
  ...
  } catch {
    throw new MonkeError(`Malformed URL or DSN at ${location}: ${unwrapped}`);
  }
  ```

- `src/resources.ts` - resolves and collision-checks deterministic Resource values. Current
  collision errors include the value:

  ```ts
  // src/resources.ts:587-589
  throw new MonkeError(
    `Resource value collision for ${value.env}=${value.value} in ${options.sourceRoot}; retained session ${state.session} already owns that value`,
  );
  ```

- `__tests__/env.test.ts` already uses DSN-shaped managed values, so add redaction tests there
  without introducing real secrets.
- `__tests__/single-repo.test.ts` already covers Resource value collisions at lines 989-1023;
  update that assertion to prove values are redacted.

Repo conventions to match:

- Errors use `MonkeError`.
- Tests use Vitest `expect(...).toThrow(...)` and helpers from `__tests__/helpers.ts`.
- Use repo vocabulary from `CONTEXT.md`: "Resource value" and "Managed env file".

## Commands you will need

| Purpose       | Command                                                        | Expected on success |
| ------------- | -------------------------------------------------------------- | ------------------- |
| Focused tests | `bun test __tests__/env.test.ts __tests__/single-repo.test.ts` | all tests pass      |
| Typecheck     | `bun run typecheck`                                            | exit 0, no errors   |
| Full tests    | `bun test`                                                     | all tests pass      |
| Lint check    | `bun run lint:check`                                           | exit 0              |
| Format check  | `bun run fmt:check`                                            | exit 0              |

## Scope

**In scope**:

- `src/env.ts`
- `src/resources.ts`
- `__tests__/env.test.ts`
- `__tests__/single-repo.test.ts`

**Out of scope**:

- Changing env parsing behavior.
- Redacting Resource command stdout/stderr diagnostics. Existing tests intentionally omit stdout
  for thrown resource command failures, and broader diagnostic policy should be a separate plan.
- Changing the content written to managed env files or session root `.env`.

## Git workflow

- Branch if requested: `feature/redact-secret-bearing-errors`
- Do not create `codex/` branches.
- Commit style: concise imperative, for example `Redact env values in errors`.
- Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a small redaction helper

In `src/env.ts`, add a local helper near the env error functions, for example:

```ts
function describeRedactedValue(value: string): string {
  return `<redacted length=${value.length}>`;
}
```

The helper must not return any substring of the value. A length is acceptable because it helps
diagnose empty/truncated values without revealing content.

In `src/resources.ts`, either add an equivalent local helper or a tiny shared helper only if the
repo already has a natural shared location. Do not create a broad utility module just for this
unless duplication becomes meaningfully larger than two local helpers.

**Verify**: `bun run typecheck` exits 0.

### Step 2: Redact raw env values in error messages

Update these `src/env.ts` error paths so they name the location and problem, but not the raw
env/URL/DSN value:

- `Unsupported env value at ...`
- `Malformed URL or DSN at ...`
- `Expected explicit port at ...`
- `Malformed explicit port at ...`

Keep env names and file locations in the messages. Those are not secret and are needed for
remediation.

**Verify**: `bun test __tests__/env.test.ts` passes.

### Step 3: Redact Resource value collision messages

Update `rejectResourceValueCollisions` in `src/resources.ts` so the error includes:

- the Resource env name, for example `DISCORD_CHANNEL`
- the source root
- the retained session that already owns the value
- a redacted value descriptor, not the value

Example target shape:

```text
Resource value collision for DISCORD_CHANNEL=<redacted length=...> in /repo; retained session first already owns that value
```

Do not include the raw Resource value anywhere in the thrown message.

**Verify**: `bun test __tests__/single-repo.test.ts` passes.

### Step 4: Add regression tests

In `__tests__/env.test.ts`, add assertions that invalid managed env values do not appear in
thrown messages. Use placeholder values that are clearly fake; do not introduce real secrets.
Assert both:

- malformed/unsupported value path
- malformed URL/DSN path

In `__tests__/single-repo.test.ts`, update the Resource collision test so it still checks the
env name and collision context, and additionally asserts the raw value is absent.

**Verify**:

```bash
bun test __tests__/env.test.ts __tests__/single-repo.test.ts
```

Expected: all focused tests pass.

### Step 5: Run the full verification gate

Run:

```bash
bun run typecheck
bun run lint:check
bun run fmt:check
bun test
```

**Verify**: all four commands exit 0.

## Test plan

- Add/update focused tests in `__tests__/env.test.ts` for redacted env rewrite failures.
- Update `__tests__/single-repo.test.ts` Resource value collision coverage to assert raw values
  are absent.
- Run focused tests first, then the full verification gate.

## Done criteria

- [ ] No `MonkeError` from `src/env.ts` includes raw managed env values, URLs, or DSNs.
- [ ] Resource value collision errors include env name and session context but not the raw value.
- [ ] Focused tests prove raw fake values are absent from error messages.
- [ ] `bun run typecheck`, `bun run lint:check`, `bun run fmt:check`, and `bun test` pass.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- Preserving useful error context appears to require exposing a raw env or Resource value.
- Tests reveal another secret-bearing error family outside the in-scope files.
- The fix requires changing env rewrite semantics.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- Future error messages around env files and Resources should include file path, env name, and
  failure kind, but not values.
- Reviewers should search the diff for interpolation of variables named `value`, `rawValue`,
  `innerValue`, `unwrapped`, or `literal` inside error messages.
