import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("distributed skill source layout uses internal and imported categories", () => {
  expect(
    existsSync(path.join(projectRoot, "skills", "internal", "monke-tools-core", "SKILL.md")),
  ).toBe(true);
  expect(existsSync(path.join(projectRoot, "skills", "imported"))).toBe(true);
  expect(existsSync(path.join(projectRoot, "skills", "core"))).toBe(false);

  const coreSkill = readFileSync(
    path.join(projectRoot, "skills", "internal", "monke-tools-core", "SKILL.md"),
    "utf8",
  );
  expect(coreSkill).toMatch(/^name: monke-tools-core$/m);
});

test("metadata and install docs do not reference the retired package discovery path", () => {
  const combined = [
    "README.md",
    "package.json",
    "bun.lock",
    "scripts/install-local.sh",
    "docs/adr/0001-install-distributed-skills-into-agent-roots.md",
  ]
    .map((relativePath) => readFileSync(path.join(projectRoot, relativePath), "utf8"))
    .join("\n");

  expect(combined).not.toMatch(/TanStack Intent|@tanstack\/intent|tanstack-intent/);
  expect(combined).not.toMatch(/npm link|npm root -g|global package roots|intent-skills/);
  expect(combined).toMatch(/Distributed skills/);
  expect(combined).toMatch(/Agent skill roots/);
});
