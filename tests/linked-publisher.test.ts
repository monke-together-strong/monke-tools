import { existsSync, lstatSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { stringify } from "yaml";

import { runCliAsync } from "../src/index.ts";
import {
  createRepo,
  git,
  installFakeCodexSummary,
  installFakeCodiff,
  makeTempDir,
  read,
  write,
  writeExecutable
} from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

function fixture() {
  const sandbox = makeTempDir("linked-publisher");
  const consumer = createRepo(path.join(sandbox, "consumer"), { "README.md": "Consumer.\n" });

  const upstream = createRepo(path.join(sandbox, "upstream"), {
    "skills/base/SKILL.md":
      "---\nname: base\ndescription: Upstream trigger.\n---\nBase instructions.\n"
  });

  const publisher = createRepo(path.join(sandbox, "publisher"), {
    "skills/own/SKILL.md": "---\nname: own\ndescription: Own trigger.\n---\nOwn instructions.\n"
  });

  const bin = path.join(sandbox, "bin");
  installFakeCodiff(bin);
  installFakeCodexSummary(bin);
  writeExecutable(
    path.join(bin, "npx"),
    `#!/bin/sh
set -eu
source="$4"
shift 4
mkdir -p .agents/skills
while [ "$1" = --skill ]; do
  if [ "$2" = '*' ]; then cp -R "$source/skills/"* .agents/skills/;
  else
    slug=$(printf '%s' "$2" | tr '[:upper:] ' '[:lower:]-')
    cp -R "$source/skills/$slug" .agents/skills/
  fi
  shift 2
done
`
  );

  const runtime = createTestRuntime({
    cwd: consumer,
    env: {
      HOME: path.join(sandbox, "home"),
      MONKE_HOME: path.join(sandbox, "monke-home"),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`
    },
    onStderr() {},
    onStdout() {}
  });

  function declare(kind: "reference" | "skill", slug = "base", selector = "base") {
    write(
      publisher,
      "monke.yml",
      stringify({
        skills: [
          {
            commit: git(upstream, ["rev-parse", "HEAD"]),
            modelInvocation: "deny",
            skills: [{ description: "Publisher trigger.", kind, selector, slug }],
            source: upstream
          }
        ]
      })
    );
  }

  declare("reference");
  const installed = path.join(consumer, ".agents/skills/monke-tools");

  return { consumer, declare, installed, publisher, runtime, upstream };
}

describe("linked publisher collections", () => {
  test.each([false, true])("publisher YAML overrides stale JSON with linked=%s", async (linked) => {
    const { installed, publisher, runtime, upstream } = fixture();
    write(
      publisher,
      "skills.lock.json",
      JSON.stringify({
        recipes: [
          { commit: git(upstream, ["rev-parse", "HEAD"]), skills: ["base"], source: upstream }
        ],
        version: 4
      })
    );
    git(publisher, ["add", "."]);
    git(publisher, ["commit", "-m", "Publish declaration beside stale JSON"]);
    await runCliAsync(
      ["skills", "add", linked ? publisher : `${publisher}#HEAD`, "--project"],
      runtime
    );
    expect(read(installed, "references/imported/base/MAIN.md")).toBe("Base instructions.\n");
    expect(existsSync(path.join(installed, "imported/base"))).toBeFalsy();
    write(publisher, "monke.yml", "# No declared imports.\n");
    git(publisher, ["add", "."]);
    git(publisher, ["commit", "-m", "Remove YAML declarations"]);
    await runCliAsync(["skills", "update", "--project", "--adapter", "codiff"], runtime);
    expect(existsSync(path.join(installed, "references/imported/base"))).toBeFalsy();
    expect(existsSync(path.join(installed, "imported/base"))).toBeFalsy();
    expect(read(installed, "imported/own/SKILL.md")).toContain("Own instructions.");
  });

  test.each([
    { body: "---\nReference starts with a rule.\n", linked: false },
    { body: "---\nReference starts with a rule.\n", linked: true },
    { body: "---\nKeep this section.\n---\nKeep the tail.\n", linked: false },
    { body: "---\nKeep this section.\n---\nKeep the tail.\n", linked: true }
  ])(
    "published reference bodies retain horizontal rules with linked=$linked",
    async ({ body, linked }) => {
      const { declare, installed, publisher, runtime, upstream } = fixture();
      write(
        upstream,
        "skills/base/SKILL.md",
        `---\nname: base\ndescription: Reference.\n---\n${body}`
      );
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Reference with Markdown rules"]);
      declare("reference");
      git(publisher, ["add", "."]);
      git(publisher, ["commit", "-m", "Publish reference"]);
      await runCliAsync(
        ["skills", "add", linked ? publisher : `${publisher}#HEAD`, "--project", "--skill", "base"],
        runtime
      );
      expect(read(installed, "references/imported/base/MAIN.md")).toBe(body);
      await runCliAsync(["skills", "update", "--project", "--adapter", "codiff"], runtime);
      expect(read(installed, "references/imported/base/MAIN.md")).toBe(body);
    }
  );

  test("default selection publishes declared references beside linked own skills", async () => {
    const { installed, publisher, runtime } = fixture();
    await runCliAsync(["skills", "add", publisher, "--link", "--project"], runtime);
    expect(read(installed, "references/imported/base/MAIN.md")).toBe("Base instructions.\n");
    expect(existsSync(path.join(installed, "imported/base/SKILL.md"))).toBeFalsy();
    expect(realpathSync(path.join(installed, "imported/own"))).toBe(
      realpathSync(path.join(publisher, "skills/own"))
    );
    expect(
      lstatSync(path.join(publisher, "skills/references/imported/base")).isDirectory()
    ).toBeTruthy();
    expect(git(publisher, ["check-ignore", "skills/references/imported/base/MAIN.md"])).toBe(
      "skills/references/imported/base/MAIN.md"
    );
  });

  test("selection can install only a declared reference", async () => {
    const { installed, publisher, runtime } = fixture();
    await runCliAsync(
      ["skills", "add", publisher, "--link", "--project", "--skill", "base"],
      runtime
    );
    expect(read(installed, "references/imported/base/MAIN.md")).toBe("Base instructions.\n");
    expect(existsSync(path.join(installed, "imported/own"))).toBeFalsy();
  });

  test("linked publisher imports isolate consumer overrides from publisher restores", async () => {
    const { consumer, declare, installed, publisher, runtime } = fixture();

    const runtimeAt = (cwd: string) =>
      createTestRuntime({
        cwd,
        env: runtime.env,
        onStderr: runtime.writeStderr,
        onStdout: runtime.writeStdout
      });

    declare("skill");
    await runCliAsync(["skills", "add", publisher, "--link", "--project"], runtime);
    const publisherSkill = read(publisher, "skills/imported/base/SKILL.md");
    await runCliAsync(
      [
        "skills",
        "policy",
        "publisher",
        "base",
        "--project",
        "--description",
        "Consumer trigger.",
        "--model-invocation",
        "allow"
      ],
      runtime
    );
    const consumerSkill = read(installed, "imported/base/SKILL.md");
    expect(consumerSkill).toContain("description: Consumer trigger.");
    expect(consumerSkill).toContain("disable-model-invocation: false");
    expect(read(publisher, "skills/imported/base/SKILL.md")).toBe(publisherSkill);

    await runCliAsync(["skills", "restore", "--repo"], runtimeAt(publisher));
    expect(read(installed, "imported/base/SKILL.md")).toBe(consumerSkill);
    const other = createRepo(path.join(consumer, "..", "other"), { "README.md": "Other.\n" });
    await runCliAsync(["skills", "add", publisher, "--link", "--project"], runtimeAt(other));
    expect(read(other, ".agents/skills/monke-tools/imported/base/SKILL.md")).toBe(publisherSkill);
    expect(read(installed, "imported/base/SKILL.md")).toBe(consumerSkill);

    write(publisher, "monke.yml", "skills: []\n");
    await runCliAsync(["skills", "restore", "--repo"], runtimeAt(publisher));
    expect(existsSync(path.join(publisher, "skills/imported/base"))).toBeFalsy();
    expect(read(installed, "imported/base/SKILL.md")).toBe(consumerSkill);
    await runCliAsync(["skills", "update", "--project", "--adapter", "codiff"], runtime);
    expect(existsSync(path.join(installed, "imported/base"))).toBeFalsy();
    expect(realpathSync(path.join(installed, "imported/own"))).toBe(
      realpathSync(path.join(publisher, "skills/own"))
    );
  });

  test("aliases into declared publisher imports keep consumer metadata local", async () => {
    const { declare, installed, publisher, runtime } = fixture();
    declare("skill");
    await runCliAsync(["skills", "add", publisher, "--link", "--project"], runtime);
    const publisherSkill = read(publisher, "skills/imported/base/SKILL.md");
    symlinkSync("imported/base", path.join(publisher, "skills/alias"), "dir");
    await runCliAsync(
      ["skills", "add", publisher, "--link", "--project", "--skill", "alias"],
      runtime
    );
    await runCliAsync(
      ["skills", "policy", "publisher", "alias", "--project", "--description", "Alias trigger."],
      runtime
    );
    expect(read(installed, "imported/alias/SKILL.md")).toContain("description: Alias trigger.");
    expect(read(publisher, "skills/imported/base/SKILL.md")).toBe(publisherSkill);
  });

  test.each(["skill", "reference"] as const)(
    "declared %s selections accept selectors and slugs without duplicate publication",
    async (kind) => {
      const { declare, installed, publisher, runtime, upstream } = fixture();
      write(
        upstream,
        "skills/base-skill/SKILL.md",
        "---\nname: Base Skill\ndescription: Base trigger.\n---\nBase instructions.\n"
      );
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Publish named skill"]);
      declare(kind, "base-skill", "Base Skill");
      await runCliAsync(
        ["skills", "add", publisher, "--link", "--project", "--skill", "BASE SKILL"],
        runtime
      );

      const entry =
        kind === "skill"
          ? "imported/base-skill/SKILL.md"
          : "references/imported/base-skill/MAIN.md";

      expect(read(installed, entry)).toContain("Base instructions.");
      await runCliAsync(
        ["skills", "add", publisher, "--link", "--project", "--skill", "Base Skill", "base-skill"],
        runtime
      );
      expect(read(installed, entry)).toContain("Base instructions.");
      expect(existsSync(path.join(installed, "imported/own"))).toBeFalsy();

      if (kind === "skill") {
        await runCliAsync(
          [
            "skills",
            "policy",
            "publisher",
            "base-skill",
            "--project",
            "--description",
            "Consumer trigger.",
            "--model-invocation",
            "allow"
          ],
          runtime
        );
      }

      write(
        upstream,
        "skills/base-skill/SKILL.md",
        "---\nname: base-skill\ndescription: Changed trigger.\n---\nChanged instructions.\n"
      );
      git(upstream, ["add", "."]);
      git(upstream, ["commit", "-m", "Change selector without changing slug"]);
      declare(kind, "base-skill", "base-skill");
      await runCliAsync(["skills", "update", "--project", "--adapter", "codiff"], runtime);

      const expected = [
        "Changed instructions.",
        ...(kind === "skill"
          ? ["description: Consumer trigger.", "disable-model-invocation: false"]
          : [])
      ];

      for (const text of expected) {
        expect(read(installed, entry)).toContain(text);
      }
    }
  );

  test.each(["guide", "Base Skill"])(
    "exact own slug selection excludes the %s alias",
    async (other) => {
      const { declare, installed, publisher, runtime, upstream } = fixture();
      const slug = other === "guide" ? "Guide" : "Base Skill";
      write(
        publisher,
        `skills/${slug}/SKILL.md`,
        `---\nname: ${slug}\ndescription: Exact own skill.\n---\nExact own instructions.\n`
      );

      if (other === "guide") {
        write(
          publisher,
          "skills/guide/SKILL.md",
          "---\nname: guide\ndescription: Different own skill.\n---\nOther instructions.\n"
        );
      } else {
        write(
          upstream,
          "skills/base-skill/SKILL.md",
          "---\nname: Base Skill\ndescription: Declared skill.\n---\nOther instructions.\n"
        );
        git(upstream, ["add", "."]);
        git(upstream, ["commit", "-m", "Publish alias"]);
        declare("skill", "base-skill", "Base Skill");
      }

      const otherSlug = other === "guide" ? "guide" : "base-skill";

      const probes =
        other === "guide"
          ? [
              { expected: [slug, otherSlug], selected: [slug, otherSlug] },
              { expected: [slug], selected: [slug] }
            ]
          : [
              { expected: [slug, otherSlug], selected: [] },
              { expected: [otherSlug], selected: ["BASE SKILL"] },
              { expected: [slug], selected: [slug] }
            ];

      for (const probe of probes) {
        await runCliAsync(
          [
            "skills",
            "add",
            publisher,
            "--link",
            "--project",
            ...(probe.selected.length ? ["--skill", ...probe.selected] : [])
          ],
          runtime
        );
        expect(
          [slug, otherSlug].filter((name) => existsSync(path.join(installed, "imported", name)))
        ).toStrictEqual(probe.expected);
      }

      await runCliAsync(["skills", "update", "--project", "--adapter", "codiff"], runtime);
      expect(read(installed, `imported/${slug}/SKILL.md`)).toContain("Exact own instructions.");
      expect(existsSync(path.join(installed, "imported", otherSlug))).toBeFalsy();
    }
  );

  test("a declared reference collision fails before restoring or publishing guidance", async () => {
    const { consumer, declare, installed, publisher, runtime } = fixture();
    declare("reference", "own");
    await expect(
      runCliAsync(["skills", "add", publisher, "--link", "--project"], runtime)
    ).rejects.toThrow(/own.*collides/u);
    expect(existsSync(path.join(installed, "imported/own"))).toBeFalsy();
    expect(existsSync(path.join(publisher, "skills/references/imported/own"))).toBeFalsy();
    expect(read(consumer, ".git/monke-tools/skill-registry/skills.lock.json")).toContain(
      '"recipes": []'
    );
  });

  test("updates follow publisher kind changes and preserve consumer metadata overrides", async () => {
    const { declare, installed, publisher, runtime } = fixture();
    await runCliAsync(
      ["skills", "add", publisher, "--link", "--project", "--skill", "base"],
      runtime
    );
    declare("skill");
    await runCliAsync(["skills", "update", "--project", "--adapter", "codiff"], runtime);
    expect(read(installed, "imported/base/SKILL.md")).toContain("description: Publisher trigger.");
    expect(read(installed, "imported/base/SKILL.md")).toContain("disable-model-invocation: true");
    expect(existsSync(path.join(installed, "references/imported/base"))).toBeFalsy();
    await runCliAsync(
      [
        "skills",
        "policy",
        "publisher",
        "base",
        "--project",
        "--description",
        "Consumer trigger.",
        "--model-invocation",
        "allow"
      ],
      runtime
    );
    await runCliAsync(["skills", "update", "--project", "--adapter", "codiff"], runtime);
    expect(read(installed, "imported/base/SKILL.md")).toContain("description: Consumer trigger.");
    expect(read(installed, "imported/base/SKILL.md")).toContain("disable-model-invocation: false");
  });

  test.each([
    { action: "readd", removeConfig: false },
    { action: "update", removeConfig: false },
    { action: "readd", removeConfig: true },
    { action: "update", removeConfig: true }
  ])(
    "$action replaces a retired import with an own skill, removeConfig=$removeConfig",
    async ({ action, removeConfig }) => {
      const { declare, installed, publisher, runtime } = fixture();
      const add = ["skills", "add", publisher, "--link", "--project"];
      declare("skill");
      await runCliAsync(add, runtime);

      if (removeConfig) {
        rmSync(path.join(publisher, "monke.yml"));
      } else {
        write(publisher, "monke.yml", "skills: []\n");
      }

      write(
        publisher,
        "skills/base/SKILL.md",
        "---\nname: base\ndescription: Own base.\n---\nOwn base instructions.\n"
      );
      await runCliAsync(action === "readd" ? add : ["skills", "update", "--project"], runtime);
      expect(read(installed, "imported/base/SKILL.md")).toContain("Own base instructions.");
      expect(realpathSync(path.join(installed, "imported/base"))).toBe(
        realpathSync(path.join(publisher, "skills/base"))
      );
      expect(existsSync(path.join(publisher, "skills/imported/base"))).toBeFalsy();

      rmSync(path.join(publisher, "skills/base"), { recursive: true });
      declare("skill");
      await runCliAsync(action === "readd" ? add : ["skills", "update", "--project"], runtime);
      expect(read(installed, "imported/base/SKILL.md")).toContain("Base instructions.");
      expect(read(installed, "imported/base/SKILL.md")).toContain(
        "description: Publisher trigger."
      );

      if (removeConfig) {
        rmSync(path.join(publisher, "monke.yml"));
      } else {
        write(publisher, "monke.yml", "skills: []\n");
      }

      await runCliAsync(action === "readd" ? add : ["skills", "update", "--project"], runtime);
      expect(existsSync(path.join(installed, "imported/base"))).toBeFalsy();
      expect(existsSync(path.join(publisher, "skills/imported/base"))).toBeFalsy();
    }
  );

  test("a Sessions-only config preserves a legacy linked collection without a restore marker", async () => {
    const { installed, publisher, runtime } = fixture();
    write(publisher, "monke.yml", "apps: {}\n");
    const legacy = "---\nname: base\ndescription: Legacy base.\n---\nLegacy instructions.\n";
    write(publisher, "skills/imported/base/SKILL.md", legacy);
    await runCliAsync(["skills", "add", publisher, "--link", "--project"], runtime);
    expect(read(installed, "imported/base/SKILL.md")).toBe(legacy);
    expect(read(publisher, "skills/imported/base/SKILL.md")).toBe(legacy);
    expect(existsSync(path.join(publisher, "skills/.monke-restored.json"))).toBeFalsy();
  });
});
