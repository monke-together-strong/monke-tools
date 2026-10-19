import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createOxlintConfig } from "../packages/oxc-config/src/oxlint.ts";
import { makeTempDir, write } from "./helpers.ts";

const requireViteDependency = createRequire(import.meta.resolve("vite-plus/package.json"));

const requireTsgolintDependency = createRequire(
  requireViteDependency.resolve("oxlint-tsgolint/package.json")
);

const tsgolintExecutable = requireTsgolintDependency.resolve(
  `@oxlint-tsgolint/${process.platform}-${process.arch}/tsgolint${process.platform === "win32" ? ".exe" : ""}`
);

const oxlint = path.resolve(import.meta.dirname, "../packages/oxc-config/node_modules/.bin/oxlint");

function lint(source: string) {
  const root = makeTempDir("oxc-errors");
  write(root, "input.ts", source);
  write(
    root,
    "oxlint.config.mjs",
    `export default ${JSON.stringify(createOxlintConfig({ root }))};`
  );
  write(
    root,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { module: "NodeNext", strict: true, target: "ESNext" },
      include: ["input.ts"]
    })
  );

  // Standalone Oxlint must not inherit Vite+'s config loading mode.
  const result = Bun.spawnSync([oxlint, "-c", "oxlint.config.mjs", "--format=unix", "input.ts"], {
    cwd: root,
    env: { ...process.env, OXLINT_TSGOLINT_PATH: tsgolintExecutable, VP_VERSION: undefined },
    timeout: 20_000
  });

  return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

describe("oxc-config error parameters", () => {
  it("accepts cause: unknown in rejection callbacks", () => {
    const result = lint(`declare const pending: Promise<string>;

export const handled = pending.catch((cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)
);
`);

    expect(result).toMatchObject({ exitCode: 0 });
  });

  it("accepts cause in catch clauses and unknown error helpers", () => {
    const result = lint(`export function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function caught(): string {
  try {
    throw new Error("expected");
  } catch (cause) {
    return describeCause(cause);
  }
}
`);

    expect(result).toMatchObject({ exitCode: 0 });
  });

  it.each([
    [
      "unknown payload",
      "export function describePayload(payload: unknown): string { return String(payload); }",
      "anti-slop(no-unknown-parameters)"
    ],
    [
      "property access before narrowing",
      "declare const pending: Promise<string>;\n\nexport const handled = pending.catch((cause: unknown) => cause.message);",
      "typescript(TS18046)"
    ],
    [
      "missing unknown annotation",
      "declare const pending: Promise<string>;\n\nexport const handled = pending.catch((cause) => String(cause));",
      "typescript(use-unknown-in-catch-callback-variable)"
    ],
    [
      "conflicting catch parameter name",
      "declare const pending: Promise<string>;\n\nexport const handled = pending.catch((error: unknown) => String(error));",
      "unicorn(catch-error-name)"
    ]
  ])("rejects %s", (_description, source, diagnostic) => {
    const result = lint(source);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(diagnostic);
  });
});
