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
import {
  Command,
  CommanderError,
  type OutputConfiguration,
} from "@commander-js/extra-typings";
import * as z from "zod";

const ConfigSchema = z.strictObject({
  sourceRoot: z.string().min(1),
  concurrency: z.number().int().positive(),
});

interface ConfigurableCliParser {
  configureOutput(configuration: OutputConfiguration): unknown;
  exitOverride(callback?: (error: CommanderError) => never): unknown;
  showSuggestionAfterError(displaySuggestion?: boolean): unknown;
}

function configureCliParser<T extends ConfigurableCliParser>(program: T): T {
  let errorOutput = "";

  program.showSuggestionAfterError(false);
  program.configureOutput({
    writeErr: (message) => {
      errorOutput += message;
    },
  });
  program.exitOverride((error) => {
    throw new CommanderError(error.exitCode, error.code, errorOutput.trimEnd() || error.message);
  });
  return program;
}

function reportCliFailure(error: unknown): void {
  if (error instanceof CommanderError && error.exitCode === 0) return; // explicit help, version

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

const program = configureCliParser(new Command())
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
argument and option types. The shared parser helper is generic so inference survives the call.

Commander normally writes a failure to stderr before `exitOverride()` throws. Buffer that output so
the executable handler can print it exactly once. This also preserves Commander's generated help
when a command owns subcommands but none was selected: with `exitOverride()`, the thrown error's
message is only the placeholder `(outputHelp)`, not the help text Commander already sent to
`writeErr`.

`ConfigSchema.parse(raw)` returns `z.output<typeof ConfigSchema>`, so no duplicate `Config`
interface or cast is needed. Annotating the input `unknown` records that it has not yet crossed the
boundary.

Configure the root parser before declaring any subcommand. `.command()` copies the parent's output
configuration and exit callback at creation time, so a subcommand declared first writes its own
diagnostic and calls `process.exit`, skipping the handler and killing the process mid-run. Nothing
type-checks this and the root command still behaves, so the gap shows only on subcommand failures.
The same copy covers help configuration and `allowExcessArguments` — set them once on the root
instead of repeating them per subcommand. Leave Commander's built-in help option and help command
enabled unless the product deliberately replaces them.

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

Explicit help (`--help` or `help <command>`) and version stay stdout successes with exit status
zero. In Commander 15, parsing a command that owns subcommands with none selected generates help on
stderr and exits with status one; preserve that generated output instead of replacing it with a
custom missing-command guard. Every other failure produces one stderr diagnostic and a nonzero
status. A standalone CLI that needs no testable boundary can skip the override and let Commander
write and exit on its own.
