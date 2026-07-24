# Zod 4 and Commander extra-typings refactoring playbook

Research snapshot: 2026-07-24

This guide is a reusable playbook for TypeScript repositories that are considering Zod for
runtime boundaries and `@commander-js/extra-typings` for Commander CLIs. It separates documented
library behavior from the architectural recommendations made here, then applies the playbook to
monke-tools.

## Recommendation

Adopt both libraries, for different reasons:

- Use Zod 4 to make untrusted file, state, and protocol boundaries explicit. Start with persisted
  state that is currently cast without runtime validation. Do not turn filesystem, graph, or
  workflow logic into giant schemas.
- Use `@commander-js/extra-typings` to derive action arguments and options from the Commander
  declaration. It is a focused type-safety cleanup, not runtime validation.

For monke-tools specifically:

1. Add the Commander typing layer as a small isolated change.
2. Add Zod to Session state, repo reservations, and Swing history before changing `monke.yml`.
3. Move Global monke config to schemas next.
4. Split `monke.yml` parsing into a structural schema followed by the existing semantic builder.
5. Convert smaller JSON and manifest boundaries after their current failure semantics are captured
   in tests.

This ordering gets the unchecked persisted data behind validation early while avoiding a
high-churn rewrite of the repository's most mature validator.

## Version snapshot and compatibility decision

The registry reported Zod `4.4.3`, Commander `15.0.0`, and
`@commander-js/extra-typings` `15.0.0` as the latest releases on the snapshot date
([Zod metadata](https://registry.npmjs.org/zod/latest),
[Commander metadata](https://registry.npmjs.org/commander/latest),
[extra-typings metadata](https://registry.npmjs.org/%40commander-js%2Fextra-typings/latest)).
The extra-typings maintainers explicitly require its major and minor numbers to match Commander's;
patch versions are independent
([v15 usage documentation](https://github.com/commander-js/extra-typings/tree/v15.0.0#usage)).

monke-tools was migrated from Commander `14.0.3` to the latest matching `15.0` pair:

```json
{
  "commander": "~15.0.0",
  "@commander-js/extra-typings": "~15.0.0",
  "zod": "^4.4.3"
}
```

Using matching `~15.0` ranges prevents a future Commander `15.1` from silently moving beyond an
extra-typings `15.0` declaration. Exact versions are also valid. The important invariant is that
the installed major and minor versions match.

Commander 15 is ESM-only and raises its documented Node engine floor to 22.12
([v15 package metadata](https://github.com/tj/commander.js/blob/v15.0.0/package.json)). Another
repository should not copy this version pair without first checking its module format and supported
Node versions. When upgrading later, resolve the newest releases and choose a matching Commander
and extra-typings minor pair rather than copying the snapshot versions from this guide.

Zod is runtime code and belongs in `dependencies` for an application that parses with it. If a
published library exposes Zod-aware APIs, use the separate library-author guidance below.

## The boundary model

Treat runtime validation as a pipeline:

```text
bytes/text
  -> YAML or JSON syntax parser
  -> unknown JavaScript value
  -> structural schema
  -> normalized boundary value
  -> semantic/domain validation
  -> domain object
```

Each stage owns a different failure:

- The YAML or JSON parser owns malformed syntax.
- Zod owns shape, primitive types, required fields, closed keys, and small local invariants.
- Ordinary domain functions own filesystem containment, repository topology, dependency
  ownership, uniqueness across entities, process execution, and other checks that need context or
  I/O.

This separation is a recommendation of this playbook, not a rule imposed by Zod. Zod documents
refinements as custom validation and requires refinement functions to return failure rather than
throw; thrown errors are not caught
([refinement documentation](https://zod.dev/api#refinements)). Keeping I/O and domain workflows
outside refinements makes their dependencies, error handling, and tests easier to see.

## Zod 4 patterns

### Parse `unknown`; return a validated output

After `JSON.parse`, YAML `toJS()`, a subprocess response, or a file read, keep the value typed as
`unknown` until the boundary schema succeeds:

```ts
import * as z from "zod";

const ToolConfigSchema = z.strictObject({
  version: z.literal(1),
  sourceRoot: z.string().min(1),
});

type ToolConfig = z.output<typeof ToolConfigSchema>;

function parseToolConfig(input: unknown): ToolConfig {
  return ToolConfigSchema.parse(input);
}
```

`parse` validates and returns a strongly typed deep clone; on failure it throws `ZodError`.
`safeParse` instead returns a discriminated success/error result
([parsing and error handling](https://zod.dev/basics#parsing-data)). Prefer:

- `parse` inside a narrow adapter that intentionally translates `ZodError`;
- `safeParse` where the caller needs explicit control of the public error; and
- `parseAsync` or `safeParseAsync` whenever the schema contains asynchronous transforms or
  refinements, because synchronous parse is not valid for those schemas
  ([async parsing](https://zod.dev/basics#parsing-data)).

Do not write `JSON.parse(text) as SomeType` or `yaml.parse(text) as SomeType` at a trust boundary.
The cast changes only TypeScript's opinion; it does not validate the value.

### Use strict objects for formats the application owns

`z.object()` strips unrecognized keys from its parsed output. `z.strictObject()` rejects them,
`z.looseObject()` passes them through, and `.catchall()` validates them with a chosen schema
([object behavior](https://zod.dev/api#objects),
[strict objects](https://zod.dev/api#zstrictobject)).

Recommended policy:

| Boundary                                           | Object mode                               |
| -------------------------------------------------- | ----------------------------------------- |
| Authored config with a closed vocabulary           | `z.strictObject()`                        |
| Persisted application-owned state                  | `z.strictObject()`                        |
| Internal process protocol controlled on both sides | `z.strictObject()`                        |
| Third-party response where extra fields are normal | `z.object()` or an explicitly loose shape |
| Dynamic string-keyed map                           | `z.record(keySchema, valueSchema)`        |

This policy makes misspelled config keys fail rather than disappear. Use loose behavior only as an
intentional compatibility decision, not as the default.

### Derive types from the schema at boundary-owned shapes

Zod can derive a static type with `z.infer`; when input and output differ, `z.input` and `z.output`
name the two sides explicitly
([type inference](https://zod.dev/basics#inferring-types),
[input/output example](https://zod.dev/api#preprocess)).

Use:

```ts
type StoredConfig = z.input<typeof ConfigSchema>;
type Config = z.output<typeof ConfigSchema>;
```

Recommended ownership rule:

- Derive raw, stored, transport, and normalized boundary types from their schema.
- Keep domain interfaces explicit when they include contextual or constructed values such as
  `Map`, `Set`, absolute paths, open resources, or behavior.
- Avoid maintaining a handwritten interface and a structurally identical schema side by side.
  That creates two sources of truth.

For monke-tools, `RepoConfig` and `ResolvedGraph` should remain domain types. A new
`RawRepoConfig` should be schema-derived.

### Keep errors at the application's abstraction level

Every Zod issue includes a message plus structured metadata such as `code` and `path`
([error structure](https://zod.dev/error-customization)). Zod 4 uses a unified `error` parameter
for schema-level, per-parse, and global customization; schema-level customization has higher
precedence than per-parse customization
([error customization and precedence](https://zod.dev/error-customization#per-parse-error-customization)).

Zod also provides:

- `z.prettifyError()` for a human-readable string;
- `z.treeifyError()` for a nested representation; and
- `z.flattenError()` for a shallow form-oriented representation.

The older `z.formatError()` is deprecated
([error formatting](https://zod.dev/error-formatting)).

For a CLI or library with established errors, do not leak raw `ZodError` formatting as the public
contract. Translate at the boundary:

```ts
function parseOwnedFile<T extends z.ZodType>(
  schema: T,
  input: unknown,
  label: string,
): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }

  throw new MonkeError(`Invalid ${label}:\n${formatBoundaryIssues(result.error.issues)}`);
}
```

The adapter should map issue paths into the repository's existing location syntax and preserve
important domain wording. Snapshot or behavior-test those messages before migration.

Zod omits input values from issues by default to reduce accidental exposure of sensitive data.
Only enable `reportInput` deliberately
([input reporting](https://zod.dev/error-customization#include-input-in-issues)). Config files,
environment data, command output, and persisted state can contain secrets, so the default is
appropriate here.

Avoid a process-wide global error map unless the whole application truly wants one vocabulary.
Boundary-local translation keeps a reusable schema independent from CLI wording.

### Choose native checks, refinements, transforms, and codecs deliberately

Use the smallest mechanism that represents the boundary:

| Need                                              | Mechanism                          |
| ------------------------------------------------- | ---------------------------------- |
| Primitive shape, range, format, collection length | Native Zod schema/check            |
| Local predicate on an already valid value         | `.refine()`                        |
| Multiple local issues from one pass               | `.check()`                         |
| Validate, then convert in one direction           | `.transform()` or `.pipe()`        |
| Convert in both read and write directions         | `z.codec()`                        |
| Context, filesystem, graph, or I/O validation     | Ordinary domain function after Zod |

Refinement and transform functions should not throw because Zod does not catch those exceptions
([refinements](https://zod.dev/api#refinements),
[transforms](https://zod.dev/api#transforms)). A transform is unidirectional, and pipes compose
schemas with transforms
([pipes and transforms](https://zod.dev/api#pipes)).
In current Zod 4, `.superRefine()` is deprecated in favor of the lower-level `.check()` API
([custom checks](https://zod.dev/api#check)).

Codecs, introduced in Zod 4.1, define input and output schemas plus `decode` and `encode`
operations for bidirectional conversion
([codec documentation](https://zod.dev/codecs)). Use one only when the same abstraction really owns
both serialization directions, such as an ISO timestamp stored as a string and used as a `Date`.
For one-way config normalization or path resolution, a small explicit domain function is usually
clearer.

Be cautious with coercion. Accepting `"123"` where a number was intended can conceal an authored
config mistake. Prefer strict input types for owned YAML and JSON unless the format contract
explicitly allows coercion.

### Defaults are not migrations

`.default()` returns an output default immediately when the input is `undefined`; `.prefault()`
supplies an input value and still parses it
([defaults and prefaults](https://zod.dev/api#defaults)). `.catch()` returns a fallback after a
validation error
([catch values](https://zod.dev/api#catch)).

Recommended policy:

- Use `.default()` for an optional field whose absence has the same meaning within one format
  version.
- Use `.prefault()` only when the default itself must be normalized or checked.
- Do not use `.catch()` for durable state. It can turn corruption into apparently valid data.
- Do not use defaults as a substitute for a version migration when the meaning or shape changed.

### Version persisted formats explicitly

Zod does not prescribe a persistence migration system. The following is this playbook's
recommendation, built from Zod's literal and discriminated-union primitives. Zod documents that a
discriminated union selects object variants using a shared literal discriminator
([discriminated unions](https://zod.dev/api#discriminated-unions)).

For application-owned state:

1. Store a required integer `version`.
2. Define a strict schema for every version still accepted.
3. Parse the stored value as a discriminated union.
4. Migrate historical values explicitly to the current shape.
5. Validate the migrated result with the current schema.
6. Write only the current version.
7. Reject unknown future versions with a clear incompatibility error.

```ts
const StateV1 = z.strictObject({
  version: z.literal(1),
  root: z.string(),
});

const StateV2 = z.strictObject({
  version: z.literal(2),
  sourceRoot: z.string(),
});

const StoredState = z.discriminatedUnion("version", [StateV1, StateV2]);
type CurrentState = z.output<typeof StateV2>;

function loadCurrentState(input: unknown): CurrentState {
  const stored = StoredState.parse(input);
  const migrated = stored.version === 1 ? { version: 2 as const, sourceRoot: stored.root } : stored;
  return StateV2.parse(migrated);
}
```

Keep migrations pure and test one fixture per historical version. Do not rewrite a user's stored
file merely because it was read successfully unless the application has an explicit atomic
migration policy.

### Application code and reusable libraries have different dependency rules

Application code that owns its schemas should normally import the full package:

```ts
import * as z from "zod";
```

For a published library built on Zod, the official guidance is to declare Zod in
`peerDependencies` and also in `devDependencies`
([peer dependency guidance](https://zod.dev/library-authors#how-to-configure-peer-dependencies)).
For a library that accepts user-provided schemas, the official guidance is to build against
`zod/v4/core`; this preserves compatibility with Zod and Zod Mini
([library import guidance](https://zod.dev/library-authors#which-subpaths-should-i-import-from),
[accepting schemas](https://zod.dev/library-authors#how-to-accept-user-defined-schemas)).

If a reusable library only needs to call an arbitrary validator as a black box, Zod's own
library-author guide suggests considering Standard Schema rather than coupling the library to Zod
([library boundary guidance](https://zod.dev/library-authors#do-i-need-to-depend-on-zod)).

These library rules do not require an ordinary CLI application such as monke-tools to use
`zod/v4/core`.

## Commander 15 with `@commander-js/extra-typings` 15

### What it improves

The package infers:

- all action-handler parameters, including parsed options; and
- the object returned by `.opts()`.

It requires TypeScript 5 or newer. Commander supplies the runtime behavior
([v15 project documentation](https://github.com/commander-js/extra-typings/tree/v15.0.0#extra-typings-for-commander)).

It does **not** validate arbitrary runtime objects. It derives types from the strings and parsers
already used to declare the CLI.

### Prefer fluent inference

The generic type accumulates as `.argument()`, `.option()`, and related calls return newly
parameterized command types. Put `.action()` after the complete declaration:

```ts
import { Command } from "@commander-js/extra-typings";

new Command()
  .command("spawn")
  .argument("<session>")
  .option("--no-dirty")
  .option("-m, --main")
  .action((session, options) => {
    // session: string
    // options.dirty: boolean (a lone negated option defaults to true)
    // options.main: boolean | undefined
  });
```

The package documentation explicitly shows that inference is built through chaining
([usage tips](https://github.com/commander-js/extra-typings/tree/v15.0.0#usage-tips)).
Do not annotate the action arguments with duplicate handwritten option interfaces; allow the
declaration to be the source of truth.

For `.opts()` without an action, configure the command in the same variable initializer:

```ts
const command = new Command().option("--install").option("--interactive");

const options = command.opts();
```

This pattern is important. Declaring `const command = new Command()` and mutating it in later
statements does not update the static type of the original variable, so `.opts()` loses the useful
inference
([working and broken patterns](https://github.com/commander-js/extra-typings/tree/v15.0.0#usage-tips)).

Commander action handlers receive one value per declared argument, then parsed options, then the
command object
([Commander action handler](https://github.com/tj/commander.js/tree/v15.0.0#action-handler)).
Use `parseAsync` when an action handler is asynchronous
([Commander parsing](https://github.com/tj/commander.js/tree/v15.0.0#parse-and-parseasync)).

### Direct import versus ambient dev-only setup

There are two supported shapes.

**Direct import**

```ts
import { Command, CommanderError } from "@commander-js/extra-typings";
```

Advantages:

- explicit at the point of use;
- the primary usage documented by the project; and
- no project-wide module declaration that changes the meaning of `commander`.

Cost:

- the extra-typings package must be runtime-resolvable because the source imports it, even though
  its implementation delegates Commander behavior to `commander`.

**Ambient module**

```ts
// commander.d.ts
declare module "commander" {
  export * from "@commander-js/extra-typings";
}
```

Application imports remain:

```ts
import { Command } from "commander";
```

This permits extra-typings to be development-only. The v15 maintainers describe this setup as
recently devised and do not promote it as the suggested method
([ambient setup](https://github.com/commander-js/extra-typings/tree/v15.0.0#ambient-module-setup)).

Recommended policy:

- Prefer direct imports in application code and install extra-typings as a normal dependency.
- Use the ambient form only when unchanged runtime import paths or a type-only production
  footprint is important.
- If using the ambient form, ensure the declaration file is included by `tsconfig`, typecheck the
  packed artifact or production install, and add a small compile-time fixture. A declaration that
  works only in the maintainer checkout is not sufficient.

### Known limitations

The project documents:

- noisy generic types in editors and errors;
- inference-returning chains use the base class rather than subclass `this`;
- `.command(name)` on a `Command` subclass returns the base command type; and
- `Option` and `Argument` subclasses need explicit type parameters.

See the
[v15 limitations](https://github.com/commander-js/extra-typings/tree/v15.0.0#limitations).
These limitations are minor for monke-tools because it constructs ordinary `Command` instances and
does not subclass Commander.

Avoid exporting deeply inferred Commander generic types across modules. Keep command construction
near the CLI adapter and pass plain application values into domain functions.

### Bun and runtime implications

Commander 15's documented engine floor is Node 22.12
([package metadata](https://github.com/tj/commander.js/blob/v15.0.0/package.json)). That is a Node
support statement, not a Commander-specific Bun certification.

Bun supports Node-style package resolution plus both ESM and CommonJS, and asks users to report
Node-compatible packages that fail under Bun as Bun bugs
([Node compatibility](https://bun.sh/docs/runtime/nodejs-compat),
[module resolution](https://bun.sh/docs/runtime/module-resolution)). The v15 extra-typings package
peers on Commander's matching `15.0` minor
([package metadata](https://github.com/commander-js/extra-typings/blob/v15.0.0/package.json)).

Practical guidance:

- Keep the existing Bun CLI behavior tests after changing imports.
- Cover successful parsing, unknown options, missing arguments, negated booleans, synchronous and
  asynchronous actions, help/error interception, and process exit behavior.
- Do not treat a TypeScript-only success as a runtime compatibility test.
- If a distributed executable may run under Node as well as Bun, honor Commander's Node 22.12
  floor.

No Bun-specific adapter should be necessary for extra-typings. The change is primarily in imports
and inferred types; Commander remains the runtime parser.

## A reusable adoption checklist

### Discovery

- Search for `JSON.parse`, YAML parsing, environment decoding, subprocess JSON, request bodies,
  database JSON, message queues, local storage, and `as SomeType` casts.
- Search for handwritten `isRecord`, `requireString`, `assertKnownKeys`, and normalization helpers.
- Search for persisted objects with a `version` field but no runtime parser.
- Search for Commander `.argument`, `.option`, `.action`, and generic `.opts<T>()` calls.
- Identify public error text and behavior tests before changing validation.

### Boundary design

- Name the raw/stored schema separately from the domain object.
- Decide whether unknown keys reject, strip, or pass through.
- State which defaults are same-version defaults and which changes require migration.
- Keep syntax errors distinct from schema errors.
- Keep contextual and I/O validation outside schemas.
- Decide whether the boundary fails closed, fails soft, or deliberately tolerates partial data.

### Implementation

- Parse external data to `unknown`.
- Use strict schemas for application-owned closed formats.
- Derive boundary types with `z.input`/`z.output`.
- Translate Zod errors into the application's error abstraction.
- Validate writes as well as reads for persisted application-owned data.
- Add fixtures for malformed syntax, unknown keys, wrong primitives, missing fields, corrupt nested
  records, supported old versions, and unknown future versions.
- For Commander, keep the definition and action in one fluent chain and remove duplicate option
  interfaces only after inference is verified.

### Verification

- Run typechecking and the full behavior suite.
- Compare user-visible error wording and exit status.
- Test packaged or production dependency installation.
- Test the actual supported runtimes rather than assuming Node and Bun are identical.
- Confirm invalid persisted files fail with the file path and field path needed to repair them.
- Confirm migrations are deterministic and writers emit only the current version.

### Smells to reject

- `schema.parse(value) as DomainType`
- a schema and a handwritten identical interface
- one enormous custom `.check()` containing filesystem and process calls
- `.catch(defaultValue)` on durable state
- `z.object()` on an owned closed format without consciously accepting key stripping
- global error customization used to emulate one boundary's wording
- a codec used where only a one-way normalization is needed
- extra-typings plus retained handwritten action option types
- an inferred Commander type exported deep into application code

## monke-tools pre-migration boundary inventory

This table records the evidence that motivated the migration. The implementation status and lessons
are captured after the migration plan.

### Runtime data

| Boundary                                                                                 | Current behavior                                                             | Recommendation                                                                                                                              | Priority                   |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| [`src/registry.ts`](../../src/registry.ts) Session state reads                           | YAML is cast directly to `SessionState` in single and list reads             | Strict versioned schema; translate errors with file path; validate before write                                                             | Highest                    |
| [`src/registry.ts`](../../src/registry.ts) repo reservations                             | YAML is cast directly to `RepoReservation`                                   | Strict v1 schema; positive integer/range checks; validate before allocation and write                                                       | Highest                    |
| [`src/swing.ts`](../../src/swing.ts) Swing history                                       | YAML is cast directly to `SwingHistory`                                      | Strict v1 schema with discriminated target union; preserve missing-file default                                                             | High                       |
| [`src/global-config.ts`](../../src/global-config.ts) Global monke config                 | Syntax-safe YAML plus comprehensive manual structural validation             | Replace record/key/type helpers with strict schemas; retain path normalization and duplicate-target domain checks                           | High                       |
| [`src/config.ts`](../../src/config.ts) `monke.yml`                                       | Strict YAML parsing plus extensive manual structural and semantic validation | Add raw structural schemas only; retain path containment, existence, dependency ownership, graph, and cross-entry uniqueness in domain code | Medium/high, larger change |
| [`src/resources.ts`](../../src/resources.ts) Resource command runner envelope and return | JSON envelope and dynamic return map checked manually                        | Strict envelope schema; use record/string validation for output values, then retain exact declared-key and collision checks                 | Medium                     |
| [`src/cleanup-merged.ts`](../../src/cleanup-merged.ts) `gh` JSON                         | Mixed casts, array checks, and a fail-soft normalizer                        | Use schemas that preserve fail-safe cleanup behavior; do not accidentally turn malformed optional metadata into unsafe eligibility          | Medium                     |
| [`src/swing.ts`](../../src/swing.ts) `gh` JSON                                           | Manual object and required-field helpers                                     | Small third-party response schemas with explicit required fields and tolerant extra keys                                                    | Medium                     |
| [`src/skills.ts`](../../src/skills.ts) flat Skill manifest                               | Partial cast, top-level checks, then `String(...)` coercion for links        | Strict versioned manifest; reject malformed links rather than stringify them                                                                | Medium                     |
| [`scripts/import-skills.ts`](../../scripts/import-skills.ts) import recipe store         | Thorough manual normalization and uniqueness checks                          | Schema for structure plus existing uniqueness/sorting functions                                                                             | Low/medium                 |
| [`src/runtime.ts`](../../src/runtime.ts) lock metadata                                   | Best-effort JSON with intentional fallback to file timestamp                 | Keep the small tolerant parser unless a schema makes the fallback clearer; this is not a high-value migration                               | Low                        |

The key distinction is current correctness risk. `config.ts` and `global-config.ts` are verbose but
already defensive. `registry.ts` and Swing history trust casts on durable files, so a malformed or
newer file can leak arbitrary shapes into port allocation, cleanup, and navigation.

### CLI declarations

[`src/index.ts`](../../src/index.ts) is already shaped well for extra-typings: each subcommand
chains its arguments and options directly into `.action()`. The immediate cleanup is to:

- import Commander symbols from the matching extra-typings package;
- remove `RawSpawnCommandOptions`, `RawCleanupCommandOptions`, and inline `{ binary?: string }`
  action annotations;
- let negated `--no-dirty`, booleans, option values, and positional arguments infer from the
  declaration; and
- retain the existing error mapping and `parseAsync` behavior.

[`scripts/import-skills.ts`](../../scripts/import-skills.ts) and
[`scripts/update-skills.ts`](../../scripts/update-skills.ts) currently call generic `.opts<T>()`.
Their command declarations are built in one initializer chain, so extra-typings can infer the
options. Prefer an action callback or the typed configured command value; if the scripts continue
reading positional values after `parse`, verify whether `processedArgs` gives a cleaner typed path
than `args[0]!`.

## monke-tools migration plan

### Phase 0: characterize behavior

- Add tests for corrupt Session state, reservation, and Swing history files.
- Pin expected file-path and field-path information in failures.
- Add CLI type fixtures or `expectTypeOf` checks for `--no-dirty`, option values, and optional
  arguments.
- Record current fail-safe behavior for malformed `gh` responses before schema work.

### Phase 1: Commander typing layer

- Align Commander and extra-typings on the selected minor line (`15.0` for this migration).
- Prefer direct imports.
- Remove duplicate action option types.
- Run typecheck plus the CLI tests.

This phase is small and independent from runtime data validation.

### Phase 2: persisted Session state and reservations

- Create a small persistence schema module for `SessionState` and `RepoReservation`.
- Use strict v1 schemas and schema-derived stored types.
- Centralize YAML syntax parsing, Zod issue translation, and file labels.
- Route `loadSessionState`, `listSessionStates`, `getOrCreateReservation`, and
  `listReservations` through the schemas.
- Validate writes without changing atomicity or file layout.
- Reject unknown versions clearly; do not invent migrations until v2 exists.

### Phase 3: other machine-local state

- Add a strict `SwingHistory` schema with a discriminated `kind` target.
- Move Global monke config structure into Zod.
- Keep absolute-path normalization, duplicate target detection, and installation semantics in
  ordinary functions.
- Reuse only a small boundary helper; do not create a generic validation framework.

### Phase 4: `monke.yml`

- Define raw schemas for apps, mappings, external repos, seed paths, Resource values, and Resource
  commands.
- Preserve YAML parser settings for duplicate keys, disabled merges, and strict syntax.
- Preserve key order where it controls materialization or output.
- Feed the schema output into the current domain construction code.
- Keep `resolveInside`, filesystem existence, dependency graph traversal, ownership checks,
  duplicate rewrite targets, and output-name collision logic outside Zod.
- Delete manual record/type/key helpers only when their error behavior is replaced and tested.

This should be a separation refactor, not a rewrite of the graph algorithm.

### Phase 5: protocol and manifest boundaries

- Convert the Resource command runner envelope first, then its dynamic return record.
- Convert required `gh` response shapes while preserving cleanup's fail-closed eligibility
  decisions.
- Convert flat Skill manifests and import recipes.
- Leave tolerant lock metadata last; retain its file-timestamp fallback if a schema is added.

### Phase 6: consolidate

- Remove duplicated boundary interfaces that are now schema-derived.
- Remove obsolete record/key/type helpers.
- Keep separate adapters for config errors, persisted-state errors, and external-command errors when
  their public wording differs.
- Review dependency placement and packaged runtime behavior.

## monke-tools implementation record

Implemented on 2026-07-24 with Zod `4.4.3`, Commander `15.0.0`, and
`@commander-js/extra-typings` `15.0.0`.

The migration covered:

- strict, versioned Session state, reservations, and Swing history;
- strict Global config and `monke.yml` structural schemas, with contextual filesystem and graph
  checks left in ordinary domain code;
- Resource command envelopes and return maps;
- tolerant third-party GitHub CLI response schemas that preserve fail-closed cleanup behavior;
- strict flat Skill manifests and import recipe stores;
- best-effort lock metadata, while retaining the file timestamp as the fallback;
- validation on persisted writes as well as reads; and
- inferred Commander action/options types in the main CLI, Skill import/update scripts, and the
  Better Stack Skill CLI.

### Findings to carry into other repositories

1. **Treat error text as an API.** A generic Zod formatter changed established messages. The shared
   adapter needed explicit handling for unknown keys and the repository's `path must ...` grammar.
   Characterization tests should be written before deleting manual validators.
2. **Validate owned writes too.** Read validation protects consumers, but write validation locates
   internal construction errors at the producer and prevents new corrupt durable state.
3. **Keep owned and external object policies different.** Strict objects were appropriate for
   configs, manifests, state, and internal protocols. GitHub CLI responses use ordinary
   `z.object()` shapes so new upstream fields do not break the application.
4. **Preserve fail-soft and fail-closed semantics deliberately.** Malformed optional cleanup
   metadata still makes a candidate ineligible rather than crashing or becoming eligible.
   Unreadable lock metadata still falls back to the lock file timestamp.
5. **Schema validation does not replace contextual validation.** Path containment, file
   existence, dependency ownership, graph checks, dynamic exact-key comparisons, output
   collisions, and cross-record uniqueness remained outside Zod.
6. **Commander inference works best when construction stays local and fluent.** Direct imports
   worked under Bun. A positive flag such as `--codex` inferred as `true | undefined`, while the
   lone negated `--no-dirty` inferred as an always-defined `boolean`. `processedArgs` provided a
   typed positional-argument path for parser-style scripts. Handwritten `.opts<T>()` and action
   option interfaces became unnecessary. When a named handler is useful, derive its options with
   `ReturnType<ConfiguredCommand["opts"]>` rather than recreating the option shape.
7. **Matching versions are a dependency invariant.** Commander and extra-typings must share major
   and minor numbers. Matching tilde ranges encode that constraint better than independent caret
   ranges.
8. **`noUncheckedIndexedAccess` still needs semantic narrowing.** After a dynamic output key is
   proven present, TypeScript may still retain `undefined` for record indexing. A narrow non-null
   assertion at that already-validated seam is clearer than weakening the schema-derived type.
9. **Order can be observable.** Schema output and subsequent `Object.entries()` traversal must
   preserve configuration order where materialization or generated output depends on it.
10. **Scope test discovery in repositories containing clones.** In this repository, bare
    `bun test` also discovers tests beneath untracked `tmp/` clones. Use `bun test ./__tests__` for
    the repository suite, or configure an exclusion, so fixture repositories cannot contaminate
    verification.

The small shared adapter was enough: YAML syntax policy, structural parsing, issue-path formatting,
and application error translation. Boundary-specific schemas and domain checks stayed near their
callers; no general validation framework was needed.

## Expected outcome

The goal is not “use Zod everywhere.” The useful end state is:

- every untrusted value crosses one visible parser;
- application-owned formats reject unknown keys;
- persisted versions are explicit and future versions fail safely;
- raw boundary types come from schemas;
- domain objects remain designed for the domain;
- errors still speak in monke-tools terminology; and
- Commander declarations, rather than parallel interfaces, determine CLI action types.

That combination removes unsafe casts and repetitive structural checks without hiding the
repository's filesystem, Git, Session, and Resource semantics inside validation-library machinery.
