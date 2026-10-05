import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { parse } from "yaml";

import { readImportRecipeStore, writeImportRecipeStore } from "../scripts/skill-import-recipes.ts";
import { errorMessage, ThrownValueSchema } from "../src/errors.ts";
import { loadGlobalMonkeConfig, saveGlobalMonkeConfig } from "../src/global-config.ts";
import { runInstallSkillsLocked } from "../src/guidance-installation.ts";
import { runCliAsync } from "../src/index.ts";
import { shellQuote } from "../src/shell-quote.ts";
import { preflightSkillRegistryInstall } from "../src/skill-registry.ts";
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
    diffAdapter: "codiff",
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

function installGitImporter(fixture: ReturnType<typeof registryFixture>) {
  writeExecutable(
    path.join(fixture.bin, "npx"),
    `#!/bin/sh
set -eu
source="$4"
shift 4
cat <<'OUT'
Security Risk Assessments
git-skill Safe 0 alerts Low Risk
Details: https://skills.sh/owner/repo
Installation complete
OUT
mkdir -p .agents/skills
while [ "$1" = --skill ]; do
  if [ "$2" = '*' ]; then
    cp -R "$source/skills/"* .agents/skills/
  else
    cp -R "$source/skills/$2" .agents/skills/
  fi
  shift 2
done
`
  );
}

describe("Skill import registry CLI", () => {
  test.each(["create", "adopt"] as const)(
    "a required baseline failure rolls back %s before reporting success",
    async (action) => {
      const fixture = registryFixture();
      await runCliAsync(["skills", "list"], fixture.runtime);
      const previous = readImportRecipeStore(fixture.registry);
      const baseline = path.join(fixture.registry, ".monke-skill-baseline");
      rmSync(baseline, { recursive: true });
      writeFileSync(baseline, "Existing baseline obstruction.\n");
      const slug = action === "create" ? "new-workflow" : "typography";
      const request =
        action === "create"
          ? ["skills", "create", slug]
          : ["skills", "adopt", path.join(fixture.source, slug)];
      await expect(runCliAsync(request, fixture.runtime)).rejects.toThrow(/ENOTDIR/u);
      expect(readImportRecipeStore(fixture.registry)).toStrictEqual(previous);
      expect(read(fixture.source, "typography/SKILL.md")).toContain("Course instructions.");
      expect(readFileSync(baseline, "utf-8")).toBe("Existing baseline obstruction.\n");
      expect(existsSync(`${baseline}.tmp`)).toBeFalsy();
      const managed = path.join(fixture.monkeHome, "skill-sources", slug);
      expect(existsSync(managed)).toBeFalsy();
      expect(fixture.stdout()).not.toContain(managed);
      for (const target of Object.values(fixture.installed)) {
        expect(existsSync(path.join(target, slug))).toBeFalsy();
      }
    }
  );

  test.each(["Monke home", "active guidance"] as const)(
    "an independent protected copy in %s does not report its registered slug unchanged",
    async (storage) => {
      const fixture = registryFixture();
      await runCliAsync(["skills", "create", "registered"], fixture.runtime);
      const owner = path.join(fixture.monkeHome, "skill-sources/registered/registered");
      const root =
        storage === "Monke home"
          ? path.join(fixture.monkeHome, "orphans")
          : path.join(fixture.guidance, "skills/personal");
      const copy = path.join(root, "registered");
      cpSync(owner, copy, { recursive: true });
      const previous = readImportRecipeStore(fixture.registry);
      await expect(runCliAsync(["skills", "adopt", copy], fixture.runtime)).rejects.toThrow(
        /independent Skill copy inside managed storage/u
      );
      expect(readImportRecipeStore(fixture.registry)).toStrictEqual(previous);
      expect(read(copy, "SKILL.md")).toBe(read(owner, "SKILL.md"));
      expect(fixture.stdout()).not.toContain("Unchanged: registered");
      await runCliAsync(["skills", "adopt", owner], fixture.runtime);
      expect(fixture.stdout()).toContain("Unchanged: registered");
    }
  );

  test("an interactive Git slug change reports adopted projections before confirmation or publication", async () => {
    const fixture = registryFixture();
    const config = loadGlobalMonkeConfig(fixture.monkeHome);
    saveGlobalMonkeConfig(fixture.monkeHome, {
      ...config,
      skillInstallPreference: { targets: [{ kind: "codex" }] }
    });
    const upstream = createRepo(path.join(fixture.sandbox, "git-source"), {
      "README.md": "Git source.\n"
    });
    writeSkill(path.join(upstream, "skills"), "typography", "Git instructions.\n");
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Original skill"]);
    installGitImporter(fixture);
    await runCliAsync(["skills", "add", `${upstream}#HEAD`, "--name", "original"], fixture.runtime);
    cpSync(
      path.join(fixture.registry, "skills/imported/typography"),
      path.join(fixture.installed.claude, "typography"),
      { recursive: true }
    );
    await runCliAsync(
      ["skills", "adopt", path.join(fixture.installed.claude, "typography")],
      fixture.runtime
    );
    const previous = readImportRecipeStore(fixture.registry);
    git(upstream, ["mv", "skills/typography", "skills/renamed-typography"]);
    git(upstream, ["commit", "-m", "Rename skill folder"]);
    writeExecutable(
      path.join(fixture.bin, "npx"),
      `#!/bin/sh\nset -eu\nsource="$4"\nmkdir -p .agents/skills\ncp -R "$source/skills/renamed-typography" .agents/skills/\n`
    );
    await expect(
      runCliAsync(["skills", "update", "--interactive"], fixture.runtime)
    ).rejects.toThrow(/typography.*renamed-typography.*adopted projections/u);
    expect(readImportRecipeStore(fixture.registry)).toStrictEqual(previous);
    expect(read(fixture.installed.claude, "typography/SKILL.md")).toContain("Git instructions.");
    expect(read(fixture.installed.codex, "typography/SKILL.md")).toContain("Git instructions.");
    expect(
      existsSync(path.join(fixture.registry, "skills/imported/renamed-typography"))
    ).toBeFalsy();
  });

  test.each(["Monke home", "active guidance"] as const)(
    "an unregistered skill inside %s reports a protected-source error",
    async (storage) => {
      const fixture = registryFixture();
      const root =
        storage === "Monke home"
          ? path.join(fixture.monkeHome, "unregistered")
          : path.join(fixture.guidance, "skills/personal");
      writeSkill(root, "orphan", "Unregistered instructions.\n");
      await expect(
        runCliAsync(["skills", "adopt", path.join(root, "orphan")], fixture.runtime)
      ).rejects.toThrow(/unregistered Skill inside managed storage/u);
      expect(read(root, "orphan/SKILL.md")).toContain("Unregistered instructions.");
      expect(readImportRecipeStore(fixture.registry).recipes).toStrictEqual([]);
      expect(fixture.stdout()).not.toContain("Unchanged: orphan");
      expect(existsSync(path.join(fixture.installed.codex, "orphan"))).toBeFalsy();
    }
  );

  test.each([
    { error: /registered owner.*duplicate discovery/u, harness: "codex", preservesLeftover: true },
    { error: /registered owner occupies.*projection/u, harness: "claude", preservesLeftover: true },
    { error: /registered owner occupies.*projection/u, harness: "cursor", preservesLeftover: true },
    { error: /registered owner.*duplicate discovery/u, harness: "custom", preservesLeftover: true }
  ] as const)(
    "adoption preserves a registered physical owner in a raw $harness harness path",
    async (scenario) => {
      const fixture = registryFixture();
      const config = loadGlobalMonkeConfig(fixture.monkeHome);
      saveGlobalMonkeConfig(fixture.monkeHome, {
        ...config,
        skillInstallPreference: {
          targets: [
            { kind: "codex" },
            ...(scenario.harness === "custom"
              ? [{ kind: "custom" as const, path: path.join(fixture.sandbox, "custom-skills") }]
              : [])
          ]
        }
      });
      const rawRoot = {
        claude: fixture.installed.claude,
        codex: path.resolve(fixture.installed.codex, "../.."),
        cursor: path.resolve(fixture.installed.cursor, "../.."),
        custom: path.join(fixture.sandbox, "custom-skills")
      }[scenario.harness];
      writeSkill(rawRoot, "typography", "Course instructions.\n");
      const owner = path.join(rawRoot, "typography");
      await runCliAsync(["skills", "add", owner, "--name", "original", "--link"], fixture.runtime);
      const previous = readImportRecipeStore(fixture.registry);
      let report = "";
      try {
        await runCliAsync(
          ["skills", "adopt", path.join(fixture.source, "typography")],
          fixture.runtime
        );
      } catch (error) {
        report = errorMessage(ThrownValueSchema.parse(error));
      }
      expect(report).toMatch(scenario.error);
      expect(readImportRecipeStore(fixture.registry)).toStrictEqual(previous);
      expect(read(owner, "SKILL.md")).toContain("Course instructions.");
      expect(realpathSync(path.join(fixture.registry, "skills/imported/typography"))).toBe(owner);
      expect(existsSync(path.join(fixture.source, "typography"))).toBe(scenario.preservesLeftover);
    }
  );

  test("policy publication preserves an incidental projection replaced by a user-owned entry", async () => {
    const fixture = registryFixture();
    const config = loadGlobalMonkeConfig(fixture.monkeHome);
    saveGlobalMonkeConfig(fixture.monkeHome, {
      ...config,
      skillInstallPreference: { targets: [{ kind: "codex" }] }
    });
    writeSkill(fixture.installed.claude, "typography", "Course instructions.\n");
    await runCliAsync(
      ["skills", "adopt", path.join(fixture.source, "typography")],
      fixture.runtime
    );
    const previous = readImportRecipeStore(fixture.registry);
    const owner = path.join(fixture.monkeHome, "skill-sources/typography/typography");
    const previousBytes = read(owner, "SKILL.md");
    rmSync(path.join(fixture.installed.claude, "typography"));
    writeSkill(fixture.installed.claude, "typography", "User-owned replacement.\n");
    expect(() => {
      preflightSkillRegistryInstall(fixture.runtime, fixture.guidance, {
        builtInTargetKinds: ["claude"]
      });
    }).toThrow(/adopted Skill projection/u);
    await expect(
      runCliAsync(["skills", "policy", "typography", "--model-invocation", "deny"], fixture.runtime)
    ).rejects.toThrow(/adopted Skill projection/u);
    expect(readImportRecipeStore(fixture.registry)).toStrictEqual(previous);
    expect(read(owner, "SKILL.md")).toBe(previousBytes);
    await runCliAsync(["skills", "remove", "typography"], fixture.runtime);
    expect(read(fixture.installed.claude, "typography/SKILL.md")).toContain(
      "User-owned replacement."
    );
  });

  test.each(["Markdown", "symlink"] as const)(
    "a detected external %s dependency stops the complete batch with actionable paths",
    async (dependency) => {
      const fixture = registryFixture();
      const original = path.join(fixture.source, "typography");
      write(fixture.source, "shared.md", "Shared content.\n");
      writeSkill(fixture.source, "healthy", "Healthy instructions.\n");
      if (dependency === "Markdown") {
        write(original, "SKILL.md", `${read(original, "SKILL.md")}\n[Shared](../shared.md)\n`);
      } else {
        symlinkSync("../shared.md", path.join(original, "shared.md"));
      }
      await expect(
        runCliAsync(["skills", "adopt", fixture.checkout], fixture.runtime)
      ).rejects.toThrow(/typography:.*shared\.md/u);
      expect(read(fixture.source, "healthy/SKILL.md")).toContain("Healthy instructions.");
      expect(read(original, "SKILL.md")).toContain("Course instructions.");
      expect(readImportRecipeStore(fixture.registry).recipes).toStrictEqual([]);
      expect(existsSync(path.join(fixture.monkeHome, "skill-sources/private-course"))).toBeFalsy();
    }
  );

  test.each([false, true])(
    "publication failure restores the whole batch or retains recovery when restoration is obstructed (%s)",
    async (obstructRecovery) => {
      const fixture = registryFixture();
      await runCliAsync(["skills", "create", "existing"], fixture.runtime);
      const previous = readImportRecipeStore(fixture.registry);
      const previousManifest = read(fixture.installed.claude, ".monke-tools-flat-skills.json");
      const previousInstructions = read(path.dirname(fixture.installed.claude), "CLAUDE.md");
      writeSkill(fixture.source, "second", "Second instructions.\n");
      writeSkill(fixture.installed.claude, "typography", "Course instructions.\n");
      let failed = false;
      fixture.runtime.writeStderr = (message) => {
        if (!failed && message.startsWith("Linked monke-tools skills")) {
          failed = true;
          if (obstructRecovery) {
            rmSync(fixture.source, { recursive: true });
            writeFileSync(fixture.source, "A concurrent writer obstructed the source parent.\n");
          }
          throw new Error("Controlled target publication failure");
        }
      };
      await expect(
        runCliAsync(["skills", "adopt", fixture.checkout], fixture.runtime)
      ).rejects.toThrow(
        obstructRecovery ? /Recovery copies retained at/u : /Controlled target publication failure/u
      );
      expect(failed).toBeTruthy();
      expect(readImportRecipeStore(fixture.registry)).toStrictEqual(previous);
      expect(read(fixture.installed.claude, ".monke-tools-flat-skills.json")).toBe(
        previousManifest
      );
      expect(read(path.dirname(fixture.installed.claude), "CLAUDE.md")).toBe(previousInstructions);
      expect(read(fixture.installed.claude, "typography/SKILL.md")).toContain(
        "Course instructions."
      );
      expect(existsSync(path.join(fixture.installed.codex, "second"))).toBeFalsy();
      expect(existsSync(path.join(fixture.installed.cursor, "typography"))).toBeFalsy();
      expect(existsSync(path.join(fixture.monkeHome, "skill-sources/private-course"))).toBeFalsy();
      const recoveryNames = readdirSync(fixture.monkeHome).filter((name) =>
        name.startsWith(".monke-adopt-recovery-")
      );
      expect(recoveryNames).toHaveLength(obstructRecovery ? 1 : 0);
      const recovery = path.join(fixture.monkeHome, recoveryNames[0] ?? "missing");
      const recoveryIndex = existsSync(recovery) ? read(recovery, "recovery.json") : "";
      expect(recoveryIndex.includes(path.join(fixture.source, "typography"))).toBe(
        obstructRecovery
      );
      const recoveredSkill = (existsSync(recovery) ? readdirSync(recovery) : []).find(
        (name) =>
          existsSync(path.join(recovery, name, "SKILL.md")) &&
          read(recovery, `${name}/SKILL.md`).includes("Second instructions.")
      );
      expect(recoveredSkill !== undefined).toBe(obstructRecovery);
      const restoredTypography = obstructRecovery
        ? readFileSync(fixture.source, "utf-8")
        : read(fixture.source, "typography/SKILL.md");
      const restoredSecond = obstructRecovery
        ? readFileSync(fixture.source, "utf-8")
        : read(fixture.source, "second/SKILL.md");
      expect(restoredTypography).toContain(
        obstructRecovery ? "concurrent writer" : "Course instructions."
      );
      expect(restoredSecond).toContain(
        obstructRecovery ? "concurrent writer" : "Second instructions."
      );
    }
  );

  test.each(["bytes", "metadata", "executable", "symlink", "directory"] as const)(
    "a %s difference preserves the complete selected adoption batch",
    async (difference) => {
      const fixture = registryFixture();
      writeSkill(fixture.source, "healthy", "Healthy instructions.\n");
      const original = path.join(fixture.source, "typography");
      write(original, "scripts/report.sh", "echo report\n");
      write(original, "references/first.md", "First reference.\n");
      write(original, "references/second.md", "Second reference.\n");
      symlinkSync("references/first.md", path.join(original, "alias.md"));
      const copy = path.join(fixture.installed.claude, "typography");
      cpSync(original, copy, { recursive: true, verbatimSymlinks: true });
      if (difference === "bytes") {
        write(copy, "SKILL.md", `${read(copy, "SKILL.md")}\n`);
      }
      if (difference === "metadata") {
        write(copy, "agents/openai.yaml", "policy:\n  allow_implicit_invocation: false\n");
      }
      if (difference === "executable") {
        chmodSync(path.join(copy, "scripts/report.sh"), 0o755);
      }
      if (difference === "symlink") {
        rmSync(path.join(copy, "alias.md"));
        symlinkSync("references/second.md", path.join(copy, "alias.md"));
      }
      if (difference === "directory") {
        mkdirSync(path.join(copy, "empty"));
      }
      const previous = loadGlobalMonkeConfig(fixture.monkeHome);
      const copyBytes = read(copy, "SKILL.md");
      await expect(
        runCliAsync(
          ["skills", "adopt", fixture.checkout, "--skill", "typography", "healthy"],
          fixture.runtime
        )
      ).rejects.toThrow(/differing copies/u);
      expect(read(fixture.source, "healthy/SKILL.md")).toContain("Healthy instructions.");
      expect(read(original, "SKILL.md")).toContain("Course instructions.");
      expect(read(copy, "SKILL.md")).toBe(copyBytes);
      expect(readlinkSync(path.join(original, "alias.md"))).toBe("references/first.md");
      expect(loadGlobalMonkeConfig(fixture.monkeHome)).toStrictEqual(previous);
      expect(readImportRecipeStore(fixture.registry).recipes).toStrictEqual([]);
      expect(existsSync(path.join(fixture.monkeHome, "skill-sources/private-course"))).toBeFalsy();
      expect(existsSync(path.join(fixture.installed.codex, "healthy"))).toBeFalsy();
    }
  );

  test("adoption preserves scripts and internal aliases and keeps differently named skills separate", async () => {
    const fixture = registryFixture();
    const custom = path.join(fixture.sandbox, "custom-skills");
    const config = loadGlobalMonkeConfig(fixture.monkeHome);
    saveGlobalMonkeConfig(fixture.monkeHome, {
      ...config,
      skillInstallPreference: {
        targets: [
          ...(config.skillInstallPreference?.targets ?? []),
          { kind: "custom", path: custom }
        ]
      }
    });
    const original = path.join(fixture.source, "typography");
    write(
      original,
      "SKILL.md",
      `${read(original, "SKILL.md")}\n[Guide](references/guide%20one.md#details)\n`
    );
    write(original, "references/guide one.md", "# Details\n");
    writeExecutable(path.join(original, "scripts/report.sh"), "#!/bin/sh\necho report\n");
    symlinkSync("references/guide one.md", path.join(original, "guide.md"));
    cpSync(original, path.join(custom, "typography"), { recursive: true, verbatimSymlinks: true });
    write(
      fixture.source,
      "different/SKILL.md",
      read(original, "SKILL.md").split("\n[Guide]")[0] ?? ""
    );
    await runCliAsync(["skills", "adopt", fixture.checkout], fixture.runtime);
    const managed = path.join(fixture.monkeHome, "skill-sources/private-course");
    expect(readlinkSync(path.join(managed, "typography/guide.md"))).toBe("references/guide one.md");
    expect(statSync(path.join(managed, "typography/scripts/report.sh")).mode % 512).toBe(0o755);
    expect(realpathSync(path.join(custom, "monke-tools/imported/typography"))).toBe(
      path.join(managed, "typography")
    );
    expect(existsSync(path.join(custom, "typography"))).toBeFalsy();
    expect(realpathSync(path.join(fixture.installed.claude, "different"))).toBe(
      path.join(managed, "different")
    );
  });

  test("identical copies reuse a registered owner and repeat adoption reports unchanged", async () => {
    const fixture = registryFixture();
    await runCliAsync(["skills", "add", fixture.checkout, "--link"], fixture.runtime);
    const previous = readImportRecipeStore(fixture.registry);
    const raw = path.resolve(fixture.installed.codex, "../../typography");
    cpSync(path.join(fixture.source, "typography"), raw, { recursive: true });
    await runCliAsync(["skills", "adopt", raw], fixture.runtime);
    expect(existsSync(raw)).toBeFalsy();
    expect(readImportRecipeStore(fixture.registry)).toStrictEqual(previous);
    expect(realpathSync(path.join(fixture.installed.claude, "typography"))).toBe(
      path.join(fixture.source, "typography")
    );
    await runCliAsync(
      ["skills", "adopt", path.join(fixture.installed.claude, "typography")],
      fixture.runtime
    );
    expect(fixture.stdout()).toContain("Unchanged: typography");
    writeSkill(path.dirname(raw), "typography", "Divergent leftover.\n");
    await expect(runCliAsync(["skills", "adopt", raw], fixture.runtime)).rejects.toThrow(
      /registered owner/u
    );
    expect(readImportRecipeStore(fixture.registry)).toStrictEqual(previous);
    expect(read(fixture.source, "typography/SKILL.md")).toContain("Course instructions.");
    expect(read(path.dirname(raw), "typography/SKILL.md")).toContain("Divergent leftover.");
  });

  test("adoption consolidates identical global copies without enabling an unconfigured harness", async () => {
    const fixture = registryFixture();
    const config = loadGlobalMonkeConfig(fixture.monkeHome);
    saveGlobalMonkeConfig(fixture.monkeHome, {
      ...config,
      skillInstallPreference: { targets: [{ kind: "codex" }] }
    });
    const rawCodex = path.resolve(fixture.installed.codex, "../../typography");
    writeSkill(path.dirname(rawCodex), "typography", "Course instructions.\n");
    writeSkill(fixture.installed.claude, "typography", "Course instructions.\n");
    await runCliAsync(["skills", "adopt", rawCodex], fixture.runtime);
    const owner = path.join(fixture.monkeHome, "skill-sources/typography/typography");
    expect(existsSync(rawCodex)).toBeFalsy();
    expect(realpathSync(path.join(fixture.installed.claude, "typography"))).toBe(owner);
    expect(realpathSync(path.join(fixture.installed.codex, "typography"))).toBe(owner);
    expect(existsSync(path.join(fixture.installed.claude, "monke-tools-core"))).toBeFalsy();
    expect(loadGlobalMonkeConfig(fixture.monkeHome)).toStrictEqual({
      ...config,
      skillInstallPreference: { targets: [{ kind: "codex" }] }
    });
    await runInstallSkillsLocked(fixture.runtime, fixture.guidance);
    expect(() => {
      preflightSkillRegistryInstall(fixture.runtime, fixture.guidance, {
        builtInTargetKinds: ["claude"]
      });
    }).not.toThrow();
    await runInstallSkillsLocked(fixture.runtime, fixture.guidance, {
      builtInTargetKinds: ["claude"]
    });
    expect(realpathSync(path.join(fixture.installed.claude, "typography"))).toBe(owner);
    await runInstallSkillsLocked(fixture.runtime, fixture.guidance, {
      builtInTargetKinds: ["codex"]
    });
    expect(realpathSync(path.join(fixture.installed.claude, "typography"))).toBe(owner);
    expect(existsSync(path.join(fixture.installed.claude, "monke-tools-core"))).toBeFalsy();
    await runCliAsync(["skills", "remove", "typography"], fixture.runtime);
    expect(existsSync(path.join(fixture.installed.claude, "typography"))).toBeFalsy();
    expect(existsSync(path.join(owner, "SKILL.md"))).toBeTruthy();
  });

  test("creation shares editable files across targets and retains them through installation and removal", async () => {
    const fixture = registryFixture();
    await runCliAsync(
      [
        "skills",
        "create",
        "weekly-report",
        "--description",
        "Use for weekly reports: progress and risks."
      ],
      fixture.runtime
    );
    const skill = path.join(fixture.monkeHome, "skill-sources/weekly-report/weekly-report");
    expect(fixture.stdout()).toContain(path.join(skill, "SKILL.md"));
    expect(
      parse(readFileSync(path.join(skill, "SKILL.md"), "utf-8").split("---")[1] ?? "")
    ).toMatchObject({
      description: "Use for weekly reports: progress and risks.",
      name: "weekly-report"
    });
    for (const root of Object.values(fixture.installed)) {
      expect(realpathSync(path.join(root, "weekly-report"))).toBe(skill);
    }
    writeSkill(path.dirname(skill), "weekly-report", "My weekly report workflow.\n");
    await runCliAsync(
      ["skills", "policy", "weekly-report", "--model-invocation", "deny"],
      fixture.runtime
    );
    await runInstallSkillsLocked(fixture.runtime, fixture.guidance);
    expect(read(fixture.installed.codex, "weekly-report/SKILL.md")).toContain(
      "My weekly report workflow."
    );
    expect(read(fixture.installed.claude, "weekly-report/SKILL.md")).toContain(
      "disable-model-invocation: true"
    );
    await expect(
      runCliAsync(["skills", "create", "weekly-report"], fixture.runtime)
    ).rejects.toThrow(/already registered/u);
    await runCliAsync(["skills", "remove", "weekly-report"], fixture.runtime);
    expect(readFileSync(path.join(skill, "SKILL.md"), "utf-8")).toContain(
      "My weekly report workflow."
    );
    expect(existsSync(path.join(fixture.installed.codex, "weekly-report"))).toBeFalsy();
  });

  test("adoption replaces an unmanaged Claude skill with shared links and preserves supporting files", async () => {
    const fixture = registryFixture();
    const original = path.join(fixture.installed.claude, "personal");
    writeSkill(fixture.installed.claude, "personal", "My instructions.\n");
    write(original, "scripts/report.sh", "echo report\n");
    write(original, "references/report.md", "Report reference.\n");
    await runCliAsync(["skills", "adopt", original], fixture.runtime);
    const skill = path.join(fixture.monkeHome, "skill-sources/personal/personal");
    for (const root of Object.values(fixture.installed)) {
      expect(realpathSync(path.join(root, "personal"))).toBe(skill);
      expect(read(root, "personal/references/report.md")).toBe("Report reference.\n");
    }
    expect(readFileSync(path.join(skill, "scripts/report.sh"), "utf-8")).toBe("echo report\n");
    writeFileSync(
      path.join(fixture.installed.codex, "personal/SKILL.md"),
      "Edited through Codex.\n"
    );
    expect(readFileSync(path.join(original, "SKILL.md"), "utf-8")).toBe("Edited through Codex.\n");
    expect(readImportRecipeStore(fixture.registry).recipes).toMatchObject([
      {
        localSource: { kind: "link", skillSourceFolder: path.dirname(skill) },
        name: "personal"
      }
    ]);
  });

  test("adoption selects collection skills, removes old entries, and leaves alias targets intact", async () => {
    const fixture = registryFixture();
    const original = path.join(fixture.source, "typography");
    const external = path.join(fixture.sandbox, "external", "linked");
    writeSkill(fixture.source, "unselected", "Unselected.\n");
    writeSkill(path.dirname(external), "linked", "External instructions.\n");
    symlinkSync(external, path.join(fixture.source, "linked"), "dir");
    await runCliAsync(
      [
        "skills",
        "adopt",
        fixture.checkout,
        "--name",
        "personal",
        "--skill",
        "typography",
        "linked"
      ],
      fixture.runtime
    );
    const managed = path.join(fixture.monkeHome, "skill-sources/personal");
    expect(existsSync(original)).toBeFalsy();
    expect(existsSync(path.join(fixture.source, "linked"))).toBeFalsy();
    expect(realpathSync(path.join(fixture.installed.codex, "linked"))).toBe(
      path.join(managed, "linked")
    );
    expect(readFileSync(path.join(external, "SKILL.md"), "utf-8")).toContain(
      "External instructions."
    );
    expect(read(fixture.source, "unselected/SKILL.md")).toContain("Unselected.");
    expect(existsSync(path.join(fixture.installed.codex, "unselected"))).toBeFalsy();
    await runCliAsync(["skills", "update"], fixture.runtime);
    await runInstallSkillsLocked(fixture.runtime, fixture.guidance);
    expect(realpathSync(path.join(fixture.installed.codex, "typography"))).toBe(
      path.join(managed, "typography")
    );
  });

  test("adoption reports an unselected alias before removing its physical source or another selected skill", async () => {
    const fixture = registryFixture();
    writeSkill(fixture.source, "healthy", "Healthy instructions.\n");
    symlinkSync("typography", path.join(fixture.source, "unselected-alias"), "dir");
    await expect(
      runCliAsync(
        ["skills", "adopt", fixture.checkout, "--skill", "typography", "healthy"],
        fixture.runtime
      )
    ).rejects.toThrow(
      /typography: removing .* would break unselected Skill alias .*unselected-alias/u
    );
    expect(read(fixture.source, "unselected-alias/SKILL.md")).toContain("Course instructions.");
    expect(readlinkSync(path.join(fixture.source, "unselected-alias"))).toBe("typography");
    expect(read(fixture.source, "healthy/SKILL.md")).toContain("Healthy instructions.");
    expect(readImportRecipeStore(fixture.registry).recipes).toStrictEqual([]);
    expect(existsSync(path.join(fixture.installed.codex, "healthy"))).toBeFalsy();
  });

  test.each(["skill", "collection"] as const)(
    "adoption accepts an ordinary ancestor alias above a supplied %s",
    async (scope) => {
      const fixture = registryFixture();
      const ancestor = path.join(fixture.sandbox, "ancestor-alias");
      symlinkSync(fixture.checkout, ancestor, "dir");
      const source = path.join(ancestor, ".claude", "skills");
      await runCliAsync(
        [
          "skills",
          "adopt",
          scope === "skill" ? path.join(source, "typography") : source,
          "--name",
          "personal"
        ],
        fixture.runtime
      );
      const managed = path.join(fixture.monkeHome, "skill-sources/personal/typography");
      expect(read(managed, "SKILL.md")).toContain("Course instructions.");
      expect(realpathSync(path.join(fixture.installed.claude, "typography"))).toBe(managed);
      expect(existsSync(path.join(fixture.source, "typography"))).toBeFalsy();
      expect(readlinkSync(ancestor)).toBe(fixture.checkout);
    }
  );

  test("adoption reports an explicit collection alias and preserves its external skills", async () => {
    const fixture = registryFixture();
    const collection = path.join(fixture.sandbox, "collection-alias");
    symlinkSync(fixture.source, collection, "dir");
    await expect(runCliAsync(["skills", "adopt", collection], fixture.runtime)).rejects.toThrow(
      /inside an aliased collection/u
    );
    expect(read(fixture.source, "typography/SKILL.md")).toContain("Course instructions.");
    expect(readlinkSync(collection)).toBe(fixture.source);
    expect(readImportRecipeStore(fixture.registry).recipes).toStrictEqual([]);
  });

  test("adopting a single Codex alias removes duplicate discovery and preserves the external source", async () => {
    const fixture = registryFixture();
    const external = path.join(fixture.sandbox, "external", "original");
    const codexRoot = path.join(fixture.sandbox, "home", ".codex", "skills");
    writeSkill(path.dirname(external), "original", "External instructions.\n");
    write(codexRoot, "unrelated/SKILL.md", "Unrelated.\n");
    symlinkSync(external, path.join(codexRoot, "personal"), "dir");
    await runCliAsync(["skills", "adopt", "~/.codex/skills/personal"], fixture.runtime);
    expect(existsSync(path.join(codexRoot, "personal"))).toBeFalsy();
    expect(readFileSync(path.join(external, "SKILL.md"), "utf-8")).toContain(
      "External instructions."
    );
    expect(read(codexRoot, "unrelated/SKILL.md")).toBe("Unrelated.\n");
    expect(realpathSync(path.join(fixture.installed.codex, "personal"))).toBe(
      path.join(fixture.monkeHome, "skill-sources/personal/personal")
    );
  });

  test("adopting an entire harness root skips skills Monke already manages", async () => {
    const fixture = registryFixture();
    await runCliAsync(["skills", "create", "already-managed"], fixture.runtime);
    const codexRoot = path.join(fixture.sandbox, "home", ".codex", "skills");
    writeSkill(codexRoot, "personal", "Personal instructions.\n");
    await runCliAsync(["skills", "adopt", codexRoot, "--name", "from-codex"], fixture.runtime);
    expect(existsSync(path.join(codexRoot, "personal"))).toBeFalsy();
    expect(read(fixture.installed.codex, "personal/SKILL.md")).toContain("Personal instructions.");
    expect(
      readImportRecipeStore(fixture.registry).recipes.find((recipe) => recipe.name === "from-codex")
        ?.skills
    ).toStrictEqual([{ kind: "skill", selector: "personal", slug: "personal" }]);
    expect(
      existsSync(
        path.join(fixture.monkeHome, "skill-sources/already-managed/already-managed/SKILL.md")
      )
    ).toBeTruthy();
    expect(
      read(path.join(fixture.guidance, "skills/internal"), "monke-tools-core/SKILL.md")
    ).toContain("Internal instructions.");
  });

  test("divergent global copies are reported before adoption changes files", async () => {
    const fixture = registryFixture();
    const original = path.join(fixture.source, "typography");
    writeSkill(fixture.installed.claude, "typography", "Unrelated target.\n");
    await expect(runCliAsync(["skills", "adopt", original], fixture.runtime)).rejects.toThrow(
      /differing copies.*typography/u
    );
    expect(readFileSync(path.join(original, "SKILL.md"), "utf-8")).toContain(
      "Course instructions."
    );
    expect(read(fixture.installed.claude, "typography/SKILL.md")).toContain("Unrelated target.");
    expect(existsSync(path.join(fixture.monkeHome, "skill-sources/typography"))).toBeFalsy();
    expect(readImportRecipeStore(fixture.registry).recipes).toStrictEqual([]);
  });

  test("invalid selections fail without changes and already managed sources report unchanged", async () => {
    const fixture = registryFixture();
    await expect(
      runCliAsync(
        ["skills", "adopt", fixture.checkout, "--skill", "typography", "missing"],
        fixture.runtime
      )
    ).rejects.toThrow(/missing/u);
    expect(read(fixture.source, "typography/SKILL.md")).toContain("Course instructions.");
    await runCliAsync(["skills", "add", fixture.checkout], fixture.runtime);
    await runCliAsync(
      ["skills", "adopt", path.join(fixture.source, "typography"), "--skill", "typography"],
      fixture.runtime
    );
    expect(fixture.stdout()).toContain("Unchanged: typography");
    await expect(runCliAsync(["skills", "create", "../escape"], fixture.runtime)).rejects.toThrow(
      /lowercase/u
    );
    await expect(
      runCliAsync(["skills", "create", "monke-tools-core"], fixture.runtime)
    ).rejects.toThrow(/duplicate/u);
    expect(existsSync(path.join(fixture.monkeHome, "skill-sources/monke-tools-core"))).toBeFalsy();
  });

  test("explicit removal survives installation and explicit re-add enables a bundled source again", async () => {
    const fixture = registryFixture();
    const gitSource = createRepo(path.join(fixture.sandbox, "git-source"), {
      "skills/git-skill/SKILL.md": "---\nname: git-skill\n---\nBundled Git instructions.\n"
    });
    const source = `${gitSource}#HEAD`;
    installGitImporter(fixture);
    writeSkill(
      path.join(fixture.guidance, "skills/imported"),
      "git-skill",
      "Bundled Git instructions.\n"
    );
    writeImportRecipeStore(fixture.guidance, {
      recipes: [{ skills: [{ kind: "skill", selector: "git-skill", slug: "git-skill" }], source }],
      version: 3
    });
    await runCliAsync(["skills", "add", fixture.checkout], fixture.runtime);
    await runCliAsync(["skills", "remove", source], fixture.runtime);
    await runInstallSkillsLocked(fixture.runtime, fixture.guidance);
    for (const root of Object.values(fixture.installed)) {
      expect(existsSync(path.join(root, "git-skill"))).toBeFalsy();
      expect(realpathSync(path.join(root, "typography"))).toBe(
        path.join(fixture.source, "typography")
      );
    }
    await runCliAsync(["skills", "add", source], fixture.runtime);
    await runInstallSkillsLocked(fixture.runtime, fixture.guidance);
    for (const root of Object.values(fixture.installed)) {
      expect(read(root, "git-skill/SKILL.md")).toContain("Bundled Git instructions.");
    }
    expect(readImportRecipeStore(fixture.registry).removedSources ?? []).toStrictEqual([]);
  });

  test("linked imports use existing provider layouts and write learned changes back to their source", async () => {
    const fixture = registryFixture();
    const actualSkill = path.join(fixture.sandbox, "skill-repo", "typography");
    writeSkill(path.dirname(actualSkill), "typography", "Course instructions.\n");
    rmSync(path.join(fixture.source, "typography"), { recursive: true });
    symlinkSync(actualSkill, path.join(fixture.source, "typography"), "dir");
    symlinkSync(fixture.source, path.join(fixture.source, "loop"), "dir");
    writeSkill(path.join(fixture.checkout, ".codex/skills"), "typography", "Separate copy.\n");
    await runCliAsync(["skills", "add", fixture.checkout, "--link"], fixture.runtime);
    for (const root of Object.values(fixture.installed)) {
      expect(realpathSync(path.join(root, "typography"))).toBe(actualSkill);
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
    expect(loadGlobalMonkeConfig(fixture.monkeHome)).toMatchObject({ diffAdapter: "codiff" });
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
    write(gitSource, "skills/git-skill/support.md", "Supporting Git content.\n");
    symlinkSync("support.md", path.join(gitSource, "skills/git-skill/alias.md"));
    git(gitSource, ["add", "."]);
    git(gitSource, ["commit", "-m", "First skill"]);
    // Exercise the actual published-importer process boundary without network downloads.
    installGitImporter(fixture);
    await runCliAsync(
      ["skills", "add", `${gitSource}#HEAD`, "--name", "git-source"],
      fixture.runtime
    );
    expect(fixture.stdout()).toContain("Security Risk Assessments");
    expect(fixture.stdout()).toContain("git-skill");
    expect(fixture.stdout()).toContain("https://skills.sh/owner/repo");
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
    expect(git(reviewRepo, ["ls-tree", commit, "skills/imported/git-skill/alias.md"])).toContain(
      "120000 blob"
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
      expect(existsSync(path.join(fixture.source, "monke-tools-core"))).toBeFalsy();
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
      if (kind === "link") {
        writeSkill(fixture.source, "typography", "Course instructions.\n");
        await runCliAsync(["skills", "update"], fixture.runtime);
      }
      expect(readFileSync(fixture.codiffLog, "utf-8").trim().split("\n")).toHaveLength(3);
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

  test.each([
    "empty",
    "flat",
    "symlink",
    "provider",
    "candidate",
    "new_collection",
    "alias",
    "root_entry"
  ] as const)(
    "a failed installer in an existing %s project preserves unrelated edits and restores only skills",
    async (layout) => {
      const fixture = registryFixture();
      const project = createRepo(path.join(fixture.sandbox, "existing-project"), {
        "notes/README.md": "Unrelated notes.\n",
        "README.md": "Original project.\n"
      });
      const cwd = layout === "symlink" ? path.join(fixture.sandbox, "project-link") : project;
      if (layout === "symlink") {
        symlinkSync(project, cwd, "dir");
      }
      if (layout === "flat") {
        writeSkill(project, "typography", "Original skill.\n");
        write(project, "typography/assets/icon.svg", "Original supporting asset.\n");
      }
      const { command, upstream } = installer(fixture);
      writeSkill(upstream, "typography", "Partial install.\n");
      const failFlag = path.join(fixture.sandbox, "fail-installer");
      const partialOutput = [
        "printf 'Edited during installation.\\n' > README.md",
        "mkdir -p notes/generated/partial-skill",
        "printf '%s\\n' '---' 'name: partial-skill' 'description: Partial skill.' '---' > notes/generated/partial-skill/SKILL.md",
        "printf 'New generated docs.\\n' > notes/generated/README.md",
        ...(layout === "root_entry"
          ? [
              "printf '%s\\n' '---' 'name: root-skill' 'description: Partial root skill.' '---' > SKILL.md"
            ]
          : []),
        ...(layout === "alias" ? ["ln -s typography skills/beta"] : []),
        ...(layout === "flat"
          ? [
              "rm typography/SKILL.md",
              "printf '%s\\n' '---' 'name: asset-skill' 'description: Partial asset skill.' '---' > typography/assets/SKILL.md"
            ]
          : []),
        "if [ -f skills/README.md ]; then printf 'Edited unrelated docs.\\n' > skills/README.md; printf 'New unrelated file.\\n' > skills/new.txt; fi"
      ].join("; ");
      const failingCommand = `if [ -f ${shellQuote(failFlag)} ]; then ${partialOutput}; fi; ${command}; installer_status=$?; ${layout === "new_collection" ? "printf 'New collection docs.\\n' > .claude/skills/README.md; " : ""}exit "$installer_status"`;
      if (layout === "provider") {
        await runCliAsync(
          ["skills", "add", "--name", "course", "--command", failingCommand, "--cwd", cwd],
          fixture.runtime
        );
        write(project, "skills/README.md", "Unrelated project docs.\n");
      }
      if (["candidate", "alias"].includes(layout)) {
        writeSkill(path.join(project, "skills"), "typography", "Original candidate skill.\n");
        write(project, "skills/README.md", "Unrelated project docs.\n");
      }
      const accepted = readImportRecipeStore(fixture.registry);
      write(fixture.sandbox, "fail-installer", "fail\n");
      await expect(
        runCliAsync(
          layout === "provider"
            ? ["skills", "update"]
            : ["skills", "add", "--name", "course", "--command", failingCommand, "--cwd", cwd],
          fixture.runtime
        )
      ).rejects.toThrow(/exited with code 42/u);
      const collectionDocs = existsSync(path.join(project, ".claude/skills/README.md"))
        ? read(project, ".claude/skills/README.md")
        : "";
      expect(collectionDocs).toBe(layout === "new_collection" ? "New collection docs.\n" : "");
      expect(existsSync(path.join(project, "skills/beta"))).toBeFalsy();
      expect(existsSync(path.join(project, "SKILL.md"))).toBeFalsy();
      expect(read(project, "README.md")).toBe("Edited during installation.\n");
      expect(read(project, "notes/README.md")).toBe("Unrelated notes.\n");
      expect(existsSync(path.join(project, "notes/generated/partial-skill"))).toBeFalsy();
      expect(read(project, "notes/generated/README.md")).toBe("New generated docs.\n");
      expect(git(project, ["rev-parse", "--show-toplevel"]).trim()).toBe(project);
      expect(existsSync(path.join(project, ".claude/skills"))).toBe(
        ["provider", "new_collection"].includes(layout)
      );
      expect(existsSync(path.join(project, ".claude/skills/typography"))).toBe(
        layout === "provider"
      );
      const restoredSkill = existsSync(path.join(project, "typography/SKILL.md"))
        ? read(project, "typography/SKILL.md")
        : "";
      expect(restoredSkill.includes("Original skill.")).toBe(layout === "flat");
      const restoredAsset = existsSync(path.join(project, "typography/assets/icon.svg"))
        ? read(project, "typography/assets/icon.svg")
        : "";
      expect(restoredAsset).toBe(layout === "flat" ? "Original supporting asset.\n" : "");
      expect(existsSync(path.join(project, "typography/assets/SKILL.md"))).toBeFalsy();
      expect(readImportRecipeStore(fixture.registry)).toStrictEqual(accepted);
      const unrelatedDocs = existsSync(path.join(project, "skills/README.md"))
        ? read(project, "skills/README.md")
        : "";
      expect(unrelatedDocs).toBe(
        ["provider", "candidate", "alias"].includes(layout) ? "Edited unrelated docs.\n" : ""
      );
      expect(existsSync(path.join(project, "skills/new.txt"))).toBe(
        ["provider", "candidate", "alias"].includes(layout)
      );
      rmSync(failFlag);
      await runCliAsync(
        layout === "provider"
          ? ["skills", "update"]
          : ["skills", "add", "--name", "course", "--command", command, "--cwd", cwd],
        fixture.runtime
      );
      expect(realpathSync(path.join(fixture.installed.claude, "typography"))).toBe(
        path.join(
          project,
          ["candidate", "alias"].includes(layout)
            ? "skills/typography"
            : ".claude/skills/typography"
        )
      );
    }
  );

  test.each(["collection", "nested"] as const)(
    "recovery detaches a replaced %s alias without changing the unrelated target",
    async (layout) => {
      const fixture = registryFixture();
      const foreign = path.join(fixture.sandbox, "foreign-skills");
      const foreignSlug = layout === "nested" ? "notes" : "typography";
      writeSkill(foreign, foreignSlug, "Unrelated foreign instructions.\n");
      const foreignBytes = read(foreign, `${foreignSlug}/SKILL.md`);
      const replaced = layout === "nested" ? ".claude/skills/group" : ".claude/skills";
      if (layout === "nested") {
        write(fixture.source, "group/notes/README.md", "Existing notes.\n");
      }
      const command = `rm -rf ${replaced}; ln -s ${shellQuote(foreign)} ${replaced}; exit 42`;
      await runCliAsync(
        ["skills", "add", fixture.checkout, "--link", "--command", command],
        fixture.runtime
      );
      const accepted = read(fixture.source, "typography/SKILL.md");
      await expect(runCliAsync(["skills", "update"], fixture.runtime)).rejects.toThrow(/code 42/u);
      expect(read(foreign, `${foreignSlug}/SKILL.md`)).toBe(foreignBytes);
      expect(read(fixture.source, "typography/SKILL.md")).toBe(accepted);
      expect(realpathSync(fixture.source)).toBe(fixture.source);
      expect(existsSync(path.join(fixture.source, "group"))).toBeFalsy();
    }
  );

  test.each([undefined, "codiff"])(
    "updates honor the configured LFV adapter unless overridden with %s",
    async (adapter) => {
      const fixture = registryFixture();
      const config = loadGlobalMonkeConfig(fixture.monkeHome);
      saveGlobalMonkeConfig(fixture.monkeHome, { ...config, diffAdapter: "lfv" });
      const log = path.join(fixture.bin, "lfv.log");
      writeExecutable(
        path.join(fixture.bin, "lfv"),
        `#!/bin/sh
set -eu
printf '%s\\n' "$@" > ${shellQuote(log)}
printf '%s\\n' '{"version":1,"ok":true,"command":"review.create","data":{"url":"https://lfv.example/review/123"}}'
`
      );
      await runCliAsync(["skills", "add", fixture.checkout, "--link"], fixture.runtime);
      writeSkill(fixture.source, "typography", "Updated skill.\n");
      await runCliAsync(
        ["skills", "update", ...(adapter ? ["--adapter", adapter] : [])],
        fixture.runtime
      );
      expect(readFileSync(adapter ? fixture.codiffLog : log, "utf-8")).toContain(
        adapter ? "--commit" : "--source\ncommit\n--ref\n"
      );
      expect(existsSync(adapter ? log : fixture.codiffLog)).toBeFalsy();
      expect(fixture.stdout().includes("https://lfv.example/review/123")).toBe(
        adapter === undefined
      );
      expect(read(fixture.installed.claude, "typography/SKILL.md")).toContain("Updated skill.");
    }
  );

  test("repeat Git add preserves references and overrides across selection replacement", async () => {
    const fixture = registryFixture();
    const upstream = createRepo(path.join(fixture.sandbox, "git-source"), {
      "README.md": "Git skills.\n"
    });
    writeSkill(path.join(upstream, "skills"), "alpha", "Alpha instructions.\n");
    writeSkill(path.join(upstream, "skills"), "bravo", "Bravo instructions.\n");
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Skill source"]);
    installGitImporter(fixture);
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

  test.each(["policy", "installer", "new linked target"] as const)(
    "failed %s publication restores bytes in external symlinked skill directories",
    async (operation) => {
      const fixture = registryFixture();
      const actual = path.join(fixture.sandbox, "actual-skills");
      writeSkill(actual, "typography", "External instructions.\n");
      write(
        actual,
        "typography/agents/openai.yaml",
        "policy:\n  allow_implicit_invocation: true\n"
      );
      rmSync(path.join(fixture.source, "typography"), { recursive: true });
      symlinkSync(path.join(actual, "typography"), path.join(fixture.source, "typography"), "dir");
      const script = path.join(fixture.sandbox, "modify-linked-skill.sh");
      writeExecutable(
        script,
        `#!/bin/sh
set -eu
cat > .claude/skills/typography/SKILL.md <<'SKILL'
---
name: typography
description: A course skill.
---
New installer instructions.
SKILL
`
      );
      await runCliAsync(
        ["skills", "add", fixture.checkout, "--link", "--command", `sh ${shellQuote(script)}`],
        fixture.runtime
      );
      await runCliAsync(
        ["skills", "policy", "private-course", "--model-invocation", "deny"],
        fixture.runtime
      );
      const brokenSlug = operation === "new linked target" ? "color" : "typography";
      if (operation === "new linked target") {
        writeSkill(actual, "color", "External color instructions.\n");
        writeFileSync(
          script,
          `${readFileSync(script, "utf-8")}ln -s ${shellQuote(path.join(actual, "color"))} .claude/skills/color\n`
        );
      }
      const metadata = path.join(fixture.sandbox, "agent-metadata");
      write(metadata, "openai.yaml", "policy:\n  allow_implicit_invocation: false\n");
      rmSync(path.join(actual, brokenSlug, "agents"), { force: true, recursive: true });
      symlinkSync(metadata, path.join(actual, brokenSlug, "agents"), "dir");
      const accepted = read(actual, "typography/SKILL.md");
      const externalAccepted = read(actual, `${brokenSlug}/SKILL.md`);
      const recipe = readImportRecipeStore(fixture.registry);
      await expect(
        runCliAsync(
          operation === "policy"
            ? ["skills", "policy", "private-course", "--model-invocation", "deny"]
            : ["skills", "update"],
          fixture.runtime
        )
      ).rejects.toThrow(/agents path to be a regular directory/u);
      expect(read(actual, "typography/SKILL.md")).toBe(accepted);
      expect(read(actual, `${brokenSlug}/SKILL.md`)).toBe(externalAccepted);
      expect(read(metadata, "openai.yaml")).toBe("policy:\n  allow_implicit_invocation: false\n");
      expect(readImportRecipeStore(fixture.registry)).toStrictEqual(recipe);
      expect(realpathSync(path.join(fixture.installed.claude, "typography"))).toBe(
        path.join(actual, "typography")
      );
      expect(readlinkSync(path.join(actual, brokenSlug, "agents"))).toBe(metadata);
      expect(existsSync(path.join(fixture.source, "color"))).toBeFalsy();
    }
  );

  test("an unavailable Git pin does not block healthy local source updates", async () => {
    const fixture = registryFixture();
    installGitImporter(fixture);
    const upstream = createRepo(path.join(fixture.sandbox, "git-source"), {
      "README.md": "Git source.\n"
    });
    writeSkill(path.join(upstream, "skills"), "alpha", "Git skill.\n");
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Git skill"]);
    await runCliAsync(["skills", "add", `${upstream}#HEAD`, "--name", "a-git"], fixture.runtime);
    const later = path.join(fixture.sandbox, "z-personal");
    writeSkill(later, "personal", "Original personal.\n");
    await runCliAsync(["skills", "add", later], fixture.runtime);
    rmSync(path.join(fixture.registry, "skills/imported/alpha"), { recursive: true });
    rmSync(upstream, { recursive: true });
    writeSkill(later, "personal", "Updated personal.\n");
    await expect(runCliAsync(["skills", "update"], fixture.runtime)).rejects.toThrow(/git-source/u);
    expect(read(fixture.installed.claude, "personal/SKILL.md")).toContain("Updated personal.");
    expect(readFileSync(fixture.codiffLog, "utf-8").trim().split("\n")).toHaveLength(3);
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
