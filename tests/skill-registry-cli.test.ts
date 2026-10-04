import {
  existsSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { parse } from "yaml";

import { readImportRecipeStore, writeImportRecipeStore } from "../scripts/skill-import-recipes.ts";
import { errorMessage, ThrownValueSchema } from "../src/errors.ts";
import { loadGlobalMonkeConfig, saveGlobalMonkeConfig } from "../src/global-config.ts";
import { runCliAsync } from "../src/index.ts";
import { shellQuote } from "../src/shell-quote.ts";
import {
  createRepo,
  git,
  installFakeCodiff,
  makeTempDir,
  read,
  write,
  writeExecutable,
  writeGlobalInstructionsSource
} from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

function registryFixture() {
  const sandbox = makeTempDir("skill-registry");
  const monkeHome = path.join(sandbox, "monke-home");
  const home = path.join(sandbox, "home");
  const guidance = path.join(monkeHome, "installs", "release-fixture");
  const checkout = path.join(sandbox, "private-course");
  const source = path.join(checkout, ".claude", "skills");
  const registry = path.join(monkeHome, "skill-registry");
  const bin = path.join(sandbox, "bin");
  const codiffLog = installFakeCodiff(bin);
  let stdout = "";
  const runtime = createTestRuntime({
    cwd: sandbox,
    env: { HOME: home, MONKE_HOME: monkeHome, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    onStderr() {},
    onStdout(message) {
      stdout += message;
    }
  });
  write(
    guidance,
    "install-manifest.json",
    JSON.stringify({
      artifactDigest: "0".repeat(64),
      artifactName: "monke-tools-v1.2.3-macos-arm64.tar.gz",
      createdAt: "2026-08-20T12:34:56.000Z",
      guidanceHashes: {},
      installKind: "release",
      minimumCodiffVersion: "1.14.0",
      platform: "macos-arm64",
      releaseTag: "monke-tools-v1.2.3",
      releaseVersion: "1.2.3",
      schemaVersion: 1,
      sourceCommit: "0".repeat(40),
      toolBuildIdentity: "1.2.3"
    })
  );
  symlinkSync(path.join("installs", "release-fixture"), path.join(monkeHome, "current"), "dir");
  writeSkill(
    path.join(guidance, "skills/internal"),
    "monke-tools-core",
    "Internal instructions.\n"
  );
  writeGlobalInstructionsSource(guidance, "Team instructions.\n");
  saveGlobalMonkeConfig(monkeHome, {
    diffAdapter: "lfv",
    skillInstallPreference: {
      targets: [{ kind: "claude" }, { kind: "codex" }, { kind: "cursor" }]
    },
    version: 1
  });
  writeSkill(source, "typography", "Course instructions.\n");
  const installed = {
    claude: path.join(home, ".claude", "skills"),
    codex: path.join(home, ".codex", "skills", "monke-tools", "imported"),
    cursor: path.join(home, ".cursor", "skills", "monke-tools", "imported")
  };
  return {
    bin,
    checkout,
    codiffLog,
    guidance,
    installed,
    monkeHome,
    registry,
    runtime,
    sandbox,
    source,
    stdout: () => stdout
  };
}

function writeSkill(source: string, slug: string, body: string) {
  write(
    source,
    `${slug}/SKILL.md`,
    `---\nname: ${slug}\ndescription: A course skill.\n---\n${body}`
  );
}

function installer(fixture: ReturnType<typeof registryFixture>) {
  const upstream = path.join(fixture.sandbox, "installer-output");
  const script = path.join(fixture.sandbox, "install-course.sh");
  writeExecutable(
    script,
    `#!/bin/sh
set -eu
printf '%s\\n' "$PWD" >> ${shellQuote(path.join(fixture.sandbox, "installer-cwd"))}
rm -rf .claude/skills
mkdir -p .claude
cp -R ${shellQuote(upstream)} .claude/skills
[ ! -f ${shellQuote(path.join(fixture.sandbox, "fail-installer"))} ] || exit 42
`
  );
  return { command: `sh ${shellQuote(script)}`, upstream };
}

describe("Skill import registry CLI", () => {
  test("linked imports use existing provider layouts and write learned changes back to their source", async () => {
    const fixture = registryFixture();
    writeSkill(path.join(fixture.checkout, ".codex/skills"), "typography", "Separate copy.\n");
    await runCliAsync(["skills", "add", fixture.checkout, "--link"], fixture.runtime);
    for (const root of Object.values(fixture.installed)) {
      expect(realpathSync(path.join(root, "typography"))).toBe(
        path.join(fixture.source, "typography")
      );
    }
    writeFileSync(
      path.join(fixture.installed.codex, "typography/SKILL.md"),
      "Learned instruction.\n"
    );
    expect(read(fixture.source, "typography/SKILL.md")).toBe("Learned instruction.\n");
    expect(read(fixture.installed.claude, "typography/SKILL.md")).toBe("Learned instruction.\n");
    expect(readImportRecipeStore(fixture.registry).recipes).toMatchObject([
      { localSource: { kind: "link", skillSourceFolder: fixture.source }, name: "private-course" }
    ]);
    expect(loadGlobalMonkeConfig(fixture.monkeHome)).toMatchObject({ diffAdapter: "lfv" });
    expect(existsSync(path.join(fixture.guidance, "skills/imported/typography"))).toBeFalsy();
  });

  test("one update replays command and Git imports, reapplies policies, and reviews linked file bytes", async () => {
    const fixture = registryFixture();
    const { command, upstream } = installer(fixture);
    writeSkill(upstream, "typography", "First installer version.\n");
    writeSkill(upstream, "color", "First color.\n");
    await runCliAsync(["skills", "add", "--name", "course", "--command", command], fixture.runtime);
    const skillSourceFolder = path.join(fixture.monkeHome, "skill-sources/course/.claude/skills");
    await runCliAsync(
      ["skills", "policy", "course", "--model-invocation", "deny"],
      fixture.runtime
    );
    await runCliAsync(
      ["skills", "policy", "course", "color", "--model-invocation", "allow"],
      fixture.runtime
    );
    const linked = path.join(fixture.sandbox, "personal");
    writeSkill(linked, "personal", "First personal version.\n");
    await runCliAsync(["skills", "add", linked, "--link"], fixture.runtime);
    writeSkill(linked, "personal", "Second personal version.\n");

    const gitSource = createRepo(path.join(fixture.sandbox, "git-source"), {
      "README.md": "Skill source.\n"
    });
    writeSkill(path.join(gitSource, "skills"), "git-skill", "First Git version.\n");
    git(gitSource, ["add", "."]);
    git(gitSource, ["commit", "-m", "First skill"]);
    // Exercise the actual published-importer process boundary without network downloads.
    writeExecutable(
      path.join(fixture.bin, "npx"),
      '#!/bin/sh\nset -eu\nmkdir -p .agents\ncp -R "$4/skills" .agents/skills\n'
    );
    await runCliAsync(
      ["skills", "add", `${gitSource}#HEAD`, "--name", "git-source"],
      fixture.runtime
    );
    writeSkill(path.join(gitSource, "skills"), "git-skill", "Second Git version.\n");
    git(gitSource, ["add", "."]);
    git(gitSource, ["commit", "-m", "Update skill"]);
    const expectedCommit = git(gitSource, ["rev-parse", "HEAD"]).trim();

    for (const slug of ["typography", "color", "animation"]) {
      writeSkill(upstream, slug, "Second installer version.\n");
      write(
        upstream,
        `${slug}/agents/openai.yaml`,
        "interface:\n  display_name: Course\npolicy:\n  allow_implicit_invocation: true\n"
      );
    }
    writeSkill(linked, "personal", "Second personal version.\n");
    writeFileSync(
      path.join(fixture.installed.codex, "typography/SKILL.md"),
      `${read(skillSourceFolder, "typography/SKILL.md")}Learned local rule.\n`
    );
    await runCliAsync(["skills", "update"], fixture.runtime);

    for (const [slug, disable] of [
      ["typography", true],
      ["color", false],
      ["animation", true]
    ] as const) {
      expect(
        parse(read(skillSourceFolder, `${slug}/SKILL.md`).split("---")[1] ?? "")
      ).toMatchObject({
        "disable-model-invocation": disable
      });
      expect(parse(read(skillSourceFolder, `${slug}/agents/openai.yaml`))).toMatchObject({
        interface: { display_name: "Course" },
        policy: { allow_implicit_invocation: !disable }
      });
      expect(read(fixture.installed.codex, `${slug}/SKILL.md`)).toContain(
        "Second installer version."
      );
    }
    const { recipes } = readImportRecipeStore(fixture.registry);
    expect(recipes.find((recipe) => recipe.name === "course")).toMatchObject({
      disableModelInvocation: true,
      skills: [
        { slug: "animation" },
        { disableModelInvocation: false, slug: "color" },
        { slug: "typography" }
      ]
    });
    expect(recipes.find((recipe) => recipe.name === "git-source")?.lock?.commit).toBe(
      expectedCommit
    );
    expect(read(fixture.sandbox, "installer-cwd").trim().split("\n")).toStrictEqual([
      path.join(fixture.monkeHome, "skill-sources/course"),
      path.join(fixture.monkeHome, "skill-sources/course")
    ]);
    const launch = readFileSync(fixture.codiffLog, "utf-8").trim().split("\n");
    expect(launch).toHaveLength(3);
    expect(launch[0]).toBe("--commit");
    const reviewRepo = launch[2] ?? "";
    const commit = launch[1] ?? "";
    const diff = git(reviewRepo, ["diff", `${commit}^`, commit]);
    expect(diff).toContain("-First installer version.");
    expect(diff).toContain("-Learned local rule.");
    expect(diff).toContain("+Second installer version.");
    expect(diff).toContain("+Second personal version.");
    expect(diff).toContain("-First personal version.");
    expect(diff).toContain("+Second Git version.");
    expect(git(reviewRepo, ["ls-tree", commit, "skills/imported/typography"])).toContain(
      "040000 tree"
    );
    await runCliAsync(["skills", "update"], fixture.runtime);
    expect(readFileSync(fixture.codiffLog, "utf-8").trim().split("\n")).toHaveLength(3);
    expect(fixture.stdout()).toContain("No skill changes.");
  });

  test.each(["exit", "collision", "metadata"] as const)(
    "an installer %s failure restores source bytes and symlinks while later sources still update",
    async (failure) => {
      const fixture = registryFixture();
      const { command, upstream } = installer(fixture);
      writeSkill(upstream, "typography", "Accepted version.\n");
      write(fixture.source, "typography/reference.md", "Reference content.\n");
      symlinkSync("reference.md", path.join(fixture.source, "typography/alias.md"));
      await runCliAsync(
        ["skills", "add", fixture.checkout, "--name", "a-course", "--link", "--command", command],
        fixture.runtime
      );
      await runCliAsync(
        ["skills", "policy", "a-course", "--model-invocation", "deny"],
        fixture.runtime
      );
      const accepted = read(fixture.source, "typography/SKILL.md");
      const [recipe] = readImportRecipeStore(fixture.registry).recipes;
      const later = path.join(fixture.sandbox, "z-personal");
      writeSkill(later, "personal", "Original personal.\n");
      await runCliAsync(["skills", "add", later], fixture.runtime);
      writeSkill(later, "personal", "Updated personal.\n");
      if (failure === "exit") {
        write(fixture.sandbox, "fail-installer", "fail\n");
      }
      if (failure === "collision") {
        writeSkill(upstream, "monke-tools-core", "Conflicts with internal guidance.\n");
      }
      if (failure === "metadata") {
        write(upstream, "typography/agents/openai.yaml", "policy: null\n");
      }
      await expect(runCliAsync(["skills", "update"], fixture.runtime)).rejects.toThrow(/a-course/u);
      expect(read(fixture.source, "typography/SKILL.md")).toBe(accepted);
      expect(readlinkSync(path.join(fixture.source, "typography/alias.md"))).toBe("reference.md");
      expect(
        readImportRecipeStore(fixture.registry).recipes.find((item) => item.name === "a-course")
      ).toStrictEqual(recipe);
      expect(read(fixture.installed.codex, "personal/SKILL.md")).toContain("Updated personal.");
      expect(readFileSync(fixture.codiffLog, "utf-8").trim().split("\n")).toHaveLength(3);
    }
  );

  test("selection replacement and removal retire managed projections while keeping the external source", async () => {
    const fixture = registryFixture();
    writeSkill(fixture.source, "color", "Color instructions.\n");
    await runCliAsync(
      ["skills", "add", fixture.checkout, "--skill", "typography"],
      fixture.runtime
    );
    await runCliAsync(["skills", "add", fixture.checkout, "--skill", "color"], fixture.runtime);
    for (const root of Object.values(fixture.installed)) {
      expect(existsSync(path.join(root, "typography"))).toBeFalsy();
      expect(realpathSync(path.join(root, "color"))).toBe(path.join(fixture.source, "color"));
    }
    const repurposed = path.join(fixture.installed.claude, "color");
    rmSync(repurposed);
    writeFileSync(repurposed, "User-owned file.\n");
    await runCliAsync(["skills", "remove", "private-course"], fixture.runtime);
    await runCliAsync(["skills", "list"], fixture.runtime);
    expect(readFileSync(repurposed, "utf-8")).toBe("User-owned file.\n");
    expect(existsSync(path.join(fixture.installed.codex, "color"))).toBeFalsy();
    expect(read(fixture.source, "color/SKILL.md")).toContain("Color instructions.");
    expect(readImportRecipeStore(fixture.registry).recipes).toStrictEqual([]);
  });

  test("local per-skill overrides survive disappearance and reintroduction", async () => {
    const fixture = registryFixture();
    writeSkill(fixture.source, "color", "Color instructions.\n");
    await runCliAsync(["skills", "add", fixture.checkout], fixture.runtime);
    await runCliAsync(
      ["skills", "policy", "private-course", "--model-invocation", "deny"],
      fixture.runtime
    );
    await runCliAsync(
      ["skills", "policy", "private-course", "color", "--model-invocation", "allow"],
      fixture.runtime
    );
    rmSync(path.join(fixture.source, "color"), { recursive: true });
    await runCliAsync(["skills", "update"], fixture.runtime);
    expect(existsSync(path.join(fixture.installed.claude, "color"))).toBeFalsy();
    writeSkill(fixture.source, "color", "Restored color.\n");
    await runCliAsync(["skills", "update"], fixture.runtime);
    expect(parse(read(fixture.source, "color/agents/openai.yaml"))).toMatchObject({
      policy: { allow_implicit_invocation: true }
    });
    expect(read(fixture.source, "color/SKILL.md")).toContain("disable-model-invocation: false");
  });

  test.each(["link", "command"] as const)(
    "a missing %s source does not prevent healthy sources updating",
    async (kind) => {
      const fixture = registryFixture();
      const { command, upstream } = installer(fixture);
      writeSkill(upstream, "typography", "Recovered installer.\n");
      await runCliAsync(
        [
          "skills",
          "add",
          fixture.checkout,
          "--name",
          "a-course",
          "--link",
          ...(kind === "command" ? ["--command", command] : [])
        ],
        fixture.runtime
      );
      const later = path.join(fixture.sandbox, "z-personal");
      writeSkill(later, "personal", "Original personal.\n");
      await runCliAsync(["skills", "add", later], fixture.runtime);
      rmSync(fixture.source, { recursive: true });
      writeSkill(later, "personal", "Updated personal.\n");
      let outcome = "updated";
      try {
        await runCliAsync(["skills", "update"], fixture.runtime);
      } catch (error) {
        outcome = errorMessage(ThrownValueSchema.parse(error));
      }
      expect(outcome).toMatch(
        kind === "link" ? /a-course.*Skill source is missing/u : /^updated$/u
      );
      expect(existsSync(path.join(fixture.installed.claude, "typography"))).toBe(
        kind === "command"
      );
      expect(read(fixture.installed.claude, "personal/SKILL.md")).toContain("Updated personal.");
    }
  );

  test("re-adding a command with a new working directory publishes its new source", async () => {
    const fixture = registryFixture();
    const { command, upstream } = installer(fixture);
    writeSkill(upstream, "typography", "First directory.\n");
    await runCliAsync(["skills", "add", "--name", "course", "--command", command], fixture.runtime);
    const cwd = path.join(fixture.sandbox, "moved-course");
    writeSkill(upstream, "typography", "Second directory.\n");
    await runCliAsync(
      ["skills", "add", "--name", "course", "--command", command, "--cwd", cwd],
      fixture.runtime
    );
    expect(realpathSync(path.join(fixture.installed.claude, "typography"))).toBe(
      path.join(cwd, ".claude/skills/typography")
    );
    expect(read(fixture.installed.claude, "typography/SKILL.md")).toContain("Second directory.");
  });

  test("a failed first installer leaves no source or registered recipe", async () => {
    const fixture = registryFixture();
    const { command, upstream } = installer(fixture);
    writeSkill(upstream, "typography", "Partial install.\n");
    write(fixture.sandbox, "fail-installer", "fail\n");
    await expect(
      runCliAsync(["skills", "add", "--name", "course", "--command", command], fixture.runtime)
    ).rejects.toThrow(/exited with code 42/u);
    expect(existsSync(path.join(fixture.monkeHome, "skill-sources/course"))).toBeFalsy();
    expect(readImportRecipeStore(fixture.registry).recipes).toStrictEqual([]);
  });

  test("repeat Git add preserves references and overrides across selection replacement", async () => {
    const fixture = registryFixture();
    const upstream = createRepo(path.join(fixture.sandbox, "git-source"), {
      "README.md": "Git skills.\n"
    });
    writeSkill(path.join(upstream, "skills"), "alpha", "Alpha instructions.\n");
    writeSkill(path.join(upstream, "skills"), "bravo", "Bravo instructions.\n");
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Skill source"]);
    writeExecutable(
      path.join(fixture.bin, "npx"),
      `#!/bin/sh
set -eu
source="$4"
shift 4
mkdir -p .agents/skills
while [ "$1" = --skill ]; do
  cp -R "$source/skills/$2" .agents/skills/
  shift 2
done
`
    );
    const source = `${upstream}#HEAD`;
    write(fixture.guidance, "skills/references/imported/alpha/MAIN.md", "Alpha instructions.\n");
    writeImportRecipeStore(fixture.guidance, {
      recipes: [{ skills: [{ kind: "reference", selector: "alpha", slug: "alpha" }], source }],
      version: 3
    });
    await runCliAsync(["skills", "add", source, "--name", "git-source"], fixture.runtime);
    expect(read(fixture.registry, "skills/references/imported/alpha/MAIN.md")).toContain(
      "Alpha instructions."
    );
    expect(existsSync(path.join(fixture.installed.claude, "alpha"))).toBeFalsy();
    await runCliAsync(["skills", "add", source, "--skill", "bravo"], fixture.runtime);
    await runCliAsync(
      ["skills", "policy", "git-source", "--model-invocation", "deny"],
      fixture.runtime
    );
    await runCliAsync(
      ["skills", "policy", "git-source", "bravo", "--model-invocation", "allow"],
      fixture.runtime
    );
    await runCliAsync(["skills", "add", source, "--skill", "alpha"], fixture.runtime);
    await runCliAsync(["skills", "add", source, "--skill", "bravo"], fixture.runtime);
    expect(parse(read(fixture.installed.claude, "bravo/agents/openai.yaml"))).toMatchObject({
      policy: { allow_implicit_invocation: true }
    });
  });

  test("policy refresh rejects a newly occupied target before publishing policy or new skills", async () => {
    const fixture = registryFixture();
    await runCliAsync(["skills", "add", fixture.checkout], fixture.runtime);
    const previous = readImportRecipeStore(fixture.registry);
    const accepted = read(fixture.source, "typography/SKILL.md");
    writeSkill(fixture.source, "color", "New color.\n");
    write(fixture.installed.claude, "color/SKILL.md", "User-owned color.\n");
    await expect(
      runCliAsync(
        ["skills", "policy", "private-course", "--model-invocation", "deny"],
        fixture.runtime
      )
    ).rejects.toThrow(/non-managed/u);
    expect(readImportRecipeStore(fixture.registry)).toStrictEqual(previous);
    expect(read(fixture.source, "typography/SKILL.md")).toBe(accepted);
    expect(read(fixture.installed.claude, "color/SKILL.md")).toBe("User-owned color.\n");
  });

  test("an unrelated target blocks source publication before source policy or target changes", async () => {
    const fixture = registryFixture();
    const occupied = path.join(fixture.installed.claude, "typography");
    write(occupied, "SKILL.md", "Unrelated skill.\n");
    await expect(runCliAsync(["skills", "add", fixture.checkout], fixture.runtime)).rejects.toThrow(
      /non-managed/u
    );
    expect(readImportRecipeStore(fixture.registry).recipes).toStrictEqual([]);
    expect(readFileSync(path.join(occupied, "SKILL.md"), "utf-8")).toBe("Unrelated skill.\n");
    expect(existsSync(path.join(fixture.installed.codex, "typography"))).toBeFalsy();
  });
});
