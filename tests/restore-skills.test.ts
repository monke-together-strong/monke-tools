import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { writeImportRecipeStore } from "../scripts/skill-import-recipes.ts";
import { rememberRestoredRecipe, restoreSkillImports } from "../scripts/skill-lock.ts";
import { errorMessage, ThrownValueSchema } from "../src/errors.ts";
import { createRepo, git, makeTempDir, read, write, writeExecutable } from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

describe("parallel locked skill restore", () => {
  it("preserves distinct skill and reference sources sharing a slug in batch restore", async () => {
    const sandbox = makeTempDir("cross-kind-skill-restore");

    const recipes = (["skill", "reference"] as const).map((kind) => {
      const source = createRepo(path.join(sandbox, `source-${kind}`), {
        "skills/shared/SKILL.md": `---\nname: shared\ndescription: Shared fixture.\n---\nDistinct ${kind} bytes.\n`
      });

      return {
        commit: git(source, ["rev-parse", "HEAD"]),
        disableModelInvocation: true,
        skills: [{ kind, selector: "shared", slug: "shared" }],
        source
      };
    });

    const target = path.join(sandbox, "target");
    writeImportRecipeStore(target, { recipes, version: 4 });
    const bin = path.join(sandbox, "bin");
    writeExecutable(
      path.join(bin, "npx"),
      `#!/bin/sh
set -eu
mkdir -p .agents/skills
cp -R "$4/skills/shared" .agents/skills/shared
`
    );

    const runtime = createTestRuntime({
      cwd: target,
      env: {
        MONKE_HOME: path.join(sandbox, "home"),
        PATH: `${bin}${path.delimiter}${process.env.PATH}`
      }
    });

    await restoreSkillImports(target, false, runtime);

    expect(read(target, "skills/imported/shared/SKILL.md")).toContain("Distinct skill bytes.");
    expect(read(target, "skills/imported/shared/SKILL.md")).toContain(
      "disable-model-invocation: true"
    );
    expect(read(target, "skills/references/imported/shared/MAIN.md")).toBe(
      "Distinct reference bytes.\n"
    );
    const marker = read(target, "skills/.monke-restored.json");
    writeExecutable(path.join(bin, "git"), "#!/bin/sh\nexit 42\n");
    writeExecutable(path.join(bin, "npx"), "#!/bin/sh\nexit 42\n");
    await restoreSkillImports(target, false, runtime);
    expect(read(target, "skills/.monke-restored.json")).toBe(marker);
  });

  it("serves importer fetches of a remote source from its pinned checkout", async () => {
    const sandbox = makeTempDir("remote-skill-restore");

    const skill = (body: string) =>
      `---\nname: remote\ndescription: Remote fixture.\n---\n${body}\n`;

    const upstream = createRepo(path.join(sandbox, "upstream"), {
      "skills/remote/SKILL.md": skill("Pinned.")
    });

    const commit = git(upstream, ["rev-parse", "HEAD"]);
    write(upstream, "skills/remote/SKILL.md", skill("Latest."));
    git(upstream, ["commit", "-am", "advance upstream"]);
    const target = path.join(sandbox, "target");

    writeImportRecipeStore(target, {
      recipes: [
        {
          commit,
          skills: [{ kind: "skill", selector: "remote", slug: "remote" }],
          source: "https://example.test/upstream"
        }
      ],
      version: 4
    });

    const bin = path.join(sandbox, "bin");
    const importerUrls = path.join(sandbox, "importer-urls");

    writeExecutable(
      path.join(bin, "npx"),
      `#!/bin/sh
set -eu
url=\${4%%#*}
for remote in "$url" https://example.test/sibling; do
  git ls-remote --get-url "$remote" >> ${JSON.stringify(importerUrls)}
done
git clone --quiet "$url" checkout
mkdir -p .agents/skills
cp -R checkout/skills/remote .agents/skills/remote
`
    );

    try {
      // Restore fetches the fixture through the inherited rewrite. The importer keeps that
      // rewrite, but restore's longer checkout rewrite wins for the source.
      vi.stubEnv("GIT_CONFIG_COUNT", "1");
      vi.stubEnv("GIT_CONFIG_KEY_0", `url.${sandbox}/.insteadOf`);
      vi.stubEnv("GIT_CONFIG_VALUE_0", "https://example.test/");

      const runtime = createTestRuntime({
        cwd: target,
        env: {
          MONKE_HOME: path.join(sandbox, "home"),
          PATH: `${bin}${path.delimiter}${process.env.PATH}`
        }
      });

      await restoreSkillImports(target, false, runtime);
    } finally {
      vi.unstubAllEnvs();
    }

    expect(read(target, "skills/imported/remote/SKILL.md")).toContain("Pinned.");
    const [sourceUrl, siblingUrl] = read(sandbox, "importer-urls").trim().split("\n");
    expect(sourceUrl).toMatch(/\/upstream-validation$/u);
    expect(siblingUrl).toBe(`${sandbox}/sibling`);
  });

  it.each([
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

      const limit = 8;

      const skillContents = Array.from(
        { length: limit + 3 },
        (_, index) =>
          `---\nname: skill-${index}\ndescription: Fixture Skill\n---\naccepted skill-${index}\n`
      );

      const recipes = skillContents.map((content, index) => {
        const slug = `skill-${index}`;
        const skills = [{ kind: "skill" as const, selector: slug, slug }];
        write(sandbox, `skills/imported/${slug}/SKILL.md`, content);

        return {
          commit: String(index).padStart(40, "0"),
          skills,
          source: `owner/source-${index}`
        };
      });

      writeImportRecipeStore(sandbox, { recipes, version: 4 });
      const acceptedLock = read(sandbox, "skills.lock.json");

      for (const recipe of recipes) {
        rememberRestoredRecipe(sandbox, recipe);
      }

      for (let index = 0; index < limit + 2; index += 1) {
        rmSync(path.join(sandbox, `skills/imported/skill-${index}`), { recursive: true });
      }

      write(sandbox, "skills/imported/obsolete/SKILL.md", "obsolete");

      const script = `#!${process.execPath}
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
const root = ${JSON.stringify(sandbox)};
const home = ${JSON.stringify(home)};
const failImport = ${failImport};
const limit = ${limit};
const skillContents = ${JSON.stringify(skillContents)};
const args = process.argv.slice(2);
const importer = path.basename(process.argv[1]) === "npx";
if (!importer && args[0] !== "fetch") process.exit(0);
const index = importer
  ? Number(/source-([0-9]+)/u.exec(args[args.indexOf("add") + 1])?.[1])
  : Number(args.at(-1));
const phase = importer ? "import" : "fetch";
const marker = (name) => path.join(root, name);
writeFileSync(marker(phase + "-start-" + index), "");
const active = marker("active-" + phase + "-" + index);
writeFileSync(active, "");
if (readdirSync(root).filter((name) => name.startsWith("active-")).length > limit) {
  throw new Error("More than " + limit + " sources ran at once");
}
async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for sibling sources");
    await Bun.sleep(10);
  }
}
// Both network phases must overlap for the first full batch of sources.
if (index < limit) {
  await waitFor(() =>
    Array.from({ length: limit }, (_, item) => item).every((item) =>
      existsSync(marker(phase + "-start-" + item))
    )
  );
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
  writeFileSync(path.join(target, "SKILL.md"), skillContents[index]);
}
rmSync(active);
writeFileSync(marker(phase + "-done-" + index), "");
`;

      for (const command of ["git", "npx"]) {
        const file = path.join(bin, command);
        writeFileSync(file, script);
        chmodSync(file, 0o755);
      }

      try {
        vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
        vi.stubEnv("MONKE_HOME", home);
        let failure: string | null = null;

        try {
          await restoreSkillImports(sandbox);
        } catch (cause) {
          failure = errorMessage(ThrownValueSchema.parse(cause)).split("\n").at(-1) ?? null;
        }

        expect(failure).toStrictEqual(expectedFailure);

        for (let index = 0; index < limit + 2; index += 1) {
          expect(existsSync(path.join(sandbox, `fetch-done-${index}`))).toBeTruthy();
        }

        for (const index of Array.from({ length: limit + 2 }, (_, item) => item).filter(
          (item) => !failImport || item !== 0
        )) {
          expect(existsSync(path.join(sandbox, `import-done-${index}`))).toBeTruthy();
          expect(read(sandbox, `skills/imported/skill-${index}/SKILL.md`)).toBe(
            skillContents[index]
          );
        }

        expect(existsSync(path.join(sandbox, `fetch-start-${limit + 2}`))).toBeFalsy();
        expect(existsSync(path.join(sandbox, "skills/imported/obsolete"))).toBe(failImport);
        expect(read(sandbox, "skills.lock.json")).toBe(acceptedLock);
        expect(readdirSync(path.join(sandbox, "tmp"))).toStrictEqual([]);
        expect(readdirSync(path.join(home, "locks"))).toStrictEqual([]);
      } finally {
        vi.unstubAllEnvs();
      }
    },
    15_000
  );
});
