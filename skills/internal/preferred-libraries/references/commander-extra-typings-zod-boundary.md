# Commander, extra-typings, and Zod boundary

> **Status: WIP SLOP**

Use this pattern for a TypeScript CLI that accepts structured runtime input.

## Responsibilities

- Commander owns CLI grammar: commands, arguments, options, choices, relationships, help, version.
- `@commander-js/extra-typings` infers action arguments and options from those declarations.
  Commander ships its own types, but its action parameters are broadly typed and `.opts<T>()` trusts
  whatever type the caller supplies.
- Zod validates structured values assembled from CLI input, files, environment, or subprocess
  output.
- One executable-level handler renders every failure.

Add extra-typings when source code declares a Commander CLI, judged from direct imports rather than
a transitive lockfile entry. Keep both packages on the same major and minor. A direct extra-typings
import is a runtime dependency even though Commander provides the parser.

## Boundary

```ts
import { readFile } from "node:fs/promises";
import { Command, CommanderError } from "@commander-js/extra-typings";
import * as z from "zod";

const ConfigSchema = z.strictObject({
  sourceRoot: z.string().min(1),
  concurrency: z.number().int().positive(),
});

function reportCliFailure(error: unknown): void {
  if (error instanceof CommanderError && error.exitCode === 0) return; // help, version

  process.stderr.write(`${formatCliFailure(error)}\n`);
  process.exitCode = 1;
}

function formatCliFailure(error: unknown): string {
  if (error instanceof z.ZodError) {
    return `error: invalid input\n${z.prettifyError(error)}`;
  }
  // Expected failures carry a message already written for the user.
  if (error instanceof AppError || error instanceof CommanderError) {
    return error.message;
  }
  // Anything else is a bug, so keep the stack for whoever debugs it.
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

const program = new Command()
  .configureOutput({ writeErr: () => undefined })
  .exitOverride()
  .requiredOption("--config <path>")
  .action(async (options) => {
    const raw: unknown = JSON.parse(await readFile(options.config, "utf8"));
    await run(ConfigSchema.parse(raw));
  });

try {
  await program.parseAsync();
} catch (error) {
  reportCliFailure(error);
}
```

Every configuration method returns `this`, so chaining into `new Command()` keeps the inferred
argument and option types. Extract a shared helper once several executables need the same
configuration, and make it generic so inference survives the call.

`ConfigSchema.parse(raw)` returns `z.output<typeof ConfigSchema>`, so no duplicate `Config`
interface or cast is needed. Annotating the input `unknown` records that it has not yet crossed the
boundary.

Configure the root parser before declaring any subcommand. `.command()` copies the parent's output
configuration and exit callback at creation time, so a subcommand declared first writes its own
diagnostic and calls `process.exit`, skipping the handler and killing the process mid-run. Nothing
type-checks this and the root command still behaves, so the gap shows only on subcommand failures.
The same copy covers `helpOption`, `addHelpCommand`, and `allowExcessArguments` — set them once on
the root instead of repeating them per subcommand.

Call `program.parseAsync()` when any action or hook is asynchronous, and `schema.parseAsync()` when
a schema holds asynchronous refinements. Commander reads `process.argv` when `parse()` receives no
arguments; pass `(argv, { from: "user" })` only where a wrapper injects arguments for tests or
embedding.

Await that boundary rather than installing a process-level `uncaughtException` handler.

## Error ownership

Throw and let errors bubble to the one handler. Catching an error only to reformat and rethrow it
buys nothing.

**Use `safeParse()` only when a failure produces a value; use `parse()` when a failure produces an
error.** Falling back to a default, degrading to partial data, or returning `null` are real
recoveries that `parse()` cannot express. Checking `success` and then throwing is not — that is
the handler's job.

Give the handler two classes of failure to tell apart:

- An `AppError` — the single class the application throws for expected failures — carries a
  message written for the user. Print the message alone.
- Anything else is a bug. Print the stack, or nobody can debug it.

That distinction is the whole job of such a class. A marker class nothing tests with `instanceof` is
`Error` with a longer name.

Wrap a boundary in a helper when the failure needs a label the handler cannot reconstruct — which
file, which subprocess, which upstream response. One helper keeps each call site to a single line
and still names the source:

```ts
export function parseBoundaryValue<T extends z.ZodType>(
  schema: T,
  value: unknown,
  label: string,
): z.output<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new AppError(`Invalid ${label}:\n${z.prettifyError(result.error)}`);
}
```

The global `ZodError` branch then catches only schemas that bypassed the helper.

`z.prettifyError` is the right default, not always the best output. When schemas phrase their own
messages to complete a sentence — `z.array(..., { error: "must be a non-empty array" })` —
joining path to message reads better: `apps.web.ports must be a non-empty array`. That pairing
earns a small custom formatter, so long as it stays inside the one helper. Judge it on the sentence
a user reads.

Help and version stay stdout successes with exit status zero; every other failure produces one
stderr diagnostic and a nonzero status. A standalone CLI that needs no testable boundary can skip
the override and let Commander write and exit on its own.
