import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { writeImportRecipeStore } from "../scripts/skill-import-recipes.ts";
import { guidanceDigest, restoreSkillImports } from "../scripts/skill-lock.ts";
import { errorMessage, ThrownValueSchema } from "../src/errors.ts";
import { makeTempDir, read, write } from "./helpers.ts";

describe("parallel locked skill restore", () => {
  test.each([
    { expectedFailure: null, failImport: false },
    {
      expectedFailure: "Fixture import failed",
      failImport: true
    }
  ])(
    "bounds Git and importer concurrency and waits for siblings when an import fails: $failImport",
    async ({ expectedFailure, failImport }) => {
      const sandbox = makeTempDir("parallel-skill-restore");
      const home = path.join(sandbox, "home");
      const bin = path.join(sandbox, "bin");
      mkdirSync(bin);
      const recipes = Array.from({ length: 7 }, (_, index) => {
        const slug = `skill-${index}`;
        const skills = [{ kind: "skill" as const, selector: slug, slug }];
        write(sandbox, `skills/imported/${slug}/SKILL.md`, `accepted ${slug}\n`);
        return {
          lock: {
            commit: String(index).padStart(40, "0"),
            digest: guidanceDigest(sandbox, skills),
            importerVersion: "1.7.0",
            materializerVersion: 1,
            repository: `https://github.com/owner/source-${index}.git`,
            subpath: "",
            updateRef: "HEAD"
          },
          skills,
          source: `owner/source-${index}`
        };
      });
      writeImportRecipeStore(sandbox, { recipes, version: 3 });
      const acceptedLock = read(sandbox, "skills.lock.json");
      for (let index = 0; index < 6; index += 1) {
        rmSync(path.join(sandbox, `skills/imported/skill-${index}`), { recursive: true });
      }
      write(sandbox, "skills/imported/obsolete/SKILL.md", "obsolete");
      const script = `#!${process.execPath}
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
const root = ${JSON.stringify(sandbox)};
const home = ${JSON.stringify(home)};
const failImport = ${failImport};
const args = process.argv.slice(2);
const importer = path.basename(process.argv[1]) === "npx";
if (!importer && args[0] !== "fetch") process.exit(0);
const index = importer
  ? Number(args[args.indexOf("--skill") + 1].split("-")[1])
  : Number(args.at(-1));
const phase = importer ? "import" : "fetch";
const marker = (name) => path.join(root, name);
writeFileSync(marker(phase + "-start-" + index), "");
const active = marker("active-" + phase + "-" + index);
writeFileSync(active, "");
if (readdirSync(root).filter((name) => name.startsWith("active-")).length > 4) {
  throw new Error("More than four sources ran at once");
}
async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for sibling sources");
    await Bun.sleep(10);
  }
}
// Both network phases must overlap for the first batch of four sources.
if (index < 4) {
  await waitFor(() => [0, 1, 2, 3].every((item) => existsSync(marker(phase + "-start-" + item))));
}
if (importer && failImport) {
  if (index === 0) {
    writeFileSync(marker("failed"), "");
    rmSync(active);
    process.stderr.write("Fixture import failed");
    process.exit(42);
  }
  await waitFor(() => existsSync(marker("failed")));
  await Bun.sleep(100);
  if (readdirSync(path.join(home, "locks")).length === 0) {
    throw new Error("Mutation lock released before sibling finished");
  }
}
if (importer) {
  const slug = "skill-" + index;
  const target = path.join(".agents", "skills", slug);
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, "SKILL.md"), "accepted " + slug + "\\n");
}
rmSync(active);
writeFileSync(marker(phase + "-done-" + index), "");
`;
      for (const command of ["git", "npx"]) {
        const file = path.join(bin, command);
        writeFileSync(file, script);
        chmodSync(file, 0o755);
      }
      const originalPath = process.env.PATH;
      const originalHome = process.env.MONKE_HOME;
      try {
        process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
        process.env.MONKE_HOME = home;
        let failure: string | null = null;
        try {
          await restoreSkillImports(sandbox);
        } catch (error) {
          failure = errorMessage(ThrownValueSchema.parse(error)).split("\n").at(-1) ?? null;
        }
        expect(failure).toStrictEqual(expectedFailure);
        for (let index = 0; index < 6; index += 1) {
          expect(existsSync(path.join(sandbox, `fetch-done-${index}`))).toBeTruthy();
        }
        for (const index of Array.from({ length: 6 }, (_, item) => item).filter(
          (item) => !failImport || item !== 0
        )) {
          expect(existsSync(path.join(sandbox, `import-done-${index}`))).toBeTruthy();
          expect(read(sandbox, `skills/imported/skill-${index}/SKILL.md`)).toBe(
            `accepted skill-${index}\n`
          );
        }
        expect(existsSync(path.join(sandbox, "fetch-start-6"))).toBeFalsy();
        expect(existsSync(path.join(sandbox, "skills/imported/obsolete"))).toBe(failImport);
        expect(read(sandbox, "skills.lock.json")).toBe(acceptedLock);
        expect(readdirSync(path.join(sandbox, "tmp"))).toStrictEqual([]);
        expect(readdirSync(path.join(home, "locks"))).toStrictEqual([]);
      } finally {
        process.env.PATH = originalPath;
        process.env.MONKE_HOME = originalHome;
      }
    },
    15_000
  );
});
