import { Command } from "@commander-js/extra-typings";
import { expectTypeOf, test } from "vitest";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

test("Commander declarations infer positional and option types", () => {
  const command = new Command()
    .argument("<session>")
    .option("--no-dirty")
    .option("--codex")
    .option("--timeout <seconds>", "Timeout", Number);

  command.action((session, options) => {
    expectTypeOf(session).toEqualTypeOf<string>();
    expectTypeOf(options.dirty).toEqualTypeOf<boolean>();
    expectTypeOf<Equal<typeof options.codex, true | undefined>>().toEqualTypeOf<true>();
    expectTypeOf(options.timeout).toEqualTypeOf<number | undefined>();
  });

  expectTypeOf(command.processedArgs[0]).toEqualTypeOf<string>();

  new Command().argument("[target]").action((target) => {
    expectTypeOf<Equal<typeof target, string | undefined>>().toEqualTypeOf<true>();
  });
});
