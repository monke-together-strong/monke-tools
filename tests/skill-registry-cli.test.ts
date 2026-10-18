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

import { describe, expect, it, vi } from "vite-plus/test";
import { parse, stringify } from "yaml";

import { readImportRecipeStore, writeImportRecipeStore } from "../scripts/skill-import-recipes.ts";
import { guidanceDigest, restoreLockedImports } from "../scripts/skill-lock.ts";
import { errorMessage, ThrownValueSchema } from "../src/errors.ts";
import { loadGlobalMonkeConfig, saveGlobalMonkeConfig } from "../src/global-config.ts";
import { runInstallSkillsLocked } from "../src/guidance-installation.ts";
import { runCliAsync } from "../src/index.ts";
import { shellQuote } from "../src/shell-quote.ts";
import { preflightSkillRegistryInstall } from "../src/skill-registry.ts";
import {
  createRepo,
  git,
  installFakeCodexSummary,
  installFakeCodiff,
  installInternalRootImporter,
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
  installFakeCodexSummary(bin);
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

function installNamedGitImporter(fixture: ReturnType<typeof registryFixture>) {
  writeExecutable(
    path.join(fixture.bin, "npx"),
    `#!/usr/bin/env bun
import { cpSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
const source = process.argv[5];
const selectors = [];
for (let index = 6; process.argv[index] === "--skill"; index += 2) selectors.push(process.argv[index + 1].toLowerCase());
let installed = 0;
for (const folder of readdirSync(path.join(source, "skills"))) {
  const directory = path.join(source, "skills", folder);
  const content = readFileSync(path.join(directory, "SKILL.md"), "utf8");
  const name = /^name: (.+)$/m.exec(content)[1];
  if (!selectors.includes("*") && !selectors.includes(name.toLowerCase())) continue;
  const slug = name.toLowerCase().replace(/[^a-z0-9._]+/g, "-").replace(/^[.\\-]+|[.\\-]+$/g, "").substring(0, 255) || "unnamed-skill";
  const destination = path.join(".agents", "skills", slug);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(directory, destination, { recursive: true });
  installed += 1;
}
if (installed === 0) throw new Error("No matching skills: " + selectors.join(", "));
`
  );
}

async function namedPublisherTransition(options: {
  action: "update" | "readd";
  candidateName: string;
  initial: "own" | "reference" | "skill";
  selector: string;
}) {
  const { action, candidateName, initial, selector } = options;
  const fixture = registryFixture();
  installNamedGitImporter(fixture);

  const skill = (body: string, name = "Fancy Author") =>
    `---\nname: ${name}\ndescription: Author trigger.\n---\n${body}\n`;

  const declaredName = initial === "own" ? candidateName : "Fancy Author";

  const upstream = createRepo(path.join(fixture.sandbox, "named-import"), {
    "skills/author/SKILL.md": skill("Declared author.", declaredName)
  });

  const declaration = stringify({
    skills: [
      {
        commit: git(upstream, ["rev-parse", "HEAD"]),
        skills: [
          {
            kind: initial === "reference" ? "reference" : "skill",
            selector: declaredName,
            slug: "fancy-author"
          }
        ],
        source: upstream
      }
    ]
  });

  const publisher = createRepo(
    path.join(fixture.sandbox, "named-publisher"),
    initial === "own"
      ? { "skills/authors/SKILL.md": skill("Owned author.") }
      : { "monke.yml": declaration }
  );

  const source = `${publisher}#HEAD`;

  if (candidateName === "Unrelated") {
    write(publisher, "skills/existing/SKILL.md", skill("Retained sibling.", "Existing"));
    git(publisher, ["add", "."]);
    git(publisher, ["commit", "-m", "Publish a selected sibling"]);
  }

  await runCliAsync(
    [
      "skills",
      "add",
      source,
      "--skill",
      selector,
      ...(candidateName === "Unrelated" ? ["Existing"] : [])
    ],
    fixture.runtime
  );
  const acceptedRegistry = read(fixture.registry, "skills.lock.json");

  const acceptedGuidance =
    initial === "reference"
      ? read(fixture.registry, "skills/references/imported/fancy-author/MAIN.md")
      : read(fixture.installed.codex, "fancy-author/SKILL.md");

  if (initial === "own") {
    rmSync(path.join(publisher, "skills/authors"), { recursive: true });
    write(publisher, "monke.yml", declaration);
  } else {
    write(publisher, "monke.yml", "skills: []\n");
    write(publisher, "skills/new-folder/SKILL.md", skill("Owned replacement.", candidateName));
  }

  git(publisher, ["add", "-A"]);
  git(publisher, ["commit", "-m", "Move the selected author"]);
  const command = action === "update" ? ["skills", "update"] : ["skills", "add", source];

  return { acceptedGuidance, acceptedRegistry, command, fixture, publisher };
}

describe("Skill import registry CLI", () => {
  it.each([
    { action: "add", scope: "global" },
    { action: "update", scope: "global" },
    { action: "add", scope: "project" },
    { action: "update", scope: "project" },
    { action: "add", scope: "repo" },
    { action: "update", scope: "repo" },
    { action: "restore", scope: "repo" }
  ])(
    "rejects unconfined support links on Git $action before publishing $scope state",
    async ({ action, scope }) => {
      const fixture = registryFixture();
      installInternalRootImporter(fixture.bin);

      const consumer = createRepo(path.join(fixture.sandbox, "consumer"), {
        "README.md": "Consumer.\n"
      });

      const runtime = createTestRuntime({
        cwd: consumer,
        env: fixture.runtime.env,
        onStderr() {},
        onStdout() {}
      });

      const flags = scope === "global" ? [] : [`--${scope}`];

      const registry =
        scope === "repo"
          ? consumer
          : scope === "project"
            ? path.join(consumer, ".git/monke-tools/skill-registry")
            : fixture.registry;

      const storePath = scope === "repo" ? "monke.yml" : "skills.lock.json";

      const upstream = createRepo(path.join(fixture.sandbox, "upstream"), {
        "skills/base/SKILL.md":
          "---\nname: base\ndescription: Base.\nmetadata:\n  internal: true\n---\nAccepted instructions.\n"
      });

      await runCliAsync(
        ["skills", "add", `${upstream}#HEAD`, "--skill", "base", ...flags],
        runtime
      );

      const accepted = {
        guidance: read(registry, "skills/imported/base/SKILL.md"),
        marker: read(registry, "skills/.monke-restored.json"),
        store: read(registry, storePath)
      };

      const invalid =
        action === "add"
          ? createRepo(path.join(fixture.sandbox, "invalid"), {
              "skills/invalid/SKILL.md":
                "---\nname: invalid\ndescription: Invalid.\nmetadata:\n  internal: true\n---\nRejected instructions.\n"
            })
          : upstream;

      const slug = action === "add" ? "invalid" : "base";
      write(invalid, "shared.md", "Checkout support.\n");
      write(
        invalid,
        `skills/${slug}/SKILL.md`,
        `---\nname: ${slug}\ndescription: Changed.\nmetadata:\n  internal: true\n---\nRejected instructions.\n`
      );
      symlinkSync("../../shared.md", path.join(invalid, "skills", slug, "support.md"));
      git(invalid, ["add", "."]);
      git(invalid, ["commit", "-m", "Add checkout-confined support link"]);

      if (action === "restore") {
        write(
          registry,
          storePath,
          stringify({
            skills: [
              {
                commit: git(upstream, ["rev-parse", "HEAD"]),
                skills: ["base"],
                source: `${upstream}#HEAD`
              }
            ]
          })
        );
        accepted.store = read(registry, storePath);
      }

      const command =
        action === "add"
          ? ["skills", "add", `${invalid}#HEAD`, "--skill", slug, ...flags]
          : ["skills", action, ...flags];

      await expect(runCliAsync(command, runtime)).rejects.toThrow(
        "Imported symlink escapes its guidance directory"
      );
      expect(read(registry, storePath)).toBe(accepted.store);
      expect(read(registry, "skills/.monke-restored.json")).toBe(accepted.marker);
      expect(read(registry, "skills/imported/base/SKILL.md")).toBe(accepted.guidance);
      expect(existsSync(path.join(registry, "skills/imported", slug, "support.md"))).toBeFalsy();
      expect(existsSync(path.join(registry, "skills/imported/invalid"))).toBeFalsy();
    }
  );

  it.each(["skill", "reference"] as const)(
    "rejects an edited %s support link during mt skills policy before changing accepted state",
    async (kind) => {
      const fixture = registryFixture();
      installGitImporter(fixture);

      const upstream = createRepo(path.join(fixture.sandbox, "reference-source"), {
        "skills/base/SKILL.md": "---\nname: base\ndescription: Base.\n---\nBase instructions.\n"
      });

      const publisher = createRepo(path.join(fixture.sandbox, "publisher"), {
        "monke.yml": stringify({
          skills: [
            {
              commit: git(upstream, ["rev-parse", "HEAD"]),
              skills: [{ kind: "reference", slug: "base" }],
              source: upstream
            }
          ]
        }),
        "skills/own-skill/SKILL.md":
          "---\nname: own-skill\ndescription: Original trigger.\n---\nOwn instructions.\n"
      });

      await runCliAsync(
        ["skills", "add", `${publisher}#HEAD`, "--name", "publisher"],
        fixture.runtime
      );

      const link = path.join(
        fixture.registry,
        kind === "skill"
          ? "skills/imported/own-skill/shared.md"
          : "skills/references/imported/base/shared.md"
      );

      const support = path.resolve(path.dirname(link), "../../shared.md");
      writeFileSync(support, "Shared local support.\n");
      symlinkSync("../../shared.md", link);

      const accepted = {
        entry: read(fixture.registry, "skills/imported/own-skill/SKILL.md"),
        marker: read(fixture.registry, "skills/.monke-restored.json"),
        reference: read(fixture.registry, "skills/references/imported/base/MAIN.md"),
        store: read(fixture.registry, "skills.lock.json")
      };

      const policy = [
        "skills",
        "policy",
        "publisher",
        "own-skill",
        "--description",
        "Next trigger."
      ];

      await expect(runCliAsync(policy, fixture.runtime)).rejects.toThrow(
        "Imported symlink escapes its guidance directory"
      );

      expect(read(fixture.registry, "skills/imported/own-skill/SKILL.md")).toBe(accepted.entry);
      expect(read(fixture.registry, "skills/.monke-restored.json")).toBe(accepted.marker);
      expect(read(fixture.registry, "skills/references/imported/base/MAIN.md")).toBe(
        accepted.reference
      );
      expect(read(fixture.registry, "skills.lock.json")).toBe(accepted.store);
      expect(readlinkSync(link)).toBe("../../shared.md");
      expect(readFileSync(support, "utf-8")).toBe("Shared local support.\n");

      rmSync(link);
      await runCliAsync(policy, fixture.runtime);
      expect(read(fixture.registry, "skills/imported/own-skill/SKILL.md")).toContain(
        "description: Next trigger."
      );
    }
  );

  it("includes declared imports of Git publishers, retains consumer overrides, and updates accepted pins", async () => {
    const fixture = registryFixture();
    installGitImporter(fixture);

    const upstream = createRepo(path.join(fixture.sandbox, "declared-source"), {
      "README.md": "Declared source.\n"
    });

    writeSkill(path.join(upstream, "skills"), "imported-skill", "Imported first revision.\n");
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Upstream skill"]);

    const publisher = createRepo(path.join(fixture.sandbox, "publisher"), {
      "README.md": "Publisher.\n"
    });

    writeSkill(path.join(publisher, "skills"), "own-skill", "Publisher instructions.\n");

    function pinPublisher() {
      write(
        publisher,
        "monke.yml",
        stringify({
          skills: [
            {
              commit: git(upstream, ["rev-parse", "HEAD"]),
              modelInvocation: "deny",
              skills: [{ description: "Publisher trigger.", slug: "imported-skill" }],
              source: upstream
            }
          ]
        })
      );
      git(publisher, ["add", "."]);
      git(publisher, ["commit", "-m", "Publish accepted imports"]);
    }

    pinPublisher();
    await runCliAsync(
      ["skills", "add", `${publisher}#HEAD`, "--name", "publisher"],
      fixture.runtime
    );
    expect(read(fixture.installed.codex, "own-skill/SKILL.md")).toContain(
      "Publisher instructions."
    );
    expect(read(fixture.installed.codex, "imported-skill/SKILL.md")).toContain(
      "description: Publisher trigger."
    );
    expect(read(fixture.installed.codex, "imported-skill/SKILL.md")).toContain(
      "disable-model-invocation: true"
    );
    await runCliAsync(
      [
        "skills",
        "policy",
        "publisher",
        "imported-skill",
        "--description",
        "Consumer trigger.",
        "--model-invocation",
        "allow"
      ],
      fixture.runtime
    );
    writeSkill(path.join(upstream, "skills"), "imported-skill", "Imported second revision.\n");
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Advance imported skill"]);
    pinPublisher();
    await runCliAsync(["skills", "update"], fixture.runtime);
    const entry = read(fixture.installed.codex, "imported-skill/SKILL.md");
    expect(entry).toContain("Imported second revision.");
    expect(entry).toContain("description: Consumer trigger.");
    expect(entry).toContain("disable-model-invocation: false");
    expect(readImportRecipeStore(fixture.registry).recipes).toHaveLength(1);
  });

  it.each([
    { explicit: false, initial: "skill", readd: false },
    { explicit: false, initial: "reference", readd: false },
    { explicit: true, initial: "skill", readd: false },
    { explicit: true, initial: "reference", readd: false },
    { explicit: false, initial: "skill", readd: true },
    { explicit: false, initial: "reference", readd: true },
    { explicit: true, initial: "skill", readd: true },
    { explicit: true, initial: "reference", readd: true }
  ] as const)(
    "follows publisher kinds from $initial in Git consumers with explicit=$explicit readd=$readd",
    async ({ explicit, initial, readd }) => {
      const fixture = registryFixture();
      installGitImporter(fixture);

      const upstream = createRepo(path.join(fixture.sandbox, "kind-source"), {
        "skills/base/SKILL.md":
          "---\nname: base\ndescription: Base trigger.\n---\nBase instructions.\n"
      });

      const publisher = createRepo(path.join(fixture.sandbox, "kind-publisher"), {
        "skills/own/SKILL.md": "---\nname: own\ndescription: Own trigger.\n---\nOwn instructions.\n"
      });

      function publish(kind: "skill" | "reference") {
        writeSkill(
          path.join(publisher, "skills"),
          "own",
          kind === "reference"
            ? "Load ../../references/imported/base/MAIN.md.\n"
            : "Self-contained instructions.\n"
        );
        write(
          publisher,
          "monke.yml",
          stringify({
            skills: [
              {
                commit: git(upstream, ["rev-parse", "HEAD"]),
                skills: [{ kind, slug: "base" }],
                source: upstream
              }
            ]
          })
        );
        git(publisher, ["add", "."]);
        git(publisher, ["commit", "-m", `Publish ${kind}`]);
      }

      publish(initial);
      const add = ["skills", "add", `${publisher}#HEAD`, ...(explicit ? ["--skill", "base"] : [])];
      await runCliAsync(add, fixture.runtime);
      const nextKind = initial === "skill" ? "reference" : "skill";
      publish(nextKind);
      await runCliAsync(readd ? add : ["skills", "update"], fixture.runtime);
      const skill = path.join(fixture.registry, "skills/imported/base/SKILL.md");
      const reference = path.join(fixture.registry, "skills/references/imported/base/MAIN.md");
      expect(existsSync(skill)).toBe(nextKind === "skill");
      expect(existsSync(reference)).toBe(nextKind === "reference");
      const entry = readFileSync(nextKind === "skill" ? skill : reference, "utf-8");
      expect(entry).toContain("Base instructions.");
      expect(entry.startsWith("---")).toBe(nextKind === "skill");
    }
  );

  it.each(["update", "readd", "remove"] as const)(
    "retires a publisher reference together with its consumer on %s",
    async (action) => {
      const fixture = registryFixture();
      installGitImporter(fixture);

      const upstream = createRepo(path.join(fixture.sandbox, "reference-source"), {
        "skills/base/SKILL.md":
          "---\nname: base\ndescription: Base trigger.\n---\nBase instructions.\n"
      });

      const publisher = createRepo(path.join(fixture.sandbox, "reference-publisher"), {
        "monke.yml": stringify({
          skills: [
            {
              commit: git(upstream, ["rev-parse", "HEAD"]),
              skills: [{ kind: "reference", slug: "base" }],
              source: upstream
            }
          ]
        }),
        "skills/own/SKILL.md":
          "---\nname: own\ndescription: Own trigger.\n---\nLoad ../../references/imported/base/MAIN.md.\n"
      });

      const source = `${publisher}#HEAD`;
      await runCliAsync(["skills", "add", source], fixture.runtime);

      if (action !== "remove") {
        writeSkill(path.join(publisher, "skills"), "own", "Self-contained instructions.\n");
        write(publisher, "monke.yml", "skills: []\n");
        git(publisher, ["add", "."]);
        git(publisher, ["commit", "-m", "Retire reference"]);
      }

      const command =
        action === "readd"
          ? ["skills", "add", source]
          : ["skills", action, ...(action === "remove" ? [source] : [])];

      const external = createRepo(path.join(fixture.sandbox, "external"), {
        "skills/retained/SKILL.md":
          "---\nname: retained\ndescription: Retained trigger.\n---\nLoad ../../references/imported/base/MAIN.md.\n"
      });

      await runCliAsync(["skills", "add", `${external}#HEAD`], fixture.runtime);
      const acceptedRegistry = read(fixture.registry, "skills.lock.json");
      const acceptedOwn = read(fixture.installed.codex, "own/SKILL.md");
      await expect(runCliAsync(command, fixture.runtime)).rejects.toThrow(
        /Cannot replace Imported reference base; it is used by skills\/imported\/retained\/SKILL.md/u
      );
      expect(read(fixture.registry, "skills.lock.json")).toBe(acceptedRegistry);
      expect(read(fixture.installed.codex, "own/SKILL.md")).toBe(acceptedOwn);
      expect(read(fixture.registry, "skills/references/imported/base/MAIN.md")).toBe(
        "Base instructions.\n"
      );
      await runCliAsync(["skills", "remove", `${external}#HEAD`], fixture.runtime);
      await runCliAsync(command, fixture.runtime);
      expect(
        existsSync(path.join(fixture.registry, "skills/references/imported/base"))
      ).toBeFalsy();
      const ownEntry = path.join(fixture.installed.codex, "own/SKILL.md");
      expect(existsSync(ownEntry)).toBe(action !== "remove");
      const ownContent = existsSync(ownEntry) ? readFileSync(ownEntry, "utf-8") : "";
      expect(ownContent.includes("Self-contained instructions.")).toBe(action !== "remove");
    }
  );

  it.each([
    { explicit: false, readd: false, remote: false, removeConfig: false },
    { explicit: true, readd: false, remote: false, removeConfig: false },
    { explicit: false, readd: false, remote: false, removeConfig: true },
    { explicit: true, readd: false, remote: false, removeConfig: true },
    { explicit: false, readd: true, remote: false, removeConfig: false },
    { explicit: true, readd: true, remote: false, removeConfig: false },
    { explicit: false, readd: true, remote: false, removeConfig: true },
    { explicit: true, readd: true, remote: true, removeConfig: true }
  ])(
    "replaces inherited references with owned skills (explicit=$explicit removeConfig=$removeConfig readd=$readd remote=$remote)",
    async ({ explicit, readd, remote, removeConfig }) => {
      const fixture = registryFixture();
      installGitImporter(fixture);

      const upstream = createRepo(path.join(fixture.sandbox, "owned-transition-source"), {
        "skills/base/SKILL.md":
          "---\nname: base\ndescription: Base trigger.\n---\nImported base instructions.\n"
      });

      const publisher = createRepo(path.join(fixture.sandbox, "owned-transition-publisher"), {
        "monke.yml": stringify({
          skills: [
            {
              commit: git(upstream, ["rev-parse", "HEAD"]),
              skills: [{ kind: "reference", slug: "base" }],
              source: upstream
            }
          ]
        })
      });

      const source = remote ? "https://github.com/owner/owned-transition" : publisher;

      if (remote) {
        const gitConfig = path.join(fixture.sandbox, "git-config");
        write(fixture.sandbox, "git-config", `[url "${publisher}"]\n  insteadOf = ${source}.git\n`);
        fixture.runtime.env.GIT_CONFIG_GLOBAL = gitConfig;
        vi.stubEnv("GIT_CONFIG_GLOBAL", gitConfig);
        writeExecutable(
          path.join(fixture.bin, "npx"),
          `#!/bin/sh
set -eu
source="$4"
[ -d "$source" ] || source=upstream-validation
shift 4
mkdir -p .agents/skills
while [ "$1" = --skill ]; do
  if [ "$2" = '*' ]; then cp -R "$source/skills/"* .agents/skills/;
  else cp -R "$source/skills/$2" .agents/skills/; fi
  shift 2
done
`
        );
      }

      try {
        const add = ["skills", "add", `${source}#HEAD`, ...(explicit ? ["--skill", "base"] : [])];
        await runCliAsync(add, fixture.runtime);

        if (removeConfig) {
          rmSync(path.join(publisher, "monke.yml"));
        } else {
          write(publisher, "monke.yml", "skills: []\n");
        }

        writeSkill(path.join(publisher, "skills"), "base", "Owned base instructions.\n");
        git(publisher, ["add", "-A"]);
        git(publisher, ["commit", "-m", "Replace declared reference with own skill"]);
        await runCliAsync(readd ? add : ["skills", "update"], fixture.runtime);
        expect(
          existsSync(path.join(fixture.registry, "skills/references/imported/base"))
        ).toBeFalsy();
        expect(read(fixture.installed.codex, "base/SKILL.md")).toContain(
          "Owned base instructions."
        );
        expect(read(fixture.installed.codex, "base/SKILL.md")).toContain("name: base");
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );

  it.each([
    { action: "update", candidateName: "Fancy Author", initial: "skill", selector: "fancy-author" },
    { action: "readd", candidateName: "Fancy Author", initial: "skill", selector: "fancy-author" },
    {
      action: "update",
      candidateName: "Fancy Author",
      initial: "reference",
      selector: "fancy-author"
    },
    {
      action: "readd",
      candidateName: "Fancy Author",
      initial: "reference",
      selector: "fancy-author"
    },
    { action: "update", candidateName: "Fancy Author", initial: "own", selector: "fAnCy AuThOr" },
    { action: "readd", candidateName: "Fancy Author", initial: "own", selector: "fAnCy AuThOr" },
    { action: "update", candidateName: "Fancy+Author", initial: "skill", selector: "fancy-author" },
    { action: "readd", candidateName: "Fancy+Author", initial: "own", selector: "fAnCy AuThOr" }
  ] as const)(
    "retains $selector on $action when a publisher changes from $initial guidance to $candidateName",
    async ({ action, candidateName, initial, selector }) => {
      const { command, fixture, publisher } = await namedPublisherTransition({
        action,
        candidateName,
        initial,
        selector
      });

      await runCliAsync(command, fixture.runtime);
      const expected = initial === "own" ? "Declared author." : "Owned replacement.";
      expect(read(fixture.installed.codex, "fancy-author/SKILL.md")).toContain(expected);
      expect(JSON.parse(read(fixture.registry, "skills.lock.json"))).toMatchObject({
        recipes: [
          {
            commit: git(publisher, ["rev-parse", "HEAD"]),
            selection: [candidateName === "Fancy Author" ? selector : "fancy-author"],
            skills: [{ selector: candidateName, slug: "fancy-author" }]
          }
        ]
      });
      expect(
        existsSync(path.join(fixture.registry, "skills/references/imported/fancy-author"))
      ).toBeFalsy();
      rmSync(path.join(fixture.registry, "skills/imported/fancy-author"), { recursive: true });
      await runCliAsync(["skills", "update"], fixture.runtime);
      expect(read(fixture.installed.codex, "fancy-author/SKILL.md")).toContain(expected);
    }
  );

  it.each(["update", "readd"] as const)(
    "rejects a missing retained publisher identity on %s after a partial importer success",
    async (action) => {
      const { acceptedGuidance, acceptedRegistry, command, fixture } =
        await namedPublisherTransition({
          action,
          candidateName: "Unrelated",
          initial: "skill",
          selector: "fancy-author"
        });

      await expect(runCliAsync(command, fixture.runtime)).rejects.toThrow(/fancy-author/u);
      expect(read(fixture.registry, "skills.lock.json")).toBe(acceptedRegistry);
      expect(read(fixture.installed.codex, "fancy-author/SKILL.md")).toBe(acceptedGuidance);
      expect(existsSync(path.join(fixture.installed.codex, "unrelated"))).toBeFalsy();
    }
  );

  it.each([
    { declared: false, project: false },
    { declared: false, project: true },
    { declared: true, project: false },
    { declared: true, project: true }
  ])(
    "requires complete Git selections before publication with declared=$declared project=$project",
    async ({ declared, project }) => {
      const fixture = registryFixture();
      installNamedGitImporter(fixture);

      const consumer = createRepo(path.join(fixture.sandbox, "consumer"), {
        "README.md": "Consumer.\n"
      });

      const runtime = project
        ? createTestRuntime({
            cwd: consumer,
            env: fixture.runtime.env,
            onStderr() {},
            onStdout() {}
          })
        : fixture.runtime;

      const registry = project
        ? path.join(consumer, ".git/monke-tools/skill-registry")
        : fixture.registry;

      const installed = project
        ? path.join(consumer, ".agents/skills/monke-tools/imported")
        : fixture.installed.codex;

      const publisher = createRepo(path.join(fixture.sandbox, "publisher"), {
        "skills/author/SKILL.md":
          "---\nname: Fancy Author\ndescription: Author trigger.\n---\nOwn instructions.\n"
      });

      if (declared) {
        const upstream = createRepo(path.join(fixture.sandbox, "declared-source"), {
          "skills/course/SKILL.md":
            "---\nname: Course Import\ndescription: Course trigger.\n---\nDeclared instructions.\n"
        });

        write(
          publisher,
          "monke.yml",
          stringify({
            skills: [
              {
                commit: git(upstream, ["rev-parse", "HEAD"]),
                skills: [{ selector: "Course Import", slug: "course-import" }],
                source: upstream
              }
            ]
          })
        );
        git(publisher, ["add", "."]);
        git(publisher, ["commit", "-m", "Declare imported guidance"]);
      }

      const add = ["skills", "add", `${publisher}#HEAD`, ...(project ? ["--project"] : [])];
      const selection = ["FANCY AUTHOR", ...(declared ? ["COURSE-IMPORT"] : [])];
      const incomplete = [...add, "--skill", ...selection, "missing-course-skill"];
      await expect(runCliAsync(incomplete, runtime)).rejects.toThrow(
        /Selected skills not found.*missing-course-skill/u
      );
      expect(readImportRecipeStore(registry).recipes).toStrictEqual([]);
      expect(existsSync(path.join(installed, "fancy-author"))).toBeFalsy();
      expect(existsSync(path.join(installed, "course-import"))).toBeFalsy();

      await runCliAsync([...add, "--skill", ...selection], runtime);

      const guidance = [
        { body: "Own instructions.", slug: "fancy-author" },
        ...(declared ? [{ body: "Declared instructions.", slug: "course-import" }] : [])
      ];

      for (const { body, slug } of guidance) {
        expect(read(installed, `${slug}/SKILL.md`)).toContain(body);
      }

      if (declared) {
        await runCliAsync([...add, "--skill", "Fancy Author", "Course Import"], runtime);
      }

      const acceptedRegistry = read(registry, "skills.lock.json");
      const acceptedMarker = read(registry, "skills/.monke-restored.json");
      const acceptedGuidance = guidance.map(({ slug }) => read(installed, `${slug}/SKILL.md`));
      await expect(runCliAsync(incomplete, runtime)).rejects.toThrow(
        /Selected skills not found.*missing-course-skill/u
      );
      expect(read(registry, "skills.lock.json")).toBe(acceptedRegistry);
      expect(read(registry, "skills/.monke-restored.json")).toBe(acceptedMarker);
      expect(guidance.map(({ slug }) => read(installed, `${slug}/SKILL.md`))).toStrictEqual(
        acceptedGuidance
      );
      await expect(
        runCliAsync([...add, "--skill", ...selection, "fancy-author"], runtime)
      ).rejects.toThrow(/Selected skills not found.*fancy-author/u);
      expect(read(registry, "skills.lock.json")).toBe(acceptedRegistry);
      expect(read(registry, "skills/.monke-restored.json")).toBe(acceptedMarker);
      expect(existsSync(path.join(installed, "missing-course-skill"))).toBeFalsy();
    }
  );

  it.each([
    { nested: false, project: false },
    { nested: true, project: true }
  ])(
    "rejects declaration collisions for explicit internal guidance with nested=$nested project=$project",
    async ({ nested, project }) => {
      const fixture = registryFixture();
      installInternalRootImporter(fixture.bin);
      fixture.runtime.env.INSTALL_INTERNAL_SKILLS = "";

      const consumer = createRepo(path.join(fixture.sandbox, "consumer"), {
        "README.md": "Consumer.\n"
      });

      const runtime = project
        ? createTestRuntime({
            cwd: consumer,
            env: fixture.runtime.env,
            onStderr() {},
            onStdout() {}
          })
        : fixture.runtime;

      const registry = project
        ? path.join(consumer, ".git/monke-tools/skill-registry")
        : fixture.registry;

      const installed = project
        ? path.join(consumer, ".agents/skills/monke-tools/imported")
        : fixture.installed.codex;

      const upstream = createRepo(path.join(fixture.sandbox, "declared-internal"), {
        "skills/internal/SKILL.md":
          "---\nname: internal\ndescription: Declared skill.\n---\nDeclared guidance.\n"
      });

      const declaration = stringify({
        skills: [
          { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["internal"], source: upstream }
        ]
      });

      const ownPath = nested ? "skills/internal/SKILL.md" : "SKILL.md";

      const publisher = createRepo(path.join(fixture.sandbox, "internal-publisher"), {
        "monke.yml": declaration,
        [ownPath]:
          "---\nname: internal\ndescription: Internal skill.\nmetadata:\n  internal: true\n---\nOwned guidance.\n",
        "skills/public/SKILL.md":
          "---\nname: public\ndescription: Public skill.\n---\nPublic guidance.\n"
      });

      const add = ["skills", "add", `${publisher}#HEAD`, ...(project ? ["--project"] : [])];
      const explicit = [...add, "--skill", "internal"];
      await expect(runCliAsync(explicit, runtime)).rejects.toThrow(/internal.*collides/u);
      expect(readImportRecipeStore(registry).recipes).toStrictEqual([]);
      expect(existsSync(path.join(installed, "internal"))).toBeFalsy();
      await runCliAsync(add, runtime);
      expect(read(installed, "internal/SKILL.md")).toContain("Declared guidance.");
      await runCliAsync(
        ["skills", "remove", `${publisher}#HEAD`, ...(project ? ["--project"] : [])],
        runtime
      );
      rmSync(path.join(publisher, "monke.yml"));
      git(publisher, ["add", "-A"]);
      git(publisher, ["commit", "-m", "Remove declaration"]);
      await runCliAsync(explicit, runtime);
      const accepted = read(registry, "skills.lock.json");
      const marker = read(registry, "skills/.monke-restored.json");
      const guidance = read(installed, "internal/SKILL.md");
      write(publisher, "monke.yml", declaration);
      git(publisher, ["add", "."]);
      git(publisher, ["commit", "-m", "Declare colliding skill"]);

      for (const command of [
        explicit,
        add,
        ["skills", "update", ...(project ? ["--project"] : [])]
      ]) {
        await expect(runCliAsync(command, runtime)).rejects.toThrow(/internal.*collides/u);
        expect(read(registry, "skills.lock.json")).toBe(accepted);
        expect(read(registry, "skills/.monke-restored.json")).toBe(marker);
        expect(read(installed, "internal/SKILL.md")).toBe(guidance);
      }

      rmSync(path.join(publisher, ownPath));
      git(publisher, ["add", "-A"]);
      git(publisher, ["commit", "-m", "Retire own guidance"]);
      await runCliAsync(["skills", "update", ...(project ? ["--project"] : [])], runtime);
      expect(read(installed, "internal/SKILL.md")).toContain("Declared guidance.");
    }
  );

  it.each([
    { composed: false, project: false },
    { composed: true, project: true }
  ])(
    "keeps retained raw selectors across update and re-add with composed=$composed project=$project",
    async ({ composed, project }) => {
      const fixture = registryFixture();
      installInternalRootImporter(fixture.bin);
      fixture.runtime.env.INSTALL_INTERNAL_SKILLS = "";

      const consumer = createRepo(path.join(fixture.sandbox, "retained-consumer"), {
        "README.md": "Consumer.\n"
      });

      const runtime = project
        ? createTestRuntime({
            cwd: consumer,
            env: fixture.runtime.env,
            onStderr() {},
            onStdout() {}
          })
        : fixture.runtime;

      const registry = project
        ? path.join(consumer, ".git/monke-tools/skill-registry")
        : fixture.registry;

      const upstream = createRepo(path.join(fixture.sandbox, "retained-course"), {
        "skills/course/SKILL.md":
          "---\nname: course\ndescription: Course.\n---\nDeclared guidance.\n"
      });

      const publisher = createRepo(path.join(fixture.sandbox, "retained-publisher"), {
        "SKILL.md":
          "---\nname: Internal Guide\ndescription: Root.\nmetadata:\n  internal: true\n---\nAccepted internal root.\n",
        "skills/public/SKILL.md":
          "---\nname: Internal-Guide\ndescription: Child.\n---\nOther public child.\n",
        ...(composed
          ? {
              "monke.yml": stringify({
                skills: [
                  {
                    commit: git(upstream, ["rev-parse", "HEAD"]),
                    skills: ["course"],
                    source: upstream
                  }
                ]
              })
            }
          : {})
      });

      const flags = project ? ["--project"] : [];
      const add = ["skills", "add", `${publisher}#HEAD`, ...flags];
      const selectors = composed ? ["Internal Guide", "course"] : ["Internal Guide"];
      await runCliAsync([...add, "--skill", ...selectors], runtime);
      const accepted = read(registry, "skills/imported/internal-guide/SKILL.md");

      for (const command of [["skills", "update", ...flags], add, ["skills", "update", ...flags]]) {
        await runCliAsync(command, runtime);
        expect(readImportRecipeStore(registry).recipes[0]?.selection).toStrictEqual(selectors);
        expect(read(registry, "skills/imported/internal-guide/SKILL.md")).toBe(accepted);
      }

      rmSync(path.join(registry, "skills/imported"), { recursive: true });
      rmSync(path.join(registry, "skills/.monke-restored.json"));
      await runCliAsync(["skills", "update", ...flags], runtime);
      expect(readImportRecipeStore(registry).recipes[0]?.selection).toStrictEqual(selectors);
      expect(read(registry, "skills/imported/internal-guide/SKILL.md")).toBe(accepted);
      expect(existsSync(path.join(registry, "skills/imported/course"))).toBe(composed);
    }
  );

  it.each([
    { project: false, version: 3 },
    { project: true, version: 4 }
  ])(
    "recovers cold internal guidance from implicit machine v$version selections with project=$project",
    async ({ project, version }) => {
      const fixture = registryFixture();
      installInternalRootImporter(fixture.bin);
      fixture.runtime.env.INSTALL_INTERNAL_SKILLS = "";

      const consumer = createRepo(path.join(fixture.sandbox, "implicit-consumer"), {
        "README.md": "Consumer.\n"
      });

      const runtime = project
        ? createTestRuntime({
            cwd: consumer,
            env: fixture.runtime.env,
            onStderr() {},
            onStdout() {}
          })
        : fixture.runtime;

      const registry = project
        ? path.join(consumer, ".git/monke-tools/skill-registry")
        : fixture.registry;

      const installed = project
        ? path.join(consumer, ".agents/skills/monke-tools/imported")
        : fixture.installed.codex;

      const rootSkill = (body: string) =>
        `---\nname: Guide\ndescription: Root.\nmetadata:\n  internal: true\n---\n${body}\n`;

      const publisher = createRepo(path.join(fixture.sandbox, "implicit-publisher"), {
        "SKILL.md": rootSkill("Accepted internal root."),
        "skills/public/SKILL.md": "---\nname: Guide\ndescription: Child.\n---\nPublic child.\n"
      });

      const source = `${publisher}#HEAD`;
      const flags = project ? ["--project"] : [];
      await runCliAsync(["skills", "add", source, ...flags, "--skill", "Guide"], runtime);
      await runCliAsync(
        [
          "skills",
          "policy",
          source,
          "guide",
          ...flags,
          "--description",
          "Consumer trigger.",
          "--model-invocation",
          "deny"
        ],
        runtime
      );
      const accepted = read(installed, "guide/SKILL.md");
      const [recorded] = readImportRecipeStore(registry).recipes;

      if (!recorded) {
        throw new Error("Missing accepted machine recipe");
      }

      const { commit, selection: _selection, ...implicit } = recorded;

      if (version === 3) {
        write(
          registry,
          "skills.lock.json",
          JSON.stringify({
            recipes: [
              {
                ...implicit,
                lock: {
                  commit,
                  digest: guidanceDigest(registry, recorded.skills),
                  importerVersion: "1.7.0",
                  materializerVersion: 1,
                  repository: publisher,
                  subpath: "",
                  updateRef: "HEAD"
                }
              }
            ],
            version
          })
        );
      } else {
        writeImportRecipeStore(registry, { recipes: [{ ...implicit, commit }], version: 4 });
      }

      rmSync(path.join(registry, "skills/imported"), { recursive: true });
      rmSync(path.join(registry, "skills/.monke-restored.json"));
      await runCliAsync(["skills", "update", ...flags], runtime);
      expect(read(installed, "guide/SKILL.md")).toBe(accepted);
      expect(readImportRecipeStore(registry).recipes[0]).toMatchObject({
        commit,
        skills: [
          { description: "Consumer trigger.", disableModelInvocation: true, selector: "Guide" }
        ]
      });

      write(publisher, "SKILL.md", rootSkill("Updated internal root."));
      git(publisher, ["add", "."]);
      git(publisher, ["commit", "-m", "Advance the explicitly accepted internal root"]);
      await runCliAsync(["skills", "update", ...flags], runtime);
      expect(read(installed, "guide/SKILL.md")).toBe(
        accepted.replace("Accepted internal root.", "Updated internal root.")
      );
      expect(readImportRecipeStore(registry).recipes[0]?.commit).toBe(
        git(publisher, ["rev-parse", "HEAD"])
      );
    }
  );

  it("preserves internal guidance during machine explicit replay when a public child has the same name", async () => {
    const fixture = registryFixture();
    installInternalRootImporter(fixture.bin);
    fixture.runtime.env.INSTALL_INTERNAL_SKILLS = "";

    const upstream = createRepo(path.join(fixture.sandbox, "declared-source"), {
      "skills/course/SKILL.md": "---\nname: course\ndescription: Course.\n---\nDeclared.\n",
      "skills/internal/SKILL.md":
        "---\nname: internal\ndescription: External.\n---\nConflicting external.\n"
    });

    const publisher = createRepo(path.join(fixture.sandbox, "equal-names"), {
      "monke.yml": stringify({
        skills: [
          { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["course"], source: upstream }
        ]
      }),
      "SKILL.md":
        "---\nname: internal\ndescription: Root.\nmetadata:\n  internal: true\n---\nInternal root.\n",
      "skills/public/SKILL.md": "---\nname: internal\ndescription: Child.\n---\nPublic child.\n"
    });

    await runCliAsync(
      ["skills", "add", `${publisher}#HEAD`, "--skill", "internal"],
      fixture.runtime
    );
    const accepted = read(fixture.registry, "skills/imported/internal/SKILL.md");
    const lock = read(fixture.registry, "skills.lock.json");
    rmSync(path.join(fixture.registry, "skills/imported"), { recursive: true });
    rmSync(path.join(fixture.registry, "skills/.monke-restored.json"));
    write(
      publisher,
      "monke.yml",
      stringify({
        skills: [
          { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["internal"], source: upstream }
        ]
      })
    );
    git(publisher, ["add", "."]);
    git(publisher, ["commit", "-m", "Declare conflicting external"]);
    await expect(runCliAsync(["skills", "update"], fixture.runtime)).rejects.toThrow(
      /internal.*collides/u
    );
    expect(read(fixture.registry, "skills.lock.json")).toBe(lock);
    expect(read(fixture.registry, "skills/imported/internal/SKILL.md")).toBe(accepted);
  });

  it("rejects ambiguous discovery identities during machine wildcard acceptance", async () => {
    const fixture = registryFixture();
    installInternalRootImporter(fixture.bin);
    fixture.runtime.env.INSTALL_INTERNAL_SKILLS = "";

    const publisher = createRepo(path.join(fixture.sandbox, "ambiguous-wildcard"), {
      "skills/public/SKILL.md": "---\nname: internal\ndescription: Child.\n---\nAccepted child.\n"
    });

    const add = ["skills", "add", `${publisher}#HEAD`];
    await runCliAsync(add, fixture.runtime);
    const accepted = read(fixture.registry, "skills/imported/internal/SKILL.md");
    const lock = read(fixture.registry, "skills.lock.json");
    write(
      publisher,
      "SKILL.md",
      "---\nname: internal\ndescription: Root.\nmetadata:\n  internal: true\n---\nDifferent root.\n"
    );
    git(publisher, ["add", "."]);
    git(publisher, ["commit", "-m", "Introduce ambiguous root"]);

    for (const command of [add, ["skills", "update"]]) {
      await expect(runCliAsync(command, fixture.runtime)).rejects.toThrow(
        "Ambiguous Skill selector internal"
      );
      expect(read(fixture.registry, "skills.lock.json")).toBe(lock);
      expect(read(fixture.registry, "skills/imported/internal/SKILL.md")).toBe(accepted);
    }
  });

  it.each([false, true])(
    "recovers cold guidance from composed wildcard selections with project=%s",
    async (project) => {
      const fixture = registryFixture();
      installInternalRootImporter(fixture.bin);
      fixture.runtime.env.INSTALL_INTERNAL_SKILLS = "";

      const consumer = createRepo(path.join(fixture.sandbox, "consumer"), {
        "README.md": "Consumer.\n"
      });

      const runtime = project
        ? createTestRuntime({
            cwd: consumer,
            env: fixture.runtime.env,
            onStderr() {},
            onStdout() {}
          })
        : fixture.runtime;

      const registry = project
        ? path.join(consumer, ".git/monke-tools/skill-registry")
        : fixture.registry;

      const upstream = createRepo(path.join(fixture.sandbox, "declared-source"), {
        "skills/course/SKILL.md":
          "---\nname: course\ndescription: Declared course.\n---\nDeclared guidance.\n"
      });

      const publisher = createRepo(path.join(fixture.sandbox, "cold-publisher"), {
        "monke.yml": stringify({
          skills: [
            { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["course"], source: upstream }
          ]
        }),
        "SKILL.md":
          "---\nname: internal\ndescription: Internal skill.\nmetadata:\n  internal: true\n---\nInternal.\n",
        "skills/public/references/details.md": "Pinned support asset.\n",
        "skills/public/SKILL.md":
          "---\nname: public\ndescription: Public skill.\n---\nPublic guidance.\n"
      });

      const flags = project ? ["--project"] : [];
      await runCliAsync(["skills", "add", `${publisher}#HEAD`, ...flags], runtime);
      const accepted = read(registry, "skills.lock.json");
      const guidance = read(registry, "skills/imported/public/SKILL.md");
      rmSync(path.join(registry, "skills/imported"), { recursive: true });
      rmSync(path.join(registry, "skills/.monke-restored.json"));
      await runCliAsync(["skills", "update", ...flags], runtime);
      expect(read(registry, "skills.lock.json")).toBe(accepted);
      expect(read(registry, "skills/imported/public/SKILL.md")).toBe(guidance);
      expect(read(registry, "skills/imported/public/references/details.md")).toBe(
        "Pinned support asset.\n"
      );
      expect(read(registry, "skills/imported/course/SKILL.md")).toContain("Declared guidance.");
      expect(existsSync(path.join(registry, "skills/imported/internal"))).toBeFalsy();
    }
  );

  it.each(["git", "link"] as const)(
    "spans own skills and declared imports in %s publisher selections",
    async (kind) => {
      const fixture = registryFixture();
      installGitImporter(fixture);

      const upstream = createRepo(path.join(fixture.sandbox, "declared-source"), {
        "README.md": "Declared source.\n"
      });

      writeSkill(path.join(upstream, "skills"), "selected-import", "Selected import.\n");
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Upstream skill"]);

      const publisher = createRepo(path.join(fixture.sandbox, "publisher"), {
        "README.md": "Publisher.\n"
      });

      writeSkill(path.join(publisher, "skills"), "own-skill", "Publisher instructions.\n");
      write(
        publisher,
        "monke.yml",
        stringify({
          skills: [
            {
              commit: git(upstream, ["rev-parse", "HEAD"]),
              skills: ["selected-import"],
              source: upstream
            }
          ]
        })
      );
      git(publisher, ["add", "."]);
      git(publisher, ["commit", "-m", "Publish accepted imports"]);
      await runCliAsync(
        [
          "skills",
          "add",
          kind === "git" ? `${publisher}#HEAD` : publisher,
          ...(kind === "link" ? ["--link"] : []),
          "--skill",
          "selected-import"
        ],
        fixture.runtime
      );
      expect(read(fixture.installed.codex, "selected-import/SKILL.md")).toContain(
        "Selected import."
      );
      expect(existsSync(path.join(fixture.installed.codex, "own-skill"))).toBeFalsy();
      expect(existsSync(path.join(publisher, "skills/imported/selected-import/SKILL.md"))).toBe(
        kind === "link"
      );

      const ignored =
        kind === "link"
          ? git(publisher, ["check-ignore", "skills/imported/selected-import/SKILL.md"])
          : "";

      expect(ignored).toBe(kind === "link" ? "skills/imported/selected-import/SKILL.md" : "");
    }
  );

  it("fails on a declared import collision without publishing a recipe or agent skill", async () => {
    const fixture = registryFixture();
    installGitImporter(fixture);

    const upstream = createRepo(path.join(fixture.sandbox, "declared-source"), {
      "README.md": "Source.\n"
    });

    writeSkill(path.join(upstream, "skills"), "collision", "Imported instructions.\n");
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Upstream skill"]);

    const publisher = createRepo(path.join(fixture.sandbox, "publisher"), {
      "README.md": "Publisher.\n"
    });

    writeSkill(path.join(publisher, "skills"), "collision", "Owned instructions.\n");
    write(
      publisher,
      "monke.yml",
      stringify({
        skills: [
          { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["collision"], source: upstream }
        ]
      })
    );
    git(publisher, ["add", "."]);
    git(publisher, ["commit", "-m", "Conflicting collection"]);
    await expect(
      runCliAsync(["skills", "add", `${publisher}#HEAD`, "--skill", "collision"], fixture.runtime)
    ).rejects.toThrow(/collision.*collides/u);
    expect(readImportRecipeStore(fixture.registry).recipes).toStrictEqual([]);
    expect(existsSync(path.join(fixture.installed.codex, "collision"))).toBeFalsy();
  });

  it("lets a publisher publish only declared imports without resolving another level", async () => {
    const fixture = registryFixture();
    installGitImporter(fixture);

    const upstream = createRepo(path.join(fixture.sandbox, "declared-source"), {
      "monke.yml": "skills:\n  - source: owner/unavailable\n    skills: [unwanted-nested]\n",
      "README.md": "Source.\n"
    });

    writeSkill(path.join(upstream, "skills"), "selected-import", "One level only.\n");
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Upstream skill"]);

    const publisher = createRepo(path.join(fixture.sandbox, "publisher"), {
      "monke.yml": stringify({
        skills: [
          {
            commit: git(upstream, ["rev-parse", "HEAD"]),
            skills: ["selected-import"],
            source: upstream
          }
        ]
      })
    });

    await runCliAsync(["skills", "add", `${publisher}#HEAD`], fixture.runtime);
    expect(read(fixture.installed.codex, "selected-import/SKILL.md")).toContain("One level only.");
    expect(existsSync(path.join(fixture.installed.codex, "unwanted-nested"))).toBeFalsy();
  });

  it.each([
    { selection: "implicit", version: 3 },
    { selection: "implicit", version: 4 },
    { selection: "wildcard", version: 4 },
    { selection: "explicit", version: 4 }
  ] as const)(
    "preserves $selection selections from v$version recipes on re-add",
    async ({ selection, version }) => {
      const fixture = registryFixture();
      installGitImporter(fixture);

      const upstream = createRepo(path.join(fixture.sandbox, "legacy-subset"), {
        "skills/other/SKILL.md":
          "---\nname: other\ndescription: Other trigger.\n---\nOther first revision.\n",
        "skills/selected/SKILL.md":
          "---\nname: selected\ndescription: Original trigger.\n---\nSelected first revision.\n"
      });

      const source = `${upstream}#HEAD`;
      await runCliAsync(["skills", "add", source, "--skill", "selected"], fixture.runtime);
      const commit = git(upstream, ["rev-parse", "HEAD"]);
      write(
        fixture.registry,
        "skills.lock.json",
        JSON.stringify({
          recipes: [
            {
              ...(version === 3
                ? { lock: { commit, repository: upstream, subpath: "", updateRef: "HEAD" } }
                : { commit }),
              ...(selection === "wildcard" ? { selection: ["*"] } : {}),
              skills: [
                {
                  description: "Accepted trigger.",
                  ...(version === 3
                    ? { disableModelInvocation: true, kind: "skill", selector: "selected" }
                    : { modelInvocation: "deny" }),
                  slug: "selected"
                }
              ],
              source
            }
          ],
          version
        })
      );
      await runCliAsync(["skills", "list"], fixture.runtime);
      await runCliAsync(
        [
          "skills",
          "add",
          source,
          ...(selection === "explicit" ? ["--replace", "--skill", "other"] : [])
        ],
        fixture.runtime
      );
      const selected = selection !== "explicit";
      const other = selection !== "implicit";

      const expectedSelection = { explicit: "other", implicit: "selected", wildcard: "*" }[
        selection
      ];

      expect(existsSync(path.join(fixture.installed.codex, "selected/SKILL.md"))).toBe(selected);
      expect(existsSync(path.join(fixture.installed.codex, "other/SKILL.md"))).toBe(other);
      expect(JSON.parse(read(fixture.registry, "skills.lock.json"))).toMatchObject({
        recipes: [{ selection: [expectedSelection] }]
      });
      writeSkill(path.join(upstream, "skills"), "selected", "Selected second revision.\n");
      writeSkill(path.join(upstream, "skills"), "other", "Other second revision.\n");
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Advance both skills"]);
      await runCliAsync(["skills", "update"], fixture.runtime);
      expect(existsSync(path.join(fixture.installed.codex, "selected/SKILL.md"))).toBe(selected);
      expect(existsSync(path.join(fixture.installed.codex, "other/SKILL.md"))).toBe(other);
      const selectedContent = selected ? read(fixture.installed.codex, "selected/SKILL.md") : "";
      const otherContent = other ? read(fixture.installed.codex, "other/SKILL.md") : "";
      expect(selectedContent.includes("Selected second revision.")).toBe(selected);
      expect(selectedContent.includes("description: Accepted trigger.")).toBe(selected);
      expect(selectedContent.includes("disable-model-invocation: true")).toBe(selected);
      expect(otherContent.includes("Other second revision.")).toBe(other);
    }
  );

  it("migrates the pins and overrides of old machine registries on first read", async () => {
    const fixture = registryFixture();
    write(
      fixture.registry,
      "skills.lock.json",
      JSON.stringify({
        recipes: [
          {
            disableModelInvocation: true,
            lock: {
              commit: "a".repeat(40),
              digest: "b".repeat(64),
              importerVersion: "1.7.0",
              materializerVersion: 1,
              repository: "https://github.com/owner/legacy.git",
              subpath: "course",
              updateRef: "feature/topic"
            },
            name: "legacy",
            skills: [
              {
                description: "Legacy trigger.",
                disableModelInvocation: false,
                kind: "skill",
                selector: "upstream-legacy",
                slug: "legacy"
              }
            ],
            source: "https://github.com/owner/legacy/tree/feature/topic/course"
          }
        ],
        version: 3
      })
    );
    await runCliAsync(["skills", "list"], fixture.runtime);
    const registry = read(fixture.registry, "skills.lock.json");
    expect(registry).toContain('"version": 4');
    expect(registry).toContain('"source": "https://github.com/owner/legacy/course#feature/topic"');
    expect(registry).toContain(`"commit": "${"a".repeat(40)}"`);
    expect(registry).toContain('"modelInvocation": "deny"');
    expect(registry).toContain('"modelInvocation": "allow"');
    expect(registry).toContain("Legacy trigger.");
    expect(registry).not.toContain('"lock"');
    expect(registry).not.toContain("importerVersion");
  });

  it("preserves a migrated bundled source and its accepted guidance during installation", async () => {
    const fixture = registryFixture();
    const source = "https://github.com/owner/bundled/tree/main/course";

    const accepted =
      "---\nname: bundled\ndescription: Consumer trigger.\n---\nAccepted instructions.\n";

    write(fixture.registry, "skills/imported/bundled/SKILL.md", accepted);
    write(fixture.guidance, "skills/imported/bundled/SKILL.md", "New bundled instructions.\n");
    write(
      fixture.guidance,
      "monke.yml",
      stringify({ skills: [{ commit: "b".repeat(40), skills: ["bundled"], source }] })
    );
    write(
      fixture.registry,
      "skills.lock.json",
      JSON.stringify({
        recipes: [
          {
            lock: {
              commit: "a".repeat(40),
              repository: "https://github.com/owner/bundled.git",
              subpath: "course",
              updateRef: "main"
            },
            skills: [
              {
                description: "Consumer trigger.",
                kind: "skill",
                selector: "bundled",
                slug: "bundled"
              }
            ],
            source
          }
        ],
        version: 3
      })
    );
    await runInstallSkillsLocked(fixture.runtime, fixture.guidance);
    expect(read(fixture.installed.codex, "bundled/SKILL.md")).toBe(accepted);
    const migrated: unknown = JSON.parse(read(fixture.registry, "skills.lock.json"));
    expect(migrated).toStrictEqual({
      recipes: [
        {
          commit: "a".repeat(40),
          skills: [{ description: "Consumer trigger.", slug: "bundled" }],
          source
        }
      ],
      version: 4
    });
  });

  it.each([
    { added: false, scope: "machine" },
    { added: true, scope: "machine" },
    { added: false, scope: "repo" },
    { added: true, scope: "repo" }
  ])(
    "preserves identity and selection when re-adding a handwritten tree source in $scope scope with added=$added",
    async ({ added, scope }) => {
      const fixture = registryFixture();

      const upstream = createRepo(path.join(fixture.sandbox, "handwritten-tree-source"), {
        "course/skills/color/SKILL.md":
          "---\nname: color\ndescription: Color.\n---\nColor instructions.\n",
        "course/skills/typography/SKILL.md":
          "---\nname: typography\ndescription: Typography.\n---\nCourse instructions.\n"
      });

      git(upstream, ["branch", "feature/topic"]);

      const repo = createRepo(path.join(fixture.sandbox, "tree-consumer"), {
        "README.md": "Consumer.\n"
      });

      const runtime =
        scope === "repo"
          ? createTestRuntime({ cwd: repo, env: fixture.runtime.env, onStderr() {}, onStdout() {} })
          : fixture.runtime;

      const flags = scope === "repo" ? ["--repo"] : [];
      const gitConfig = path.join(fixture.sandbox, "git-config");
      write(
        fixture.sandbox,
        "git-config",
        `[url "${upstream}"]\n  insteadOf = https://github.com/owner/repeated.git\n`
      );
      runtime.env.GIT_CONFIG_GLOBAL = gitConfig;
      writeExecutable(
        path.join(fixture.bin, "npx"),
        `#!/bin/sh
set -eu
shift 4
mkdir -p .agents/skills
while [ "$1" = --skill ]; do
  if [ "$2" = '*' ]; then cp -R ${shellQuote(path.join(upstream, "course/skills"))}/* .agents/skills/;
  else cp -R ${shellQuote(path.join(upstream, "course/skills"))}/"$2" .agents/skills/; fi
  shift 2
done
`
      );
      const source = "https://github.com/owner/repeated/tree/feature/topic/course";
      const canonical = "https://github.com/owner/repeated/course#feature/topic";
      const root = scope === "repo" ? repo : fixture.registry;
      vi.stubEnv("GIT_CONFIG_GLOBAL", gitConfig);

      try {
        await runCliAsync(["skills", "add", source, ...flags, "--skill", "typography"], runtime);

        const recipe = {
          commit: git(upstream, ["rev-parse", "HEAD"]),
          modelInvocation: "deny",
          ...(scope === "machine" ? { name: "course", selection: ["typography"] } : {}),
          skills: [
            { description: "Consumer trigger.", modelInvocation: "allow", slug: "typography" }
          ],
          source
        };

        write(
          root,
          scope === "repo" ? "monke.yml" : "skills.lock.json",
          scope === "repo"
            ? stringify({ skills: [recipe] })
            : JSON.stringify({ recipes: [recipe], version: 4 })
        );
        await runCliAsync(
          ["skills", "add", source, ...flags, ...(added ? ["--skill", "color"] : [])],
          runtime
        );

        const accepted: unknown =
          scope === "repo"
            ? parse(read(root, "monke.yml"))
            : JSON.parse(read(root, "skills.lock.json"));

        const expected = {
          ...recipe,
          ...(scope === "machine"
            ? { selection: added ? ["typography", "color"] : ["typography"] }
            : {}),
          skills: added ? ["color", ...recipe.skills] : recipe.skills,
          source: canonical
        };

        expect(accepted).toStrictEqual(
          scope === "repo" ? { skills: [expected] } : { recipes: [expected], version: 4 }
        );

        const installed =
          scope === "repo" ? path.join(repo, "skills/imported") : fixture.installed.codex;

        expect(read(installed, "typography/SKILL.md")).toContain("disable-model-invocation: false");
        expect(existsSync(path.join(installed, "color"))).toBe(added);
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );

  it.each([
    { linkedEdit: false, scope: "global" },
    { linkedEdit: true, scope: "global" },
    { linkedEdit: false, scope: "project" },
    { linkedEdit: true, scope: "project" }
  ])(
    "refreshes the $scope review baseline on canonical re-add with linkedEdit=$linkedEdit",
    async ({ linkedEdit, scope }) => {
      const fixture = registryFixture();

      const upstream = createRepo(path.join(fixture.sandbox, "baseline-tree-source"), {
        "course/skills/color/SKILL.md":
          "---\nname: color\ndescription: Color.\n---\nColor instructions.\n",
        "course/skills/typography/SKILL.md":
          "---\nname: typography\ndescription: Typography.\n---\nCourse instructions.\n"
      });

      git(upstream, ["branch", "feature/topic"]);

      const consumer = createRepo(path.join(fixture.sandbox, "baseline-consumer"), {
        "README.md": "Consumer.\n"
      });

      let stdout = "";

      const runtime = createTestRuntime({
        cwd: consumer,
        env: fixture.runtime.env,
        onStderr() {},
        onStdout(message) {
          stdout += message;
        }
      });

      const flags = scope === "project" ? ["--project"] : [];

      const root =
        scope === "project"
          ? path.join(consumer, ".git/monke-tools/skill-registry")
          : fixture.registry;

      const installed =
        scope === "project"
          ? path.join(consumer, ".agents/skills/monke-tools/imported")
          : fixture.installed.codex;

      const linked = path.join(fixture.sandbox, "unrelated-linked-source");
      writeSkill(linked, "notes", "Accepted notes.\n");
      writeExecutable(
        path.join(fixture.bin, "npx"),
        `#!/bin/sh
set -eu
shift 4
mkdir -p .agents/skills
while [ "$1" = --skill ]; do
  if [ "$2" = '*' ]; then cp -R ${shellQuote(path.join(upstream, "course/skills"))}/* .agents/skills/;
  else cp -R ${shellQuote(path.join(upstream, "course/skills"))}/"$2" .agents/skills/; fi
  shift 2
done
`
      );
      const gitConfig = path.join(fixture.sandbox, "git-config");
      write(
        fixture.sandbox,
        "git-config",
        `[url "${upstream}"]\n  insteadOf = https://github.com/owner/repeated.git\n`
      );
      runtime.env.GIT_CONFIG_GLOBAL = gitConfig;
      const source = "https://github.com/owner/repeated/tree/feature/topic/course";
      const canonical = "https://github.com/owner/repeated/course#feature/topic";
      vi.stubEnv("GIT_CONFIG_GLOBAL", gitConfig);

      try {
        await runCliAsync(["skills", "add", linked, "--link", ...flags], runtime);
        await runCliAsync(["skills", "add", source, ...flags, "--skill", "typography"], runtime);
        write(
          root,
          "skills.lock.json",
          read(root, "skills.lock.json").replace(
            `"source": "${canonical}"`,
            `"source": "${source}"`
          )
        );

        if (linkedEdit) {
          writeSkill(linked, "notes", "Unreviewed notes.\n");
        }

        await runCliAsync(
          ["skills", "add", source, ...flags, "--replace", "--skill", "color"],
          runtime
        );
        expect(existsSync(path.join(installed, "typography"))).toBeFalsy();
        expect(read(installed, "color/SKILL.md")).toContain("Color instructions.");

        const beforeUpdate = stdout.length;
        await runCliAsync(["skills", "update", ...flags], runtime);
        expect(stdout.slice(beforeUpdate).includes("No skill changes.")).toBe(!linkedEdit);
        expect(existsSync(fixture.codiffLog)).toBe(linkedEdit);

        const launch = existsSync(fixture.codiffLog)
          ? readFileSync(fixture.codiffLog, "utf-8").trim().split("\n")
          : [];

        const reviewRepo = launch[2] ?? "";
        const commit = launch[1] ?? "";
        const diff = reviewRepo ? git(reviewRepo, ["diff", `${commit}^`, commit]) : "";
        expect(diff).not.toContain("typography");
        expect(diff.includes("-Accepted notes.")).toBe(linkedEdit);
        expect(diff.includes("+Unreviewed notes.")).toBe(linkedEdit);

        const beforeRepeatedUpdate = stdout.length;
        await runCliAsync(["skills", "update", ...flags], runtime);
        expect(stdout.slice(beforeRepeatedUpdate)).toContain("No skill changes.");

        const repeatedLaunch = existsSync(fixture.codiffLog)
          ? readFileSync(fixture.codiffLog, "utf-8").trim().split("\n")
          : [];

        expect(repeatedLaunch).toStrictEqual(launch);
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );

  it.each([
    { kind: "link", scope: "global", source: "foo" },
    { kind: "link", scope: "global", source: "./foo" },
    { kind: "command", scope: "global", source: "foo" },
    { kind: "command", scope: "global", source: "./foo" },
    { kind: "link", scope: "project", source: "foo" },
    { kind: "link", scope: "project", source: "./foo" },
    { kind: "command", scope: "project", source: "foo" },
    { kind: "command", scope: "project", source: "./foo" }
  ])(
    "preserves an unrelated source's review baseline on $scope $kind add from $source",
    async ({ kind, scope, source }) => {
      const fixture = registryFixture();

      const consumer = createRepo(path.join(fixture.sandbox, "baseline-consumer"), {
        "README.md": "Consumer.\n"
      });

      const original = path.join(fixture.sandbox, "original-collection");
      writeSkill(original, "notes", "Accepted notes.\n");
      writeSkill(path.join(consumer, "foo"), "color", "New collection.\n");
      let stdout = "";

      const runtime = createTestRuntime({
        cwd: consumer,
        env: fixture.runtime.env,
        onStderr() {},
        onStdout(message) {
          stdout += message;
        }
      });

      const flags = scope === "project" ? ["--project"] : [];
      await runCliAsync(["skills", "add", original, "--link", "--name", "foo", ...flags], runtime);
      writeSkill(original, "notes", "Unreviewed notes.\n");
      await runCliAsync(
        [
          "skills",
          "add",
          source,
          "--name",
          "bar",
          ...(kind === "link" ? ["--link"] : ["--command", "true"]),
          ...flags
        ],
        runtime
      );

      const beforeUpdate = stdout.length;
      await runCliAsync(["skills", "update", ...flags], runtime);
      expect(stdout.slice(beforeUpdate)).not.toContain("No skill changes.");
      const launch = readFileSync(fixture.codiffLog, "utf-8").trim().split("\n");
      expect(launch).toHaveLength(3);
      const reviewRepo = launch[2] ?? "";
      const commit = launch[1] ?? "";
      const diff = git(reviewRepo, ["diff", `${commit}^`, commit]);
      expect(diff).toContain("-Accepted notes.");
      expect(diff).toContain("+Unreviewed notes.");
      expect(diff).not.toContain("skills/imported/color");

      const beforeRepeatedUpdate = stdout.length;
      await runCliAsync(["skills", "update", ...flags], runtime);
      expect(stdout.slice(beforeRepeatedUpdate)).toContain("No skill changes.");
      expect(readFileSync(fixture.codiffLog, "utf-8").trim().split("\n")).toStrictEqual(launch);
    }
  );

  it.each(["main", "feature/topic"])(
    "keeps the identity of a tree source at %s across registry changes",
    async (updateRef) => {
      const fixture = registryFixture();

      const upstream = createRepo(path.join(fixture.sandbox, "tree-source"), {
        "course/skills/typography/SKILL.md":
          "---\nname: typography\ndescription: Typography.\n---\nCourse instructions.\n"
      });

      if (updateRef !== "main") {
        git(upstream, ["branch", updateRef]);
      }

      const gitConfig = path.join(fixture.sandbox, "git-config");
      write(
        fixture.sandbox,
        "git-config",
        `[url "${upstream}"]\n  insteadOf = https://github.com/owner/repeated.git\n`
      );
      fixture.runtime.env.GIT_CONFIG_GLOBAL = gitConfig;
      writeExecutable(
        path.join(fixture.bin, "npx"),
        `#!/bin/sh
set -eu
mkdir -p .agents/skills
cp -R ${shellQuote(path.join(upstream, "course/skills/typography"))} .agents/skills/
`
      );
      const source = `https://github.com/owner/repeated/tree/${updateRef}/course`;

      const expectedSource = updateRef.includes("/")
        ? `https://github.com/owner/repeated/course#${updateRef}`
        : source;

      vi.stubEnv("GIT_CONFIG_GLOBAL", gitConfig);

      try {
        await runCliAsync(
          ["skills", "add", source, "--name", "course", "--skill", "typography"],
          fixture.runtime
        );
        await runCliAsync(
          ["skills", "policy", "course", "typography", "--description", "Consumer trigger."],
          fixture.runtime
        );
        await runCliAsync(["skills", "add", source, "--skill", "typography"], fixture.runtime);
        await runCliAsync(["skills", "update"], fixture.runtime);
        const registry = read(fixture.registry, "skills.lock.json");
        expect(registry.match(/"source":/gu)).toHaveLength(1);
        expect(registry).toContain(`"source": "${expectedSource}"`);
        expect(registry).toContain('"name": "course"');
        expect(read(fixture.installed.codex, "typography/SKILL.md")).toContain(
          "description: Consumer trigger."
        );
        write(fixture.guidance, "skills/imported/typography/SKILL.md", "Bundled instructions.\n");
        write(
          fixture.guidance,
          "monke.yml",
          stringify({
            skills: [
              {
                commit: git(upstream, ["rev-parse", "HEAD"]),
                skills: ["typography"],
                source: expectedSource
              }
            ]
          })
        );
        await runInstallSkillsLocked(fixture.runtime, fixture.guidance);
        expect(read(fixture.installed.codex, "typography/SKILL.md")).toContain(
          "description: Consumer trigger."
        );
        await runCliAsync(["skills", "remove", expectedSource], fixture.runtime);
        await runInstallSkillsLocked(fixture.runtime, fixture.guidance);
        expect(existsSync(path.join(fixture.installed.codex, "typography"))).toBeFalsy();
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );

  it.each(["git", "link", "command"] as const)(
    "keeps %s description overrides across updates while preserving other metadata",
    async (kind) => {
      const fixture = registryFixture();
      const installedDescription = "Cut AI tells from any writing.";

      const metadata =
        "interface:\n  display_name: Writing\npolicy:\n  allow_implicit_invocation: false\n";

      const commandSource = installer(fixture);

      const gitSource = createRepo(path.join(fixture.sandbox, "git-source"), {
        "README.md": "Git skills.\n"
      });

      const source =
        kind === "git"
          ? path.join(gitSource, "skills")
          : kind === "command"
            ? commandSource.upstream
            : fixture.source;

      write(
        source,
        "typography/SKILL.md",
        "---\nname: typography\ndescription: Cut AI tells. Must always apply.\ndisable-model-invocation: true\nlicense: MIT # Keep this comment\n---\n\nKeep these instructions.\n"
      );
      write(source, "typography/agents/openai.yaml", metadata);
      writeSkill(source, "color", "Color instructions.\n");

      if (kind === "git") {
        git(gitSource, ["add", "."]);
        git(gitSource, ["commit", "-m", "Writing skills"]);
        installGitImporter(fixture);
        await runCliAsync(
          ["skills", "add", `${gitSource}#HEAD`, "--name", "course"],
          fixture.runtime
        );
      } else {
        await runCliAsync(
          kind === "command"
            ? ["skills", "add", "--name", "course", "--command", commandSource.command]
            : ["skills", "add", fixture.checkout, "--name", "course", "--link"],
          fixture.runtime
        );
      }

      await runCliAsync(
        ["skills", "policy", "course", "typography", "--description", installedDescription],
        fixture.runtime
      );

      for (const root of Object.values(fixture.installed)) {
        const markdown = read(root, "typography/SKILL.md");
        expect(parse(markdown.split("---")[1] ?? "")).toMatchObject({
          description: installedDescription,
          "disable-model-invocation": true,
          license: "MIT",
          name: "typography"
        });
        expect(markdown).toContain("# Keep this comment");
        expect(markdown.split("---")[2]).toBe("\n\nKeep these instructions.\n");
        expect(read(root, "typography/agents/openai.yaml")).toBe(metadata);
        expect(read(root, "color/SKILL.md")).toContain("description: A course skill.");
      }

      write(
        source,
        "typography/SKILL.md",
        "---\nname: typography\nmetadata:\n  summary: &desc Original description.\ndescription: *desc\n---\nUpdated upstream instructions.\n"
      );

      if (kind === "git") {
        git(gitSource, ["add", "."]);
        git(gitSource, ["commit", "-m", "Update writing skill"]);
      }

      await runCliAsync(["skills", "update"], fixture.runtime);
      expect(readImportRecipeStore(fixture.registry).recipes[0]?.skills).toContainEqual({
        description: installedDescription,
        kind: "skill",
        selector: "typography",
        slug: "typography"
      });

      for (const root of Object.values(fixture.installed)) {
        expect(read(root, "typography/SKILL.md")).toContain("Updated upstream instructions.");
        expect(parse(read(root, "typography/SKILL.md").split("---")[1] ?? "")).toMatchObject({
          description: installedDescription
        });
      }

      const replacement = 'Use when: editing "prose".\nKeep the writer\'s voice.';
      await runCliAsync(
        [
          "skills",
          "policy",
          "course",
          "typography",
          "--description",
          replacement,
          "--model-invocation",
          "deny"
        ],
        fixture.runtime
      );
      expect(
        parse(read(fixture.installed.codex, "typography/SKILL.md").split("---")[1] ?? "")
      ).toMatchObject({
        description: replacement,
        "disable-model-invocation": true
      });

      const finalDescription =
        "Use when: revising prose, preserving the authors voice, clarifying sentences, and making technical documents easier to read.";

      await runCliAsync(
        ["skills", "policy", "course", "typography", "--description", finalDescription],
        fixture.runtime
      );

      if (kind === "git") {
        rmSync(path.join(fixture.registry, "skills/imported/typography"), { recursive: true });
        await restoreLockedImports(fixture.registry);
      }

      expect(
        parse(read(fixture.installed.codex, "typography/SKILL.md").split("---")[1] ?? "")
      ).toMatchObject({
        description: finalDescription,
        "disable-model-invocation": true,
        metadata: { summary: "Original description." }
      });
    }
  );

  it.each([
    { args: [], error: /Provide --model-invocation or --description/u },
    { args: ["--description", "Use for writing."], error: /requires a Skill slug/u },
    { args: ["typography", "--description", "  "], error: /non-empty/u },
    { args: ["unknown", "--description", "Use for writing."], error: /Unknown Skill/u }
  ])(
    "leaves the source and recipe unchanged on invalid description policy ($args)",
    async ({ args, error }) => {
      const fixture = registryFixture();
      await runCliAsync(["skills", "add", fixture.checkout, "--link"], fixture.runtime);
      const original = read(fixture.source, "typography/SKILL.md");
      const store = readImportRecipeStore(fixture.registry);
      await expect(
        runCliAsync(["skills", "policy", "private-course", ...args], fixture.runtime)
      ).rejects.toThrow(error);
      expect(read(fixture.source, "typography/SKILL.md")).toBe(original);
      expect(readImportRecipeStore(fixture.registry)).toStrictEqual(store);
    }
  );

  it.each(["create", "adopt"] as const)(
    "keeps publication coherent for cold %s when recovery cleanup fails",
    async (action) => {
      const fixture = registryFixture();
      const recoveryPaths = new Set<string>();
      let stderr = "";
      fixture.runtime.writeStderr = (message) => {
        stderr += message;

        if (message.startsWith("Linked monke-tools skills")) {
          for (const name of readdirSync(fixture.monkeHome)) {
            if (name.startsWith(".monke-adopt-recovery-")) {
              const recovery = path.join(fixture.monkeHome, name);
              recoveryPaths.add(recovery);
              chmodSync(recovery, 0o500);
            }
          }
        }
      };

      const name = action === "create" ? "new-workflow" : "typography";

      try {
        await expect(
          runCliAsync(
            ["skills", action, action === "create" ? name : path.join(fixture.source, name)],
            fixture.runtime
          )
        ).resolves.toBeUndefined();
      } finally {
        for (const recovery of recoveryPaths) {
          chmodSync(recovery, 0o700);
        }
      }

      expect(stderr).toMatch(/published successfully.*could not remove recovery/u);
      const owner = path.join(fixture.monkeHome, "skill-sources", name, name);
      expect(read(owner, "SKILL.md")).toContain(`name: ${name}`);
      expect(readImportRecipeStore(fixture.registry).recipes[0]?.skills[0]?.slug).toBe(name);
      expect(realpathSync(path.join(fixture.installed.claude, name))).toBe(owner);
      expect(realpathSync(path.join(fixture.installed.codex, name))).toBe(owner);
      expect(realpathSync(path.join(fixture.installed.cursor, name))).toBe(owner);
      expect(existsSync(path.join(fixture.source, "typography"))).toBe(action === "create");
    }
  );

  it.each([
    { error: /lowercase Skill source name/u, name: "InvalidName" },
    { error: /non-managed/u, name: "new-workflow" }
  ])("restores the absent registry after a cold create failure ($name)", async (scenario) => {
    const fixture = registryFixture();
    writeSkill(
      path.join(fixture.guidance, "skills/imported"),
      "bundled",
      "Bundled instructions.\n"
    );
    writeImportRecipeStore(fixture.guidance, {
      recipes: [
        {
          skills: [{ kind: "skill", selector: "bundled", slug: "bundled" }],
          source: "example/bundled"
        }
      ],
      version: 4
    });
    const occupied = path.join(fixture.installed.claude, scenario.name);
    write(occupied, "SKILL.md", "User-owned instructions.\n");
    const preference = loadGlobalMonkeConfig(fixture.monkeHome);
    await expect(runCliAsync(["skills", "create", scenario.name], fixture.runtime)).rejects.toThrow(
      scenario.error
    );
    expect(existsSync(fixture.registry)).toBeFalsy();
    expect(existsSync(path.join(fixture.monkeHome, "skill-sources", scenario.name))).toBeFalsy();
    expect(loadGlobalMonkeConfig(fixture.monkeHome)).toStrictEqual(preference);
    expect(read(occupied, "SKILL.md")).toBe("User-owned instructions.\n");
  });

  it.each(["create", "adopt"] as const)(
    "rolls back %s on a required baseline failure before reporting success",
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

  it.each(["Monke home", "active guidance"] as const)(
    "does not report the registered slug unchanged for an independent protected copy in %s",
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

  it("reports adopted projections for an interactive Git slug change before confirmation or publication", async () => {
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

  it.each(["Monke home", "active guidance"] as const)(
    "reports a protected-source error for an unregistered skill inside %s",
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

  it("reports a missing selected registered owner during adoption before publication", async () => {
    const fixture = registryFixture();
    await runCliAsync(["skills", "add", fixture.source, "--link"], fixture.runtime);
    const previous = readImportRecipeStore(fixture.registry);
    const owner = path.join(fixture.registry, "skills/imported/typography");
    rmSync(owner);
    await expect(
      runCliAsync(["skills", "adopt", path.join(fixture.source, "typography")], fixture.runtime)
    ).rejects.toThrow(`typography: registered owner ${owner} is missing`);
    expect(readImportRecipeStore(fixture.registry)).toStrictEqual(previous);
    expect(read(fixture.source, "typography/SKILL.md")).toContain("Course instructions.");
    expect(existsSync(path.join(fixture.monkeHome, "skill-sources/typography"))).toBeFalsy();
  });

  it.each([
    { error: /registered owner.*duplicate discovery/u, harness: "codex", preservesLeftover: true },
    { error: /registered owner occupies.*projection/u, harness: "claude", preservesLeftover: true },
    { error: /registered owner occupies.*projection/u, harness: "cursor", preservesLeftover: true },
    { error: /registered owner.*duplicate discovery/u, harness: "custom", preservesLeftover: true },
    {
      error: /registered owner.*duplicate discovery/u,
      harness: "custom-claude",
      preservesLeftover: true
    }
  ] as const)(
    "preserves a registered physical owner in a raw $harness harness path during adoption",
    async (scenario) => {
      const fixture = registryFixture();
      const config = loadGlobalMonkeConfig(fixture.monkeHome);
      saveGlobalMonkeConfig(fixture.monkeHome, {
        ...config,
        skillInstallPreference: {
          targets: [
            { kind: "codex" },
            ...(scenario.harness.startsWith("custom")
              ? [
                  {
                    kind: "custom" as const,
                    path:
                      scenario.harness === "custom-claude"
                        ? fixture.installed.claude
                        : path.join(fixture.sandbox, "custom-skills")
                  }
                ]
              : [])
          ]
        }
      });

      const rawRoot = {
        claude: fixture.installed.claude,
        codex: path.resolve(fixture.installed.codex, "../.."),
        cursor: path.resolve(fixture.installed.cursor, "../.."),
        custom: path.join(fixture.sandbox, "custom-skills"),
        "custom-claude": fixture.installed.claude
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

  it.each([
    { alias: "none", claudeFirst: true, registered: true },
    { alias: "none", claudeFirst: false, registered: true },
    { alias: "none", claudeFirst: true, registered: false },
    { alias: "none", claudeFirst: false, registered: false },
    { alias: "root", claudeFirst: true, registered: true },
    { alias: "root", claudeFirst: false, registered: false },
    { alias: "missing-parent", claudeFirst: true, registered: false },
    { alias: "missing-parent", claudeFirst: false, registered: false },
    { alias: "dangling-root", claudeFirst: true, registered: false }
  ])(
    "rejects overlapping Claude/custom layouts during adoption before mutation ($registered, $claudeFirst, $alias)",
    async ({ alias, claudeFirst, registered }) => {
      const fixture = registryFixture();
      const config = loadGlobalMonkeConfig(fixture.monkeHome);
      const missing = alias === "missing-parent" || alias === "dangling-root";
      mkdirSync(missing ? path.dirname(fixture.installed.claude) : fixture.installed.claude, {
        recursive: true
      });
      const aliasPath = path.join(fixture.sandbox, "claude-alias");

      const customRoot =
        alias === "none"
          ? fixture.installed.claude
          : alias === "missing-parent"
            ? path.join(aliasPath, "skills")
            : aliasPath;

      if (alias !== "none") {
        symlinkSync(
          alias === "missing-parent"
            ? path.dirname(fixture.installed.claude)
            : fixture.installed.claude,
          aliasPath,
          "dir"
        );
      }

      const custom = { kind: "custom" as const, path: customRoot };
      saveGlobalMonkeConfig(fixture.monkeHome, {
        ...config,
        skillInstallPreference: { targets: [{ kind: "codex" }, custom] }
      });

      if (registered) {
        writeSkill(fixture.installed.claude, "typography", "Course instructions.\n");
        await runCliAsync(
          ["skills", "add", path.join(fixture.installed.claude, "typography"), "--link"],
          fixture.runtime
        );
      }

      const targets = claudeFirst
        ? [{ kind: "claude" as const }, custom]
        : [custom, { kind: "claude" as const }];

      const preference = { targets: [{ kind: "codex" as const }, ...targets] };
      saveGlobalMonkeConfig(fixture.monkeHome, { ...config, skillInstallPreference: preference });

      const previous = existsSync(fixture.registry)
        ? readImportRecipeStore(fixture.registry)
        : undefined;

      const installed = existsSync(fixture.installed.claude)
        ? readdirSync(fixture.installed.claude, { encoding: "utf-8", recursive: true }).toSorted(
            (a, b) => a.localeCompare(b)
          )
        : undefined;

      const ownerBytes = registered
        ? read(fixture.installed.claude, "typography/SKILL.md")
        : undefined;

      await expect(
        runCliAsync(["skills", "adopt", path.join(fixture.source, "typography")], fixture.runtime)
      ).rejects.toThrow(/overlapping Claude and custom Skill layouts.*configure distinct roots/u);
      expect(loadGlobalMonkeConfig(fixture.monkeHome).skillInstallPreference).toStrictEqual(
        preference
      );
      expect(read(fixture.source, "typography/SKILL.md")).toContain("Course instructions.");
      expect(existsSync(path.join(fixture.monkeHome, "skill-sources/typography"))).toBeFalsy();
      expect(
        existsSync(fixture.installed.claude)
          ? readdirSync(fixture.installed.claude, { encoding: "utf-8", recursive: true }).toSorted(
              (a, b) => a.localeCompare(b)
            )
          : undefined
      ).toStrictEqual(installed);
      expect(
        existsSync(fixture.registry) ? readImportRecipeStore(fixture.registry) : undefined
      ).toStrictEqual(previous);
      expect(
        existsSync(path.join(fixture.installed.claude, "typography/SKILL.md"))
          ? read(fixture.installed.claude, "typography/SKILL.md")
          : undefined
      ).toBe(ownerBytes);
    }
  );

  it("preserves an incidental projection replaced by a user-owned entry during policy publication", async () => {
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

  it.each(["Markdown", "symlink"] as const)(
    "stops the complete batch with actionable paths on a detected external %s dependency",
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

  it.each(["Markdown", "symlink"] as const)(
    "refuses to adopt an internal %s reference tied to its original parent",
    async (reference) => {
      const fixture = registryFixture();
      const collection = path.join(fixture.sandbox, "original-collection");
      const original = path.join(collection, "alpha");
      writeSkill(
        collection,
        "alpha",
        reference === "Markdown"
          ? "[Guide](../../original-collection/alpha/guide.md)\n"
          : "Alpha instructions.\n"
      );
      write(original, "guide.md", "Original guide.\n");

      if (reference === "symlink") {
        symlinkSync("../../original-collection/alpha/guide.md", path.join(original, "resource.md"));
      }

      await expect(runCliAsync(["skills", "adopt", original], fixture.runtime)).rejects.toThrow(
        /relocation.*cannot preserve|symlink would not remain/u
      );
      expect(read(original, "guide.md")).toBe("Original guide.\n");
      expect(existsSync(fixture.registry)).toBeFalsy();
      expect(existsSync(path.join(fixture.monkeHome, "skill-sources/alpha"))).toBeFalsy();
    }
  );

  it.each(["absolute", "physical-name"] as const)(
    "protects a logical alias with a %s source-bound symlink during adoption",
    async (kind) => {
      const fixture = registryFixture();
      const owner = path.join(fixture.sandbox, "external/physical-owner");
      writeSkill(path.dirname(owner), "physical-owner", "Physical instructions.\n");
      write(owner, "guide.md", "Physical guide.\n");

      const target =
        kind === "absolute" ? path.join(owner, "guide.md") : "../physical-owner/guide.md";

      symlinkSync(target, path.join(owner, "resource.md"));
      const alias = path.join(fixture.source, "logical-alias");
      symlinkSync(owner, alias, "dir");
      expect(read(alias, "resource.md")).toBe("Physical guide.\n");
      await expect(runCliAsync(["skills", "adopt", alias], fixture.runtime)).rejects.toThrow(
        /symlink would not remain/u
      );
      expect(read(alias, "resource.md")).toBe("Physical guide.\n");
      expect(readlinkSync(alias)).toBe(owner);
      expect(existsSync(fixture.registry)).toBeFalsy();
      expect(existsSync(path.join(fixture.monkeHome, "skill-sources/logical-alias"))).toBeFalsy();
      await runCliAsync(["skills", "add", owner, "--name", "retained", "--link"], fixture.runtime);
      const previous = readImportRecipeStore(fixture.registry);
      await runCliAsync(
        ["skills", "adopt", path.join(fixture.installed.claude, "physical-owner")],
        fixture.runtime
      );
      expect(fixture.stdout()).toContain("Unchanged: physical-owner");
      expect(read(owner, "resource.md")).toBe("Physical guide.\n");
      expect(readImportRecipeStore(fixture.registry)).toStrictEqual(previous);
    }
  );

  it("protects managed storage through ordinary ancestor aliases during adoption", async () => {
    const fixture = registryFixture();
    const protectedCollection = path.join(fixture.monkeHome, "orphans");
    writeSkill(protectedCollection, "foo", "Protected instructions.\n");
    const alias = path.join(fixture.sandbox, "ordinary-ancestor");
    symlinkSync(protectedCollection, alias, "dir");
    await expect(
      runCliAsync(["skills", "adopt", path.join(alias, "foo")], fixture.runtime)
    ).rejects.toThrow(/unregistered Skill.*inside managed storage/u);
    expect(read(protectedCollection, "foo/SKILL.md")).toContain("Protected instructions.");
    expect(readlinkSync(alias)).toBe(protectedCollection);
    expect(existsSync(fixture.registry)).toBeFalsy();
    expect(existsSync(path.join(fixture.monkeHome, "skill-sources/foo"))).toBeFalsy();
  });

  it.each(["Monke home", "active guidance"] as const)(
    "protects terminal aliases into %s during adoption",
    async (storage) => {
      const fixture = registryFixture();

      const protectedCollection =
        storage === "Monke home"
          ? path.join(fixture.monkeHome, "orphans")
          : path.join(fixture.guidance, "skills/personal");

      writeSkill(protectedCollection, "foo", "Protected instructions.\n");
      const owner = path.join(protectedCollection, "foo");
      const alias = path.join(fixture.sandbox, "foo");
      symlinkSync(owner, alias, "dir");
      await expect(runCliAsync(["skills", "adopt", alias], fixture.runtime)).rejects.toThrow(
        /unregistered Skill.*inside managed storage/u
      );
      expect(read(owner, "SKILL.md")).toContain("Protected instructions.");
      expect(readlinkSync(alias)).toBe(owner);
      expect(existsSync(fixture.registry)).toBeFalsy();
      expect(existsSync(path.join(fixture.monkeHome, "skill-sources/foo"))).toBeFalsy();
    }
  );

  it.each([false, true])(
    "preserves undiscovered registered owner roots during adoption (materialized link absent=%s)",
    async (missingLink) => {
      const fixture = registryFixture();
      const external = path.join(fixture.sandbox, "external/alpha");
      writeSkill(path.dirname(external), "alpha", "Shared self-contained instructions.\n");
      const independent = path.join(fixture.sandbox, "independent/alpha");
      cpSync(external, independent, { recursive: true });
      const collection = path.join(fixture.sandbox, "beta-collection");
      mkdirSync(collection);
      symlinkSync(external, path.join(collection, "beta"), "dir");
      await runCliAsync(
        ["skills", "add", collection, "--name", "existing-beta", "--link", "--skill", "beta"],
        fixture.runtime
      );
      await runCliAsync(
        ["skills", "add", independent, "--name", "existing-alpha", "--link"],
        fixture.runtime
      );
      const previous = readImportRecipeStore(fixture.registry);
      expect(
        previous.recipes
          .find((recipe) => recipe.name === "existing-beta")
          ?.skills.map((skill) => skill.slug)
      ).toStrictEqual(["beta"]);
      expect(realpathSync(path.join(fixture.registry, "skills/imported/beta"))).toBe(external);

      if (missingLink) {
        rmSync(path.join(fixture.installed.codex, "beta"));
      }

      rmSync(path.join(fixture.installed.claude, "beta"));
      rmSync(path.resolve(fixture.installed.codex, ".."), { recursive: true });
      rmSync(path.resolve(fixture.installed.cursor, ".."), { force: true, recursive: true });
      expect(existsSync(path.join(fixture.registry, "skills/imported/beta"))).toBe(!missingLink);
      await expect(runCliAsync(["skills", "adopt", external], fixture.runtime)).rejects.toThrow(
        /beta: registered owner .*would break after removing/u
      );
      expect(read(external, "SKILL.md")).toContain("Shared self-contained instructions.");
      expect(realpathSync(path.join(collection, "beta"))).toBe(external);
      expect(existsSync(path.join(fixture.registry, "skills/imported/beta"))).toBe(!missingLink);
      expect(realpathSync(path.join(fixture.registry, "skills/imported/alpha"))).toBe(independent);
      expect(readImportRecipeStore(fixture.registry)).toStrictEqual(previous);
      expect(existsSync(path.join(fixture.installed.claude, "beta"))).toBeFalsy();
    }
  );

  it.each([false, true])(
    "protects unprojected registered owner dependencies during adoption (materialized link absent=%s)",
    async (missingLink) => {
      const fixture = registryFixture();
      const collection = path.join(fixture.sandbox, "external-collection");
      const owner = path.join(collection, "alpha");
      writeSkill(collection, "alpha", "[Guide](../beta/guide.md)\n");
      writeSkill(collection, "beta", "Supporting skill.\n");
      write(collection, "beta/guide.md", "Supporting guide.\n");
      await runCliAsync(["skills", "add", owner, "--name", "existing", "--link"], fixture.runtime);
      const previous = readImportRecipeStore(fixture.registry);

      if (missingLink) {
        rmSync(path.join(fixture.installed.codex, "alpha"));
      }

      rmSync(path.join(fixture.installed.claude, "alpha"));
      rmSync(path.resolve(fixture.installed.codex, ".."), { recursive: true });
      rmSync(path.resolve(fixture.installed.cursor, ".."), { recursive: true });
      await expect(
        runCliAsync(["skills", "adopt", path.join(collection, "beta")], fixture.runtime)
      ).rejects.toThrow(/alpha: .*would break after removing .*beta/u);
      expect(read(collection, "beta/guide.md")).toBe("Supporting guide.\n");
      expect(existsSync(path.join(fixture.registry, "skills/imported/alpha"))).toBe(!missingLink);
      expect(readImportRecipeStore(fixture.registry)).toStrictEqual(previous);
      expect(existsSync(path.join(fixture.installed.claude, "alpha"))).toBeFalsy();
      expect(existsSync(path.join(fixture.monkeHome, "skill-sources/beta"))).toBeFalsy();
    }
  );

  it.each([false, true])(
    "restores the whole batch after publication failure or retains recovery when restoration is obstructed (%s)",
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

  it.each(["bytes", "metadata", "executable", "symlink", "directory"] as const)(
    "preserves the complete selected adoption batch on a %s difference",
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

  it("restores the absent registry including bundled registrations after a cold adoption conflict", async () => {
    const fixture = registryFixture();
    writeSkill(
      path.join(fixture.guidance, "skills/imported"),
      "bundled",
      "Bundled instructions.\n"
    );
    writeImportRecipeStore(fixture.guidance, {
      recipes: [
        {
          skills: [{ kind: "skill", selector: "bundled", slug: "bundled" }],
          source: "example/bundled"
        }
      ],
      version: 4
    });
    writeSkill(fixture.source, "healthy", "Healthy instructions.\n");
    writeSkill(fixture.installed.claude, "typography", "Divergent instructions.\n");
    const preference = loadGlobalMonkeConfig(fixture.monkeHome);
    expect(existsSync(fixture.registry)).toBeFalsy();
    await expect(
      runCliAsync(
        ["skills", "adopt", fixture.checkout, "--skill", "typography", "healthy"],
        fixture.runtime
      )
    ).rejects.toThrow(/differing copies/u);
    expect(existsSync(fixture.registry)).toBeFalsy();
    expect(read(fixture.source, "typography/SKILL.md")).toContain("Course instructions.");
    expect(read(fixture.source, "healthy/SKILL.md")).toContain("Healthy instructions.");
    expect(read(fixture.installed.claude, "typography/SKILL.md")).toContain(
      "Divergent instructions."
    );
    expect(loadGlobalMonkeConfig(fixture.monkeHome)).toStrictEqual(preference);
    expect(existsSync(path.join(fixture.monkeHome, "skill-sources/private-course"))).toBeFalsy();
  });

  it("preserves scripts and internal aliases during adoption and keeps differently named skills separate", async () => {
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

  it("preserves native symlink traversal before parent components during adoption", async () => {
    const fixture = registryFixture();
    const original = path.join(fixture.source, "typography");
    write(original, "references/guide.md", "Native internal guide.\n");
    mkdirSync(path.join(original, "references/nested"));
    symlinkSync("references/nested", path.join(original, "jump"), "dir");
    symlinkSync("jump/../guide.md", path.join(original, "resource.md"));
    write(original, "SKILL.md", `${read(original, "SKILL.md")}\n[Guide](jump/../guide.md)\n`);
    expect(read(original, "resource.md")).toBe("Native internal guide.\n");
    expect(existsSync(path.join(original, "guide.md"))).toBeFalsy();
    await runCliAsync(["skills", "adopt", original], fixture.runtime);
    const owner = path.join(fixture.monkeHome, "skill-sources/typography/typography");
    expect(read(owner, "resource.md")).toBe("Native internal guide.\n");
    expect(realpathSync(path.join(owner, "resource.md"))).toBe(
      path.join(owner, "references/guide.md")
    );
    expect(readlinkSync(path.join(owner, "resource.md"))).toBe("jump/../guide.md");
  });

  it.each([false, true])(
    "preserves same-owner replacement projections during adoption (Claude configured=%s)",
    async (configured) => {
      const fixture = registryFixture();
      saveGlobalMonkeConfig(fixture.monkeHome, {
        ...loadGlobalMonkeConfig(fixture.monkeHome),
        skillInstallPreference: {
          targets: [{ kind: "codex" }, ...(configured ? [{ kind: "claude" as const }] : [])]
        }
      });
      const owner = path.join(fixture.sandbox, "external/beta");
      writeSkill(path.dirname(owner), "beta", "Beta instructions.\n");
      write(owner, "guide.md", "Retained external guide.\n");
      await runCliAsync(["skills", "add", owner, "--name", "existing", "--link"], fixture.runtime);
      const bridge = path.join(fixture.sandbox, "beta-bridge");
      symlinkSync(owner, bridge, "dir");
      const projection = path.join(fixture.installed.claude, "beta");
      mkdirSync(fixture.installed.claude, { recursive: true });
      rmSync(projection, { force: true });
      symlinkSync(bridge, projection, "dir");
      writeSkill(fixture.installed.claude, "alpha", "[Guide](../beta/guide.md)\n");
      symlinkSync("../beta/guide.md", path.join(fixture.installed.claude, "alpha/resource.md"));
      symlinkSync("beta", path.join(fixture.installed.claude, "alpha-alias"), "dir");
      await runCliAsync(["skills", "adopt", projection], fixture.runtime);
      expect(realpathSync(projection)).toBe(owner);
      expect(readlinkSync(projection)).toBe(path.join(fixture.registry, "skills/imported/beta"));
      expect(read(fixture.installed.claude, "alpha/resource.md")).toBe(
        "Retained external guide.\n"
      );
      expect(realpathSync(path.join(fixture.installed.claude, "alpha-alias"))).toBe(owner);
      expect(readlinkSync(bridge)).toBe(owner);
    }
  );

  it("still protects removed supporting entries under native symlink parent traversal", async () => {
    const fixture = registryFixture();
    const owner = path.join(fixture.sandbox, "external/alpha");
    writeSkill(path.dirname(owner), "alpha", "Retained owner.\n");
    const collection = path.join(owner, "references");
    writeSkill(collection, "beta", "Supporting skill.\n");
    write(collection, "beta/guide.md", "Supporting guide.\n");
    mkdirSync(path.join(collection, "nested"));
    symlinkSync("references/nested", path.join(owner, "jump"), "dir");
    symlinkSync("jump/../beta/guide.md", path.join(owner, "resource.md"));
    await runCliAsync(["skills", "add", owner, "--name", "existing", "--link"], fixture.runtime);
    const previous = readImportRecipeStore(fixture.registry);
    await expect(
      runCliAsync(["skills", "adopt", collection, "--skill", "beta"], fixture.runtime)
    ).rejects.toThrow(/alpha: .*would break after removing .*beta/u);
    expect(read(owner, "resource.md")).toBe("Supporting guide.\n");
    expect(readImportRecipeStore(fixture.registry)).toStrictEqual(previous);
    expect(existsSync(path.join(fixture.monkeHome, "skill-sources/references"))).toBeFalsy();
  });

  it("reuses a registered owner for identical copies and reports unchanged on repeat adoption", async () => {
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

  it.each([
    { error: /^$/u, preservesLeftover: false, sameResource: true },
    {
      error: /relocation.*cannot preserve|symlink would not remain/u,
      preservesLeftover: true,
      sameResource: false
    }
  ])(
    "compares external reference resolution for an existing owner during adoption (same resource=$sameResource)",
    async ({ error: pattern, preservesLeftover, sameResource }) => {
      const fixture = registryFixture();
      const shared = path.join(fixture.sandbox, "shared-dependencies");
      const other = path.join(fixture.sandbox, "different-dependencies");
      write(shared, "shared.md", "Shared resource.\n");
      write(other, "shared.md", "Different resource.\n");
      const owner = path.join(shared, "a/typography");
      writeSkill(path.dirname(owner), "typography", "[Shared](../../shared.md)\n");
      symlinkSync("../../shared.md", path.join(owner, "resource.md"));
      await runCliAsync(["skills", "add", owner, "--name", "existing", "--link"], fixture.runtime);
      const previous = readImportRecipeStore(fixture.registry);
      const leftover = path.join(sameResource ? shared : other, "b/typography");
      cpSync(owner, leftover, { recursive: true, verbatimSymlinks: true });
      let report = "";

      try {
        await runCliAsync(["skills", "adopt", leftover], fixture.runtime);
      } catch (error) {
        report = errorMessage(ThrownValueSchema.parse(error));
      }

      expect(report).toMatch(pattern);
      expect(existsSync(leftover)).toBe(preservesLeftover);
      expect(read(owner, "resource.md")).toBe("Shared resource.\n");
      expect(read(shared, "shared.md")).toBe("Shared resource.\n");
      expect(read(other, "shared.md")).toBe("Different resource.\n");
      expect(readImportRecipeStore(fixture.registry)).toStrictEqual(previous);
      expect(realpathSync(path.join(fixture.installed.claude, "typography"))).toBe(owner);
    }
  );

  it.each([
    { alias: false, reference: "Markdown", selectedOwner: true },
    { alias: false, reference: "symlink", selectedOwner: false },
    { alias: true, reference: "symlink", selectedOwner: true },
    { alias: true, reference: "Markdown", selectedOwner: false }
  ] as const)(
    "preserves a retained owner's $reference dependency during batch removal (alias=$alias, selected owner=$selectedOwner)",
    async ({ alias, reference, selectedOwner }) => {
      const fixture = registryFixture();
      const collection = path.join(fixture.sandbox, "dependent-batch");
      const owner = path.join(collection, "alpha");
      const resource = path.join(collection, "beta");
      writeSkill(
        collection,
        "alpha",
        reference === "Markdown" ? "[Guide](../beta/guide.md)\n" : "Owner instructions.\n"
      );
      writeSkill(collection, "beta", "Supporting skill.\n");
      write(resource, "guide.md", "Supporting guide.\n");

      if (reference === "symlink") {
        symlinkSync("../beta/guide.md", path.join(owner, "resource.md"));
      }

      const external = path.join(fixture.sandbox, "external/beta");

      if (alias) {
        cpSync(resource, external, { recursive: true });
        rmSync(resource, { recursive: true });
        symlinkSync(external, resource, "dir");
      }

      await runCliAsync(["skills", "add", owner, "--name", "existing", "--link"], fixture.runtime);
      const previous = readImportRecipeStore(fixture.registry);
      const preference = loadGlobalMonkeConfig(fixture.monkeHome);
      await expect(
        runCliAsync(
          [
            "skills",
            "adopt",
            collection,
            "--skill",
            ...(selectedOwner ? ["alpha", "beta"] : ["beta"])
          ],
          fixture.runtime
        )
      ).rejects.toThrow(/alpha: .*would break after removing .*beta/u);
      expect(read(resource, "guide.md")).toBe("Supporting guide.\n");
      expect(realpathSync(resource)).toBe(alias ? external : resource);
      expect(read(owner, "SKILL.md")).toContain(
        reference === "Markdown" ? "../beta/guide.md" : "Owner instructions."
      );
      expect(readImportRecipeStore(fixture.registry)).toStrictEqual(previous);
      expect(loadGlobalMonkeConfig(fixture.monkeHome)).toStrictEqual(preference);
      expect(realpathSync(path.join(fixture.installed.codex, "alpha"))).toBe(owner);
      expect(existsSync(path.join(fixture.monkeHome, "skill-sources/dependent-batch"))).toBeFalsy();
    }
  );

  it("consolidates identical global copies during adoption without enabling an unconfigured harness", async () => {
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

  it("shares editable files across targets on creation and retains them through installation and removal", async () => {
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

  it("replaces an unmanaged Claude skill with shared links during adoption and preserves supporting files", async () => {
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

  it("selects collection skills for adoption, removes old entries, and leaves alias targets intact", async () => {
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

  it.each(["physical", "alias", "chain"] as const)(
    "reports an unselected alias during adoption before removing its selected %s or another selected skill",
    async (kind) => {
      const fixture = registryFixture();
      writeSkill(fixture.source, "healthy", "Healthy instructions.\n");
      const external = path.join(fixture.sandbox, "external");

      if (kind !== "physical") {
        cpSync(path.join(fixture.source, "typography"), external, { recursive: true });
        rmSync(path.join(fixture.source, "typography"), { recursive: true });
        symlinkSync(external, path.join(fixture.source, "typography"), "dir");
      }

      if (kind === "chain") {
        symlinkSync("typography", path.join(fixture.source, "middle-alias"), "dir");
      }

      const target = kind === "chain" ? "middle-alias" : "typography";
      symlinkSync(target, path.join(fixture.source, "unselected-alias"), "dir");
      await expect(
        runCliAsync(
          ["skills", "adopt", fixture.checkout, "--skill", "typography", "healthy"],
          fixture.runtime
        )
      ).rejects.toThrow(
        /typography: removing .* would break unselected Skill alias .*unselected-alias/u
      );
      expect(read(fixture.source, "unselected-alias/SKILL.md")).toContain("Course instructions.");
      expect(readlinkSync(path.join(fixture.source, "unselected-alias"))).toBe(target);
      expect(read(fixture.source, "healthy/SKILL.md")).toContain("Healthy instructions.");
      expect(readImportRecipeStore(fixture.registry).recipes).toStrictEqual([]);
      expect(existsSync(path.join(fixture.installed.codex, "healthy"))).toBeFalsy();
    }
  );

  it("preserves an independent unselected alias to the same external source during adoption", async () => {
    const fixture = registryFixture();
    const external = path.join(fixture.sandbox, "external");
    cpSync(path.join(fixture.source, "typography"), external, { recursive: true });
    rmSync(path.join(fixture.source, "typography"), { recursive: true });
    symlinkSync(external, path.join(fixture.source, "typography"), "dir");
    symlinkSync(external, path.join(fixture.source, "independent-alias"), "dir");
    await runCliAsync(
      ["skills", "adopt", fixture.checkout, "--skill", "typography"],
      fixture.runtime
    );
    expect(read(fixture.source, "independent-alias/SKILL.md")).toContain("Course instructions.");
    expect(readlinkSync(path.join(fixture.source, "independent-alias"))).toBe(external);
    expect(read(external, "SKILL.md")).toContain("Course instructions.");
    expect(existsSync(path.join(fixture.source, "typography"))).toBeFalsy();
  });

  it("lets an unselected known-harness alias stop deletion of the selected alias chain", async () => {
    const fixture = registryFixture();
    const codexRoot = path.resolve(fixture.installed.codex, "../..");
    const cursorRoot = path.resolve(fixture.installed.cursor, "../..");
    mkdirSync(codexRoot, { recursive: true });
    mkdirSync(cursorRoot, { recursive: true });
    const selected = path.join(codexRoot, "typography");
    symlinkSync(path.join(fixture.source, "typography"), selected, "dir");
    symlinkSync(selected, path.join(cursorRoot, "unselected-alias"), "dir");
    await expect(runCliAsync(["skills", "adopt", selected], fixture.runtime)).rejects.toThrow(
      /would break unselected Skill alias .*unselected-alias/u
    );
    expect(read(cursorRoot, "unselected-alias/SKILL.md")).toContain("Course instructions.");
    expect(readlinkSync(selected)).toBe(path.join(fixture.source, "typography"));
    expect(readImportRecipeStore(fixture.registry).recipes).toStrictEqual([]);
  });

  it.each([
    { configured: false, harness: "claude" },
    { configured: false, harness: "cursor" },
    { configured: true, harness: "claude" }
  ] as const)(
    "reports a nested $harness owner layout (configured=$configured) during adoption before changing the batch",
    async ({ configured, harness }) => {
      const fixture = registryFixture();
      const config = loadGlobalMonkeConfig(fixture.monkeHome);
      saveGlobalMonkeConfig(fixture.monkeHome, {
        ...config,
        skillInstallPreference: {
          targets: [{ kind: "codex" }, ...(configured ? [{ kind: harness }] : [])]
        }
      });

      const root =
        harness === "claude"
          ? fixture.installed.claude
          : path.resolve(fixture.installed.cursor, "../..");

      writeSkill(path.join(root, "category"), "typography", "Course instructions.\n");
      const owner = path.join(root, "category/typography");
      await runCliAsync(
        ["skills", "add", owner, "--name", "nested-owner", "--link"],
        fixture.runtime
      );
      const previous = readImportRecipeStore(fixture.registry);
      writeSkill(fixture.source, "healthy", "Healthy instructions.\n");
      await expect(
        runCliAsync(
          ["skills", "adopt", fixture.checkout, "--skill", "typography", "healthy"],
          fixture.runtime
        )
      ).rejects.toThrow(/registered owner.*duplicate discovery/u);
      expect(read(owner, "SKILL.md")).toContain("Course instructions.");
      expect(read(fixture.source, "typography/SKILL.md")).toContain("Course instructions.");
      expect(read(fixture.source, "healthy/SKILL.md")).toContain("Healthy instructions.");
      expect(readImportRecipeStore(fixture.registry)).toStrictEqual(previous);
      expect(existsSync(path.join(root, "typography"))).toBe(configured);
    }
  );

  it.each(["skill", "collection"] as const)(
    "accepts an ordinary ancestor alias above a supplied %s during adoption",
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

  it("reports an explicit collection alias during adoption and preserves its external skills", async () => {
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

  it("removes duplicate discovery and preserves the external source when adopting a single Codex alias", async () => {
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

  it("skips skills Monke already manages when adopting an entire harness root", async () => {
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

  it("reports divergent global copies before adoption changes files", async () => {
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

  it("rejects invalid selections without changes and reports already managed sources unchanged", async () => {
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

  it("keeps explicit removal through installation and re-enables a bundled source on explicit re-add", async () => {
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
      version: 4
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

  it("uses existing provider layouts for linked imports and writes learned changes back to their source", async () => {
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

  it("replays command and Git imports, reapplies policies, and reviews linked file bytes in one update", async () => {
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
    expect(recipes.find((recipe) => recipe.name === "git-source")?.commit).toBe(expectedCommit);
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

  it.each(["exit", "collision", "metadata"] as const)(
    "restores source bytes and symlinks after an installer %s failure while later sources still update",
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

  it("preserves the recipe for removal retry when adopted-link retirement fails", async () => {
    const fixture = registryFixture();
    saveGlobalMonkeConfig(fixture.monkeHome, {
      ...loadGlobalMonkeConfig(fixture.monkeHome),
      skillInstallPreference: { targets: [{ kind: "codex" }] }
    });
    writeSkill(fixture.installed.claude, "typography", "Course instructions.\n");
    await runCliAsync(
      ["skills", "adopt", path.join(fixture.source, "typography")],
      fixture.runtime
    );
    const previous = readImportRecipeStore(fixture.registry);
    const projection = path.join(fixture.installed.claude, "typography");
    const projectionTarget = readlinkSync(projection);
    const owner = path.join(fixture.monkeHome, "skill-sources/typography/typography");
    const ownerBytes = read(owner, "SKILL.md");
    chmodSync(fixture.installed.claude, 0o500);

    try {
      await expect(
        runCliAsync(["skills", "remove", "typography"], fixture.runtime)
      ).rejects.toThrow(/typography/u);
    } finally {
      chmodSync(fixture.installed.claude, 0o700);
    }

    expect(readImportRecipeStore(fixture.registry)).toStrictEqual(previous);
    expect(readlinkSync(projection)).toBe(projectionTarget);
    expect(realpathSync(projection)).toBe(owner);
    expect(realpathSync(path.join(fixture.installed.codex, "typography"))).toBe(owner);
    expect(read(owner, "SKILL.md")).toBe(ownerBytes);
    await runCliAsync(["skills", "remove", "typography"], fixture.runtime);
    expect(readImportRecipeStore(fixture.registry).recipes).toStrictEqual([]);
    expect(existsSync(projection)).toBeFalsy();
    expect(existsSync(path.join(fixture.installed.codex, "typography"))).toBeFalsy();
    expect(read(owner, "SKILL.md")).toBe(ownerBytes);
  });

  it("retires managed projections on selection replacement and removal while keeping the external source", async () => {
    const fixture = registryFixture();
    writeSkill(fixture.source, "color", "Color instructions.\n");
    await runCliAsync(
      ["skills", "add", fixture.checkout, "--skill", "typography"],
      fixture.runtime
    );
    await runCliAsync(
      ["skills", "add", fixture.checkout, "--replace", "--skill", "color"],
      fixture.runtime
    );

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

  it.each(["link", "command"] as const)(
    "updates healthy sources despite a missing %s source",
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

  it("publishes the new source when re-adding a command with a new working directory", async () => {
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

  it("leaves no source or registered recipe after a failed first installer", async () => {
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

  it.each([
    "empty",
    "flat",
    "symlink",
    "provider",
    "candidate",
    "new_collection",
    "alias",
    "root_entry"
  ] as const)(
    "preserves unrelated edits and restores only skills after a failed installer in an existing %s project",
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

  it.each(["collection", "nested"] as const)(
    "detaches a replaced %s alias during recovery without changing the unrelated target",
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

  it.each([undefined, "codiff"])(
    "honors the configured LFV adapter in updates unless overridden with %s",
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

  it("preserves references and selected-skill policies on repeat Git add", async () => {
    const fixture = registryFixture();

    const upstream = createRepo(path.join(fixture.sandbox, "git-source"), {
      "monke.yml": "apps: {}\n",
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
      recipes: [
        {
          commit: git(upstream, ["rev-parse", "HEAD"]),
          skills: [{ kind: "reference", selector: "alpha", slug: "alpha" }],
          source
        }
      ],
      version: 4
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
    await runCliAsync(["skills", "add", source, "--skill", "bravo"], fixture.runtime);
    expect(parse(read(fixture.installed.claude, "bravo/agents/openai.yaml"))).toMatchObject({
      policy: { allow_implicit_invocation: true }
    });
  });

  it("rejects a newly occupied target on policy refresh before publishing policy or new skills", async () => {
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

  it.each(["policy", "installer", "new linked target"] as const)(
    "restores bytes in external symlinked skill directories after failed %s publication",
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

  it("updates healthy local sources despite an unavailable Git pin", async () => {
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

  it("blocks source publication when an unrelated skill occupies the target, before source policy or target changes", async () => {
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
