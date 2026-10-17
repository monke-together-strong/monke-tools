import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { createOxlintConfig } from "../packages/oxc-config/src/oxlint.ts";
import { makeTempDir, write } from "./helpers.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const oxlint = path.join(projectRoot, "packages/oxc-config/node_modules/.bin/oxlint");

const component = `export var count = 1;

export function List({ items }: { items: string[] }) {
  return (
    <ul>
      <img src="/x.png" />
      {items.map((item) => <li>{item}</li>)}
    </ul>
  );
}
`;

const oxlintReportSchema = z.object({
  diagnostics: z.array(z.object({ code: z.string(), filename: z.string() }))
});

// `vp test` sets VP_VERSION, which makes Oxlint expect a Vite+ config with a `lint` field.
const oxlintEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== "VP_VERSION")
);

function lintCodes(root: string, directory: string) {
  const result = spawnSync(oxlint, ["-c", "oxlint.config.mjs", "-f", "json", directory], {
    cwd: root,
    encoding: "utf-8",
    env: oxlintEnv
  });

  return new Set(
    oxlintReportSchema.parse(JSON.parse(result.stdout)).diagnostics.map(({ code }) => code)
  );
}

describe("oxc-config frameworks", () => {
  it("lints a scoped framework only inside its directories and applies root tuning there", () => {
    const root = makeTempDir("oxc-frameworks");
    write(root, "apps/web/src/list.tsx", component);
    write(root, "packages/core/src/list.tsx", component);

    const config = createOxlintConfig({
      frameworks: { react: ["apps/web"] },
      options: { typeAware: false, typeCheck: false },
      root,
      rules: { "react/jsx-key": "off" }
    });

    write(root, "oxlint.config.mjs", `export default ${JSON.stringify(config)};\n`);

    const web = lintCodes(root, "apps/web");
    const core = lintCodes(root, "packages/core");

    expect(web).toContain("jsx-a11y(alt-text)");
    expect(web).not.toContain("react(jsx-key)");
    expect(web).toContain("eslint(no-var)");
    expect(core).not.toContain("jsx-a11y(alt-text)");
    expect(core).toContain("eslint(no-var)");
  });

  it("rejects a workspace framework dependency until a scope covers or declines it", () => {
    const root = makeTempDir("oxc-frameworks");
    write(root, "package.json", JSON.stringify({ workspaces: ["apps/*"] }));
    write(root, "apps/web/package.json", JSON.stringify({ dependencies: { react: "^19.0.0" } }));

    const uncovered =
      'apps/web/package.json depends on react, but frameworks["react"] does not cover apps/web.';

    expect(() => createOxlintConfig({ root })).toThrow(uncovered);
    expect(() => createOxlintConfig({ frameworks: { react: ["apps/admin"] }, root })).toThrow(
      uncovered
    );
    expect(() => createOxlintConfig({ frameworks: { react: ["apps/web"] }, root })).not.toThrow();
    expect(() => createOxlintConfig({ frameworks: { react: false }, root })).not.toThrow();
  });

  it("requires a framework to list directories when its plugin package is installed", () => {
    const root = makeTempDir("oxc-frameworks");
    write(root, "package.json", JSON.stringify({ devDependencies: { "@shadcn/lint": "^0.2.1" } }));
    write(root, "pnpm-workspace.yaml", "packages:\n  - apps/*\n");
    write(root, "apps/web/package.json", JSON.stringify({ name: "web" }));

    const unset =
      'package.json depends on @shadcn/lint, but frameworks["shadcn"] lists no directories.';

    expect(() => createOxlintConfig({ root })).toThrow(unset);
    expect(() => createOxlintConfig({ frameworks: { shadcn: [] }, root })).toThrow(unset);
    expect(() => createOxlintConfig({ frameworks: { shadcn: ["apps/web"] }, root })).not.toThrow();
  });
});
